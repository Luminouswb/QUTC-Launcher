'use strict';

/**
 * 准备 Windows 部署所需的 Electron 运行时，并从源码编译引导器。
 * Electron 31.7.7 win32-x64 的 SHA-256 来自官方 SHASUMS256.txt。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');

const ELECTRON_VERSION = '31.7.7';
const ZIP_NAME = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
const ZIP_SHA256 = 'e91986dd243d55947e6c5d3fad21795562ec21fa0eec5e95f7e28c830571467f';

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'vendor', 'electron');

const MIRRORS = [
  `https://registry.npmmirror.com/-/binary/electron/v${ELECTRON_VERSION}/${ZIP_NAME}`,
  `https://npmmirror.com/mirrors/electron/v${ELECTRON_VERSION}/${ZIP_NAME}`,
  `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ZIP_NAME}`,
];

function readVersion(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'version'), 'utf8').trim();
  } catch {
    return '';
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function download(url, dest) {
  const part = `${dest}.part`;
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'QUTC-Launcher-Setup' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  let lastReport = 0;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received - lastReport >= 8 * 1024 * 1024) {
        lastReport = received;
        const done = (received / 1048576).toFixed(0);
        const all = total ? (total / 1048576).toFixed(0) : '?';
        process.stdout.write(`\r  ${done} / ${all} MB`);
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), progress, fs.createWriteStream(part));
    process.stdout.write('\n');
    const digest = await sha256File(part);
    if (digest !== ZIP_SHA256) {
      throw new Error(`SHA-256 不符（${digest}）`);
    }
    fs.renameSync(part, dest);
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
}

async function ensureElectron() {
  if (fs.existsSync(path.join(electronDir, 'electron.exe')) && readVersion(electronDir) === ELECTRON_VERSION) {
    return electronDir;
  }

  const zipPath = path.join(root, 'vendor', ZIP_NAME);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  let ready = fs.existsSync(zipPath) && (await sha256File(zipPath)) === ZIP_SHA256;
  if (!ready) {
    fs.rmSync(zipPath, { force: true });
    let lastError = null;
    for (const url of MIRRORS) {
      try {
        console.log(`下载 Electron ${ELECTRON_VERSION}`);
        console.log(`  ${url}`);
        await download(url, zipPath);
        ready = true;
        break;
      } catch (err) {
        lastError = err;
        console.error(`  失败: ${err.message}`);
        fs.rmSync(zipPath, { force: true });
      }
    }
    if (!ready) {
      throw new Error(lastError ? `无法下载 Electron：${lastError.message}` : '无法下载 Electron');
    }
  }

  console.log('解压 Electron 运行时...');
  fs.rmSync(electronDir, { recursive: true, force: true });
  fs.mkdirSync(electronDir, { recursive: true });
  const extracted = spawnSync('tar', ['-xf', zipPath, '-C', electronDir], { stdio: 'inherit' });
  if (extracted.status !== 0 || !fs.existsSync(path.join(electronDir, 'electron.exe'))) {
    throw new Error('解压 Electron 失败');
  }
  fs.rmSync(zipPath, { force: true });
  return electronDir;
}

function cscPath() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function compileBootstrap() {
  const source = path.join(root, 'build', 'launcher-bootstrap.cs');
  const icon = path.join(root, 'build', 'icon.ico');
  const out = path.join(root, 'build', 'launcher-bootstrap.exe');
  const csc = cscPath();
  if (!csc) {
    throw new Error('找不到 csc.exe。Windows 通常自带 .NET Framework 4，位于 %WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319\\');
  }
  console.log('编译引导器...');
  const args = ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll'];
  if (fs.existsSync(icon)) args.push(`/win32icon:${icon}`);
  args.push(`/out:${out}`, source);
  const result = spawnSync(csc, args, { stdio: 'inherit' });
  if (result.status !== 0 || !fs.existsSync(out)) {
    throw new Error('编译引导器失败');
  }
  return out;
}

module.exports = {
  ELECTRON_VERSION,
  ZIP_SHA256,
  root,
  electronDir,
  ensureElectron,
  compileBootstrap,
};
