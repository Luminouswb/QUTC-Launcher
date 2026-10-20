'use strict';

/**
 * MOD 下载真实冒烟测试（会访问 Modrinth 并下载文件）。
 * 用法：node scripts/smoke-mod.js [临时数据目录]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hashFile } = require('../src/core/hash');

async function main() {
  const dataRoot = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qutc-mod-'));
  process.env.QUTC_DATA = dataRoot;

  const Paths = require('../src/core/paths');
  const Config = require('../src/core/config');
  const Instances = require('../src/core/instances');
  const Mods = require('../src/core/mods');

  Paths.init({
    appRoot: path.join(__dirname, '..'),
    exeDir: path.join(__dirname, '..'),
    isPackaged: false,
    userDataDir: dataRoot,
    appVersion: '1.0.0',
  });
  await Config.load();
  await Config.save({ mirror: 'official', downloadConcurrency: 6 });

  const instance = await Instances.createInstance({
    name: 'MOD 冒烟',
    versionId: 'fabric-loader-0.19.5-1.20.1',
    mcVersion: '1.20.1',
    loader: { type: 'fabric', version: '0.19.5' },
  });
  console.log(`[MOD 冒烟] 实例: ${instance.id} / ${instance.name}`);
  console.log(`[MOD 冒烟] 数据目录: ${dataRoot}`);

  const search = await Mods.searchMods('mod menu', { instanceId: instance.id, limit: 5 });
  if (!search.hits.length) throw new Error('Modrinth 搜索没有结果');
  const project = search.hits.find((hit) => /mod menu/i.test(hit.title)) || search.hits[0];
  console.log(`[MOD 冒烟] 搜索命中: ${project.title} (${project.projectId})`);

  const versions = await Mods.listVersions(project.projectId, { instanceId: instance.id });
  if (!versions.length) throw new Error('没有适配 1.20.1 Fabric 的版本');
  const version = versions[0];
  console.log(`[MOD 冒烟] 使用版本: ${version.versionNumber} (${version.id})`);

  const result = await Mods.installMod(
    { instanceId: instance.id, versionId: version.id, installDependencies: true },
    {
      onPhase: (phase) => console.log(`  · ${phase}`),
      onLog: (line) => console.log(`    ${line}`),
      onProgress: (p) => {
        if (p.bytesTotal) process.stdout.write(`\r  ${p.phase} ${((p.bytesDone / p.bytesTotal) * 100).toFixed(0)}%`);
      },
    },
  );
  process.stdout.write('\n');

  const modsDir = path.join(Paths.getPaths().instanceGameDir(instance.id), 'mods');
  if (!fs.existsSync(modsDir)) throw new Error('mods 目录不存在');
  const files = fs.readdirSync(modsDir).filter((name) => name.endsWith('.jar'));
  if (!files.length) throw new Error('没有下载任何 jar');
  for (const item of result.installed) {
    const file = path.join(modsDir, item.filename);
    if (!fs.existsSync(file)) throw new Error(`缺少文件 ${item.filename}`);
    const sha1 = await hashFile(file, 'sha1');
    if (!/^[0-9a-f]{40}$/.test(sha1)) throw new Error('文件哈希异常');
  }
  console.log(`[MOD 冒烟] 安装 ${result.installed.length} 个文件: ${result.installed.map((item) => item.filename).join(', ')}`);
  if (result.warnings.length) console.log(`[MOD 冒烟] 警告: ${result.warnings.join(' | ')}`);

  // 依赖测试：Iris 的 required 依赖是 Sodium
  const irisSearch = await Mods.searchMods('iris shaders', { instanceId: instance.id, limit: 5 });
  const irisProject = irisSearch.hits.find((hit) => /iris/i.test(hit.title));
  if (!irisProject) throw new Error('没有找到 Iris');
  const irisVersions = await Mods.listVersions(irisProject.projectId, { instanceId: instance.id });
  if (!irisVersions.length) throw new Error('Iris 没有适配 1.20.1 Fabric 的版本');
  const withDeps = await Mods.installMod(
    { instanceId: instance.id, versionId: irisVersions[0].id, installDependencies: true },
    { onLog: (line) => console.log(`    ${line}`) },
  );
  console.log(`[MOD 冒烟] 依赖测试安装 ${withDeps.installed.length} 个文件: ${withDeps.installed.map((item) => `${item.filename}${item.dependency ? '(依赖)' : ''}`).join(', ')}`);
  if (withDeps.installed.length < 2) throw new Error('Iris 的 required 依赖没有自动安装');

  const localJar = path.join(dataRoot, '本地测试.jar');
  fs.writeFileSync(localJar, Buffer.from('QUTC local jar test'));
  const local = await Mods.installLocalJar(instance.id, localJar);
  if (!fs.existsSync(path.join(modsDir, local.filename))) throw new Error('本地导入文件缺失');
  console.log(`[MOD 冒烟] 本地导入: ${local.filename}`);
  console.log('[MOD 冒烟] 通过');
}

main().catch((err) => {
  console.error('[MOD 冒烟] 失败:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
