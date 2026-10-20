'use strict';

/**
 * authlib-injector 真实下载与 SHA-256 校验测试。
 * 运行：node scripts/smoke-authlib.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qutc-authlib-'));
process.env.QUTC_DATA = dataRoot;

const Paths = require('../src/core/paths');
const { ensureAuthlibInjector } = require('../src/core/authlib');
const { readJson } = require('../src/core/util');
const { verifyFile } = require('../src/core/hash');

async function main() {
  Paths.init({
    appRoot: path.join(__dirname, '..'),
    exeDir: path.join(__dirname, '..'),
    isPackaged: false,
    userDataDir: dataRoot,
    appVersion: '1.0.0',
  });
  const file = await ensureAuthlibInjector({ mirror: 'official', onLog: (line) => console.log(`  ${line}`) });
  const manifest = await readJson(path.join(Paths.getPaths().cache, 'authlib-injector-latest.json'), {});
  if (!fs.existsSync(file)) throw new Error('authlib-injector 未下载');
  if (!(await verifyFile(file, manifest.sha256, 'sha256'))) throw new Error('SHA-256 校验失败');
  console.log(`[authlib 冒烟] 通过: ${file}`);
}

main().catch((err) => {
  console.error('[authlib 冒烟] 失败:', err.message);
  process.exitCode = 1;
});
