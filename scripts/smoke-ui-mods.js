'use strict';

/**
 * 通过 Chromium DevTools 协议实际驱动 Electron 界面，验证 MOD 页面和 IPC。
 * 用法：node scripts/smoke-ui-mods.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qutc-ui-mod-'));
process.env.QUTC_DATA = dataRoot;

const Paths = require('../src/core/paths');
const Instances = require('../src/core/instances');
const Config = require('../src/core/config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout, label) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`等待超时: ${label}`);
}

async function main() {
  Paths.init({
    appRoot: root,
    exeDir: root,
    isPackaged: false,
    userDataDir: dataRoot,
    appVersion: '1.0.0',
  });
  await Config.load();
  await Config.save({ acceptedSecurityNotice: true });
  const instance = await Instances.createInstance({
    name: 'UI MOD 测试',
    versionId: 'fabric-loader-0.19.5-1.20.1',
    mcVersion: '1.20.1',
    loader: { type: 'fabric', version: '0.19.5' },
  });

  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const runtime = path.join(base, 'QUTC-Launcher', 'runtime', 'electron.exe');
  if (!fs.existsSync(runtime)) throw new Error(`缺少运行时: ${runtime}，请先运行 node scripts/setup.js --runtime-only`);

  const port = 9333;
  const env = { ...process.env, QUTC_DATA: dataRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.QUTC_SCREENSHOT;
  const child = spawn(runtime, [`--remote-debugging-port=${port}`, root], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  console.log(`[UI MOD] Electron pid=${child.pid}, data=${dataRoot}`);

  try {
    const list = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const pages = await res.json();
        return pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl);
      } catch {
        return null;
      }
    }, 20000, 'DevTools 端口');
    console.log(`[UI MOD] 页面: ${list.url}`);

    const ws = new WebSocket(list.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || '页面脚本异常');
      }
      return result.result.value;
    };

    await send('Runtime.enable');
    await waitFor(() => evaluate("document.getElementById('app') && !document.getElementById('app').hidden").catch(() => false), 20000, '应用初始化');
    await evaluate("document.querySelector('[data-view=\"mods\"]').click()");
    await sleep(600);
    await evaluate("document.getElementById('mod-search').value='钠'; document.getElementById('btn-mod-search').click()");
    const titles = await waitFor(async () => {
      const list = await evaluate("[...document.querySelectorAll('#mod-grid .pack-card strong')].map((n) => n.textContent)");
      return Array.isArray(list) && list.length ? list : null;
    }, 25000, 'MOD 搜索结果');
    console.log(`[UI MOD] 中文搜索“钠”结果: ${titles.slice(0, 3).join(' / ')}`);
    if (!titles.some((title) => /sodium/i.test(title))) throw new Error('中文别名没有匹配到 Sodium');
    const hint = await evaluate("document.getElementById('mod-hint').textContent");
    if (!/sodium/i.test(hint)) throw new Error(`中文搜索提示没有显示英文别名: ${hint}`);

    await evaluate("document.querySelector('#mod-grid .pack-card .btn').click()");
    await waitFor(() => evaluate("Boolean(document.querySelector('#modal-root .modal'))"), 10000, 'MOD 版本弹窗');
    const versions = await evaluate("[...document.querySelectorAll('#modal-root select option')].length");
    if (!versions) throw new Error('版本弹窗没有选项');
    await evaluate("document.querySelector('#modal-root .modal-actions .btn.primary').click()");

    const installed = await waitFor(() => {
      const dir = path.join(dataRoot, 'instances', instance.id, 'minecraft', 'mods');
      if (!fs.existsSync(dir)) return null;
      const jars = fs.readdirSync(dir).filter((name) => name.endsWith('.jar'));
      return jars.length ? jars : null;
    }, 60000, 'MOD 文件写入');
    console.log(`[UI MOD] 已写入: ${installed.join(', ')}`);

    await evaluate("document.querySelector('[data-view=\"accounts\"]').click()");
    await sleep(300);
    const hasYgg = await evaluate("Boolean(document.getElementById('ygg-username') && document.getElementById('ygg-password') && document.getElementById('btn-ygg-login'))");
    if (!hasYgg) throw new Error('账户页缺少外置登录表单');
    console.log('[UI MOD] 外置登录表单存在');

    await evaluate(`(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'authlib-injector:yggdrasil-server:' + encodeURIComponent('https://littleskin.cn/api/yggdrasil'));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(2500);
    const serverValue = await evaluate("document.getElementById('ygg-auth-server').value");
    if (!serverValue.includes('littleskin.cn')) throw new Error(`拖拽没有填入服务器: ${serverValue}`);
    console.log(`[UI MOD] 拖拽后验证服务器: ${serverValue}`);
    console.log('[UI MOD] 通过');
    ws.close();
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

main().catch((err) => {
  console.error('[UI MOD] 失败:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
