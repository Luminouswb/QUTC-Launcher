'use strict';

/**
 * QUTC Launcher - 通用工具函数
 * 纯 Node.js，无任何第三方依赖。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function ensureDirAsync(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写入 JSON，避免断电/崩溃导致配置损坏 */
async function writeJsonAtomic(file, data) {
  await ensureDirAsync(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function writeTextAtomic(file, text) {
  await ensureDirAsync(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function nowIso() {
  return new Date().toISOString();
}

/** 生成实例 id / 文件名安全 slug（保留中文） */
function sanitizeName(name, fallback = 'instance') {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 48);
  return cleaned || fallback;
}

function randomId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

function uniqueName(base, taken) {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${base} (${i})`;
    if (!set.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

/** 将 Windows 路径统一成可比较形式 */
function normalizePath(p) {
  return path.resolve(p).toLowerCase();
}

/** 判断 child 是否位于 parent 之内（用于导入/解压安全） */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 安全的相对路径校验：拒绝绝对路径、盘符、..、控制字符 */
function assertSafeRelative(rel, label = 'path') {
  const text = String(rel || '');
  if (!text || text.length > 512) throw new Error(`${label} 非法: 长度异常`);
  if (/[\u0000-\u001f]/.test(text)) throw new Error(`${label} 含控制字符`);
  const unified = text.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
    throw new Error(`${label} 不允许绝对路径: ${text}`);
  }
  const parts = unified.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) {
    throw new Error(`${label} 含非法片段: ${text}`);
  }
  return unified;
}

function safeJoin(root, rel) {
  const clean = assertSafeRelative(rel, '路径');
  const target = path.resolve(root, clean);
  if (!isInside(root, target)) throw new Error(`路径越界: ${rel}`);
  return target;
}

/** 拆分含空格的命令行（支持双引号），用于旧版 minecraftArguments */
function splitArgs(text) {
  const out = [];
  let current = '';
  let quote = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      quote = !quote;
    } else if (/\s/.test(ch) && !quote) {
      if (current) {
        out.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

/** 替换字符串里的 ${var} 占位符；未定义的变量替换为空字符串 */
function replaceVars(text, vars) {
  return String(text).replace(/\$\{([^}]+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const value = vars[key];
      return value === undefined || value === null ? '' : String(value);
    }
    return '';
  });
}

/** 异步并发池，保持结果顺序 */
async function mapLimit(items, limit, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let next = 0;
  const runners = new Array(Math.max(1, Math.min(limit, list.length))).fill(null).map(async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 创建带节流的进度上报器 */
function createProgress(onProgress, intervalMs = 120) {
  let last = 0;
  let pending = null;
  let timer = null;
  const flush = () => {
    timer = null;
    if (!pending || !onProgress) return;
    last = Date.now();
    const payload = pending;
    pending = null;
    try {
      onProgress(payload);
    } catch {
      /* 进度回调异常不影响主流程 */
    }
  };
  return {
    report(payload, force = false) {
      if (!onProgress) return;
      pending = payload;
      if (force || Date.now() - last >= intervalMs) flush();
      else if (!timer) timer = setTimeout(flush, intervalMs);
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

/** 单文件下载进度：累加分片字节并节流上报 */
function createFileProgress(onProgress, phase, intervalMs = 150) {
  let done = 0;
  let last = 0;
  let total = 0;
  return {
    add(chunkBytes, knownTotal) {
      done += Number(chunkBytes) || 0;
      if (knownTotal) total = Number(knownTotal) || total;
      const now = Date.now();
      if (!onProgress) return;
      if (now - last < intervalMs && !(total && done >= total)) return;
      last = now;
      try {
        onProgress({ phase, bytesDone: done, bytesTotal: total, filesDone: 0, filesTotal: 1 });
      } catch {
        /* 进度回调异常不影响下载 */
      }
    },
    get done() {
      return done;
    },
  };
}

class CancelledError extends Error {
  constructor(message = '操作已取消') {
    super(message);
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

class Abort {
  constructor() {
    this.cancelled = false;
    this.listeners = new Set();
  }
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this.listeners.clear();
  }
  throwIfCancelled() {
    if (this.cancelled) throw new CancelledError();
  }
  onCancel(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

module.exports = {
  ensureDir,
  ensureDirAsync,
  exists,
  pathExists,
  readJsonSafe,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
  sleep,
  formatBytes,
  nowIso,
  sanitizeName,
  randomId,
  uniqueName,
  normalizePath,
  isInside,
  assertSafeRelative,
  safeJoin,
  splitArgs,
  replaceVars,
  mapLimit,
  createProgress,
  createFileProgress,
  CancelledError,
  Abort,
};
