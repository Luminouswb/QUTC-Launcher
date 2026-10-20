'use strict';

/**
 * QUTC Launcher - HTTP 下载器
 *
 * 安全要点：
 * - 仅允许 HTTPS + 公网地址；
 * - 下载到 .part 临时文件，校验 SHA-1 后原子替换；
 * - 已存在的文件优先校验，损坏则重新下载；
 * - 支持 BMCLAPI 镜像（仍以 Mojang 官方哈希为准）。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const { assertSafeRemoteUrl } = require('./security');
const { ensureDirAsync, sleep, mapLimit, Abort } = require('./util');
const { verifyFile } = require('./hash');

const USER_AGENT = 'QUTC-Launcher/1.0 (Minecraft Club Launcher; +https://qutc.club)';

function mirrorUrl(input, mirror) {
  if (!mirror || mirror === 'official') return input;
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    if (mirror === 'bmclapi') {
      if (
        host === 'piston-meta.mojang.com' ||
        host === 'launchermeta.mojang.com' ||
        host === 'piston-data.mojang.com'
      ) {
        url.hostname = 'bmclapi2.bangbang93.com';
        return url.href;
      }
      if (host === 'libraries.minecraft.net') {
        url.hostname = 'bmclapi2.bangbang93.com';
        url.pathname = `/maven${url.pathname}`;
        return url.href;
      }
      if (host === 'resources.download.minecraft.net') {
        url.hostname = 'bmclapi2.bangbang93.com';
        url.pathname = `/assets${url.pathname}`;
        return url.href;
      }
    }
    return url.href;
  } catch {
    return input;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000, abort) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (abort) {
    if (abort.cancelled) controller.abort();
    else abort.onCancel(onAbort);
  }
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
    if (abort) abort.listeners.delete(onAbort);
  }
}

/**
 * 获取 JSON（带重试、镜像回退）
 */
