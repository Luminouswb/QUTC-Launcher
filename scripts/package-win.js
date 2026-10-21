'use strict';

/**
 * 组装 Windows 便携目录。
 *
 *   QUTC Launcher.exe          由 build/launcher-bootstrap.cs 编译的引导器
 *   QUTC Launcher.runtime.exe  Electron 本体
 *   resources/app/             启动器源码
 *
 * 直接运行会输出到 dist/QUTC-Launcher，并默认打 zip。
 * 日常安装请用 node scripts/setup.js。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, electronDir, ensureElectron, compileBootstrap } = require('./runtime');

const pkg = require(path.join(root, 'package.json'));

function portableDir() {
  return path.join(root, 'dist', 'QUTC-Launcher');
}

function resetDir(outDir, keep) {
  fs.mkdirSync(outDir, { recursive: true });
  const keepNames = new Set(keep || []);
  for (const name of fs.readdirSync(outDir)) {
    if (keepNames.has(name)) continue;
    try {
      fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
    } catch (err) {
      throw new Error(`无法更新 ${outDir}。请先退出正在运行的 QUTC Launcher。${err.message}`);
    }
  }
}

function buildPortable(outDir, options = {}) {
  const exe = path.join(electronDir, 'electron.exe');
  const bootstrap = path.join(root, 'build', 'launcher-bootstrap.exe');
  if (!fs.existsSync(exe)) {
    throw new Error('缺少 Electron 运行时。请先运行 node scripts/setup.js');
  }
  if (!fs.existsSync(bootstrap)) {
    throw new Error('缺少引导器。请先运行 node scripts/setup.js');
  }

  resetDir(outDir, options.keep);
  fs.cpSync(electronDir, outDir, { recursive: true });
  fs.renameSync(path.join(outDir, 'electron.exe'), path.join(outDir, 'QUTC Launcher.runtime.exe'));
  fs.copyFileSync(bootstrap, path.join(outDir, 'QUTC Launcher.exe'));
  fs.copyFileSync(path.join(root, 'build', 'icon.ico'), path.join(outDir, 'icon.ico'));

  const appDir = path.join(outDir, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.cpSync(path.join(root, 'src'), path.join(appDir, 'src'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'SECURITY.md', 'LICENSE']) {
    const source = path.join(root, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(appDir, file));
  }

  fs.writeFileSync(
    path.join(outDir, '启动说明.txt'),
    [
      `QUTC Launcher ${pkg.version}`,
      '',
      '双击 QUTC Launcher.exe 启动。',
      '账号、实例和游戏文件保存在同目录的 QUTCData/，复制该目录即可备份。',
      'QUTC Minecraft Club 内部使用。',
    ].join('\r\n'),
    'utf8',
  );

  if (options.zip) {
    const zip = path.join(root, 'dist', `QUTC-Launcher-${pkg.version}-win-x64.zip`);
    fs.mkdirSync(path.dirname(zip), { recursive: true });
    fs.rmSync(zip, { force: true });
    console.log('正在压缩便携版...');
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -LiteralPath '${outDir.replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -CompressionLevel Optimal`,
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      console.error(`压缩失败，便携目录仍在 ${outDir}`);
    } else {
      console.log(`已生成 ${zip}`);
    }
  }

  console.log(`便携目录: ${outDir}`);
  return outDir;
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Windows 打包脚本只能在 Windows 上运行');
  }
  await ensureElectron();
  compileBootstrap();
  const zip = !process.argv.includes('--no-zip');
  buildPortable(portableDir(), { zip });
}

module.exports = { buildPortable, portableDir };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
