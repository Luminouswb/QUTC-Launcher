'use strict';

/**
 * QUTC Launcher - 版本（游戏配置）管理
 *
 * 每个版本拥有独立的 minecraft 目录（mods/config/saves 等），
 * 通过 .qutc 压缩包导入/导出。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Paths = require('./paths');
const {
  ensureDirAsync,
  exists,
  readJson,
  writeJsonAtomic,
  sanitizeName,
  randomId,
  uniqueName,
  nowIso,
  assertSafeRelative,
  isInside,
} = require('./util');
const { createZip, listZip, extractZip, readZipEntry, listFilesRecursive } = require('./zip');

const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]{5,39}$/;
const VERSION_ID_RE = /^[A-Za-z0-9._-]{1,90}$/;

function assertVersionId(id) {
  const value = String(id || '').trim();
  if (!VERSION_ID_RE.test(value) || value.includes('..')) throw new Error('版本 ID 非法');
  return value;
}

const DEFAULT_MC_DIRS = [
  'mods',
  'config',
  'saves',
  'resourcepacks',
  'shaderpacks',
  'logs',
  'crash-reports',
];

const EXPORT_EXCLUDES = [
  'logs/',
  'crash-reports/',
  'natives/',
  'screenshots/',
  '.mixin.out/',
  'debug/',
];

function assertInstanceId(id) {
  if (!INSTANCE_ID_RE.test(String(id || ''))) throw new Error('版本 ID 非法');
  return id;
}

function instanceDir(id) {
  const dir = Paths.getPaths().instanceDir(assertInstanceId(id));
  if (!isInside(Paths.getPaths().instances, dir)) throw new Error('版本路径越界');
  return dir;
}

async function ensureInstanceDirs(id) {
  const dir = instanceDir(id);
  const gameDir = Paths.getPaths().instanceGameDir(id);
  await ensureDirAsync(path.join(dir, 'natives'));
  await ensureDirAsync(gameDir);
  for (const sub of DEFAULT_MC_DIRS) await ensureDirAsync(path.join(gameDir, sub));
  return { dir, gameDir };
}

async function listInstances() {
  const root = Paths.getPaths().instances;
  const items = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const item of items) {
    if (!item.isDirectory() || !INSTANCE_ID_RE.test(item.name)) continue;
    const data = await readJson(Paths.getPaths().instanceFile(item.name), null);
    if (!data || !data.versionId) continue;
    result.push(publicInstance(data));
  }
  result.sort((a, b) => String(b.lastPlayedAt || '').localeCompare(String(a.lastPlayedAt || '')));
  return result;
}

function normalizeLoader(loader) {
  const allowed = new Set(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']);
  const type = loader && allowed.has(loader.type) ? loader.type : 'vanilla';
  return { type, version: type === 'vanilla' ? '' : String((loader && loader.version) || '').slice(0, 48) };
}

function publicInstance(data) {
  return {
    id: data.id,
    name: data.name,
    versionId: data.versionId,
    mcVersion: data.mcVersion || data.versionId,
    loader: data.loader || { type: 'vanilla', version: '' },
    createdAt: data.createdAt || '',
    lastPlayedAt: data.lastPlayedAt || '',
    playTimeMs: data.playTimeMs || 0,
    memoryMb: data.memoryMb || 0,
    modpack: data.modpack || null,
    notes: data.notes || '',
    jvmArgsExtra: data.jvmArgsExtra || '',
    gameArgsExtra: data.gameArgsExtra || '',
    customResolution: data.customResolution || { enabled: false, width: 1280, height: 720 },
    external: Boolean(data.externalGameDir),
    externalPath: data.externalGameDir || '',
  };
}

/** 版本实际使用的游戏目录：外部版本直接使用用户选择的原目录 */
function gameDirForInstance(data) {
  if (data && data.externalGameDir) return path.resolve(String(data.externalGameDir));
  return Paths.getPaths().instanceGameDir(assertInstanceId(data && data.id));
}

async function getGameDir(id) {
  return gameDirForInstance(await getInstance(id));
}

async function getInstance(id) {
  const data = await readJson(Paths.getPaths().instanceFile(assertInstanceId(id)), null);
  if (!data) throw new Error('版本不存在');
  return data;
}