async function getJson(input, { mirror, timeout = 30000, retries = 3, abort, headers } = {}) {
  let lastError;
  const candidates = [mirrorUrl(input, mirror)];
  if (mirror && mirror !== 'official') candidates.push(input);
  for (let attempt = 0; attempt < retries; attempt += 1) {
    for (const candidate of candidates) {
      if (abort) abort.throwIfCancelled();
      try {
        const safe = assertSafeRemoteUrl(candidate);
        const res = await fetchWithTimeout(
          safe,
          { headers: { accept: 'application/json', ...(headers || {}) } },
          timeout,
          abort,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        if (err && err.cancelled) throw err;
      }
    }
    if (attempt < retries - 1) await sleep(700 * (attempt + 1));
  }
  throw new Error(`请求失败: ${shortUrl(input)} - ${lastError ? lastError.message : 'unknown'}`);
}

/**
 * 下载单个文件到磁盘，校验哈希。返回 { skipped, bytes, sha1 }
 */
async function downloadFile(input, dest, options = {}) {
  const {
    sha1,
    size,
    mirror,
    abort,
    onChunk,
    retries = 3,
    timeout = 120000,
    force = false,
    allowMissingHash = false,
    expectedSha256,
    trustSize = false,
  } = options;

  if (!force && (await fsp.stat(dest).then(() => true).catch(() => false))) {
    const stat = await fsp.stat(dest);
    if (trustSize && size && stat.size === size) {
      if (onChunk) onChunk(stat.size, size);
      return { skipped: true, bytes: stat.size };
    }
    if (size && stat.size !== size) {
      // 大小不符，重下
    } else if (sha1) {
      if (await verifyFile(dest, sha1, 'sha1')) {
        if (onChunk) onChunk(size || stat.size, size || stat.size);
        return { skipped: true, bytes: stat.size };
      }
    } else if (expectedSha256) {
      if (await verifyFile(dest, expectedSha256, 'sha256')) {
        if (onChunk) onChunk(size || stat.size, size || stat.size);
        return { skipped: true, bytes: stat.size };
      }
    } else {
      if (size ? stat.size === size : stat.size > 0) {
        return { skipped: true, bytes: stat.size };
      }
    }
  }
  if (!sha1 && !expectedSha256 && !allowMissingHash) {
    // 没有哈希的内容仍允许下载（例如 Forge 的 maven 依赖），但必须显式开启
    // 这里保持宽松：仅要求 HTTPS。调用方应在可能时提供哈希。
  }

  await ensureDirAsync(path.dirname(dest));
  const candidates = [mirrorUrl(input, mirror)];
  if (mirror && mirror !== 'official') candidates.push(input);

  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    for (const candidate of candidates) {
      if (abort) abort.throwIfCancelled();
      const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
      try {
        const safe = assertSafeRemoteUrl(candidate);
        const res = await fetchWithTimeout(
          safe,
          { headers: { accept: '*/*' } },
          timeout,
          abort,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const total = Number(res.headers.get('content-length')) || size || 0;
        if (size && total && total > size * 1.05 + 1024) {
          throw new Error(`服务器返回体积异常: ${total} > ${size}`);
        }
        let received = 0;
        const counter = new Transform({
          transform(chunk, enc, cb) {
            received += chunk.length;
            if (size && received > size + 1024 * 1024) {
              cb(new Error('下载体积超过预期'));
              return;
            }
            if (onChunk) onChunk(chunk.length, total || size || 0);
            cb(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
        if (size && received !== size) {
          throw new Error(`文件大小不符: ${received} != ${size}`);
        }
        if (sha1 && !(await verifyFile(tmp, sha1, 'sha1'))) {
          throw new Error('SHA-1 校验失败');
        }
        if (expectedSha256 && !(await verifyFile(tmp, expectedSha256, 'sha256'))) {
          throw new Error('SHA-256 校验失败');
        }
        await fsp.rm(dest, { force: true }).catch(() => {});
        await fsp.rename(tmp, dest);
        return { skipped: false, bytes: received };
      } catch (err) {
        lastError = err;
        await fsp.rm(tmp, { force: true }).catch(() => {});
        if (err && err.cancelled) throw err;
        if (abort && abort.cancelled) throw new Error('操作已取消');
      }
    }
    if (attempt < retries - 1) await sleep(500 * (attempt + 2));
  }
  throw new Error(`下载失败: ${shortUrl(input)} - ${lastError ? lastError.message : 'unknown'}`);
}

/**
 * 批量下载，带全局进度。
 * items: [{url, dest, sha1, size, label}]
 */
async function downloadMany(items, options = {}) {
  const {
    concurrency = 8,
    mirror,
    abort,
    onProgress,
    retries = 3,
    verifyExisting = true,
    trustSize = false,
    continueOnError = false,
  } = options;

  const totalBytes = items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  const totalFiles = items.length;
  let doneBytes = 0;
  let doneFiles = 0;
  let skippedFiles = 0;
  let lastReport = 0;
  const errors = [];

  const report = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < 150) return;
    lastReport = now;
    onProgress({
      filesDone: doneFiles,
      filesTotal: totalFiles,
      skippedFiles,
      bytesDone: doneBytes,
      bytesTotal: totalBytes,
    });
  };
  report(true);

  const queue = items.map((item, index) => ({ ...item, index }));
  await mapLimit(queue, Math.max(1, concurrency), async (item) => {
    if (abort) abort.throwIfCancelled();
    try {
      const result = await downloadFile(item.url, item.dest, {
        sha1: item.sha1,
        size: item.size,
        mirror,
        abort,
        retries,
        onChunk: (n) => {
          doneBytes += n;
          report();
        },
        force: !verifyExisting,
        trustSize,
      });
      if (result.skipped) skippedFiles += 1;
    } catch (err) {
      if (!continueOnError) throw err;
      errors.push({ item, error: err && err.message ? err.message : String(err) });
    }
    if (abort) abort.throwIfCancelled();
    doneFiles += 1;
    report();
  });
  report(true);
  return { files: totalFiles, bytes: doneBytes, errors };
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').pop() || '/';
    return `${u.hostname}/${file.length > 48 ? `${file.slice(0, 45)}...` : file}`;
  } catch {
    return String(url).slice(0, 60);
  }
}

module.exports = {
  USER_AGENT,
  mirrorUrl,
  getJson,
  downloadFile,
  downloadMany,
  fetchWithTimeout,
  Abort,
};
