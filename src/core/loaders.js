'use strict';

/**
 * QUTC Launcher - 模组加载器安装（Fabric / Quilt / Forge / NeoForge）
 *
 * 安全说明：
 * - Fabric / Quilt 只使用官方 meta 返回的 JSON，直接写入 versions/，不执行任何程序；
 * - Forge / NeoForge 官方安装器是唯一被执行的第三方文件，必须：
 *     1. 用户在界面上显式同意；
 *     2. 从官方 Maven（或明确列出的镜像）下载；
 *     3. 能拿到官方 SHA-1 时必须校验通过。
 * - 安装器以 --installClient 方式运行在当前启动器的数据目录内，
 *   所有写入都限制在 QUTCData 下。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Paths = require('./paths');
const { getJson, downloadFile, fetchWithTimeout } = require('./http');
const { assertSafeRemoteUrl } = require('./security');
const { saveVersionJson, getJavaMajor, getVanillaJson, installVersion } = require('./versions');const { ensureJava } = require('./java');
const {
  exists,
  readJson,
  writeJsonAtomic,
  nowIso,
  CancelledError,
  createFileProgress,
} = require('./util');
const { hashFile } = require('./hash');

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const BMCLAPI = 'https://bmclapi2.bangbang93.com';
const NEOFORGE_QLU = 'https://mirrors.qlu.edu.cn/bmclapi/net/neoforged/neoforge';
const NEOFORGE_OFFICIAL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const NEOFORGE_MIRROR_ARG = 'https://mirrors.qlu.edu.cn/bmclapi';

const INSTALLER_TIMEOUT_MS = 30 * 60 * 1000;
const SAFE_VERSION_ID = /^[A-Za-z0-9._-]{1,90}$/;

function assertVersionId(id) {
  const text = String(id || '');
  if (!SAFE_VERSION_ID.test(text)) throw new Error(`版本 ID 非法: ${text.slice(0, 80)}`);
  return text;
}

function normalizeMcVersion(mcVersion) {
  const value = String(mcVersion || '').trim();
  if (!/^\d{1,2}\.\d{1,2}(\.\d{1,2})?([-_a-zA-Z0-9.]*)$/.test(value)) {
    throw new Error(`Minecraft 版本号非法: ${value.slice(0, 40)}`);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Fabric / Quilt                                                      */
/* ------------------------------------------------------------------ */

