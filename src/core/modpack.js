'use strict';

/**
 * QUTC Launcher - 整合包安装（Modrinth .mrpack）
 *
 * .mrpack 本质是一个 ZIP，内含 modrinth.index.json：
 * - 列出要下载的模组文件（带 SHA-1 / SHA-512）；
 * - dependencies 指明 Minecraft 与加载器版本；
 * - overrides / client-overrides 是需要覆盖到版本目录的文件。
 *
 * 本模块不执行包内任何脚本，只做：
 * 1. 校验索引结构；
 * 2. 校验路径留在版本目录内；
 * 3. 按官方哈希下载文件；
 * 4. 解压 overrides（复用 zip.js 的防穿越逻辑）。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const Paths = require('./paths');
const Instances = require('./instances');
const { installLoader, installVersion } = require('./loaders');
const { downloadMany } = require('./http');
const { readZipEntry, extractZip } = require('./zip');
const {
  assertSafeRelative,
  ensureDirAsync,
  isInside,
  nowIso,
} = require('./util');

const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const LOADER_KEYS = ['neoforge', 'forge', 'fabric-loader', 'quilt-loader'];

function validateMcVersion(value) {
  const mc = String(value || '').trim();
  if (!/^\d{1,2}\.\d{1,2}(\.\d{1,2})?([-_a-zA-Z0-9.]*)$/.test(mc)) {
    throw new Error(`整合包中的 Minecraft 版本非法: ${mc.slice(0, 40)}`);
  }
  return mc;
}

function validateLoaderDependency(key) {
  const value = String(key || '').trim();
  if (!/^[A-Za-z0-9._+-]{1,48}$/.test(value)) throw new Error('整合包加载器版本非法');
  return value;
}

/**
 * 读取并校验 mrpack 索引
 */
async function readMrpackIndex(file) {
  const raw = await readZipEntry(file, 'modrinth.index.json', { maxBytes: MAX_INDEX_BYTES });
  if (!raw) throw new Error('不是有效的整合包：缺少 modrinth.index.json');
  let index;
  try {
    index = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('整合包索引 JSON 解析失败');
  }
  if (!index || index.formatVersion !== 1) throw new Error('不支持的整合包格式版本');
  if (index.game !== 'minecraft') throw new Error('整合包游戏类型不是 Minecraft');
  const deps = index.dependencies || {};
  const mcVersion = validateMcVersion(deps.minecraft);
  const loaderKey = LOADER_KEYS.find((key) => deps[key]);
  if (!loaderKey) throw new Error('整合包未指定模组加载器');
  const loaderType =
    loaderKey === 'fabric-loader' ? 'fabric' : loaderKey === 'quilt-loader' ? 'quilt' : loaderKey;
  const loaderVersion = validateLoaderDependency(deps[loaderKey]);

  const files = [];
  if (index.files !== undefined && !Array.isArray(index.files)) throw new Error('整合包文件列表格式异常');
  for (const entry of index.files || []) {
    if (!entry || typeof entry.path !== 'string') continue;
    const rel = assertSafeRelative(entry.path, '整合包文件路径');
    if (!rel || rel.length > 512) continue;
    if (entry.env && entry.env.client === 'unsupported') continue;
    const hashes = entry.hashes || {};
    if (!/^[0-9a-f]{40}$/i.test(hashes.sha1 || '')) {
      throw new Error(`整合包文件缺少 SHA-1: ${rel}`);
    }
    const url = Array.isArray(entry.downloads) ? entry.downloads.find((u) => typeof u === 'string') : '';
    if (!url) throw new Error(`整合包文件缺少下载地址: ${rel}`);
    files.push({
      path: rel,
      url,
      sha1: String(hashes.sha1).toLowerCase(),
      size: Number(entry.fileSize) || 0,
    });
  }

  return {
    name: String(index.name || '整合包').slice(0, 80),
    summary: String(index.summary || '').slice(0, 500),
    versionId: String(index.versionId || '').slice(0, 80),
    mcVersion,
    loader: { type: loaderType, version: loaderVersion },
    files,
    fileCount: files.length,
  };
}

/**
 * 从 .mrpack 安装整合包
 * @param {string} file
 * @param {{consent?:boolean, mirror?:string, abort?:object, onPhase?:Function,
 *          onLog?:Function, onProgress?:Function}} ctx
 */
