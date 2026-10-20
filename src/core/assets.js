'use strict';

/**
 * QUTC Launcher - 资源文件（assets）安装
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Paths = require('./paths');
const { getJson, downloadFile, downloadMany } = require('./http');
const { verifyFile } = require('./hash');
const { ensureDirAsync, exists } = require('./util');

const ASSET_BASE = 'https://resources.download.minecraft.net';

function assetObjectUrl(hash) {
  return `${ASSET_BASE}/${hash.slice(0, 2)}/${hash}`;
}

function isSha1(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || ''));
}

async function ensureIndex(index, ctx) {
  if (!index || !index.id) return null;
  const file = Paths.getPaths().assetIndex(index.id);
  if (exists(file)) {
    if (!index.sha1 || (await verifyFile(file, index.sha1, 'sha1'))) {
      const json = await fsp.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
      if (json) return json;
    }
  }
  if (!index.url) return null;
  await downloadFile(index.url, file, {
    sha1: index.sha1,
    size: index.size,
    mirror: ctx.mirror,
    abort: ctx.abort,
    retries: 3,
  });
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

/**
 * 下载一个版本所需的全部资源。
 * @returns {{assetsDir:string, assetIndexId:string, virtual:boolean, objects:number}}
 */
async function installAssets(versionJson, ctx = {}) {
  const indexMeta = versionJson.assetIndex;
  const assetsRoot = Paths.getPaths().assets;
  if (!indexMeta || !indexMeta.id) {
    return { assetsDir: assetsRoot, assetIndexId: 'legacy', virtual: false, objects: 0 };
  }
  if (ctx.onPhase) ctx.onPhase(`检查资源索引 ${indexMeta.id}`);
  const index = await ensureIndex(indexMeta, ctx);
  if (!index || !index.objects) {
    return { assetsDir: assetsRoot, assetIndexId: indexMeta.id, virtual: false, objects: 0 };
  }

  const objectEntries = Object.entries(index.objects);
  const items = [];
  const seenHash = new Set();
  for (const [name, info] of objectEntries) {
    if (!info || !isSha1(info.hash)) continue;
    // 多个资源名可能指向同一个对象，去重避免并发写同一文件
    if (seenHash.has(info.hash)) continue;
    seenHash.add(info.hash);
    const dest = Paths.getPaths().assetObject(info.hash);
    items.push({
      url: assetObjectUrl(info.hash),
      dest,
      sha1: info.hash,
      size: Number(info.size) || 0,
      name,
    });
  }

  if (ctx.onPhase) ctx.onPhase(`下载游戏资源 (${items.length} 个文件)`);
  await downloadMany(items, {
    concurrency: ctx.concurrency || 16,
    mirror: ctx.mirror,
    abort: ctx.abort,
    retries: 3,
    onProgress: (p) => {
      if (ctx.onProgress) ctx.onProgress({ ...p, phase: 'assets' });
    },
  });

  // 旧版本（1.6 及以前）需要把资源按原名放进 virtual 目录
  let assetsDir = assetsRoot;
  if (index.virtual) {
    if (ctx.onPhase) ctx.onPhase(`构建旧版资源目录 ${indexMeta.id}`);
    const virtualDir = path.join(assetsRoot, 'virtual', indexMeta.id);
    await ensureDirAsync(virtualDir);
    for (const [name, info] of objectEntries) {
      if (!info || !isSha1(info.hash)) continue;
      const src = Paths.getPaths().assetObject(info.hash);
      const dest = path.join(virtualDir, ...name.split('/'));
      if (!dest.startsWith(virtualDir)) continue;
      await ensureDirAsync(path.dirname(dest));
      try {
        await fsp.copyFile(src, dest);
      } catch {
        /* 单个资源失败不阻塞整个安装 */
      }
    }
    assetsDir = virtualDir;
  }

  // 极旧版本会把资源直接映射到游戏目录 resources/
  if (index.map_to_resources && ctx.gameDir) {
    if (ctx.onPhase) ctx.onPhase('映射旧版游戏资源');
    const resourcesDir = path.join(ctx.gameDir, 'resources');
    await ensureDirAsync(resourcesDir);
    for (const [name, info] of objectEntries) {
      if (!info || !isSha1(info.hash)) continue;
      const src = Paths.getPaths().assetObject(info.hash);
      const dest = path.join(resourcesDir, ...name.split('/'));
      if (!dest.startsWith(resourcesDir)) continue;
      await ensureDirAsync(path.dirname(dest));
      try {
        await fsp.copyFile(src, dest);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    assetsDir,
    assetIndexId: indexMeta.id,
    virtual: Boolean(index.virtual),
    objects: items.length,
  };
}

/** 检查资源索引是否已就绪（用于判断版本是否已完整安装） */
async function isAssetIndexReady(assetIndex) {
  if (!assetIndex || !assetIndex.id) return true;
  const file = Paths.getPaths().assetIndex(assetIndex.id);
  if (!exists(file)) return false;
  if (!assetIndex.sha1) return true;
  return verifyFile(file, assetIndex.sha1, 'sha1');
}

module.exports = {
  installAssets,
  isAssetIndexReady,
  ensureIndex,
  assetObjectUrl,
};
