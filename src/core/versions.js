'use strict';

/**
 * QUTC Launcher - 原版版本清单 / 版本 JSON / 安装
 *
 * 全部内容来自 Mojang 官方：
 * - 版本清单：https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
 * - 每个版本的 JSON 与 client.jar 均校验官方 SHA-1
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Paths = require('./paths');
const { getJson, downloadFile, downloadMany } = require('./http');
const { verifyFile } = require('./hash');
const {
  isAllowed,
  libraryArtifact,
  nativeArtifact,
  mergeLibraries,
} = require('./rules');
const { installAssets, isAssetIndexReady } = require('./assets');
const { extractZip } = require('./zip');
const { ensureDirAsync, exists, readJson, writeJsonAtomic, createFileProgress } = require('./util');
const { PLATFORM_NAME, ARCH_NAME } = require('./rules');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MANIFEST_TTL_MS = 15 * 60 * 1000;

function ruleContext(extraFeatures = {}) {
  return {
    osName: PLATFORM_NAME,
    osArch: ARCH_NAME,
    osVersion: os.release(),
    features: {
      is_demo_user: false,
      has_custom_resolution: false,
      has_quick_plays_support: false,
      is_quick_play_singleplayer: false,
      is_quick_play_multiplayer: false,
      is_quick_play_realms: false,
      ...extraFeatures,
    },
  };
}

async function getManifest({ force = false, mirror, abort, onPhase } = {}) {
  const p = Paths.getPaths();
  const file = path.join(p.cache, 'manifests', 'version_manifest_v2.json');
  const metaFile = path.join(p.cache, 'manifests', 'version_manifest_v2.meta.json');
  const meta = await readJson(metaFile, null);
  if (!force && exists(file) && meta && Date.now() - meta.fetchedAt < MANIFEST_TTL_MS) {
    const cached = await readJson(file, null);
    if (cached && Array.isArray(cached.versions)) return cached;
  }
  if (onPhase) onPhase('获取版本清单');
  try {
    const manifest = await getJson(MANIFEST_URL, { mirror, abort, retries: 3 });
    if (!manifest || !Array.isArray(manifest.versions) || !manifest.latest) {
      throw new Error('版本清单格式异常');
    }
    await writeJsonAtomic(file, manifest);
    await writeJsonAtomic(metaFile, { fetchedAt: Date.now(), url: MANIFEST_URL });
    return manifest;
  } catch (err) {
    if (err && err.cancelled) throw err;
    const cached = await readJson(file, null);
    if (cached && Array.isArray(cached.versions)) {
      if (onPhase) onPhase('版本清单获取失败，使用本地缓存');
      return cached;
    }
    throw err;
  }
}

async function getVersionEntry(id, options = {}) {
  const manifest = await getManifest(options);
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) throw new Error(`版本不存在: ${id}`);
  return entry;
}

async function getVanillaJson(id, options = {}) {
  const p = Paths.getPaths();
  const cacheFile = path.join(p.cache, 'version-json', `${id}.json`);
  const entry = await getVersionEntry(id, options);
  if (!options.force && exists(cacheFile)) {
    if (!entry.sha1 || (await verifyFile(cacheFile, entry.sha1, 'sha1'))) {
      return readJson(cacheFile, null);
    }
  }
  if (options.onPhase) options.onPhase(`下载版本信息 ${id}`);
  await downloadFile(entry.url, cacheFile, {
    sha1: entry.sha1,
    mirror: options.mirror,
    abort: options.abort,
    retries: 3,
    timeout: 60000,
  });
  const json = await readJson(cacheFile, null);
  if (!json) throw new Error(`版本 JSON 解析失败: ${id}`);
  return json;
}

async function loadVersionJson(id) {
  const installed = Paths.getPaths().versionJson(id);
  if (exists(installed)) {
    const json = await readJson(installed, null);
    if (json) return json;
  }
  const p = Paths.getPaths();
  const cacheFile = path.join(p.cache, 'version-json', `${id}.json`);
  const json = await readJson(cacheFile, null);
  if (json) return json;
  throw new Error(`版本 ${id} 尚未安装`);
}

async function saveVersionJson(id, json) {
  if (!/^[A-Za-z0-9._-]{1,90}$/.test(String(id)) || String(id).includes('..')) {
    throw new Error('版本 ID 非法');
  }
  const dir = Paths.getPaths().versionDir(id);
  await ensureDirAsync(dir);
  await writeJsonAtomic(Paths.getPaths().versionJson(id), json);
}

/**
 * 解析版本继承链，合并父/子版本 JSON。
 * @returns {{ id:string, json:object, chain:string[], clientOwner:string, raw:object }}
 */
