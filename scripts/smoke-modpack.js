'use strict';

/**
 * 真实 .mrpack 安装冒烟测试。
 * 用法：node scripts/smoke-modpack.js <QUTCData 路径>
 * 该目录应已安装 1.20.1 与 Fabric 0.19.5（可用 smoke-install.js / smoke-loader.js 生成）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataRoot = process.argv[2];
if (!dataRoot || !fs.existsSync(dataRoot)) {
  console.error('用法: node scripts/smoke-modpack.js <QUTCData>');
  process.exit(1);
}
process.env.QUTC_DATA = dataRoot;

const Paths = require('../src/core/paths');
const Config = require('../src/core/config');
const Modrinth = require('../src/core/modrinth');
const Modpack = require('../src/core/modpack');
const { createZip } = require('../src/core/zip');
const { hashFile } = require('../src/core/hash');

async function main() {
  Paths.init({
    appRoot: path.join(__dirname, '..'),
    exeDir: path.join(__dirname, '..'),
    isPackaged: false,
    userDataDir: dataRoot,
    appVersion: '1.0.0',
  });
  await Config.load();
  await Config.save({ mirror: 'official', downloadConcurrency: 8 });

  const versions = await Modrinth.getProjectVersions('sodium', { gameVersion: '1.20.1', loader: 'fabric' });
  const version = versions.find((item) => item.files.some((file) => /\.jar$/i.test(file.filename)));
  if (!version) throw new Error('没有找到 Sodium 1.20.1 Fabric 版本');
  const file = version.files.find((item) => /\.jar$/i.test(item.filename));
  console.log(`[整合包冒烟] 使用 ${version.versionNumber} / ${file.filename} (${file.size} B)`);

  const pack = path.join(os.tmpdir(), `qutc-sodium-${Date.now()}.mrpack`);
  const writer = await createZip(pack);
  await writer.addJson('modrinth.index.json', {
    formatVersion: 1,
    game: 'minecraft',
    name: 'QUTC Sodium Smoke',
    versionId: '1.0.0',
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.19.5' },
    files: [
      {
        path: 'mods/sodium.jar',
        hashes: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 },
        downloads: [file.url],
        fileSize: file.size,
      },
    ],
  });
  await writer.addText('overrides/config/qutc-smoke.txt', 'QUTC modpack smoke OK');
  await writer.close();

  const result = await Modpack.installMrpack(pack, {
    onPhase: (phase) => console.log(`  · ${phase}`),
    onLog: (line) => console.log(`    ${line}`),
    onProgress: (p) => {
      if (p.bytesTotal) {
        process.stdout.write(`\r  ${p.phase || ''} ${((p.bytesDone / p.bytesTotal) * 100).toFixed(1)}%`);
      }
    },
  });
  process.stdout.write('\n');
  const gameDir = Paths.getPaths().instanceGameDir(result.instance.id);
  const modFile = path.join(gameDir, 'mods', 'sodium.jar');
  const override = path.join(gameDir, 'config', 'qutc-smoke.txt');
  if (!fs.existsSync(modFile)) throw new Error('Sodium 未写入实例');
  if ((await hashFile(modFile, 'sha1')) !== file.hashes.sha1) throw new Error('Sodium 哈希不符');
  if (!fs.existsSync(override)) throw new Error('overrides 未应用');
  console.log(`[整合包冒烟] 实例: ${result.instance.name} (${result.instance.id})`);
  console.log('[整合包冒烟] 通过');
  fs.rmSync(pack, { force: true });
}

main().catch((err) => {
  console.error('[整合包冒烟] 失败:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
