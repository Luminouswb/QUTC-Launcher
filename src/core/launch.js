'use strict';

/**
 * QUTC Launcher - 启动参数构建与游戏进程管理
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Paths = require('./paths');
const {
  resolveVersion,
  collectLibraries,
  getJavaMajor,
  extractNatives,
  ruleContext,
  isOptionalLibrary,
} = require('./versions');
const { isAllowed } = require('./rules');
const { ensureJava } = require('./java');
const { installAssets } = require('./assets');
const { ensureAuthlibInjector } = require('./authlib');
const { exists, splitArgs, replaceVars, ensureDirAsync, nowIso, readJson, writeJsonAtomic } = require('./util');
const { uuidDashed } = require('./hash');

function flattenArgumentList(list, features) {
  const ctx = ruleContext(features);
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (item && typeof item === 'object') {
      if (item.rules && !isAllowed(item.rules, ctx)) continue;
      if (typeof item.value === 'string') out.push(item.value);
      else if (Array.isArray(item.value)) out.push(...item.value.filter((v) => typeof v === 'string'));
    }
  }
  return out;
}

async function resolveAssetsDir(versionJson) {
  const p = Paths.getPaths();
  const meta = versionJson.assetIndex;
  if (!meta || !meta.id) return { dir: p.assets, id: 'legacy', virtual: false };
  const file = p.assetIndex(meta.id);
  if (!exists(file)) {
    const installed = await installAssets(versionJson, { mirror: require('./config').get().mirror });
    return { dir: installed.assetsDir, id: installed.assetIndexId, virtual: installed.virtual };
  }
  const json = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (json.virtual) {
    return {
      dir: path.join(p.assets, 'virtual', meta.id),
      id: meta.id,
      virtual: true,
    };
  }
  return { dir: p.assets, id: meta.id, virtual: false };
}

/**
 * 构建完整启动命令
 * @param {object} instance
 * @param {object} account
 * @param {{memoryMb?:number, javaPath?:string, customResolution?:object, jvmArgsExtra?:string,
 *          gameArgsExtra?:string, onPhase?:Function, onLog?:Function}} options
 */