async function assertUniqueName(name, exceptId = '') {
  const target = String(name || '').trim().toLocaleLowerCase();
  if (!target) throw new Error('版本名称不能为空');
  const items = await listInstances();
  if (items.some((item) => item.id !== exceptId && String(item.name).trim().toLocaleLowerCase() === target)) {
    throw new Error(`版本名称「${name}」已存在，请修改名称`);
  }
}

/**
 * 创建版本
 * @param {{name:string, versionId:string, mcVersion?:string,
 *          loader?:{type:string,version:string}, modpack?:object, memoryMb?:number}} options
 */
async function createInstance(options) {
  const name = sanitizeName(options.name || options.mcVersion || options.versionId || '新版本');
  await assertUniqueName(name);
  const versionId = assertVersionId(options.versionId);
  const id = `i${Date.now().toString(36)}${randomId(3)}`;
  await ensureInstanceDirs(id);
  const data = {
    id,
    name,
    versionId,
    mcVersion: options.mcVersion || versionId,
    loader: normalizeLoader(options.loader),
    createdAt: nowIso(),
    lastPlayedAt: '',
    playTimeMs: 0,
    memoryMb: options.memoryMb || 0,
    modpack: options.modpack || null,
    notes: '',
    jvmArgsExtra: '',
    gameArgsExtra: '',
    customResolution: { enabled: false, width: 1280, height: 720 },
  };
  await writeJsonAtomic(Paths.getPaths().instanceFile(id), data);
  return publicInstance(data);
}

/**
 * 原地注册一个已有游戏目录：只写版本元数据，不复制/移动用户文件。
 * @param {{name:string, versionId:string, mcVersion?:string, loader?:object, externalGameDir:string}} options
 */
async function createExternalInstance(options) {
  const name = sanitizeName(options.name || options.mcVersion || '外部版本');
  await assertUniqueName(name);
  const versionId = assertVersionId(options.versionId);
  const raw = String(options.externalGameDir || '').trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error('外部游戏目录必须是绝对路径');
  let real;
  try {
    real = await fsp.realpath(raw);
  } catch {
    throw new Error('选择的文件夹不存在');
  }
  const stat = await fsp.stat(real);
  if (!stat.isDirectory()) throw new Error('选择的路径不是文件夹');
  if (isInside(Paths.getPaths().root, real)) {
    throw new Error('不能把 QUTC 数据目录内部注册为外部版本');
  }
  const id = `i${Date.now().toString(36)}${randomId(3)}`;
  const dir = instanceDir(id);
  await ensureDirAsync(path.join(dir, 'natives'));
  const data = {
    id,
    name,
    versionId,
    mcVersion: options.mcVersion || versionId,
    loader: normalizeLoader(options.loader),
    externalGameDir: real,
    createdAt: nowIso(),
    lastPlayedAt: '',
    playTimeMs: 0,
    memoryMb: options.memoryMb || 0,
    modpack: null,
    notes: '外部目录（原地使用，不复制文件）',
    jvmArgsExtra: '',
    gameArgsExtra: '',
    customResolution: { enabled: false, width: 1280, height: 720 },
  };
  await writeJsonAtomic(Paths.getPaths().instanceFile(id), data);
  return publicInstance(data);
}

async function updateInstance(id, patch) {
  const data = await getInstance(id);
  const previousName = data.name;
  const allowed = ['name', 'memoryMb', 'notes', 'icon', 'jvmArgsExtra', 'gameArgsExtra', 'customResolution'];
  for (const key of allowed) {
    if (patch[key] !== undefined) data[key] = patch[key];
  }
  if (data.name !== undefined) {
    data.name = sanitizeName(data.name, '版本');
    if (data.name !== previousName) await assertUniqueName(data.name, id);
  }
  if (data.memoryMb !== undefined) data.memoryMb = Math.max(0, Math.min(65536, Number(data.memoryMb) || 0));
  if (data.notes !== undefined) data.notes = String(data.notes).slice(0, 500);
  if (data.jvmArgsExtra !== undefined) data.jvmArgsExtra = String(data.jvmArgsExtra).slice(0, 2000);
  if (data.gameArgsExtra !== undefined) data.gameArgsExtra = String(data.gameArgsExtra).slice(0, 2000);
  if (data.customResolution !== undefined) {
    const custom = data.customResolution || {};
    data.customResolution = {
      enabled: Boolean(custom.enabled),
      width: Math.max(320, Math.min(7680, Number(custom.width) || 1280)),
      height: Math.max(240, Math.min(4320, Number(custom.height) || 720)),
    };
  }
  await writeJsonAtomic(Paths.getPaths().instanceFile(assertInstanceId(id)), data);
  return publicInstance(data);
}

