'use strict';

/**
 * QUTC Launcher - 外部游戏目录版本识别与本地导入
 *
 * 外部文件夹里通常自带 versions/<id>/<id>.json、libraries 和 assets。
 * 这里把版本元数据/客户端 jar 以及缺失的 libraries/assets 以硬链接（失败则复制）
 * 导入 QUTCData，避免重新下载；游戏目录本身仍然原地使用。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const Paths = require('./paths');
const { ensureDirAsync } = require('./util');

const VERSION_ID_RE = /^[A-Za-z0-9._-]{1,90}$/;

function findMinecraftRoot(folder) {
  const candidates = [folder, path.join(folder, '.minecraft')];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'versions'))) return candidate;
  }
  // 直接选中 versions/<id> 的情况
  const parent = path.dirname(folder);
  if (path.basename(parent) === 'versions') return path.dirname(parent);
  return null;
}

function safeVersionId(sourceId, root) {
  if (VERSION_ID_RE.test(sourceId) && !sourceId.includes('..')) return sourceId;
  return `ext-${crypto.createHash('sha1').update(`${root}|${sourceId}`).digest('hex').slice(0, 16)}`;
}

function detectLoader(json, id) {
  const main = String((json && json.mainClass) || '');
  const lower = String(id || '').toLowerCase();
  if (/quilt/i.test(main) || lower.includes('quilt')) return { type: 'quilt', version: '' };
  if (/fabric/i.test(main) || lower.includes('fabric')) return { type: 'fabric', version: '' };
  if (lower.includes('neoforge') || /neoforge/i.test(main)) return { type: 'neoforge', version: '' };
  if (lower.includes('forge') || /bootstrap|forge/i.test(main)) return { type: 'forge', version: '' };
  return { type: 'vanilla', version: '' };
}

function scanVersions(folder) {
  const root = findMinecraftRoot(folder);
  if (!root) return { folder, root: '', versions: [] };
  const versionsDir = path.join(root, 'versions');
  let entries = [];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  } catch {
    return { folder, root, versions: [] };
  }
  const versions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const jsonFile = path.join(versionsDir, dirName, `${dirName}.json`);
    if (!fs.existsSync(jsonFile)) continue;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(jsonFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      continue;
    }
    const sourceId = String(json.id || dirName);
    const id = safeVersionId(sourceId, root);
    const mcVersion = String(json.clientVersion || json.inheritsFrom || json.id || sourceId);
    versions.push({
      id,
      sourceId,
      dirName,
      mcVersion,
      loader: detectLoader(json, sourceId),
      versionDir: path.join(versionsDir, dirName),
      root,
      renamed: id !== dirName,
    });
  }
  versions.sort((a, b) => a.mcVersion.localeCompare(b.mcVersion, 'en', { numeric: true }));
  return { folder, root, versions };
}

async function linkOrCopy(src, dest) {
  await ensureDirAsync(path.dirname(dest));
  try {
    if (fs.existsSync(dest)) return;
    await fsp.link(src, dest);
  } catch {
    await fsp.copyFile(src, dest).catch(() => {});
  }
}

async function mergeTree(srcRoot, destRoot) {
  if (!fs.existsSync(srcRoot)) return;
  const items = await fsp.readdir(srcRoot, { withFileTypes: true });
  await ensureDirAsync(destRoot);
  for (const item of items) {
    const src = path.join(srcRoot, item.name);
    const dest = path.join(destRoot, item.name);
    if (item.isDirectory()) {
      await mergeTree(src, dest);
    } else if (item.isFile()) {
      await linkOrCopy(src, dest);
    }
  }
}

/**
 * 把外部文件夹里的版本以本地文件方式导入 QUTCData（不联网）。
 * @returns {Promise<{id:string, mcVersion:string, loader:object}>}
 */
async function importExternalVersion(version) {
  const p = Paths.getPaths();
  const targetDir = p.versionDir(version.id);
  await ensureDirAsync(targetDir);
  const sourceDir = version.versionDir;
  const jsonFile = path.join(sourceDir, `${version.dirName}.json`);
  const json = JSON.parse((await fsp.readFile(jsonFile, 'utf8')).replace(/^\uFEFF/, ''));
  const targetJson = path.join(targetDir, `${version.id}.json`);
  if (!fs.existsSync(targetJson)) {
    const copy = { ...json, id: version.id };
    await fsp.writeFile(targetJson, JSON.stringify(copy, null, 2), 'utf8');
  }
  // 客户端 jar 重命名；其他文件原样保留
  const sourceJar = path.join(sourceDir, `${version.dirName}.jar`);
  if (fs.existsSync(sourceJar)) {
    await linkOrCopy(sourceJar, p.versionJar(version.id));
  } else if (!fs.existsSync(p.versionJar(version.id))) {
    // 加载器版本通常没有自己的 jar，复用同一 .minecraft 里原版版本的 client jar
    const parentJar = path.join(version.root, 'versions', version.mcVersion, `${version.mcVersion}.jar`);
    if (fs.existsSync(parentJar)) await linkOrCopy(parentJar, p.versionJar(version.id));
  }
  for (const file of await fsp.readdir(sourceDir)) {
    if (file === `${version.dirName}.json` || file === `${version.dirName}.jar`) continue;
    const src = path.join(sourceDir, file);
    const stat = await fsp.stat(src);
    if (stat.isFile()) await linkOrCopy(src, path.join(targetDir, file));
  }
  // 外部文件夹自带的共享库与资源，不联网重新下载
  await mergeTree(path.join(version.root, 'libraries'), p.libraries);
  await mergeTree(path.join(version.root, 'assets'), p.assets);
  return { id: version.id, mcVersion: version.mcVersion, loader: version.loader };
}

module.exports = {
  findMinecraftRoot,
  scanVersions,
  importExternalVersion,
};