async function fetchFabricLoaderVersions(mcVersion, ctx = {}) {
  const mc = normalizeMcVersion(mcVersion);
  const data = await getJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}`, {
    mirror: ctx.mirror,
    abort: ctx.abort,
    retries: 3,
  });
  if (!Array.isArray(data)) throw new Error('Fabric 加载器列表格式异常');
  return data
    .filter((item) => item && item.loader && item.loader.version)
    .map((item) => ({
      version: String(item.loader.version),
      stable: Boolean(item.loader.stable),
    }))
    .sort((a, b) => Number(b.stable) - Number(a.stable) || compareVersions(b.version, a.version));
}

async function fetchQuiltLoaderVersions(mcVersion, ctx = {}) {
  const mc = normalizeMcVersion(mcVersion);
  const data = await getJson(`${QUILT_META}/versions/loader/${encodeURIComponent(mc)}`, {
    mirror: ctx.mirror,
    abort: ctx.abort,
    retries: 3,
  });
  if (!Array.isArray(data)) throw new Error('Quilt 加载器列表格式异常');
  return data
    .filter((item) => item && item.loader && item.loader.version)
    .map((item) => ({
      version: String(item.loader.version),
      stable: Boolean(item.loader.stable),
    }))
    .sort((a, b) => Number(b.stable) - Number(a.stable) || compareVersions(b.version, a.version));
}

async function installFabric(mcVersion, loaderVersion, ctx = {}) {
  const mc = normalizeMcVersion(mcVersion);
  const list = await fetchFabricLoaderVersions(mc, ctx);
  if (!list.length) throw new Error(`Fabric 暂不支持 Minecraft ${mc}`);
  const version = loaderVersion ? String(loaderVersion) : (list.find((v) => v.stable) || list[0]).version;
  if (!list.some((v) => v.version === version)) {
    throw new Error(`Fabric 加载器版本不存在: ${version}`);
  }
  if (ctx.onPhase) ctx.onPhase(`获取 Fabric ${version} 配置`);
  const profile = await getJson(
    `${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(version)}/profile/json`,
    { mirror: ctx.mirror, abort: ctx.abort, retries: 3 },
  );
  return saveLoaderProfile(profile, { mc, version, type: 'fabric', ctx });
}

async function installQuilt(mcVersion, loaderVersion, ctx = {}) {
  const mc = normalizeMcVersion(mcVersion);
  const list = await fetchQuiltLoaderVersions(mc, ctx);
  if (!list.length) throw new Error(`Quilt 暂不支持 Minecraft ${mc}`);
  const version = loaderVersion ? String(loaderVersion) : (list.find((v) => v.stable) || list[0]).version;
  if (!list.some((v) => v.version === version)) {
    throw new Error(`Quilt 加载器版本不存在: ${version}`);
  }
  if (ctx.onPhase) ctx.onPhase(`获取 Quilt ${version} 配置`);
  const profile = await getJson(
    `${QUILT_META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(version)}/profile/json`,
    { mirror: ctx.mirror, abort: ctx.abort, retries: 3 },
  );
  return saveLoaderProfile(profile, { mc, version, type: 'quilt', ctx });
}

async function saveLoaderProfile(profile, { mc, version, type, ctx }) {
  if (!profile || typeof profile !== 'object') throw new Error('加载器配置为空');
  const id = assertVersionId(profile.id || `${type}-loader-${version}-${mc}`);
  if (profile.inheritsFrom !== mc) {
    throw new Error(`加载器配置的父版本异常: ${String(profile.inheritsFrom).slice(0, 40)}`);
  }
  if (!profile.mainClass || typeof profile.mainClass !== 'string') {
    throw new Error('加载器配置缺少主类');
  }
  if (!Array.isArray(profile.libraries)) throw new Error('加载器配置缺少依赖库');
  // 只接受 Maven 坐标 + 官方地址的库，避免加载器元数据被篡改后拉取任意主机
  for (const lib of profile.libraries) {
    if (!lib || typeof lib.name !== 'string' || !lib.name.includes(':')) {
      throw new Error('加载器依赖格式异常');
    }
    if (lib.url !== undefined) assertSafeRemoteUrl(lib.url);
  }
  if (profile.arguments && Array.isArray(profile.arguments.jvm)) {
    for (const arg of profile.arguments.jvm) {
      if (typeof arg === 'string' && arg.includes('${') && !/^\-(D|X|java)/.test(arg)) {
        // Fabric 的 -DFabricMcEmu=... 是正常的；这里只做长度限制
        if (arg.length > 4000) throw new Error('加载器 JVM 参数异常');
      }
    }
  }
  await saveVersionJson(id, profile);
  if (ctx.onLog) ctx.onLog(`[加载器] ${type} ${version} 已写入版本 ${id}`);
  return { versionId: id, mcVersion: mc, loader: { type, version }, profile };
}

/* ------------------------------------------------------------------ */
/* Forge                                                               */
/* ------------------------------------------------------------------ */

/** 从 BMCLAPI / 官方 promotions 获取 Forge 构建列表 */
async function fetchForgeVersions(mcVersion, ctx = {}) {
  const mc = normalizeMcVersion(mcVersion);
  const seen = new Map();
  try {
    const data = await getJson(`${BMCLAPI}/forge/minecraft/${encodeURIComponent(mc)}`, {
      abort: ctx.abort,
      retries: 2,
      timeout: 20000,
    });
    if (Array.isArray(data)) {
      for (const item of data) {
        if (!item || !item.version) continue;
        const version = String(item.version);
        const installer = Array.isArray(item.files)
          ? item.files.find((f) => f && f.category === 'installer' && f.format === 'jar')
          : null;
        seen.set(version, {
          version,
          sha1: installer && /^[0-9a-f]{40}$/i.test(installer.hash || '') ? installer.hash.toLowerCase() : '',
          build: Number(item.build) || 0,
          recommended: false,
          latest: false,
        });
      }
    }
  } catch (err) {
    if (ctx.onLog) ctx.onLog(`[Forge] 构建列表获取失败: ${err.message}`);
  }
  // 官方推荐/最新版本（即使 BMCLAPI 不可用也能提供至少两个版本）
  try {
    const promos = await getJson(FORGE_PROMOTIONS, { abort: ctx.abort, retries: 2, timeout: 20000 });
    const map = (promos && promos.promos) || {};
    for (const kind of ['latest', 'recommended']) {
      const value = map[`${mc}-${kind}`];
      if (!value) continue;
      const version = String(value);
      const current = seen.get(version) || { version, sha1: '', build: 0, recommended: false, latest: false };
      current[kind] = true;
      seen.set(version, current);
    }
  } catch {
    /* 官方 promotions 不可用不影响主流程 */
  }
  return [...seen.values()]
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((v) => ({
      ...v,
      latest: v.latest || false,
      recommended: v.recommended || false,
    }));
}

function forgeInstallerUrl(mc, version) {
  const rel = `${mc}-${version}`;
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${rel}/forge-${rel}-installer.jar`;
}

