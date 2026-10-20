'use strict';

/**
 * 加载器安装冒烟测试。
 * 用法：node scripts/smoke-loader.js <数据目录> [fabric|quilt|forge|neoforge]
 *
 * 数据目录应已安装对应原版版本（forge 需要 1.20.1，neoforge 需要 1.20.4）。
 * Forge/NeoForge 会真实运行官方安装器，可能耗时数分钟。
 */

const path = require('node:path');
const fs = require('node:fs');

const dataRoot = process.argv[2];
const loader = process.argv[3] || 'fabric';
if (!dataRoot || !fs.existsSync(dataRoot)) {
  console.error('用法: node scripts/smoke-loader.js <数据目录> [fabric|quilt|forge|neoforge]');
  process.exit(1);
}
process.env.QUTC_DATA = dataRoot;

const Paths = require('../src/core/paths');
const Config = require('../src/core/config');
const Loaders = require('../src/core/loaders');
const Versions = require('../src/core/versions');

const MC = loader === 'neoforge' ? '1.20.4' : '1.20.1';

async function main() {
  Paths.init({
    appRoot: path.join(__dirname, '..'),
    exeDir: path.join(__dirname, '..'),
    isPackaged: false,
    userDataDir: dataRoot,
    appVersion: '1.0.0',
  });
  await Config.load();
  await Config.save({ mirror: 'bmclapi', downloadConcurrency: 16, memoryMb: 2048 });

  let loaderVersion = process.env.LOADER_VERSION || '';
  if (!loaderVersion) {
    const list = await Loaders.listLoaderVersions(loader, MC, {});
    if (!list.length) throw new Error(`${loader} 没有可用版本`);
    loaderVersion = (list.find((item) => item.stable) || list[0]).version;
  }
  console.log(`[加载器冒烟] ${loader} ${loaderVersion} / MC ${MC}`);

  const onPhase = (phase) => console.log(`  · ${phase}`);
  const result = await Loaders.installLoader({
    loader,
    mcVersion: MC,
    loaderVersion,
    ctx: {
      consent: true,
      mirror: 'bmclapi',
      concurrency: 16,
      onPhase,
      onLog: (line) => {
        if (!/[.]{4,}/.test(line)) console.log(`    ${line}`);
      },
      onProgress: (p) => {
        if (p.bytesTotal) {
          process.stdout.write(`\r  ${p.phase || ''} ${((p.bytesDone / p.bytesTotal) * 100).toFixed(1)}%`);
        }
      },
    },
  });
  process.stdout.write('\n');
  if (!result || !result.versionId) throw new Error('加载器安装没有返回版本 ID');

  const state = await Versions.getInstallState(result.versionId);
  if (!state.installed) throw new Error(`安装状态异常: ${state.reason}`);
  const resolved = await Versions.resolveVersion(result.versionId);
  console.log(`[加载器冒烟] 版本: ${result.versionId}`);
  console.log(`[加载器冒烟] mainClass: ${resolved.json.mainClass}`);
  console.log(`[加载器冒烟] 继承链: ${resolved.chain.join(' -> ')}`);
  console.log('[加载器冒烟] 通过');
}

main().catch((err) => {
  console.error('\n[加载器冒烟] 失败:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
