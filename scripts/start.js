'use strict';

/**
 * 开发模式启动器。
 *
 * 直接把 Electron 放在 DSH 工作区里运行时，Chromium 子进程会崩溃
 * （Windows 事件日志 0xc0000005）。因此先把 vendor/electron 复制到
 * %LOCALAPPDATA%\QUTC-Launcher\runtime，再从那里启动，项目源码仍留在工作区。
 *
 * 某些环境会设置 ELECTRON_RUN_AS_NODE=1，这会让 electron.exe 变成普通 Node，
 * 因此这里显式删除该变量。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'vendor', 'electron');
const vendorExe = path.join(vendor, 'electron.exe');
if (!fs.existsSync(vendorExe)) {
  console.error('未找到 vendor/electron/electron.exe，请先下载 Electron 运行时（见 README）。');
  process.exit(1);
}

const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
const runtime = path.join(base, 'QUTC-Launcher', 'runtime');
const runtimeExe = path.join(runtime, 'electron.exe');

function readVersion(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'version'), 'utf8').trim();
  } catch (err) {
    return '';
  }
}

if (readVersion(vendor) !== readVersion(runtime) || !fs.existsSync(runtimeExe)) {
  console.log('正在准备 QUTC 运行时...');
  fs.rmSync(runtime, { recursive: true, force: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.cpSync(vendor, runtime, { recursive: true });
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(runtimeExe, [root], { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code === null ? 1 : code));
child.on('error', (err) => {
  console.error('启动 Electron 失败:', err.message);
  process.exit(1);
});