async function resolveVersion(id) {
  const chain = [];
  const seen = new Set();
  let current = id;
  while (current) {
    if (!/^[A-Za-z0-9._-]{1,90}$/.test(String(current)) || String(current).includes('..')) {
      throw new Error(`版本继承链包含非法 ID: ${String(current).slice(0, 80)}`);
    }
    if (seen.has(current)) throw new Error(`版本继承出现循环: ${current}`);
    seen.add(current);
    const json = await loadVersionJson(current);
    chain.push({ id: current, json });
    if (!json.inheritsFrom) break;
    current = json.inheritsFrom;
    if (chain.length > 8) throw new Error('版本继承层级过深');
  }

  let merged = {
    id,
    type: 'release',
    libraries: [],
    arguments: { game: [], jvm: [] },
  };
  let clientOwner = id;

  // 从最底层父版本开始合并
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const { id: nodeId, json } = chain[i];
    const isRoot = i === chain.length - 1;
    if (isRoot) {
      merged = { ...json };
      merged.arguments = normalizeArguments(json.arguments);
    } else {
      for (const key of [
        'mainClass',
        'assetIndex',
        'assets',
        'javaVersion',
        'type',
        'releaseTime',
        'time',
        'minimumLauncherVersion',
        'logging',
        'jar',
        'minecraftArguments',
      ]) {
        if (json[key] !== undefined) merged[key] = json[key];
      }
      if (json.downloads) merged.downloads = { ...(merged.downloads || {}), ...json.downloads };
      merged.libraries = mergeLibraries(merged.libraries, json.libraries);
      merged.arguments = mergeArguments(merged.arguments, normalizeArguments(json.arguments));
    }
    if (json.downloads && json.downloads.client) clientOwner = nodeId;
    merged.id = id;
    merged.inheritsFrom = undefined;
  }

  if (!merged.mainClass) throw new Error(`版本 ${id} 缺少主类信息`);
  return { id, json: merged, chain: chain.map((c) => c.id), clientOwner, raw: chain[0].json };
}

function normalizeArguments(args) {
  if (!args || typeof args !== 'object') return { game: [], jvm: [] };
  return {
    game: Array.isArray(args.game) ? args.game : [],
    jvm: Array.isArray(args.jvm) ? args.jvm : [],
  };
}

function mergeArguments(parent, child) {
  return {
    game: [...(parent.game || []), ...(child.game || [])],
    jvm: [...(parent.jvm || []), ...(child.jvm || [])],
  };
}

/** 计算需要下载的库（含旧版 natives classifier） */
function collectLibraries(versionJson) {
  const ctx = ruleContext();
  const result = [];
  for (const lib of versionJson.libraries || []) {
    if (!isAllowed(lib.rules, ctx)) continue;
    const artifact = libraryArtifact(lib);
    const native = nativeArtifact(lib);
    if (!artifact && !native) continue;
    result.push({ lib, artifact, native });
  }
  return result;
}

/**
 * 少数远古版本引用了 Mojang 已下架的 Twitch / 语音库；
 * 这些库缺失不影响单人/多人游戏启动，允许跳过。
 */
function isOptionalLibrary(relPath) {
  const value = String(relPath || '').replace(/\\/g, '/').toLowerCase();
  return (
    value.includes('/twitch-platform/') ||
    value.includes('/twitch-external-platform/') ||
    value.includes('/twitch-json/') ||
    value.includes('/jinput-platform/') ||
    value.includes('/text2speech/')
  );
}

