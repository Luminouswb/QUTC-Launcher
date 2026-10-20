'use strict';

/**
 * QUTC Launcher - Java 运行时管理
 *
 * 优先使用本机已安装的 Java；找不到时下载 Mojang 官方 Java 运行时
 * （launchermeta.mojang.com，逐文件 SHA-1 校验），避免第三方安装包。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const Paths = require('./paths');
const { getJson, downloadFile, downloadMany } = require('./http');
const { readJson, writeJsonAtomic, ensureDirAsync, exists, createFileProgress } = require('./util');

const execFileAsync = promisify(execFile);

const RUNTIME_MANIFEST =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

const COMPONENT_MAJOR = {
  'jre-legacy': 8,
  'java-runtime-alpha': 16,
  'java-runtime-beta': 17,
  'java-runtime-gamma': 17,
  'java-runtime-delta': 21,
  'java-runtime-epsilon': 21,
  'java-runtime-zeta': 21,
};

let detectCache = null;
let detectCacheAt = 0;

function platformKey() {
  if (process.platform !== 'win32') return null;
  if (process.arch === 'arm64') return 'windows-arm64';
  if (process.arch === 'ia32') return 'windows-x86';
  return 'windows-x64';
}

async function parseJavaVersion(javaPath) {
  try {
    const { stderr, stdout } = await execFileAsync(javaPath, ['-version'], {
      timeout: 8000,
      windowsHide: true,
      windowsVerbatimArguments: false,
    });
    const text = `${stderr || ''}\n${stdout || ''}`;
    const match = text.match(/version "([^"]+)"/);
    if (!match) return null;
    const raw = match[1];
    let major;
    if (raw.startsWith('1.')) major = Number(raw.split('.')[1]);
    else major = Number(raw.split('.')[0]);
    if (!Number.isFinite(major)) return null;
    return {
      path: javaPath,
      version: raw,
      major,
      arch: /64-Bit|amd64|x86_64/i.test(text) ? 'x64' : process.arch === 'ia32' ? 'x86' : 'x64',
      vendor: /OpenJDK/i.test(text) ? 'OpenJDK' : /Java\(TM\)/i.test(text) ? 'Oracle Java' : 'Java',
    };
  } catch {
    return null;
  }
}

function collectCandidates() {
  const candidates = new Set();
  const add = (p) => {
    if (!p) return;
    const normalized = path.resolve(String(p).replace(/^"|"$/g, ''));
    if (exists(normalized)) candidates.add(normalized);
  };

  // 1. 用户显式配置
  try {
    const config = require('./config').get();
    if (config.javaPath) add(config.javaPath);
  } catch {
    /* ignore */
  }

  // 2. JAVA_HOME
  if (process.env.JAVA_HOME) {
    add(path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  }

  // 3. PATH
  const pathExt = process.platform === 'win32' ? '.exe' : '';
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    add(path.join(dir, `java${pathExt}`));
  }

  // 4. Mojang 官方运行时目录
  try {
    const javaRoot = Paths.getPaths().java;
    if (fs.existsSync(javaRoot)) {
      for (const entry of fs.readdirSync(javaRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        add(path.join(javaRoot, entry.name, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
      }
    }
  } catch {
    /* ignore */
  }

  // 5. Windows 常见 JDK 安装目录
  if (process.platform === 'win32') {
    const roots = [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\BellSoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\Semeru',
      'C:\\Program Files\\GraalVM',
      'C:\\Program Files (x86)\\Java',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium'),
    ];
    for (const root of roots) {
      try {
        if (!root || !fs.existsSync(root)) continue;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          add(path.join(root, entry.name, 'bin', 'java.exe'));
        }
      } catch {
        /* ignore */
      }
    }
  }

  return [...candidates];
}

async function detectJava({ force = false } = {}) {
  if (!force && detectCache && Date.now() - detectCacheAt < 5000) return detectCache;
  const candidates = collectCandidates();
  const results = [];
  for (const candidate of candidates) {
    const info = await parseJavaVersion(candidate);
    if (info) results.push(info);
  }
  // 去重（同一路径）
  const unique = [];
  const seen = new Set();
  for (const info of results) {
    const key = path.resolve(info.path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(info);
  }
  unique.sort((a, b) => a.major - b.major || a.path.localeCompare(b.path));
  detectCache = unique;
  detectCacheAt = Date.now();
  return unique;
}

/** 根据需求选择最合适的 Java；返回 null 表示没有可用版本 */
function chooseJava(list, requiredMajor) {
  const needed = Number(requiredMajor) || 8;
  const valid = list.filter((j) => exists(j.path));
  if (!valid.length) return null;
  if (needed <= 8) {
    return valid.find((j) => j.major === 8) || null;
  }
  if (needed <= 15) {
    return valid.find((j) => j.major === needed) || valid.find((j) => j.major >= needed && j.major < 17) || null;
  }
  // 现代版本：优先精确匹配，其次更高的 LTS
  return (
    valid.find((j) => j.major === needed) ||
    valid.find((j) => j.major > needed && j.major <= needed + 8) ||
    valid.find((j) => j.major >= needed) ||
    null
  );
}

async function ensureJava({ requiredMajor, component, ctx = {} }) {
  const config = require('./config').get();
  const list = await detectJava();
  if (config.javaPath) {
    const explicit = await parseJavaVersion(config.javaPath);
    if (explicit) return { ...explicit, source: 'custom' };
    if (ctx.onLog) ctx.onLog(`[警告] 自定义 Java 不可用: ${config.javaPath}`);
  }
  const chosen = chooseJava(list, requiredMajor);
  if (chosen) return { ...chosen, source: 'system' };

  if (!config.autoDownloadJava) {
    throw new Error(`未找到 Java ${requiredMajor}，请在设置中指定 Java 路径`);
  }
  const installed = await installMojangJava(component || componentForMajor(requiredMajor), ctx);
  return installed;
}

function componentForMajor(major) {
  if (major <= 8) return 'jre-legacy';
  if (major === 16) return 'java-runtime-alpha';
  if (major === 17) return 'java-runtime-gamma';
  if (major >= 21) return 'java-runtime-delta';
  return 'java-runtime-gamma';
}

function runtimeDir(component) {
  return path.join(Paths.getPaths().java, component);
}

async function isRuntimeInstalled(component, versionName) {
  const dir = runtimeDir(component);
  const marker = await readJson(path.join(dir, '.qutc-runtime.json'), null);
  if (!marker) return false;
  if (versionName && marker.version !== versionName) return false;
  return exists(path.join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
}

/**
 * 下载 Mojang 官方 Java 运行时
 */
async function installMojangJava(component, ctx = {}) {
  if (process.platform !== 'win32') {
    throw new Error('自动下载 Java 仅支持 Windows，请手动安装 Java');
  }
  const key = platformKey();
  if (!key) throw new Error('当前平台不支持自动下载 Java');

  if (ctx.onPhase) ctx.onPhase('获取 Java 运行时清单');
  const all = await getJson(RUNTIME_MANIFEST, {
    mirror: ctx.mirror,
    abort: ctx.abort,
    retries: 3,
  });
  const bucket = all[key];
  if (!bucket) throw new Error('官方 Java 清单缺少当前平台');

  // 优先指定组件；不存在则按相近版本挑选
  let selectedComponent = component;
  let list = bucket[selectedComponent];
  if (!list || !list.length) {
    const fallbackOrder = [
      'java-runtime-gamma',
      'java-runtime-delta',
      'java-runtime-beta',
      'java-runtime-alpha',
      'jre-legacy',
    ];
    for (const name of fallbackOrder) {
      if (bucket[name] && bucket[name].length) {
        selectedComponent = name;
        list = bucket[name];
        break;
      }
    }
  }
  if (!list || !list.length) throw new Error('未找到匹配的官方 Java 运行时');

  // 同一组件可能有多个版本，选择 release 时间最新的
  const chosen = [...list].sort(
    (a, b) =>
      new Date(b.version && b.version.released ? b.version.released : 0) -
      new Date(a.version && a.version.released ? a.version.released : 0),
  )[0];
  const versionName = (chosen.version && chosen.version.name) || '';
  const dir = runtimeDir(selectedComponent);

  if (await isRuntimeInstalled(selectedComponent, versionName)) {
    const info = await parseJavaVersion(path.join(dir, 'bin', 'java.exe'));
    if (info) return { ...info, source: 'mojang' };
  }

  if (!chosen.manifest || !chosen.manifest.url) throw new Error('官方 Java 清单缺少下载地址');
  const manifestFile = path.join(Paths.getPaths().cache, `java-${selectedComponent}.json`);
  if (ctx.onPhase) ctx.onPhase(`下载 Java ${versionName || selectedComponent}`);
  const manifestProgress = createFileProgress(ctx.onProgress, 'java-manifest');
  await downloadFile(chosen.manifest.url, manifestFile, {
    sha1: chosen.manifest.sha1,
    size: chosen.manifest.size,
    mirror: ctx.mirror,
    abort: ctx.abort,
    retries: 3,
    onChunk: (n, total) => manifestProgress.add(n, total),
  });
  const manifest = await readJson(manifestFile, null);
  if (!manifest || !manifest.files) throw new Error('Java 运行时清单解析失败');

  const items = [];
  for (const [rel, info] of Object.entries(manifest.files)) {
    if (!info || info.type === 'directory' || info.type === 'link') continue;
    if (!info.downloads || !info.downloads.raw) continue;
    const dest = path.join(dir, ...rel.split('/'));
    items.push({
      url: info.downloads.raw.url,
      dest,
      sha1: info.downloads.raw.sha1,
      size: info.downloads.raw.size,
    });
  }
  if (ctx.onPhase) ctx.onPhase(`安装 Java (${items.length} 个文件)`);
  await downloadMany(items, {
    concurrency: ctx.concurrency || 8,
    mirror: ctx.mirror,
    abort: ctx.abort,
    retries: 3,
    onProgress: (p) => {
      if (ctx.onProgress) ctx.onProgress({ ...p, phase: 'java' });
    },
  });
  await ensureDirAsync(path.join(dir, 'bin'));
  await writeJsonAtomic(path.join(dir, '.qutc-runtime.json'), {
    component: selectedComponent,
    version: versionName,
    installedAt: Date.now(),
    files: items.length,
  });

  const info = await parseJavaVersion(path.join(dir, 'bin', 'java.exe'));
  if (!info) throw new Error('Java 安装完成但无法执行，请检查杀毒软件拦截');
  if (ctx.onLog) ctx.onLog(`[Java] 已安装 ${selectedComponent} ${info.version}`);
  return { ...info, source: 'mojang' };
}

module.exports = {
  RUNTIME_MANIFEST,
  detectJava,
  ensureJava,
  installMojangJava,
  parseJavaVersion,
  chooseJava,
  componentForMajor,
  platformKey,
};
