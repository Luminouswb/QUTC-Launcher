'use strict';

/**
 * 实例导出 / 导入冒烟测试（不联网）。
 * 运行：node scripts/smoke-instance.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qutc-inst-'));
process.env.QUTC_DATA = dataRoot;

const Paths = require('../src/core/paths');
const Instances = require('../src/core/instances');
const { createZip } = require('../src/core/zip');

async function main() {
  Paths.init({
    appRoot: path.join(__dirname, '..'),
    exeDir: path.join(__dirname, '..'),
    isPackaged: false,
    userDataDir: dataRoot,
    appVersion: '1.0.0',
  });

  const instance = await Instances.createInstance({
    name: '导出测试',
    versionId: '1.20.1',
    mcVersion: '1.20.1',
    loader: { type: 'fabric', version: '0.15.11' },
    memoryMb: 4096,
  });
  const gameDir = Paths.getPaths().instanceGameDir(instance.id);
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'mods', 'test.jar'), Buffer.from('fake-jar'));
  fs.mkdirSync(path.join(gameDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'config', 'a.txt'), 'hello qutc');
  fs.mkdirSync(path.join(gameDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'logs', 'should-not-export.log'), 'x');

  const out = path.join(dataRoot, 'test.qutc');
  const exported = await Instances.exportInstance(instance.id, out);
  if (!fs.existsSync(out) || exported.files < 2) throw new Error('导出失败');
  console.log(`  ok  导出 ${exported.files} 个文件，${exported.bytes} 字节`);

  const imported = await Instances.importInstance(out);
  if (!imported.instance || imported.instance.name === instance.name) {
    // 同名会生成 “导出测试 (2)”
  }
  const importedDir = Paths.getPaths().instanceGameDir(imported.instance.id);
  const modText = fs.readFileSync(path.join(importedDir, 'mods', 'test.jar'), 'utf8');
  const cfgText = fs.readFileSync(path.join(importedDir, 'config', 'a.txt'), 'utf8');
  if (modText !== 'fake-jar' || cfgText !== 'hello qutc') throw new Error('导入内容不完整');
  if (fs.existsSync(path.join(importedDir, 'logs', 'should-not-export.log'))) {
    throw new Error('日志目录不应被导出');
  }
  console.log(`  ok  导入实例「${imported.instance.name}」，文件内容一致，日志已排除`);

  // 恶意 versionId 必须被拒绝
  const evil = path.join(dataRoot, 'evil.qutc');
  const writer = await createZip(evil);
  await writer.addJson('instance.json', {
    format: 'qutc-instance',
    instance: { name: 'evil', versionId: '../../windows/system32', loader: { type: 'vanilla' } },
  });
  await writer.addText('minecraft/mods/a.txt', 'x');
  await writer.close();
  let rejected = false;
  try {
    await Instances.importInstance(evil);
  } catch (err) {
    rejected = /版本 ID 非法/.test(err.message);
  }
  if (!rejected) throw new Error('恶意 versionId 未被拒绝');
  console.log('  ok  恶意 versionId 被拒绝');

  console.log(`[实例冒烟] 通过，数据目录: ${dataRoot}`);
}

main().catch((err) => {
  console.error('[实例冒烟] 失败:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