async function installForge(mcVersion, forgeVersion, ctx = {}) {
  const mc = normalizeMcVersion(mcVersion);
  const version = String(forgeVersion || '').trim();
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,4}(\.\d{1,4})?$/.test(version)) {
    throw new Error(`Forge 版本号非法: ${version.slice(0, 40)}`);
  }
  requireInstallerConsent('Forge', ctx);
  if (ctx.onPhase) ctx.onPhase('检查 Java 运行时');
  const vanilla = await getVanillaJson(mc, { mirror: ctx.mirror, abort: ctx.abort, onPhase: ctx.onPhase });
  const javaMajor = getJavaMajor(vanilla);
  const javaInfo = await ensureJava({ requiredMajor: javaMajor, ctx });
  await ensureVanillaForInstaller(mc, ctx);
  if (ctx.onLog) ctx.onLog(`[Forge] 使用 Java: ${javaInfo.path} (${javaInfo.version})`);

  const url = forgeInstallerUrl(mc, version);
  const installer = path.join(Paths.getPaths().cache, 'downloads', `forge-${mc}-${version}-installer.jar`);
  await downloadInstaller(url, installer, { ...ctx, label: `Forge ${mc}-${version}` });
  return runInstaller({
    installer,
    mc,
    version,
    expectedId: `${mc}-forge-${version}`,
    type: 'forge',
    javaPath: javaInfo.path,
    ctx,
  });
}

/* ------------------------------------------------------------------ */
/* NeoForge                                                            */
/* ------------------------------------------------------------------ */

/** NeoForge 版本号与 Minecraft 版本的对应关系（20.2+） */
function neoForgePrefix(mcVersion) {
  const match = /^1\.(\d{1,2})(?:\.(\d{1,2}))?$/.exec(String(mcVersion));
  if (!match) return '';
  const minor = Number(match[1]);
  const patch = Number(match[2] || 0);
  if (minor < 20 || (minor === 20 && patch < 2)) return '';
  if (minor === 20) return `20.${patch}.`;
  return `${minor}.${patch}.`;
}

async function fetchNeoForgeVersions(mcVersion, ctx = {}) {
  const mc = normalizeMcVersion(mcVersion);
  const prefix = neoForgePrefix(mc);
  if (!prefix) return [];
  const text = await fetchText(`${NEOFORGE_QLU}/maven-metadata.xml`, {
    abort: ctx.abort,
    timeout: 30000,
  });
  const versions = [];
  const re = /<version>([^<]+)<\/version>/g;
  let match;
  while ((match = re.exec(text))) {
    const value = String(match[1]).trim();
    if (value.startsWith(prefix) && /^\d+\.\d+\.\d+/.test(value)) versions.push(value);
  }
  return [...new Set(versions)].sort((a, b) => compareVersions(b, a));
}

