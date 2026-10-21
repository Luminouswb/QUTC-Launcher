'use strict';

/**
 * 主进程 IPC 冒烟测试（不启动 Electron GUI）。
 * 通过 require hook 替换 electron 模块，验证 IPC 注册、参数校验、账号存储与网络 API。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qutc-ipc-'));
process.env.QUTC_DATA = dataRoot;

const handlers = new Map();
const electronStub = {
  ipcMain: {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: '' }),
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from('x'),
    decryptString: () => 'x',
  },
  app: {
    getPath: () => dataRoot,
    getVersion: () => '1.0.0',
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

const Paths = require('../src/core/paths');
const Config = require('../src/core/config');

async function call(channel, payload) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册 IPC: ${channel}`);
  const result = await handler(null, payload);
  return result;
}

function expectOk(result, label) {
  if (!result || result.ok !== true) {
    throw new Error(`${label} 失败: ${result && result.error && result.error.message}`);
  }
  return result.data;
}

function expectFail(result, label) {
  if (!result || result.ok !== false) throw new Error(`${label} 应该被拒绝，但通过了`);
  return result.error;
}

async function main() {
  Paths.init({
    appRoot: path.join(__dirname, '..'),
    exeDir: path.join(__dirname, '..'),
    isPackaged: false,
    userDataDir: dataRoot,
    appVersion: '1.0.0',
  });
  await Config.load();
  const { registerIpc } = require('../src/main/ipc');
  await registerIpc({ windows: new Set(), getMainWindow: () => null });
  console.log(`[IPC 冒烟] 数据目录: ${dataRoot}`);

  const boot = expectOk(await call('app:bootstrap', null), 'bootstrap');
  if (!Array.isArray(boot.instances)) throw new Error('bootstrap 缺少 instances');
  console.log(`  ok  bootstrap（v${boot.appVersion}，${boot.installedVersions.length} 个已安装版本）`);

  const bad = expectFail(await call('versions:state', { id: '../../etc/passwd' }), '非法版本 ID');
  console.log(`  ok  非法版本 ID 被拒绝（${bad.message}）`);

  const offline = expectOk(await call('accounts:offline', { name: 'SmokeUser' }), '离线账号');
  if (!offline.accounts.some((a) => a.name === 'SmokeUser' && a.selected)) throw new Error('离线账号未保存');
  console.log('  ok  离线账号创建并选中');

  expectFail(await call('accounts:offline', { name: '中文名' }), '非法离线用户名');
  console.log('  ok  非法离线用户名被拒绝');

  expectFail(await call('accounts:ms-login', null), '无窗口时的微软登录');
  console.log('  ok  无窗口时微软登录给出明确错误');

  const saved = expectOk(await call('config:save', { memoryMb: 2048, mirror: 'bmclapi' }), '保存配置');
  if (saved.memoryMb !== 2048 || saved.mirror !== 'bmclapi') throw new Error('配置未生效');
  console.log('  ok  配置保存');

  const manifest = expectOk(await call('versions:manifest', {}), '版本清单');
  if (!manifest.versions.length || !manifest.latest.release) throw new Error('版本清单异常');
  console.log(`  ok  Mojang 版本清单（${manifest.versions.length} 个版本，最新 ${manifest.latest.release}）`);

  const fabric = expectOk(await call('loaders:versions', { loader: 'fabric', mcVersion: '1.20.1' }), 'Fabric 版本');
  if (!fabric.length) throw new Error('Fabric 版本列表为空');
  console.log(`  ok  Fabric 加载器列表（${fabric.length} 个）`);

  const packs = expectOk(await call('modpack:search', { query: 'sodium', limit: 3 }), 'Modrinth 搜索');
  if (!Array.isArray(packs.hits)) throw new Error('Modrinth 搜索结果异常');
  console.log(`  ok  Modrinth 搜索（${packs.hits.length} 个结果）`);

  const status = expectOk(await call('task:status', null), '任务状态');
  if (status.active) throw new Error('不应有活动任务');
  console.log('  ok  任务状态');

  expectFail(await call('app:open-external', { url: 'https://evil.example.com/' }), '非法外链');
  console.log('  ok  非法外链被拒绝');

  console.log('[IPC 冒烟] 全部通过');
}

main().catch((err) => {
  console.error('[IPC 冒烟] 失败:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