async function downloadLibraries(entries, ctx) {
  const items = [];
  const seen = new Set();
  const push = (desc) => {
    if (!desc || !desc.path || !desc.url) return;
    const dest = Paths.getPaths().libraryFile(desc.path);
    if (seen.has(dest)) return;
    seen.add(dest);
    items.push({
      url: desc.url,
      dest,
      sha1: desc.sha1,
      size: desc.size,
      optional: isOptionalLibrary(desc.path),
    });
  };
  for (const entry of entries) {
    push(entry.artifact);
    if (entry.native && entry.native.path !== (entry.artifact && entry.artifact.path)) {
      push(entry.native);
    }
  }
  if (ctx.onPhase) ctx.onPhase(`下载依赖库 (${items.length} 个文件)`);
  const result = await downloadMany(items, {
    concurrency: ctx.concurrency || 8,
    mirror: ctx.mirror,
    abort: ctx.abort,
    retries: 3,
    continueOnError: true,
    onProgress: (p) => {
      if (ctx.onProgress) ctx.onProgress({ ...p, phase: 'libraries' });
    },
  });
  const failures = (result.errors || []).filter((item) => !(item.item && item.item.optional));
  const optionalFailures = (result.errors || []).filter((item) => item.item && item.item.optional);
  for (const failure of optionalFailures) {
    if (ctx.onLog) ctx.onLog(`[警告] 可选的远古依赖缺失，已跳过: ${path.basename(failure.item.dest)}`);
  }
  if (failures.length) {
    throw new Error(`依赖库下载失败: ${failures[0].error}（共 ${failures.length} 个文件）`);
  }
  return items.length;
}

async function extractNatives(entries, nativesDir, ctx) {
  await fsp.rm(nativesDir, { recursive: true, force: true });
  await ensureDirAsync(nativesDir);
  let extracted = 0;
  for (const entry of entries) {
    if (ctx.abort) ctx.abort.throwIfCancelled();
    const native = entry.native;
    if (!native || !native.path) continue;
    const jar = Paths.getPaths().libraryFile(native.path);
    if (!exists(jar)) continue;
    const excludes = (entry.lib.extract && entry.lib.extract.exclude) || ['META-INF/'];
    try {
      await extractZip(jar, nativesDir, {
        abort: ctx.abort,
        filter: (name) => !excludes.some((prefix) => name.startsWith(prefix)),
        maxTotalBytes: 512 * 1024 * 1024,
      });
      extracted += 1;
    } catch (err) {
      if (err && err.cancelled) throw err;
      if (ctx.onLog) ctx.onLog(`[警告] 解压 natives 失败: ${path.basename(jar)} - ${err.message}`);
    }
  }
  return extracted;
}

async function downloadLogging(versionJson, ctx) {
  const cfg = versionJson.logging && versionJson.logging.client;
  if (!cfg || !cfg.file) return null;
  const file = cfg.file;
  const dest = path.join(Paths.getPaths().logConfigs, file.id || path.basename(new URL(file.url).pathname));
  await downloadFile(file.url, dest, {
    sha1: file.sha1,
    size: file.size,
    mirror: ctx.mirror,
    abort: ctx.abort,
    retries: 3,
  });
  return { path: dest, argument: cfg.argument, id: file.id };
}

/**
 * 安装一个版本（原版或已写入 versions/ 的加载器版本）。
 * @param {string} id
 * @param {{nativesDir:string, gameDir?:string, mirror?:string, concurrency?:number,
 *          abort?:object, onPhase?:(text:string)=>void, onLog?:(line:string)=>void,
 *          onProgress?:(p:object)=>void}} ctx
 */