async function installNeoForge(mcVersion, neoVersion, ctx = {}) {
  const mc = normalizeMcVersion(mcVersion);
  const version = String(neoVersion || '').trim();
  if (!/^\d{2,3}\.\d{1,3}\.\d{1,3}(-[A-Za-z0-9.]+)?$/.test(version)) {
    throw new Error(`NeoForge 版本号非法: ${version.slice(0, 40)}`);
  }
  requireInstallerConsent('NeoForge', ctx);
  if (ctx.onPhase) ctx.onPhase('检查 Java 运行时');
  const vanilla = await getVanillaJson(mc, { mirror: ctx.mirror, abort: ctx.abort, onPhase: ctx.onPhase });
  const javaMajor = getJavaMajor(vanilla);
  const javaInfo = await ensureJava({ requiredMajor: javaMajor, ctx });
  await ensureVanillaForInstaller(mc, ctx);

  const rel = `net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
  const candidates = [`${NEOFORGE_QLU}/${rel}`, `${NEOFORGE_OFFICIAL}/${rel}`];
  let installer = path.join(Paths.getPaths().cache, 'downloads', `neoforge-${version}-installer.jar`);
  let got = false;
  let lastError;
  for (const url of candidates) {
    try {
      await downloadInstaller(url, installer, { ...ctx, label: `NeoForge ${version}`, optionalHash: true });
      got = true;
      break;
    } catch (err) {
      lastError = err;
      if (ctx.onLog) ctx.onLog(`[NeoForge] 下载失败: ${err.message}`);
    }
  }
  if (!got) throw new Error(`NeoForge 安装器下载失败: ${lastError ? lastError.message : '未知错误'}`);
  const sha1 = await hashFile(installer, 'sha1').catch(() => '');
  if (ctx.onLog && sha1) ctx.onLog(`[NeoForge] 安装器 SHA-1: ${sha1}`);

  return runInstaller({
    installer,
    mc,
    version,
    expectedId: `${mc}-neoforge-${version}`,
    type: 'neoforge',
    javaPath: javaInfo.path,
    ctx,
    installerArgs: ['--mirror', NEOFORGE_MIRROR_ARG],
  });
}

/* ------------------------------------------------------------------ */
/* 安装器公共逻辑                                                      */
/* ------------------------------------------------------------------ */

function requireInstallerConsent(name, ctx) {  if (ctx.consent !== true) {
    const err = new Error(
      `${name} 安装需要运行官方安装器（会下载并执行来自官方 Maven 的 jar）。\n` +
        '请在安装确认窗口中阅读说明并勾选同意后再继续。',
    );
    err.code = 'CONSENT_REQUIRED';
    throw err;
  }
}

async function fetchText(url, { abort, timeout = 20000 } = {}) {
  const safe = assertSafeRemoteUrl(url);
  const res = await fetchWithTimeout(safe, { headers: { accept: 'text/plain' } }, timeout, abort);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  return text.slice(0, 4096);
}

/** 下载官方安装器，并尽可能校验 SHA-1 */
async function downloadInstaller(url, dest, ctx = {}) {
  if (ctx.abort) ctx.abort.throwIfCancelled();
  let sha1 = '';
  try {
    const text = await fetchText(`${url}.sha1`, { abort: ctx.abort, timeout: 15000 });
    const match = /[0-9a-f]{40}/i.exec(text);
    if (match) sha1 = match[0].toLowerCase();
  } catch (err) {
    if (!ctx.optionalHash) {
      if (ctx.onLog) ctx.onLog(`[警告] 无法获取 ${ctx.label || '安装器'} 的官方 SHA-1: ${err.message}`);
    }
  }
  const expected = ctx.expectedSha1 || sha1;
  if (ctx.onPhase) ctx.onPhase(`下载 ${ctx.label || '安装器'}`);
  const installerProgress = createFileProgress(ctx.onProgress, 'installer');
  await downloadFile(url, dest, {
    sha1: expected || undefined,
    mirror: ctx.mirror,
    abort: ctx.abort,
    retries: 3,
    timeout: 600000,
    onChunk: (n, total) => installerProgress.add(n, total),
  });
  if (!expected) {
    if (ctx.onLog) ctx.onLog('[警告] 未获取到官方 SHA-1，安装器仅通过 HTTPS 传输，请确认来源可信。');
  }
  return { sha1: expected };
}

async function ensureLauncherProfiles() {
  const file = path.join(Paths.getPaths().root, 'launcher_profiles.json');
  if (!exists(file)) {
    await writeJsonAtomic(file, { profiles: {}, settings: {}, version: 3 });
  }
}

async function ensureVanillaForInstaller(mc, ctx) {
  const p = Paths.getPaths();
  if (exists(p.versionJson(mc)) && exists(p.versionJar(mc))) return;
  if (ctx.onPhase) ctx.onPhase(`安装原版 Minecraft ${mc}`);
  if (ctx.onLog) ctx.onLog(`[加载器] 先安装原版 ${mc}，安装器需要原版文件`);
  await installVersion(mc, {
    mirror: ctx.mirror,
    concurrency: ctx.concurrency,
    abort: ctx.abort,
    onPhase: ctx.onPhase,
    onLog: ctx.onLog,
    onProgress: ctx.onProgress,
  });
}

/**
 * 运行 Forge / NeoForge 官方安装器。
 * 安装器会把 libraries/ 与 versions/ 写入当前数据目录。
 */
async function runInstaller({ installer, mc, version, expectedId, type, javaPath, ctx, installerArgs = [] }) {
  await ensureLauncherProfiles();
  const root = Paths.getPaths().root;
  const args = ['-jar', installer, '--installClient', root, ...installerArgs];
  if (ctx.onPhase) ctx.onPhase(`运行 ${type === 'forge' ? 'Forge' : 'NeoForge'} 安装器`);
  if (ctx.onLog) ctx.onLog(`[安装器] ${path.basename(javaPath)} ${args.join(' ')}`);

  const code = await runProcess(javaPath, args, {
    cwd: root,
    abort: ctx.abort,
    timeoutMs: INSTALLER_TIMEOUT_MS,
    onLine: (line) => {
      if (ctx.onLog) ctx.onLog(line);
    },
  });
  if (code !== 0) throw new Error(`官方安装器退出码 ${code}，请查看日志`);

  // 优先使用规范的版本 id；若安装器写入的名字不同则扫描目录
  let id = assertVersionId(expectedId);
  if (!exists(Paths.getPaths().versionJson(id))) {
    const found = await findInstalledLoaderVersion(mc, version, type);
    if (!found) throw new Error('安装器执行完成，但未找到生成的版本 JSON');
    id = found;
  }
  const json = await readJson(Paths.getPaths().versionJson(id), null);
  if (!json) throw new Error('安装器生成的版本 JSON 无法解析');

  // 由启动器再走一遍安装流程，确保客户端 jar / 资源完整
  await installVersion(id, {
    nativesDir: ctx.nativesDir,
    mirror: ctx.mirror,
    concurrency: ctx.concurrency,
    abort: ctx.abort,
    onPhase: ctx.onPhase,
    onLog: ctx.onLog,
    onProgress: ctx.onProgress,
  });
  if (ctx.onLog) ctx.onLog(`[加载器] ${type} ${version} 安装完成: ${id}`);
  return { versionId: id, mcVersion: mc, loader: { type, version }, installedAt: nowIso() };
}

async function findInstalledLoaderVersion(mc, version, type) {
  const dir = Paths.getPaths().versions;
  const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const candidates = items
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .filter((name) => name.includes(type) && name.includes(version) && name.includes(mc))
    .filter((name) => SAFE_VERSION_ID.test(name));
  return candidates.find((name) => exists(Paths.getPaths().versionJson(name))) || '';
}

/** 运行子进程并逐行收集输出；支持取消与超时 */
function runProcess(exe, args, { cwd, abort, timeoutMs, onLine }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let buffer = '';
    let child;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (abort) abort.listeners.delete(onAbort);
      fn(value);
    };
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(reject, new CancelledError('安装已取消'));
    };
    if (abort) {
      if (abort.cancelled) return finish(reject, new CancelledError('安装已取消'));
      abort.onCancel(onAbort);
    }
    try {
      const env = { ...process.env };
      delete env.JAVA_TOOL_OPTIONS;
      delete env._JAVA_OPTIONS;
      delete env.JAVA_OPTIONS;
      child = spawn(exe, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      return finish(reject, err);
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(reject, new Error('安装器运行超时'));
    }, timeoutMs);

    const push = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 4 * 1024 * 1024) buffer = buffer.slice(-1024 * 1024);
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line && onLine) onLine(line);
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => {
      if (buffer && onLine) onLine(buffer);
      finish(resolve, code === null ? -1 : code);
    });
  });
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
  const pb = String(b).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 统一入口
 * @param {'vanilla'|'fabric'|'quilt'|'forge'|'neoforge'} loader
 */
async function installLoader({ loader, mcVersion, loaderVersion, ctx = {} }) {
  let result;
  switch (loader) {
    case 'fabric':
      result = await installFabric(mcVersion, loaderVersion, ctx);
      break;
    case 'quilt':
      result = await installQuilt(mcVersion, loaderVersion, ctx);
      break;
    case 'forge':
      return installForge(mcVersion, loaderVersion, ctx);
    case 'neoforge':
      return installNeoForge(mcVersion, loaderVersion, ctx);
    default:
      throw new Error(`未知加载器: ${loader}`);
  }
  // Fabric/Quilt 只写入了 profile JSON，这里补齐客户端、依赖和资源
  await installVersion(result.versionId, {
    nativesDir: ctx.nativesDir,
    mirror: ctx.mirror,
    concurrency: ctx.concurrency,
    abort: ctx.abort,
    onPhase: ctx.onPhase,
    onLog: ctx.onLog,
    onProgress: ctx.onProgress,
  });
  return result;
}

async function listLoaderVersions(loader, mcVersion, ctx = {}) {
  switch (loader) {
    case 'fabric':
      return fetchFabricLoaderVersions(mcVersion, ctx);
    case 'quilt':
      return fetchQuiltLoaderVersions(mcVersion, ctx);
    case 'forge':
      return fetchForgeVersions(mcVersion, ctx);
    case 'neoforge':
      return fetchNeoForgeVersions(mcVersion, ctx);
    default:
      return [];
  }
}

/** 清理安装器临时文件（可选，保留缓存便于复用） */
async function cleanupInstallerCache(olderThanMs = 30 * 24 * 3600 * 1000) {
  const dir = path.join(Paths.getPaths().cache, 'downloads');
  const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  for (const item of items) {
    if (!item.isFile() || !/-installer\.jar$/i.test(item.name)) continue;
    const file = path.join(dir, item.name);
    const stat = await fsp.stat(file).catch(() => null);
    if (stat && now - stat.mtimeMs > olderThanMs) await fsp.rm(file, { force: true }).catch(() => {});
  }
}

module.exports = {
  fetchFabricLoaderVersions,
  fetchQuiltLoaderVersions,
  fetchForgeVersions,
  fetchNeoForgeVersions,
  installFabric,
  installQuilt,
  installForge,
  installNeoForge,
  installLoader,
  listLoaderVersions,
  neoForgePrefix,
  compareVersions,
  runProcess,
  downloadInstaller,
  cleanupInstallerCache,
};
