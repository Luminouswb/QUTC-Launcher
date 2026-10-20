'use strict';

/**
 * 生成便携版：dist/QUTC-Launcher/
 *
 * 结构（Electron 便携应用）：
 *   QUTC Launcher.exe          （C# 引导器：优先启动 LocalAppData/旁边的 runtime）
 *   QUTC Launcher.runtime.exe  （Electron 本体）
 *   resources/app/{package.json,src,...}
 *   ...Electron 运行时
 *
 * 运行：node scripts/package-win.js [--no-zip]
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const distRoot = path.join(root, 'dist');
const outDir = path.join(distRoot, 'QUTC-Launcher');
const electronDir = path.join(root, 'vendor', 'electron');
const bootstrap = path.join(root, 'build', 'launcher-bootstrap.exe');

if (!fs.existsSync(path.join(electronDir, 'electron.exe'))) {
  console.error('缺少 vendor/electron/electron.exe，无法打包。');
  process.exit(1);
}
if (!fs.existsSync(bootstrap)) {
  console.error('缺少 build/launcher-bootstrap.exe，无法打包。');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.cpSync(electronDir, outDir, { recursive: true });
const oldExe = path.join(outDir, 'electron.exe');
if (fs.existsSync(oldExe)) fs.renameSync(oldExe, path.join(outDir, 'QUTC Launcher.runtime.exe'));
fs.copyFileSync(bootstrap, path.join(outDir, 'QUTC Launcher.exe'));

const appDir = path.join(outDir, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
fs.cpSync(path.join(root, 'src'), path.join(appDir, 'src'), { recursive: true });
for (const file of ['package.json', 'README.md', 'SECURITY.md', 'LICENSE']) {
  const source = path.join(root, file);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(appDir, file));
}
fs.copyFileSync(path.join(root, 'build', 'icon.ico'), path.join(outDir, 'icon.ico'));

const version = pkg.version;
fs.writeFileSync(
  path.join(outDir, '启动说明.txt'),
  [
    `QUTC Launcher v${version}`,
    '',
    '双击 “QUTC Launcher.exe” 启动。',
    '如果双击无反应（常见于 DSH/沙箱工作区），请把整个 QUTC-Launcher 文件夹',
    '复制到普通目录（例如 C:\\QUTC）后再双击；不要直接在受限工作区内运行。',
    '首次启动会在 exe 同目录创建 QUTCData/（便携数据目录）。',
    '账户、实例、游戏文件都在 QUTCData 中，备份时整个目录复制即可。',
    'QUTC Minecraft Club 内部使用。',
  ].join('\r\n'),
  'utf8',
);

if (!process.argv.includes('--no-zip')) {
  const zip = path.join(distRoot, `QUTC-Launcher-${version}-win-x64.zip`);
  fs.rmSync(zip, { force: true });
  console.log('正在压缩便携版（Electron 体积较大，请稍候）…');
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -LiteralPath '${outDir.replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -CompressionLevel Optimal`,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) console.error('压缩失败，可手动压缩 dist/QUTC-Launcher。');
  else console.log(`已生成 ${zip}`);
}

console.log(`便携版目录：${outDir}`);
