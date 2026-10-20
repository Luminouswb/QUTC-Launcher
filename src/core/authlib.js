'use strict';

/**
 * QUTC Launcher - authlib-injector 运行时
 *
 * 第三方 Yggdrasil（LittleSkin）需要 authlib-injector 作为 javaagent，
 * 游戏才能完成外置登录鉴权并加载皮肤。这里按 SHA-256 校验官方构建。
 */

const fs = require('node:fs');
const path = require('node:path');

const Paths = require('./paths');
const { getJson, downloadFile } = require('./http');
const { verifyFile } = require('./hash');
const { ensureDirAsync, readJson, writeJsonAtomic } = require('./util');

const LATEST = 'https://authlib-injector.yushi.moe/artifact/latest.json';
const MIRROR = 'https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/latest.json';
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000;

async function fetchManifest({ mirror, abort, onLog } = {}) {
  const cacheFile = path.join(Paths.getPaths().cache, 'authlib-injector-latest.json');
  const cached = await readJson(cacheFile, null);
  if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < CACHE_MAX_AGE && cached.version) {
    return cached;
  }
  const urls = mirror === 'bmclapi' ? [MIRROR, LATEST] : [LATEST, MIRROR];
  let lastError = null;
  for (const url of urls) {
    try {
      const data = await getJson(url, { retries: 2, timeout: 20000, abort });
      const sha256 = data && data.checksums && String(data.checksums.sha256 || '').toLowerCase();
      if (!data || !data.version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(data.version))) {
        throw new Error('authlib-injector 版本信息异常');
      }
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('authlib-injector 缺少 SHA-256');
      const record = {
        version: String(data.version),
        build: Number(data.build_number) || 0,
        downloadUrl: String(data.download_url || ''),
        sha256,
        fetchedAt: Date.now(),
      };
      await writeJsonAtomic(cacheFile, record);
      if (onLog) onLog(`[authlib-injector] 获取版本 ${record.version} (sha256 ${sha256.slice(0, 12)}…)`);
      return record;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`无法获取 authlib-injector 版本信息: ${lastError ? lastError.message : '网络错误'}`);
}

async function ensureAuthlibInjector({ mirror, abort, onLog } = {}) {
  const manifest = await fetchManifest({ mirror, abort, onLog });
  const dir = path.join(Paths.getPaths().libraries, 'authlib-injector');
  await ensureDirAsync(dir);
  const dest = path.join(dir, `authlib-injector-${manifest.version}.jar`);
  if (fs.existsSync(dest) && (await verifyFile(dest, manifest.sha256, 'sha256'))) {
    return dest;
  }
  let url = manifest.downloadUrl;
  if (mirror === 'bmclapi') {
    url = url.replace('https://authlib-injector.yushi.moe', 'https://bmclapi2.bangbang93.com/mirrors/authlib-injector');
  }
  if (onLog) onLog('[authlib-injector] 正在下载运行时…');
  await downloadFile(url, dest, {
    expectedSha256: manifest.sha256,
    abort,
    retries: 3,
    timeout: 120000,
    onChunk: () => {},
  });
  if (onLog) onLog('[authlib-injector] SHA-256 校验通过');
  return dest;
}

module.exports = { ensureAuthlibInjector };