async function buildLaunchCommand(instance, account, options = {}) {
  const config = require('./config').get();
  const resolved = await resolveVersion(instance.versionId);
  const versionJson = resolved.json;
  const javaMajor = getJavaMajor(versionJson) || 8;
  const component = (versionJson.javaVersion && versionJson.javaVersion.component) || undefined;

  if (options.onPhase) options.onPhase('检查 Java 运行时');
  const java = await ensureJava({
    requiredMajor: javaMajor,
    component,
    ctx: {
      onPhase: options.onPhase,
      onProgress: options.onProgress,
      onLog: options.onLog,
      mirror: config.mirror,
    },
  });

  if (options.onPhase) options.onPhase('检查游戏资源');
  const assets = await resolveAssetsDir(versionJson);
  const nativesDir = Paths.getPaths().instanceNatives(instance.id);
  await ensureDirAsync(nativesDir);

  const entries = collectLibraries(versionJson);
  const classpath = [];
  for (const entry of entries) {
    if (!entry.artifact || !entry.artifact.path) continue;
    const file = Paths.getPaths().libraryFile(entry.artifact.path);
    if (!exists(file)) {
      if (isOptionalLibrary(entry.artifact.path)) {
        if (options.onLog) options.onLog(`[警告] 跳过已下架的远古依赖: ${entry.artifact.path}`);
        continue;
      }
      throw new Error(`缺少依赖库 ${entry.artifact.path}，请重新安装该版本`);
    }
    if (!classpath.includes(file)) classpath.push(file);
  }
  const clientJar = Paths.getPaths().versionJar(resolved.clientOwner);
  const clientDownloads = versionJson.downloads && versionJson.downloads.client;
  if (clientDownloads) {
    if (!exists(clientJar)) throw new Error('缺少客户端 jar，请重新安装该版本');
    classpath.push(clientJar);
  }

  // natives 只需要在版本变化时解压一次
  const nativesMarker = path.join(nativesDir, '.qutc-natives.json');
  const marker = await readJson(nativesMarker, null);
  const markerKey = resolved.chain.join('|');
  if (!marker || marker.key !== markerKey) {
    if (options.onPhase) options.onPhase('解压本地库');
    const extracted = await extractNatives(entries, nativesDir, {
      abort: options.abort,
      onLog: options.onLog,
    });
    if (!extracted && entries.some((entry) => entry.native)) {
      throw new Error('没有可用的 natives 文件，请重新安装该版本');
    }
    await writeJsonAtomic(nativesMarker, { key: markerKey, versionId: instance.versionId, at: Date.now() });
  }

  const gameDir = instance.externalGameDir
    ? path.resolve(String(instance.externalGameDir))
    : Paths.getPaths().instanceGameDir(instance.id);
  await ensureDirAsync(gameDir);

  const custom = options.customResolution || config.customResolution || { enabled: false };
  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(custom.enabled),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };

  const uuid = uuidDashed(account.uuid);
  const accessToken = account.accessToken || '0';
  const vars = {
    auth_player_name: account.name || 'Player',
    auth_uuid: uuid,
    auth_access_token: accessToken,
    auth_session: `token:${accessToken}:${uuid}`,
    auth_xuid: account.xuid || '',
    clientid: config.installationId || '',
    user_type: account.type === 'microsoft' ? 'msa' : account.type === 'yggdrasil' ? 'mojang' : 'legacy',
    user_properties: '{}',
    version_name: instance.versionId,
    version_type: versionJson.type || 'release',
    game_directory: gameDir,
    assets_root: assets.dir,
    game_assets: assets.dir,
    assets_index_name: assets.id,
    natives_directory: nativesDir,
    launcher_name: 'QUTC-Launcher',
    launcher_version: Paths.getPaths().appVersion,
    classpath: classpath.join(path.delimiter),
    classpath_separator: path.delimiter,
    library_directory: Paths.getPaths().libraries,
    resolution_width: custom.enabled ? custom.width : 854,
    resolution_height: custom.enabled ? custom.height : 480,
    quickPlayPath: '',
    quickPlaySingleplayer: '',
    quickPlayMultiplayer: '',
    quickPlayRealms: '',
  };

  const memory = Number(options.memoryMb || instance.memoryMb || config.memoryMb || 4096);
  const minMemory = Math.min(1024, memory);
  const jvmArgs = [];

  jvmArgs.push(`-Xmx${memory}M`, `-Xms${minMemory}M`);
  jvmArgs.push('-Dfile.encoding=UTF-8');
  jvmArgs.push('-Dminecraft.launcher.brand=QUTC-Launcher');
  jvmArgs.push(`-Dminecraft.launcher.version=${Paths.getPaths().appVersion}`);
  jvmArgs.push('-Dlog4j2.formatMsgNoLookups=true');

  if (account.type === 'yggdrasil') {
    const authServer = account.authServer || 'https://littleskin.cn/api/yggdrasil';
    const authlib = await ensureAuthlibInjector({
      mirror: config.mirror,
      abort: options.abort,
      onLog: options.onLog,
    });
    jvmArgs.push(`-javaagent:${authlib}=${authServer}`);
  }

  // 版本 JSON 自带的 JVM 参数
  const versionJvm = flattenArgumentList(versionJson.arguments && versionJson.arguments.jvm, features);
  jvmArgs.push(...versionJvm);

  // 极旧版本没有 arguments.jvm
  if (!versionJvm.some((a) => a === '-cp' || a === '-classpath')) {
    jvmArgs.push('-Djava.library.path=' + nativesDir);
    jvmArgs.push('-cp', vars.classpath);
  }

  if (versionJson.logging && versionJson.logging.client) {
    const logId = versionJson.logging.client.file && versionJson.logging.client.file.id;
    const logPath = logId ? path.join(Paths.getPaths().logConfigs, logId) : '';
    if (logPath && exists(logPath)) {
      const argument = versionJson.logging.client.argument || '-Dlog4j.configurationFile=${path}';
      jvmArgs.push(replaceVars(argument, { path: logPath }));
    }
  }

  const extraJvm = splitArgs(config.jvmArgsExtra || '');
  jvmArgs.push(...extraJvm);

  // 游戏参数
  let gameArgs;
  if (versionJson.arguments && Array.isArray(versionJson.arguments.game) && versionJson.arguments.game.length) {
    gameArgs = flattenArgumentList(versionJson.arguments.game, features);
  } else if (versionJson.minecraftArguments) {
    gameArgs = splitArgs(versionJson.minecraftArguments);
  } else {
    throw new Error('版本缺少游戏启动参数');
  }

  // 旧版本自定义分辨率
  if (custom.enabled && !gameArgs.includes('--width')) {
    gameArgs.push('--width', String(custom.width), '--height', String(custom.height));
  }
  const extraGame = splitArgs(config.gameArgsExtra || '');
  gameArgs.push(...extraGame);

  const finalJvm = jvmArgs.map((arg) => replaceVars(arg, vars));
  const finalGame = gameArgs.map((arg) => replaceVars(arg, vars));

  return {
    javaPath: java.path,
    javaInfo: java,
    args: [...finalJvm, versionJson.mainClass, ...finalGame],
    mainClass: versionJson.mainClass,
    cwd: gameDir,
    nativesDir,
    assetsDir: assets.dir,
    versionId: instance.versionId,
    javaMajor,
    // 用于日志/调试，不包含访问令牌
    displayCommand: [
      java.path,
      ...finalJvm.map((a) => redactToken(a)),
      versionJson.mainClass,
      ...finalGame.map((a) => (/^[0-9a-f]{16,}$/i.test(a) ? '<redacted>' : a)),
    ],
  };
}

