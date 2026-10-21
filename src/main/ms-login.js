'use strict';

/**
 * 弹出微软登录窗口，并在跳转到官方桌面回调时取走授权码。
 * 这个窗口不加载启动器 preload，没有 Node 权限。
 */

const { BrowserWindow, session } = require('electron');
const MicrosoftAuth = require('../core/auth/microsoft');

const PARTITION = 'persist:qutc-microsoft';

let pending = null;

function browserUserAgent() {
  const chrome = process.versions.chrome || '128.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

function openMicrosoftLogin(parent) {
  if (pending && pending.win && !pending.win.isDestroyed()) {
    pending.win.focus();
    return pending.promise;
  }

  let settled = false;
  let win = null;
  let stopWatching = () => {};
  const windows = new Set();

  const promise = new Promise((resolve, reject) => {
    const settle = (err, code) => {
      if (settled) return;
      settled = true;
      pending = null;
      stopWatching();
      for (const item of windows) {
        if (!item.isDestroyed()) item.destroy();
      }
      if (err) reject(err);
      else resolve(code);
    };

    const consume = (url) => {
      let code;
      try {
        code = MicrosoftAuth.parseRedirectUrl(url);
      } catch (err) {
        settle(err);
        return true;
      }
      if (!code) return false;
      settle(null, code);
      return true;
    };

    const attach = (target) => {
      windows.add(target);
      target.webContents.setWindowOpenHandler(() => ({
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: win || parent,
          width: 480,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: loginPreferences(ses),
        },
      }));
      target.webContents.on('did-create-window', (child) => attach(child));
      target.webContents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
        if (isMainFrame === false) return;
        if (consume(url)) event.preventDefault();
      });
      target.webContents.on('will-navigate', (event, url) => {
        if (consume(url)) event.preventDefault();
      });
      target.on('closed', () => {
        windows.delete(target);
        if (windows.size === 0) settle(new MicrosoftAuth.AuthError('登录已取消', 'cancelled'));
      });
    };

    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setUserAgent(browserUserAgent());
    ses.webRequest.onBeforeRequest(
      { urls: ['https://login.live.com/oauth20_desktop.srf*'] },
      (details, callback) => {
        const mainFrame = details.resourceType === 'mainFrame' || details.resourceType === 'main_frame';
        const handled = mainFrame && consume(details.url);
        callback({ cancel: Boolean(handled) });
      },
    );
    stopWatching = () => {
      try {
        ses.webRequest.onBeforeRequest(null);
      } catch {
        /* 会话可能已经释放 */
      }
    };

    win = new BrowserWindow({
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: Boolean(parent && !parent.isDestroyed()),
      width: 480,
      height: 720,
      title: '登录微软账号',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: loginPreferences(ses),
    });
    attach(win);
    win.loadURL(MicrosoftAuth.buildAuthorizeUrl()).catch((err) => {
      if (!settled) settle(err);
    });
  });

  pending = { win, promise };
  promise.then(
    () => {
      if (pending && pending.promise === promise) pending = null;
    },
    () => {
      if (pending && pending.promise === promise) pending = null;
    },
  );
  return promise;
}

function loginPreferences(ses) {
  return {
    session: ses,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
  };
}

module.exports = { openMicrosoftLogin };
