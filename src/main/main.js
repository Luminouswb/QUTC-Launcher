'use strict';

/**
 * QUTC Launcher - Electron 主进程入口
 *
 * 安全基线：
 * - 渲染进程运行在 sandbox + contextIsolation 下，没有 Node 权限；
 * - 所有能力通过 preload 暴露的白名单 IPC 调用；
 * - 禁止页面内导航、禁止 window.open、外链只允许白名单域名；
 * - 主进程只加载本地 src/renderer/index.html，不加载任何远程页面。
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu, shell, session, protocol, net } = require('electron');

const Paths = require('../core/paths');
const Config = require('../core/config');
const { registerIpc } = require('./ipc');
const { appendLauncherLog } = require('./log');

const APP_ID = 'club.qutc.launcher';
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, 'preload.js');

// 本地资源协议（背景图），必须在 app ready 之前注册为特权 scheme
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'qutc-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
  },
]);

let mainWindow = null;
const windows = new Set();

app.setAppUserModelId(APP_ID);
// 关闭 Chromium 的磁盘缓存/日志，减少数据目录噪音
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  boot();
}

function boot() {
  app.whenReady().then(async () => {
    hardenSession();
    Menu.setApplicationMenu(null);

    const isPackaged = app.isPackaged;
    const exeDir = path.dirname(app.getPath('exe'));
    Paths.init({
      appRoot: app.getAppPath(),
      exeDir,
      isPackaged,
      userDataDir: app.getPath('userData'),
      appVersion: app.getVersion(),
    });
    await Config.load();
    appendLauncherLog(`启动器启动，数据目录: ${Paths.getPaths().root}`);

    await registerIpc({ app, windows, getMainWindow: () => mainWindow });
    registerAssetProtocol();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // 渲染进程不需要发起 API 请求：仅允许本地页面、内联资源与远程图片（封面/头像/皮肤）
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      if (
        url.protocol === 'file:' ||
        url.protocol === 'data:' ||
        url.protocol === 'blob:' ||
        url.protocol === 'qutc-asset:'
      ) {
        return callback({ cancel: false });
      }
      if (url.protocol === 'https:' && details.resourceType === 'image') {
        return callback({ cancel: false });
      }
      return callback({ cancel: true });
    } catch {
      return callback({ cancel: true });
    }
  });
}

/**
 * qutc-asset:// 只从 QUTCData/cache 读取背景图，不做任何其它映射。
 * 文件名来自 Config.backgroundImage（如 background.png），并做白名单校验防穿越。
 */
function registerAssetProtocol() {
  const cacheDir = Paths.getPaths().cache;
  protocol.handle('qutc-asset', (request) => {
    try {
      const url = new URL(request.url);
      const name = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0];
      if (name !== 'background') return new Response('Not Found', { status: 404 });
      const file = Config.get().backgroundImage;
      if (!file || !/^background\.(png|jpe?g|webp)$/i.test(file)) {
        return new Response('Not Found', { status: 404 });
      }
      const full = path.resolve(cacheDir, file);
      if (!full.startsWith(path.resolve(cacheDir) + path.sep)) {
        return new Response('Not Found', { status: 404 });
      }
      return net.fetch(pathToFileURL(full).toString());
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'QUTC Launcher',
    backgroundColor: '#0d1014',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'renderer', 'logo.png'),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow = win;
  windows.add(win);

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    windows.delete(win);
    if (mainWindow === win) mainWindow = null;
  });

  // 禁止渲染进程跳转、弹窗
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    const { isAllowedExternalUrl } = require('../core/security');
    if (isAllowedExternalUrl(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  win.loadFile(RENDERER);

  // 测试/截图模式：QUTC_SCREENSHOT=<png 路径> 时渲染完成后截图并退出
  const shot = process.env.QUTC_SCREENSHOT;
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
          fs.mkdirSync(path.dirname(shot), { recursive: true });
          fs.writeFileSync(shot, image.toPNG());
          appendLauncherLog(`截图已保存: ${shot}`);
        } catch (err) {
          appendLauncherLog(`截图失败: ${err.message}`);
        } finally {
          app.quit();
        }
      }, 1800);
    });
  }
  return win;
}

process.on('uncaughtException', (err) => {
  appendLauncherLog(`[致命] 未捕获异常: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (err) => {
  appendLauncherLog(`[警告] 未处理的 Promise 拒绝: ${err && err.stack ? err.stack : err}`);
});

module.exports = { createWindow };
