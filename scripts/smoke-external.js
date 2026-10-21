'use strict';

/**
 * 外部文件夹实例冒烟测试：原地注册、不复制、删除不碰原目录。
 * 运行：node scripts/smoke-external.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qutc-external-inst-'));
const external = fs.mkdtempSync(path.join(os.tmpdir(), 'qutc-external-dir-'));
fs.writeFileSync(path.join(external, 'marker.txt'), 'keep me');
process.env.QUTC_DATA = dataRoot;
process.env.EXT_DIR = external;

const Paths = require('../src/core/paths');
const Instances = require('../src/core/instances');

async function main() {
  Paths.init({
    appRoot: path.join(__dirname, '..'),
    exeDir: path.join(__dirname, '..'),
    isPackaged: false,
    userDataDir: dataRoot,
    appVersion: '1.0.0',
  });
  const instance = await Instances.createExternalInstance({
    name: '外部目录测试',
    versionId: '1.20.1',
    mcVersion: '1.20.1',
    loader: { type: 'vanilla', version: '' },
    externalGameDir: external,
  });
  assert.strictEqual(instance.external, true);
  assert.strictEqual(
    fs.realpathSync.native(await Instances.getGameDir(instance.id)).toLowerCase(),
    fs.realpathSync.native(external).toLowerCase(),
  );

  const list = await Instances.listInstances();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].external, true);

  await assert.rejects(() => Instances.duplicateInstance(instance.id, '副本'), /外部/);
  await Instances.deleteInstance(instance.id);
  assert.strictEqual(fs.existsSync(path.join(external, 'marker.txt')), true);
  assert.strictEqual((await Instances.listInstances()).length, 0);
  console.log('[外部实例冒烟] 通过：原地使用、禁止复制、删除不碰原目录');
}

main().catch((err) => {
  console.error('[外部实例冒烟] 失败:', err.message);
  process.exitCode = 1;
});
