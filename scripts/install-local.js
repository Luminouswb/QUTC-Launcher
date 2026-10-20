'use strict';

/**
 * 把便携版安装到当前用户的 LocalAppData，并在桌面创建快捷方式。
 * 这样运行时不在 DSH/沙箱受限的工作区目录内，Electron 可以正常启动。
 *
 * 运行：node scripts/install-local.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const source = path.join(root, 'dist', 'QUTC-Launcher');
const target = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'QUTC-Launcher');
const exeName = 'QUTC Launcher.exe';

if (!fs.existsSync(path.join(source, exeName))) {
  console.error(`找不到便携版目录：${source}`);
  console.error('请先运行: node scripts/package-win.js');
  process.exit(1);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

console.log(`安装到: ${target}`);
copyDir(source, target);

// 保留用户已有的 QUTCData，不覆盖
const exe = path.join(target, exeName);
if (!fs.existsSync(exe)) {
  console.error('安装后找不到主程序');
  process.exit(1);
}

const desktop = path.join(os.homedir(), 'Desktop');
const shortcut = path.join(desktop, 'QUTC Launcher.lnk');
const ps = [
  '$ws = New-Object -ComObject WScript.Shell',
  `$s = $ws.CreateShortcut('${shortcut.replace(/'/g, "''")}')`,
  `$s.TargetPath = '${exe.replace(/'/g, "''")}'`,
  `$s.WorkingDirectory = '${target.replace(/'/g, "''")}'`,
  `$s.IconLocation = '${exe.replace(/'/g, "''")},0'`,
  "$s.Description = 'QUTC Minecraft Club Launcher'",
  '$s.Save()',
].join('; ');

const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
  windowsHide: true,
  encoding: 'utf8',
});
if (result.status !== 0) {
  console.warn('桌面快捷方式创建失败（可手动打开安装目录）：', result.stderr || result.stdout);
} else {
  console.log(`桌面快捷方式: ${shortcut}`);
}

console.log('');
console.log('完成。以后请从桌面「QUTC Launcher」快捷方式启动，');
console.log(`或直接运行: ${exe}`);