async function renameInstance(id, name) {
  return updateInstance(id, { name });
}

/** 把历史遗留的“新版本”/重名版本改成可区分的名称 */
async function normalizeInstanceNames() {
  const items = await listInstances();
  const used = new Set();
  for (const item of items) {
    const data = await getInstance(item.id);
    let base = String(data.name || '').trim();
    if (!base || /^(新实例|新版本|实例|版本)(\s*\(\d+\))?$/.test(base)) {
      base = String(data.mcVersion || data.versionId || '版本');
    }
    base = sanitizeName(base, '版本');
    let name = base;
    let index = 2;
    while (used.has(name.toLocaleLowerCase())) {
      name = `${base} (${index})`;
      index += 1;
    }
    used.add(name.toLocaleLowerCase());
    if (data.name !== name) {
      data.name = name;
      await writeJsonAtomic(Paths.getPaths().instanceFile(data.id), data);
    }
  }
}

async function deleteInstance(id) {
  const data = await getInstance(id);
  if (data.externalGameDir) {
    // 外部版本只删除 QUTC 自己的元数据，绝不动用户选择的原目录
    await fsp.rm(instanceDir(id), { recursive: true, force: true });
    return true;
  }
  const dir = instanceDir(id);
  const trashRoot = path.join(Paths.getPaths().root, 'trash');
  await ensureDirAsync(trashRoot);
  const dest = path.join(trashRoot, `${id}-${Date.now()}`);
  await fsp.rename(dir, dest).catch(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  // 保留 7 天，之后由启动器启动时清理
  return true;
}

async function duplicateInstance(id, newName) {
  const source = await getInstance(id);
  if (source.externalGameDir) throw new Error('外部文件夹版本不支持复制，请重新添加目录');
  const created = await createInstance({
    name: uniqueName(newName || `${source.name} 副本`, (await listInstances()).map((i) => i.name)),
    versionId: source.versionId,
    mcVersion: source.mcVersion,
    loader: source.loader,
    modpack: source.modpack,
    memoryMb: source.memoryMb,
  });
  const srcGame = Paths.getPaths().instanceGameDir(id);
  const dstGame = Paths.getPaths().instanceGameDir(created.id);
  await fsp.cp(srcGame, dstGame, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(srcGame, src).replace(/\\/g, '/');
      return !EXPORT_EXCLUDES.some((prefix) => rel.startsWith(prefix.replace(/\/$/, '')));
    },
  }).catch(() => {});
  return created;
}

async function updateLastPlayed(id, durationMs = 0) {
  const data = await getInstance(id);
  data.lastPlayedAt = nowIso();
  data.playTimeMs = (data.playTimeMs || 0) + Math.max(0, durationMs);
  await writeJsonAtomic(Paths.getPaths().instanceFile(id), data);
  return publicInstance(data);
}

/**
 * 导出版本为 .qutc 压缩包
 */