function redactToken(value) {
  if (!value) return value;
  const text = String(value);
  if (text.length > 60 && /^[A-Za-z0-9_.-]+$/.test(text)) return '<redacted>';
  return text;
}

/** 逐行解码：优先 UTF-8，失败时回退 GBK（Windows 旧版 Java 控制台） */
class LineDecoder {
  constructor(onLine) {
    this.onLine = onLine;
    this.buffer = Buffer.alloc(0);
    this.utf8 = new TextDecoder('utf-8', { fatal: true });
    this.gbk = null;
    try {
      this.gbk = new TextDecoder('gbk');
    } catch {
      this.gbk = null;
    }
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const idx = this.buffer.indexOf(0x0a);
      if (idx < 0) break;
      const raw = this.buffer.subarray(0, idx);
      this.buffer = this.buffer.subarray(idx + 1);
      const line = raw.subarray(0, raw.length && raw[raw.length - 1] === 0x0d ? raw.length - 1 : raw.length);
      let text;
      try {
        text = this.utf8.decode(line);
      } catch {
        try {
          text = this.gbk ? this.gbk.decode(line) : line.toString('utf8');
        } catch {
          text = line.toString('utf8');
        }
      }
      this.onLine(stripAnsi(text));
    }
    if (this.buffer.length > 1024 * 1024) {
      // 防止无换行输出撑爆内存
      this.onLine(stripAnsi(this.buffer.toString('utf8').slice(0, 2048)));
      this.buffer = Buffer.alloc(0);
    }
  }
  flush() {
    if (this.buffer.length) {
      this.onLine(stripAnsi(this.buffer.toString('utf8')));
      this.buffer = Buffer.alloc(0);
    }
  }
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

class GameProcess {
  constructor({ onLog, onExit }) {
    this.child = null;
    this.onLog = onLog || (() => {});
    this.onExit = onExit || (() => {});
    this.startedAt = 0;
    this.logFile = '';
    this.exitCode = null;
  }

  get running() {
    return Boolean(this.child && this.exitCode === null);
  }

  async start(command) {
    if (this.running) throw new Error('游戏已在运行');
    const p = Paths.getPaths();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFile = path.join(p.logs, `launch-${stamp}.log`);
    await ensureDirAsync(path.dirname(this.logFile));
    const header = [
      `# QUTC Launcher ${p.appVersion}`,
      `# 时间: ${nowIso()}`,
      `# 版本: ${command.versionId}`,
      `# Java: ${command.javaPath} (${command.javaInfo.version})`,
      `# 工作目录: ${command.cwd}`,
      '# 注意：访问令牌已从调试日志中隐藏。',
      '',
    ].join('\r\n');
    await fsp.writeFile(this.logFile, header, 'utf8');

    const env = { ...process.env };
    // 避免外部 _JAVA_OPTIONS / JAVA_TOOL_OPTIONS 注入不可控参数
    delete env._JAVA_OPTIONS;
    delete env.JAVA_TOOL_OPTIONS;
    delete env.JAVA_OPTIONS;
    env.MC_LAUNCHER = 'QUTC-Launcher';

    const child = spawn(command.javaPath, command.args, {
      cwd: command.cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.startedAt = Date.now();
    this.exitCode = null;

    const decoder = new LineDecoder((line) => {
      if (!line) return;
      fs.appendFile(this.logFile, `${line}\r\n`, () => {});
      this.onLog(line);
    });

    child.stdout.on('data', (chunk) => decoder.push(chunk));
    child.stderr.on('data', (chunk) => decoder.push(chunk));
    child.on('error', (err) => {
      this.onLog(`[启动器] 无法启动 Java: ${err.message}`);
      this.exitCode = -1;
      this.child = null;
      this.onExit({ code: -1, error: err.message, durationMs: 0, logFile: this.logFile });
    });
    child.on('close', (code) => {
      decoder.flush();
      this.exitCode = code === null ? -1 : code;
      this.child = null;
      const durationMs = Date.now() - this.startedAt;
      this.onLog(`[启动器] 游戏进程已退出，代码 ${this.exitCode}，运行 ${Math.round(durationMs / 1000)} 秒`);
      this.onExit({ code: this.exitCode, durationMs, logFile: this.logFile });
    });
    return { logFile: this.logFile, pid: child.pid };
  }

  stop() {
    if (!this.running) return false;
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
    return true;
  }
}

module.exports = {
  buildLaunchCommand,
  GameProcess,
  LineDecoder,
  flattenArgumentList,
  resolveAssetsDir,
  redactToken,
};
