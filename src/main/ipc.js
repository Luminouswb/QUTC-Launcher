'use strict';

/**
 * QUTC Launcher - IPC 白名单
 *
 * 渲染进程没有任何 Node 权限，只能调用这里注册的 channel。
 * 每个 channel 都会校验参数类型/长度，文件路径只来自主进程的对话框。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ipcMain, dialog, shell, safeStorage, app } = require('electron');

const Paths = require('../core/paths');
const Config = require('../core/config');
const Versions = require('../core/versions');
const Loaders = require('../core/loaders');
const Instances = require('../core/instances');
const Modrinth = require('../core/modrinth');
const Modpack = require('../core/modpack');
const Mods = require('../core/mods');
const External = require('../core/external');
const { AccountStore } = require('../core/auth/accounts');
const MicrosoftAuth = require('../core/auth/microsoft');
const YggdrasilAuth = require('../core/auth/yggdrasil');
const Skin = require('../core/auth/skin');
const { offlineUuid, uuidDashed } = require('../core/hash');
const { validateOfflineName, isAllowedExternalUrl } = require('../core/security');
const { getJson } = require('../core/http');
const { buildLaunchCommand, GameProcess } = require('../core/launch');
const { detectJava } = require('../core/java');
const { Abort, readJson, sanitizeName } = require('../core/util');
const { openMicrosoftLogin } = require('./ms-login');
const { appendLauncherLog, getLogTail } = require('./log');
const { FrpManager } = require('../core/frp');

const VERSION_ID_RE = /^[A-Za-z0-9._-]{1,90}$/;
const LOADERS = new Set(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']);

async function registerIpc({ windows, getMainWindow }) {
  const p = Paths.getPaths();
  const accountStore = new AccountStore({
    encrypt: async (text) => {
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.encryptString(text).toString('base64');
    },
    decrypt: async (text) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用');
      return safeStorage.decryptString(Buffer.from(text, 'base64'));
    },
  });
  const tokenCache = new Map();
  const game = new GameProcess({
    onLog: (line) => broadcast(windows, 'game:log', { line }),
    onExit: (info) => {
      broadcast(windows, 'game:exit', info);
      finishGame(info);
    },
  });
  const frp = new FrpManager({
    onLog: (line) => broadcast(windows, 'frp:log', { line }),
    onStateChange: () => broadcast(windows, 'frp:state', frp.status()),
  });
  let activeTask = null;
  let runningInstanceId = '';
  let gameStartedAt = 0;

  accountStore.load().catch((err) => appendLauncherLog(`[账号] 读取失败: ${err.message}`));
  await accountStore.load();

  function broadcast(list, channel, payload) {
    for (const win of list) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  function send(channel, payload) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function handle(channel, fn) {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        const data = await fn(payload);
        return { ok: true, data };
      } catch (err) {
        const message = err && err.message ? err.message : '未知错误';
        if (!(err && err.cancelled)) appendLauncherLog(`[IPC] ${channel} 失败: ${message}`);
        return {
          ok: false,
          error: {
            message,
            code: (err && err.code) || '',
            cancelled: Boolean(err && err.cancelled),
          },
        };
      }
    });
  }

  function obj(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求参数格式错误');
    return value;
  }

  function text(value, name, max = 200) {
    if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${name} 不能为空`);
    if (trimmed.length > max) throw new Error(`${name} 过长`);
    return trimmed;
  }

  function versionId(value) {
    const id = text(value, '版本 ID', 90);
    if (!VERSION_ID_RE.test(id) || id.includes('..')) throw new Error('版本 ID 非法');
    return id;
  }

  function instanceId(value) {
    return Instances.assertInstanceId(String(value || ''));
  }

  function bool(value) {
    return value === true;
  }

  function frpEncrypt(text) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法加密保存访问密钥');
    return safeStorage.encryptString(text).toString('base64');
  }

  function frpDecrypt(enc) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取访问密钥');
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  }

  function frpAccessKey() {
    const config = Config.get();
    const enc = config.frp && typeof config.frp === 'object' ? config.frp.accessKeyEnc : '';
    if (!enc) throw new Error('尚未配置樱花访问密钥，请在下方填写后保存');
    try {
      return frpDecrypt(enc);
    } catch {
      throw new Error('访问密钥解密失败，请重新保存凭据');
    }
  }

  function frpTunnelId(value) {
    const id = String(value == null ? '' : value).trim();
    if (!/^\d{1,12}$/.test(id)) throw new Error('隧道 ID 非法');
    return id;
  }

  async function runTask(name, ctxExtra, runner) {
    if (activeTask) {
      throw new Error(`已有任务正在进行：${activeTask.label || activeTask.name}，请等待完成或取消`);
    }
    const abort = new Abort();
    const label = ctxExtra.label || name;
    activeTask = { name, label, abort, startedAt: Date.now() };
    send('task:start', { task: name, label });
    const ctx = {
      abort,
      mirror: Config.get().mirror,
      concurrency: Config.get().downloadConcurrency,
      consent: ctxExtra.consent === true,
      onPhase: (phase) => send('task:progress', { task: name, phase }),
      onProgress: (progress) => send('task:progress', { task: name, ...progress }),
      onLog: (line) => {
        appendLauncherLog(`[${name}] ${line}`);
        send('task:log', { task: name, line });
      },
    };
    try {
      const result = await runner(ctx);
      send('task:done', { task: name, ok: true });
      return result;
    } catch (err) {
      send('task:done', { task: name, ok: false, message: err && err.message });
      throw err;
    } finally {
      activeTask = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 基础信息 / 配置                                                     */
  /* ------------------------------------------------------------------ */

  handle('app:bootstrap', async () => {
    const config = Config.get();
    await Instances.normalizeInstanceNames();
    const instances = await Instances.listInstances();
    const installed = await Versions.listInstalledVersions();
    await accountStore.load();
    return {
      appVersion: p.appVersion,
      dataRoot: p.root,
      portable: p.portable,
      config,
      instances,
      installedVersions: installed,
      accounts: accountStore.list(),
      selectedAccountId: accountStore.selectedId(),
      logs: getLogTail(),
      platform: { os: process.platform, arch: process.arch },
    };
  });

  handle('config:save', async (payload) => {
    const patch = obj(payload);
    const allowed = Object.keys(Config.DEFAULT_CONFIG).filter((key) => key !== 'installationId' && key !== 'frp');
    const clean = {};
    for (const key of allowed) {
      if (patch[key] !== undefined) clean[key] = patch[key];
    }
    const saved = await Config.save(clean);
    appendLauncherLog('[配置] 已保存');
    return saved;
  });

  handle('system:java', async () => detectJava({ force: true }));

  handle('app:open-external', async (payload) => {
    const url = text(obj(payload).url, '链接', 500);
    if (!isAllowedExternalUrl(url)) throw new Error('该链接不在允许打开的域名列表中');
    await shell.openExternal(url);
    return true;
  });

  handle('app:open-data-dir', async () => {
    await shell.openPath(p.root);
    return true;
  });

  handle('app:open-logs', async () => {
    await shell.openPath(p.logs);
    return true;
  });

  handle('app:open-launcher-log', async () => {
    await shell.openPath(p.launcherLog);
    return true;
  });

  handle('dialog:choose-java', async () => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Java 可执行文件',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [{ name: 'Java', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths.length) return '';
    return result.filePaths[0];
  });

  async function clearBackgroundFiles() {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      await fsp.rm(path.join(p.cache, `background.${ext}`), { force: true }).catch(() => {});
    }
  }

  handle('appearance:pick-background', async () => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: '选择背景图',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const src = result.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('只支持 PNG / JPG / WebP 图片');
    await clearBackgroundFiles();
    const filename = `background${ext}`;
    await fsp.copyFile(src, path.join(p.cache, filename));
    await Config.save({ backgroundImage: filename });
    appendLauncherLog('[外观] 已更新背景图');
    return { backgroundImage: filename };
  });

  handle('appearance:clear-background', async () => {
    await clearBackgroundFiles();
    await Config.save({ backgroundImage: '' });
    appendLauncherLog('[外观] 已清除背景图');
    return { backgroundImage: '' };
  });

  /* ------------------------------------------------------------------ */
  /* 原版版本                                                            */
  /* ------------------------------------------------------------------ */

  handle('versions:manifest', async (payload) => {
    const opts = payload ? obj(payload) : {};
    const manifest = await Versions.getManifest({
      force: bool(opts.force),
      mirror: Config.get().mirror,
    });
    return {
      latest: manifest.latest,
      versions: manifest.versions.map((v) => ({
        id: v.id,
        type: v.type,
        releaseTime: v.releaseTime,
      })),
    };
  });

  handle('versions:installed', async () => Versions.listInstalledVersions());

  handle('versions:state', async (payload) => {
    const id = versionId(obj(payload).id);
    return Versions.getInstallState(id);
  });

  handle('versions:install', async (payload) => {
    const opts = obj(payload);
    const id = versionId(opts.id);
    const label = opts.label ? String(opts.label).slice(0, 80) : id;
    return runTask('install', { label }, async (ctx) => {
      await Versions.installVersion(id, {
        mirror: ctx.mirror,
        concurrency: ctx.concurrency,
        abort: ctx.abort,
        onPhase: ctx.onPhase,
        onProgress: ctx.onProgress,
        onLog: ctx.onLog,
      });
      const state = await Versions.getInstallState(id);
      if (!state.installed) throw new Error(state.reason || '安装未完成');
      send('versions:changed', { id });
      return { id, state };
    });
  });

  handle('versions:delete', async (payload) => {
    const id = versionId(obj(payload).id);
    const instances = await Instances.listInstances();
    if (instances.some((i) => i.versionId === id)) {
      throw new Error('该版本仍被版本使用，请先删除相关版本');
    }
    const dir = p.versionDir(id);
    if (!dir.startsWith(p.versions)) throw new Error('路径异常');
    await fsp.rm(dir, { recursive: true, force: true });
    send('versions:changed', { id, deleted: true });
    return true;
  });

  handle('loaders:versions', async (payload) => {
    const opts = obj(payload);
    const loader = String(opts.loader || '');
    if (!LOADERS.has(loader) || loader === 'vanilla') return [];
    const mc = text(opts.mcVersion, 'Minecraft 版本', 40);
    return Loaders.listLoaderVersions(loader, mc, { mirror: Config.get().mirror });
  });

  /* ------------------------------------------------------------------ */
  /* 版本                                                                */
  /* ------------------------------------------------------------------ */

  handle('instances:list', async () => Instances.listInstances());

  handle('instances:create', async (payload) => {
    const opts = obj(payload);
    const name = sanitizeName(text(opts.name, '版本名称', 48), '新版本');
    const mcVersion = text(opts.mcVersion, 'Minecraft 版本', 40);
    const loaderType = String(opts.loader || 'vanilla');
    if (!LOADERS.has(loaderType)) throw new Error('不支持的加载器');
    const loaderVersion = loaderType === 'vanilla' ? '' : String(opts.loaderVersion || '').slice(0, 48);

    return runTask('install', { label: `安装 ${name}`, consent: opts.consent }, async (ctx) => {
      let versionIdValue = mcVersion;
      let loader = { type: 'vanilla', version: '' };
      if (loaderType === 'vanilla') {
        if (ctx.onPhase) ctx.onPhase(`安装原版 ${mcVersion}`);
        await Versions.installVersion(mcVersion, {
          mirror: ctx.mirror,
          concurrency: ctx.concurrency,
          abort: ctx.abort,
          onPhase: ctx.onPhase,
          onProgress: ctx.onProgress,
          onLog: ctx.onLog,
        });
      } else {
        if (!loaderVersion) throw new Error('请选择加载器版本');
        const result = await Loaders.installLoader({
          loader: loaderType,
          mcVersion,
          loaderVersion,
          ctx,
        });
        versionIdValue = result.versionId;
        loader = result.loader;
      }
      const instance = await Instances.createInstance({
        name,
        versionId: versionIdValue,
        mcVersion,
        loader,
      });
      send('instances:changed', {});
      return instance;
    });
  });

  handle('instances:update', async (payload) => {
    const opts = obj(payload);
    const id = instanceId(opts.id);
    const patch = {};
    if (opts.name !== undefined) patch.name = sanitizeName(text(opts.name, '版本名称', 48), '版本');
    if (opts.memoryMb !== undefined) patch.memoryMb = Number(opts.memoryMb) || 0;
    if (opts.notes !== undefined) patch.notes = String(opts.notes).slice(0, 500);
    if (opts.jvmArgsExtra !== undefined) patch.jvmArgsExtra = String(opts.jvmArgsExtra).slice(0, 2000);
    if (opts.gameArgsExtra !== undefined) patch.gameArgsExtra = String(opts.gameArgsExtra).slice(0, 2000);
    if (opts.customResolution !== undefined) {
      const res = obj(opts.customResolution);
      patch.customResolution = {
        enabled: res.enabled === true,
        width: Number(res.width) || 1280,
        height: Number(res.height) || 720,
      };
    }
    const instance = await Instances.updateInstance(id, patch);
    send('instances:changed', {});
    return instance;
  });

  handle('instances:delete', async (payload) => {
    const id = instanceId(obj(payload).id);
    await Instances.deleteInstance(id);
    send('instances:changed', {});
    return true;
  });

  handle('instances:duplicate', async (payload) => {
    const id = instanceId(obj(payload).id);
    const name = obj(payload).name ? sanitizeName(String(obj(payload).name), '副本') : '';
    const instance = await Instances.duplicateInstance(id, name);
    send('instances:changed', {});
    return instance;
  });

  handle('instances:open-folder', async (payload) => {
    const id = instanceId(obj(payload).id);
    await shell.openPath(await Instances.getGameDir(id));
    return true;
  });

  handle('instances:open-subfolder', async (payload) => {
    const opts = obj(payload);
    const id = instanceId(opts.id);
    const kind = String(opts.kind || '');
    const instance = await Instances.getInstance(id);
    const gameDir = await Instances.getGameDir(id);
    let target;
    if (kind === 'version') {
      target = p.versionDir(instance.versionId);
    } else if (kind === 'instance') {
      target = Instances.instanceDir(id);
    } else if (['saves', 'resourcepacks', 'mods', 'config'].includes(kind)) {
      target = path.join(gameDir, kind);
      await fsp.mkdir(target, { recursive: true });
    } else {
      throw new Error('不支持打开的文件夹类型');
    }
    if (!fs.existsSync(target)) throw new Error('文件夹不存在');
    await shell.openPath(target);
    return true;
  });

  handle('instances:pick-external-folder', async () => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: '选择已有的 Minecraft 游戏目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return External.scanVersions(result.filePaths[0]);
  });

  handle('instances:scan-external', async (payload) => {
    const folder = text(obj(payload).folder, '游戏目录', 1000);
    return External.scanVersions(folder);
  });

  handle('instances:create-external', async (payload) => {
    const opts = obj(payload);
    const name = sanitizeName(text(opts.name, '版本名称', 48), '外部版本');
    const requestedId = versionId(opts.versionId);
    const folder = text(opts.folder, '游戏目录', 1000);
    const scan = External.scanVersions(folder);
    if (!scan.versions.length) throw new Error('未找到游戏版本，请先下载或选择包含 versions 的游戏目录');
    const selected =
      scan.versions.find((item) => item.id === requestedId) ||
      scan.versions.find((item) => item.sourceId === requestedId);
    if (!selected) throw new Error('选择的版本不在该游戏目录中');
    return runTask('external', { label: `导入外部版本 ${selected.sourceId}` }, async (ctx) => {
      if (ctx.onPhase) ctx.onPhase(`导入本地版本文件 ${selected.sourceId}`);
      const imported = await External.importExternalVersion(selected);
      const instance = await Instances.createExternalInstance({
        name,
        versionId: imported.id,
        mcVersion: imported.mcVersion,
        loader: imported.loader,
        externalGameDir: scan.root || folder,
      });
      appendLauncherLog(`[版本] 注册外部目录 ${instance.name} -> ${scan.root || folder}`);
      send('instances:changed', {});
      return instance;
    });
  });

  handle('instances:export', async (payload) => {
    const id = instanceId(obj(payload).id);
    const instance = await Instances.getInstance(id);
    const win = getMainWindow();
    const result = await dialog.showSaveDialog(win, {
      title: '导出 QUTC 版本',
      defaultPath: path.join(app.getPath('documents'), `${sanitizeName(instance.name, 'instance')}.qutc`),
      filters: [{ name: 'QUTC 版本包', extensions: ['qutc'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const dest = result.filePath.toLowerCase().endsWith('.qutc') ? result.filePath : `${result.filePath}.qutc`;
    return runTask('export', { label: `导出 ${instance.name}` }, async (ctx) => {
      const out = await Instances.exportInstance(id, dest, {
        abort: ctx.abort,
        onProgress: ctx.onProgress,
        onPhase: ctx.onPhase,
      });
      appendLauncherLog(`[版本] 已导出 ${instance.name} -> ${out.file}`);
      return out;
    });
  });

  handle('instances:import', async () => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: '导入 QUTC 版本包',
      properties: ['openFile'],
      filters: [{ name: 'QUTC 版本包', extensions: ['qutc', 'zip'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const file = result.filePaths[0];
    return runPackInstall(file, {}, 'import');
  });

  /* ------------------------------------------------------------------ */
  /* 启动游戏                                                            */
  /* ------------------------------------------------------------------ */

  handle('instances:launch', async (payload) => {
    const id = instanceId(obj(payload).id);
    if (game.running) throw new Error('游戏已在运行');
    const instance = await Instances.getInstance(id);
    const account = await resolveAccount();
    if (!account) throw new Error('请先在「账户」页添加账号');

    const config = Config.get();
    const win = getMainWindow();
    if (config.closeOnLaunch && win) win.hide();

    try {
      if (config.showGameLog) send('game:log', { line: '[启动器] 正在准备启动…' });
      const command = await buildLaunchCommand(instance, account, {
        memoryMb: instance.memoryMb || config.memoryMb,
        customResolution: instance.customResolution || config.customResolution,
        onPhase: (phase) => send('game:log', { line: `[启动器] ${phase}` }),
        onLog: (line) => send('game:log', { line }),
        abort: null,
      });
      const started = await game.start(command);
      runningInstanceId = id;
      gameStartedAt = Date.now();
      appendLauncherLog(`[游戏] 启动版本 ${instance.name} (${instance.versionId})，pid=${started.pid}`);
      return { pid: started.pid, logFile: started.logFile, versionId: instance.versionId };
    } catch (err) {
      if (config.closeOnLaunch && win) win.show();
      throw err;
    }
  });

  handle('instances:stop', async () => {
    const stopped = game.stop();
    if (stopped) send('game:log', { line: '[启动器] 正在结束游戏进程…' });
    return stopped;
  });

  handle('game:status', async () => ({ running: game.running, instanceId: runningInstanceId, startedAt: gameStartedAt }));

  /* ------------------------------------------------------------------ */
  /* 账号                                                                */
  /* ------------------------------------------------------------------ */

  handle('accounts:list', async () => {
    await accountStore.load();
    return { accounts: accountStore.list(), selectedId: accountStore.selectedId() };
  });

  handle('accounts:offline', async (payload) => {
    const name = validateOfflineName(text(obj(payload).name, '用户名', 16));
    const uuid = offlineUuid(name);
    const account = {
      id: `offline:${uuid}`,
      type: 'offline',
      name,
      uuid: uuidDashed(uuid),
      createdAt: new Date().toISOString(),
    };
    await accountStore.upsert(account, { select: true });
    appendLauncherLog(`[账号] 添加离线账号 ${name}`);
    send('accounts:changed', {});
    return { accounts: accountStore.list(), selectedId: accountStore.selectedId() };
  });

  handle('accounts:yggdrasil-resolve', async (payload) => {
    const url = text(obj(payload).url, '验证服务器地址', 500);
    const server = await YggdrasilAuth.resolveAuthServer(url);
    return { apiRoot: server.apiRoot, serverName: server.serverName };
  });

  handle('accounts:yggdrasil-login', async (payload) => {
    const opts = obj(payload);
    const username = text(opts.username, '验证服务器账号', 128);
    if (typeof opts.password !== 'string' || !opts.password) throw new Error('请输入验证服务器密码');
    if (opts.password.length > 256) throw new Error('密码过长');
    const authServer = text(opts.authServer, '验证服务器地址', 500);
    const result = await YggdrasilAuth.authenticate({
      username,
      password: opts.password,
      authServer,
    });
    await accountStore.upsert(result.account, { refreshToken: result.accessToken, select: true });
    appendLauncherLog(`[账号] 外置登录成功: ${result.account.name} @ ${result.account.authServerName || result.account.authServer}`);
    send('accounts:changed', {});
    return { accounts: accountStore.list(), selectedId: accountStore.selectedId() };
  });

  handle('accounts:ms-login', async () => {
    const parent = getMainWindow();
    if (!parent || parent.isDestroyed()) {
      throw new MicrosoftAuth.AuthError('请在启动器窗口中登录微软账号', 'no_window');
    }
    const code = await openMicrosoftLogin(parent);
    const tokens = await MicrosoftAuth.exchangeAuthCode(code);
    const result = await MicrosoftAuth.finishMicrosoftLogin({
      msAccessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
    await accountStore.upsert(result.account, { refreshToken: result.refreshToken, select: true });
    tokenCache.set(result.account.id, {
      accessToken: result.account.accessToken,
      expiresAt: result.account.accessTokenExpiresAt,
    });
    appendLauncherLog(`[账号] 微软登录成功: ${result.account.name}`);
    send('accounts:changed', {});
    return { accounts: accountStore.list(), selectedId: accountStore.selectedId() };
  });

  handle('accounts:select', async (payload) => {
    const id = text(obj(payload).id, '账号 ID', 80);
    await accountStore.select(id);
    tokenCache.delete(id);
    send('accounts:changed', {});
    return { accounts: accountStore.list(), selectedId: accountStore.selectedId() };
  });

  handle('accounts:remove', async (payload) => {
    const id = text(obj(payload).id, '账号 ID', 80);
    await accountStore.remove(id);
    tokenCache.delete(id);
    send('accounts:changed', {});
    return { accounts: accountStore.list(), selectedId: accountStore.selectedId() };
  });

  handle('accounts:refresh', async () => {
    const stored = accountStore.selected();
    if (!stored) throw new Error('没有选中的账号');
    if (stored.type !== 'microsoft') throw new Error('离线账号无需刷新');
    const refreshToken = await accountStore.getRefreshToken(stored.id);
    if (!refreshToken) throw new Error('该账号没有可用的刷新令牌，请重新登录');
    const result = await MicrosoftAuth.refreshMicrosoftAccount(refreshToken);
    await accountStore.upsert(result.account, { refreshToken: result.refreshToken, select: false });
    tokenCache.set(result.account.id, {
      accessToken: result.account.accessToken,
      expiresAt: result.account.accessTokenExpiresAt,
    });
    return { accounts: accountStore.list(), selectedId: accountStore.selectedId() };
  });

  handle('accounts:skin', async (payload) => {
    const id = text(obj(payload).id, '账号 ID', 80);
    const stored = accountStore.get(id);
    if (!stored) throw new Error('账号不存在');
    let accessToken = null;
    try {
      accessToken = await getSkinAccessToken(stored);
    } catch {
      accessToken = null;
    }
    const url = await Skin.fetchSkinTexture(stored, accessToken);
    return { url };
  });

  async function getSkinAccessToken(stored) {
    if (!stored) return null;
    if (stored.type === 'offline') return null;
    if (stored.type === 'yggdrasil') {
      return accountStore.getRefreshToken(stored.id);
    }
    // microsoft：优先用内存里的 Minecraft 访问令牌，否则走刷新链
    const cached = tokenCache.get(stored.id);
    if (cached && cached.expiresAt && cached.expiresAt > Date.now() + 60 * 1000) {
      return cached.accessToken;
    }
    const refreshToken = await accountStore.getRefreshToken(stored.id);
    if (!refreshToken) return null;
    const result = await MicrosoftAuth.refreshMicrosoftAccount(refreshToken);
    await accountStore.upsert(result.account, { refreshToken: result.refreshToken, select: false });
    tokenCache.set(result.account.id, {
      accessToken: result.account.accessToken,
      expiresAt: result.account.accessTokenExpiresAt,
    });
    return result.account.accessToken;
  }

  async function resolveAccount() {
    const stored = accountStore.selected();
    if (!stored) return null;
    if (stored.type === 'offline') {
      return { id: stored.id, type: 'offline', name: stored.name, uuid: stored.uuid, accessToken: '0' };
    }
    if (stored.type === 'yggdrasil') {
      const accessToken = await accountStore.getRefreshToken(stored.id);
      if (!accessToken) throw new Error('外置登录已过期，请在「账户」页重新登录');
      const authServer = stored.authServer || 'https://littleskin.cn/api/yggdrasil';
      const clientToken = stored.yggdrasilClientToken || '';
      try {
        const valid = await YggdrasilAuth.validate({ authServer, accessToken, clientToken });
        if (valid) {
          return {
            id: stored.id,
            type: 'yggdrasil',
            name: stored.name,
            uuid: stored.uuid,
            authServer,
            authServerName: stored.authServerName || '',
            accessToken,
          };
        }
        const result = await YggdrasilAuth.refresh({ authServer, accessToken, clientToken });
        result.account.id = stored.id;
        await accountStore.upsert(result.account, { refreshToken: result.accessToken, select: false });
        return {
          id: stored.id,
          type: 'yggdrasil',
          name: result.account.name,
          uuid: result.account.uuid,
          authServer: result.account.authServer,
          authServerName: result.account.authServerName,
          accessToken: result.accessToken,
        };
      } catch (err) {
        throw new Error(`外置登录已失效，请重新登录：${err.message}`);
      }
    }
    const cached = tokenCache.get(stored.id);
    if (cached && cached.expiresAt && cached.expiresAt > Date.now() + 60 * 1000) {
      return {
        id: stored.id,
        type: 'microsoft',
        name: stored.name,
        uuid: stored.uuid,
        xuid: stored.xuid || '',
        accessToken: cached.accessToken,
        accessTokenExpiresAt: cached.expiresAt,
      };
    }
    const refreshToken = await accountStore.getRefreshToken(stored.id);
    if (!refreshToken) throw new Error('微软账号登录已过期，请在「账户」页重新登录');
    const result = await MicrosoftAuth.refreshMicrosoftAccount(refreshToken);
    await accountStore.upsert(result.account, { refreshToken: result.refreshToken, select: false });
    tokenCache.set(result.account.id, {
      accessToken: result.account.accessToken,
      expiresAt: result.account.accessTokenExpiresAt,
    });
    return {
      id: result.account.id,
      type: 'microsoft',
      name: result.account.name,
      uuid: result.account.uuid,
      xuid: result.account.xuid || '',
      accessToken: result.account.accessToken,
      accessTokenExpiresAt: result.account.accessTokenExpiresAt,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Modrinth 整合包                                                     */
  /* ------------------------------------------------------------------ */

  handle('modpack:search', async (payload) => {
    const opts = payload ? obj(payload) : {};
    return Modrinth.searchModpacks(String(opts.query || ''), {
      gameVersion: opts.gameVersion ? String(opts.gameVersion) : '',
      loader: opts.loader ? String(opts.loader) : '',
      sort: opts.sort ? String(opts.sort) : 'relevance',
      limit: Number(opts.limit) || 12,
      offset: Number(opts.offset) || 0,
    });
  });

  handle('modpack:versions', async (payload) => {
    const opts = obj(payload);
    const id = Modrinth.normalizeProjectId(opts.projectId);
    return Modrinth.getProjectVersions(id, {
      gameVersion: opts.gameVersion ? String(opts.gameVersion) : '',
      loader: opts.loader ? String(opts.loader) : '',
    });
  });

  handle('modpack:install', async (payload) => {
    const opts = obj(payload);
    const version = await Modrinth.getVersion(text(opts.mrVersionId, '整合包版本 ID', 32));
    const file = Modrinth.pickMrpackFile(version);
    if (!file) throw new Error('该整合包版本没有 .mrpack 文件');
    return runTask('modpack', { label: `安装整合包 ${version.name}`, consent: opts.consent }, async (ctx) => {
      const dest = path.join(p.cache, 'downloads', `${file.hashes.sha1 || Date.now()}.mrpack`);
      await Modrinth.downloadMrpackFile(file, dest, ctx);
      const info = await Modpack.describeMrpack(dest);
      if ((info.loader.type === 'forge' || info.loader.type === 'neoforge') && ctx.consent !== true) {
        const err = new Error('该整合包需要 Forge/NeoForge 官方安装器，请勾选同意后重试。');
        err.code = 'CONSENT_REQUIRED';
        throw err;
      }
      const result = await Modpack.installMrpack(dest, ctx);
      send('instances:changed', {});
      return result;
    });
  });

  handle('modpack:pick-local', async () => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Modrinth 整合包',
      properties: ['openFile'],
      filters: [{ name: 'Modrinth 整合包', extensions: ['mrpack'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const file = result.filePaths[0];
    const info = await Modpack.describeMrpack(file);
    return { file, info };
  });

  handle('modpack:install-local', async (payload) => {
    const opts = obj(payload);
    const file = text(opts.file, '整合包路径', 600);
    if (!/\.mrpack$/i.test(file)) throw new Error('只支持 .mrpack 整合包');
    if (!fs.existsSync(file)) throw new Error('整合包文件不存在');
    return runTask('modpack', { label: '导入本地整合包', consent: opts.consent }, async (ctx) => {
      const info = await Modpack.describeMrpack(file);
      if ((info.loader.type === 'forge' || info.loader.type === 'neoforge') && ctx.consent !== true) {
        const err = new Error('该整合包需要 Forge/NeoForge 官方安装器，请勾选同意后重试。');
        err.code = 'CONSENT_REQUIRED';
        throw err;
      }
      const result = await Modpack.installMrpack(file, ctx);
      send('instances:changed', {});
      return result;
    });
  });

  /* ------------------------------------------------------------------ */
  /* Modrinth MOD 下载                                                   */
  /* ------------------------------------------------------------------ */

  handle('mods:search', async (payload) => {
    const opts = payload ? obj(payload) : {};
    return Mods.searchMods(String(opts.query || ''), {
      instanceId: opts.instanceId ? instanceId(opts.instanceId) : '',
      limit: Number(opts.limit) || 18,
      offset: Number(opts.offset) || 0,
      sort: opts.sort ? String(opts.sort) : 'relevance',
    });
  });

  handle('mods:versions', async (payload) => {
    const opts = obj(payload);
    const projectId = Modrinth.normalizeProjectId(opts.projectId);
    return Mods.listVersions(projectId, { instanceId: instanceId(opts.instanceId) });
  });

  handle('mods:install', async (payload) => {
    const opts = obj(payload);
    const targetInstance = instanceId(opts.instanceId);
    const version = text(opts.versionId, 'MOD 版本 ID', 32);
    if (!/^[A-Za-z0-9]{6,32}$/.test(version)) throw new Error('MOD 版本 ID 非法');
    return runTask('mods', { label: '安装 MOD' }, async (ctx) => {
      const result = await Mods.installMod(
        { instanceId: targetInstance, versionId: version, installDependencies: opts.installDependencies !== false },
        ctx,
      );
      appendLauncherLog(`[MOD] ${result.instanceName}: 安装 ${result.installed.length} 个文件`);
      return result;
    });
  });

  handle('mods:import-local', async (payload) => {
    const targetInstance = instanceId(obj(payload).instanceId);
    const win = getMainWindow();
    const picked = await dialog.showOpenDialog(win, {
      title: '选择本地 MOD（.jar）',
      properties: ['openFile'],
      filters: [{ name: 'Minecraft MOD', extensions: ['jar'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    return runTask('mods', { label: '导入本地 MOD' }, async (ctx) => {
      const result = await Mods.installLocalJar(targetInstance, picked.filePaths[0], ctx);
      appendLauncherLog(`[MOD] 本地导入 ${result.filename}`);
      return result;
    });
  });

  async function runPackInstall(file, opts, taskName) {
    const lower = file.toLowerCase();
    if (lower.endsWith('.mrpack')) {
      const info = await Modpack.describeMrpack(file);
      const needsConsent =
        (info.loader.type === 'forge' || info.loader.type === 'neoforge') && opts.consent !== true;
      if (needsConsent) {
        const err = new Error('该整合包需要安装 Forge/NeoForge，必须运行官方安装器。请在确认窗口勾选同意。');
        err.code = 'CONSENT_REQUIRED';
        throw err;
      }
      return runTask(taskName, { label: `安装整合包 ${info.name}`, consent: opts.consent }, async (ctx) => {
        const result = await Modpack.installMrpack(file, ctx);
        send('instances:changed', {});
        return result;
      });
    }
    return runTask(taskName, { label: '导入版本' }, async (ctx) => {
      const result = await Instances.importInstance(file, {
        abort: ctx.abort,
        onProgress: ctx.onProgress,
      });
      appendLauncherLog(`[版本] 导入完成: ${result.instance.name}`);
      send('instances:changed', {});
      return result;
    });
  }

  handle('task:cancel', async () => {
    if (!activeTask) return false;
    activeTask.abort.cancel();
    appendLauncherLog(`[任务] 用户取消: ${activeTask.name}`);
    return true;
  });

  handle('task:status', async () => {
    if (!activeTask) return { active: false };
    return { active: true, name: activeTask.name, label: activeTask.label, startedAt: activeTask.startedAt };
  });

  /* ------------------------------------------------------------------ */
  /* 樱花内网穿透 (Sakura Frp)                                           */
  /* ------------------------------------------------------------------ */

  handle('frp:status', async () => {
    const config = Config.get();
    const frpCfg = config.frp && typeof config.frp === 'object' ? config.frp : {};
    return {
      configured: Boolean(frpCfg.accessKeyEnc),
      account: frpCfg.account || '',
      lastTunnelId: frpCfg.lastTunnelId || '',
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      ...frp.status(),
    };
  });

  handle('frp:save-credentials', async (payload) => {
    const opts = obj(payload);
    const account = text(opts.account, '账号', 200);
    if (typeof opts.accessKey !== 'string' || !opts.accessKey.trim()) throw new Error('请输入访问密钥');
    if (opts.accessKey.length > 512) throw new Error('访问密钥过长');
    const enc = frpEncrypt(opts.accessKey.trim());
    const current = Config.get().frp || {};
    await Config.save({ frp: { account, accessKeyEnc: enc, lastTunnelId: current.lastTunnelId || '' } });
    appendLauncherLog('[樱花] 已加密保存访问密钥');
    return { configured: true, account };
  });

  handle('frp:tunnels', async () => {
    const tunnels = await frp.listTunnels(frpAccessKey());
    return { tunnels };
  });

  handle('frp:start', async (payload) => {
    const opts = obj(payload);
    const tunnelId = frpTunnelId(opts.tunnelId);
    const accessKey = frpAccessKey();
    const exe = p.frpcExe();
    broadcast(windows, 'frp:log', { line: '正在准备 frpc（首次使用需联网下载）…' });
    await frp.downloadFrpc({ dest: exe });
    const started = await frp.start({ accessKey, tunnelId, frpcPath: exe });
    const current = Config.get().frp || {};
    await Config.save({ frp: { ...current, lastTunnelId: tunnelId } });
    appendLauncherLog(`[樱花] 已启动隧道 ${tunnelId}`);
    return started;
  });

  handle('frp:stop', async () => {
    const stopped = await frp.stop();
    appendLauncherLog('[樱花] 已请求停止隧道');
    return stopped;
  });

  handle('frp:clear-credentials', async () => {
    await Config.save({ frp: { account: '', accessKeyEnc: '', lastTunnelId: '' } });
    appendLauncherLog('[樱花] 已清除访问密钥');
    return { configured: false };
  });

  /* ------------------------------------------------------------------ */
  /* 游戏进程结束                                                        */
  /* ------------------------------------------------------------------ */

  async function finishGame(info) {
    const id = runningInstanceId;
    runningInstanceId = '';
    const duration = Math.max(0, Date.now() - gameStartedAt);
    gameStartedAt = 0;
    if (!id) return;
    await Instances.updateLastPlayed(id, duration).catch(() => {});
    if (Config.get().closeOnLaunch) {
      const win = getMainWindow();
      if (win) win.show();
    }
    send('instances:changed', {});
  }

  appendLauncherLog('[IPC] 已注册');
  return { accountStore, game };
}

module.exports = { registerIpc };