async function installMrpack(file, ctx = {}) {
  const info = await readMrpackIndex(file);
  if (ctx.onPhase) ctx.onPhase(`准备安装整合包「${info.name}」`);
  if (ctx.onLog) {
    ctx.onLog(`[整合包] ${info.name} - MC ${info.mcVersion} ${info.loader.type} ${info.loader.version}`);
  }

  // 1. 原版
  await ensureVanilla(info.mcVersion, ctx);

  // 2. 加载器
  if (ctx.onPhase) ctx.onPhase(`安装 ${info.loader.type} ${info.loader.version}`);
  const loaderResult = await installLoader({
    loader: info.loader.type,
    mcVersion: info.mcVersion,
    loaderVersion: info.loader.version,
    ctx,
  });

  // 3. 版本
  const instance = await Instances.createInstance({
    name: info.name,
    versionId: loaderResult.versionId,
    mcVersion: info.mcVersion,
    loader: loaderResult.loader,
    modpack: {
      source: 'modrinth',
      name: info.name,
      versionId: info.versionId,
      installedAt: nowIso(),
    },
  });
  const gameDir = Paths.getPaths().instanceGameDir(instance.id);
  await ensureDirAsync(gameDir);

  try {
    // 4. 下载模组/资源
    if (info.files.length) {
      if (ctx.onPhase) ctx.onPhase(`下载整合包文件 (${info.files.length} 个)`);
      const items = [];
      for (const item of info.files) {
        const dest = path.resolve(gameDir, item.path);
        if (!isInside(gameDir, dest)) throw new Error(`整合包文件越界: ${item.path}`);
        items.push({ url: item.url, dest, sha1: item.sha1, size: item.size || undefined });
      }
      await downloadMany(items, {
        concurrency: ctx.concurrency || 8,
        mirror: ctx.mirror,
        abort: ctx.abort,
        retries: 3,
        onProgress: (p) => {
          if (ctx.onProgress) ctx.onProgress({ ...p, phase: 'modpack-files' });
        },
      });
    }

    // 5. overrides
    await applyOverrides(file, gameDir, ctx);
    await Instances.ensureInstanceDirs(instance.id);
    if (ctx.onLog) ctx.onLog(`[整合包] 安装完成: ${instance.name}`);
    return { instance, info };
  } catch (err) {
    await Instances.deleteInstance(instance.id).catch(() => {});
    throw err;
  }
}

async function applyOverrides(file, gameDir, ctx) {
  const tempDir = path.join(Paths.getPaths().cache, 'downloads', `overrides-${process.pid}-${Date.now()}`);
  try {
    const hasOverrides = await zipHasPrefix(file, ['overrides/', 'client-overrides/']);
    if (!hasOverrides) return;
    if (ctx.onPhase) ctx.onPhase('应用整合包覆盖文件');
    await extractZip(file, tempDir, {
      abort: ctx.abort,
      maxTotalBytes: 8 * 1024 * 1024 * 1024,
      filter: (name) => name.startsWith('overrides/') || name.startsWith('client-overrides/'),
    });
    for (const dirName of ['overrides', 'client-overrides']) {
      const source = path.join(tempDir, dirName);
      if (!isInside(tempDir, source)) continue;
      try {
        await fsp.access(source);
      } catch {
        continue;
      }
      await fsp.cp(source, gameDir, { recursive: true, force: true });
    }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function zipHasPrefix(file, prefixes) {
  const { listZip } = require('./zip');
  const entries = await listZip(file);
  return entries.some((entry) => prefixes.some((prefix) => entry.name.startsWith(prefix)));
}

async function ensureVanilla(mcVersion, ctx) {
  const p = Paths.getPaths();
  if (existsFile(p.versionJson(mcVersion)) && existsFile(p.versionJar(mcVersion))) {
    return;
  }
  if (ctx.onPhase) ctx.onPhase(`安装原版 Minecraft ${mcVersion}`);
  await installVersion(mcVersion, {
    mirror: ctx.mirror,
    concurrency: ctx.concurrency,
    abort: ctx.abort,
    onPhase: ctx.onPhase,
    onLog: ctx.onLog,
    onProgress: ctx.onProgress,
  });
}

function existsFile(file) {
  try {
    require('node:fs').accessSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 导入本地 .qutc 版本包与整合包时共用的格式探测
 */
async function describeMrpack(file) {
  return readMrpackIndex(file);
}

module.exports = {
  readMrpackIndex,
  installMrpack,
  describeMrpack,
  applyOverrides,
};