async function installVersion(id, ctx = {}) {
  const p = Paths.getPaths();
  // 原版版本可能在本地还没有 JSON：先从 Mojang 清单拉取并保存
  if (!exists(p.versionJson(id))) {
    const entry = await getVersionEntry(id, { mirror: ctx.mirror, abort: ctx.abort, onPhase: ctx.onPhase });
    if (ctx.onPhase) ctx.onPhase(`获取版本信息 ${id}`);
    const json = await getVanillaJson(id, {
      mirror: ctx.mirror,
      abort: ctx.abort,
      onPhase: ctx.onPhase,
    });
    if (!json) throw new Error(`版本 JSON 获取失败: ${id}`);
    await saveVersionJson(id, json);
  }
  const resolved = await resolveVersion(id);
  const versionDir = p.versionDir(id);
  await ensureDirAsync(versionDir);

  // 保存合并前的原始 JSON（启动器实际使用原始 JSON + 运行时合并）
  await saveVersionJson(id, resolved.raw);

  if (ctx.abort) ctx.abort.throwIfCancelled();

  // 1. 客户端 jar
  const client = resolved.json.downloads && resolved.json.downloads.client;
  if (client && client.url) {
    if (ctx.onPhase) ctx.onPhase(`下载客户端 ${id}`);
    const jarPath = p.versionJar(resolved.clientOwner);
    const clientProgress = createFileProgress(ctx.onProgress, 'client');
    await downloadFile(client.url, jarPath, {
      sha1: client.sha1,
      size: client.size,
      mirror: ctx.mirror,
      abort: ctx.abort,
      retries: 4,
      timeout: 300000,
      onChunk: (n, total) => clientProgress.add(n, total),
    });
  }

  // 2. 依赖库
  const entries = collectLibraries(resolved.json);
  if (ctx.abort) ctx.abort.throwIfCancelled();
  await downloadLibraries(entries, ctx);

  // 3. natives
  if (ctx.nativesDir) {
    if (ctx.onPhase) ctx.onPhase('解压本地库');
    await extractNatives(entries, ctx.nativesDir, ctx);
  }

  // 4. 资源
  if (ctx.abort) ctx.abort.throwIfCancelled();
  const assetResult = await installAssets(resolved.json, {
    ...ctx,
    gameDir: ctx.gameDir,
  });

  // 5. 日志配置
  await downloadLogging(resolved.json, ctx);

  // 6. 安装标记（用于快速判断完整性）
  await writeJsonAtomic(path.join(versionDir, '.qutc-installed.json'), {
    id,
    installedAt: Date.now(),
    clientOwner: resolved.clientOwner,
    assetIndex: (resolved.json.assetIndex && resolved.json.assetIndex.id) || 'legacy',
    nativesDir: ctx.nativesDir || '',
    chain: resolved.chain,
  });

  return { resolved, assets: assetResult };
}

/** 版本是否已完整安装（用于 UI 状态） */
async function getInstallState(id) {
  const p = Paths.getPaths();
  const versionJson = p.versionJson(id);
  if (!exists(versionJson)) return { installed: false, reason: '未安装' };
  const marker = await readJson(path.join(p.versionDir(id), '.qutc-installed.json'), null);
  if (!marker) return { installed: false, reason: '安装未完成' };
  let resolved;
  try {
    resolved = await resolveVersion(id);
  } catch (err) {
    return { installed: false, reason: err.message };
  }
  const client = resolved.json.downloads && resolved.json.downloads.client;
  if (client) {
    if (!exists(p.versionJar(resolved.clientOwner))) return { installed: false, reason: '缺少客户端文件' };
  }
  if (!(await isAssetIndexReady(resolved.json.assetIndex))) {
    return { installed: false, reason: '缺少资源文件' };
  }
  return { installed: true, marker, javaMajor: getJavaMajor(resolved.json) };
}

function getJavaMajor(versionJson) {
  if (versionJson.javaVersion && versionJson.javaVersion.majorVersion) {
    return Number(versionJson.javaVersion.majorVersion);
  }
  // 极旧版本没有 javaVersion 字段
  const id = String(versionJson.id || '');
  if (/^1\.(0|1|2|3|4|5|6)(\.|$)/.test(id)) return 8;
  if (/^1\.(7|8|9|10|11|12|13|14|15|16)(\.|$)/.test(id)) return 8;
  if (/^1\.(17)(\.|$)/.test(id)) return 16;
  if (/^1\.(18|19|20)(\.|$)/.test(id)) return 17;
  return 21;
}

/** 列出本地 versions/ 下的版本 id */
async function listInstalledVersions() {
  const dir = Paths.getPaths().versions;
  const result = [];
  const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    if (!item.isDirectory()) continue;
    if (exists(Paths.getPaths().versionJson(item.name))) result.push(item.name);
  }
  return result;
}

async function getVersionSummary(id, options = {}) {
  const entry = await getVersionEntry(id, options);
  const json = await getVanillaJson(id, options);
  return {
    id,
    type: entry.type,
    releaseTime: entry.releaseTime,
    url: entry.url,
    javaMajor: getJavaMajor(json),
    assetsSize: json.assetIndex ? json.assetIndex.totalSize || 0 : 0,
    clientSize: json.downloads && json.downloads.client ? json.downloads.client.size : 0,
  };
}

module.exports = {
  MANIFEST_URL,
  getManifest,
  getVersionEntry,
  getVanillaJson,
  loadVersionJson,
  saveVersionJson,
  resolveVersion,
  collectLibraries,
  downloadLibraries,
  extractNatives,
  installVersion,
  getInstallState,
  listInstalledVersions,
  getJavaMajor,
  ruleContext,
  isOptionalLibrary,
  getVersionSummary,
};