async function exportInstance(id, destFile, { onProgress, abort } = {}) {
  const data = await getInstance(id);
  const gameDir = gameDirForInstance(data);
  const files = await listFilesRecursive(gameDir);
  const filtered = files.filter((file) => {
    const rel = file.rel.replace(/\\/g, '/');
    return !EXPORT_EXCLUDES.some((prefix) => rel === prefix.replace(/\/$/, '') || rel.startsWith(prefix));
  });
  const totalBytes = filtered.reduce((sum, f) => sum + f.size, 0);
  const tmp = `${destFile}.part-${process.pid}`;
  const writer = await createZip(tmp);
  let doneBytes = 0;
  let doneFiles = 0;
  try {
    await writer.addJson('instance.json', {
      format: 'qutc-instance',
      formatVersion: 1,
      app: 'QUTC-Launcher',
      exportedAt: nowIso(),
      instance: {
        name: data.name,
        versionId: data.versionId,
        mcVersion: data.mcVersion,
        loader: data.loader,
        memoryMb: data.memoryMb,
        modpack: data.modpack,
        notes: data.notes,
      },
      fileCount: filtered.length,
      totalBytes,
    });
    for (const file of filtered) {
      if (abort) abort.throwIfCancelled();
      const rel = assertSafeRelative(file.rel.replace(/\\/g, '/'), '导出路径');
      await writer.addFile(`minecraft/${rel}`, file.path);
      doneBytes += file.size;
      doneFiles += 1;
      if (onProgress) {
        onProgress({ filesDone: doneFiles, filesTotal: filtered.length, bytesDone: doneBytes, bytesTotal: totalBytes });
      }
    }
    if (abort) abort.throwIfCancelled();
    await writer.close();
    await fsp.rm(destFile, { force: true }).catch(() => {});
    await fsp.rename(tmp, destFile);
    return { file: destFile, files: filtered.length, bytes: totalBytes };
  } catch (err) {
    await writer.abort().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * 导入 .qutc 版本包（也接受普通包含 instance.json 的压缩包）
 */
async function importInstance(zipFile, { onProgress, abort } = {}) {
  const entries = await listZip(zipFile);
  const manifestEntry = entries.find((e) => e.name === 'instance.json');
  if (!manifestEntry) throw new Error('压缩包缺少 instance.json，不是 QUTC 版本包');
  const raw = await readZipEntry(zipFile, 'instance.json');
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('instance.json 解析失败');
  }
  const meta = manifest && manifest.instance ? manifest.instance : manifest;
  if (!meta || !meta.versionId) throw new Error('版本包缺少版本信息');
  const metaVersionId = assertVersionId(meta.versionId);
  const existingNames = (await listInstances()).map((i) => i.name);
  const name = uniqueName(sanitizeName(meta.name || '导入的版本'), existingNames);
  const created = await createInstance({
    name,
    versionId: metaVersionId,
    mcVersion: typeof meta.mcVersion === 'string' ? meta.mcVersion.slice(0, 40) : metaVersionId,
    loader: normalizeLoader(meta.loader),
    modpack: meta.modpack && typeof meta.modpack === 'object' ? meta.modpack : null,
    memoryMb: Math.max(0, Math.min(65536, Number(meta.memoryMb) || 0)),
  });
  const gameDir = Paths.getPaths().instanceGameDir(created.id);
  const total = entries.filter((e) => e.name.startsWith('minecraft/') && !e.isDirectory).length;
  const tempDir = path.join(Paths.getPaths().instanceDir(created.id), 'import-tmp');
  try {
    await fsp.rm(tempDir, { recursive: true, force: true });
    await extractZip(zipFile, tempDir, {
      abort,
      filter: (entryName) => entryName !== 'instance.json',
    });
    // 兼容两种打包方式：minecraft/ 前缀，或无前缀
    const nested = path.join(tempDir, 'minecraft');
    const sourceDir = exists(nested) ? nested : tempDir;
    await fsp.cp(sourceDir, gameDir, { recursive: true, force: true });
    await fsp.rm(tempDir, { recursive: true, force: true });
    if (onProgress) {
      onProgress({ filesDone: total, filesTotal: total, bytesDone: 0, bytesTotal: 0 });
    }
  } catch (err) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await deleteInstance(created.id).catch(() => {});
    throw err;
  }
  await ensureInstanceDirs(created.id);
  return { instance: created, meta };
}

module.exports = {
  listInstances,
  getInstance,
  createInstance,
  createExternalInstance,
  normalizeInstanceNames,
  gameDirForInstance,
  getGameDir,
  updateInstance,
  renameInstance,
  deleteInstance,
  duplicateInstance,
  updateLastPlayed,
  exportInstance,
  importInstance,
  ensureInstanceDirs,
  instanceDir,
  assertInstanceId,
  publicInstance,
  assertVersionId,
};
