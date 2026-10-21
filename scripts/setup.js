'use strict';

/**
 * 一条命令完成自行部署：
 *   node scripts/setup.js
 *
 * 下载并校验 Electron，编译引导器，安装到 %LOCALAPPDATA%\QUTC-Launcher，
 * 并创建桌面快捷方式。已有的 QUTCData 会保留。
 */

const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ensureElectron, compileBootstrap } = require('./runtime');
const { buildPortable, portableDir } = require('./package-win');

function printHelp() {
  console.log(`QUTC Launcher 部署

  node scripts/setup.js                 安装到本机，并创建桌面快捷方式
  node scripts/setup.js --portable      生成 dist/QUTC-Launcher
  node scripts/setup.js --portable --zip
                                        再打成 zip
  node scripts/setup.js --runtime-only  只准备 Electron，供 npm start 使用
`);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createShortcut(exe, workingDir) {
  const script = [
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    "$shortcut = Join-Path $desktop 'QUTC Launcher.lnk'",
    '$ws = New-Object -ComObject WScript.Shell',
    '$s = $ws.CreateShortcut($shortcut)',
    `$s.TargetPath = ${psQuote(exe)}`,
    `$s.WorkingDirectory = ${psQuote(workingDir)}`,
    `$s.IconLocation = ${psQuote(`${exe},0`)}`,
    "$s.Description = 'QUTC Minecraft Club Launcher'",
    '$s.Save()',
    'Write-Output $shortcut',
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    console.warn('桌面快捷方式创建失败，可以直接运行:');
    console.warn(exe);
    if (result.stderr) console.warn(String(result.stderr).trim());
    return;
  }
  const created = String(result.stdout || '').trim();
  if (created) console.log(`桌面快捷方式: ${created}`);
}

function installDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'QUTC-Launcher');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    printHelp();
    return;
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) throw new Error('需要 Node.js 18 或更高版本');
  if (process.platform !== 'win32') throw new Error('自动部署目前只支持 Windows');

  await ensureElectron();
  if (args.has('--runtime-only')) {
    console.log('Electron 运行时已就绪。开发启动请执行 npm start，或双击 run.cmd。');
    return;
  }

  compileBootstrap();
  if (args.has('--portable')) {
    buildPortable(portableDir(), { zip: args.has('--zip') });
    return;
  }
  if (args.has('--zip')) {
    throw new Error('打 zip 请运行 node scripts/setup.js --portable --zip');
  }

  const target = installDir();
  console.log(`安装到 ${target}`);
  buildPortable(target, { keep: ['QUTCData'] });
  createShortcut(path.join(target, 'QUTC Launcher.exe'), target);
  console.log('安装完成。从桌面「QUTC Launcher」启动。');
  console.log('账号和游戏文件在该目录的 QUTCData/。再次运行本命令会更新程序并保留这份数据。');
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
