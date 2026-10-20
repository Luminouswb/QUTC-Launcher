'use strict';

/**
 * QUTC Launcher - 哈希工具
 * 所有下载内容必须通过 SHA-1 / SHA-256 / SHA-512 校验后才能被使用。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

/** 标准 CRC32 表 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer, previous = 0) {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hashBuffer(buffer, algo = 'sha1') {
  return crypto.createHash(algo).update(buffer).digest('hex');
}

function hashFile(file, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyFile(file, expected, algo = 'sha1') {
  if (!expected) return true;
  try {
    const actual = await hashFile(file, algo);
    return actual.toLowerCase() === String(expected).toLowerCase();
  } catch {
    return false;
  }
}

/** 模拟 Java UUID.nameUUIDFromBytes("OfflinePlayer:" + name) */
function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 去掉 UUID 中的连字符 */
function uuidCompact(uuid) {
  return String(uuid || '').replace(/-/g, '').toLowerCase();
}

/** 补上 UUID 连字符 */
function uuidDashed(uuid) {
  const compact = uuidCompact(uuid);
  if (!/^[0-9a-f]{32}$/.test(compact)) return String(uuid || '');
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function validUuid(uuid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(uuid || ''),
  );
}

module.exports = {
  crc32,
  hashBuffer,
  hashFile,
  verifyFile,
  offlineUuid,
  uuidCompact,
  uuidDashed,
  validUuid,
};
