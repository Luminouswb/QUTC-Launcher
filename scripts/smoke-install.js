'use strict';

/**
 * 端到端冒烟测试：真实下载一个原版版本（默认 1.20.1），校验安装状态与启动命令。
 * 运行：node scripts/smoke-install.js [版本] [official|bmclapi]
 * 数据目录：%TEMP%/qutc-smoke-<时间>
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const version = process.argv[2] || '1.20.1';
const mirror = process.argv[3] === 'official' ? 'official' : 'bmclapi';
const dataRoot = process.argv[4] ? path.resolve(process.argv[4]) : fs.mkdtempSync(path.join(os.tmpdir(), 'qutc-smoke-'));
fs.mkdirSync(dataRoot, { recursive: true });
process.env.QUTC_DATA = dataRoot;

const Paths = require('../src/core/paths');
const Config = require('../src/core/config');
const Versions = require('../src/core/versions');
const Instances = require('../src/core/instances');
const { buildLaunchCommand } = require('../src/core/launch');

async function main() {
  Paths.init({
    appRoot: path.join(__dirname, '..'),
    exeDir: path.join(__dirname, '..'),
    isPackaged: false,
    userDataDir: dataRoot,
    appVersion: '1.0.0',
  });
  await Config.load();
  await Config.save({ mirror, downloadConcurrency: 16, memoryMb: 2048 });
  console.log(`[冒烟] 数据目录: ${dataRoot}`);
  console.log(`[冒烟] 安装 ${version}（源: ${mirror}）`);
  const started = Date.now();
  const result = await Versions.installVersion(version, {
    mirror,
    concurrency: 16,
    onPhase: (phase) => console.log(`  · ${phase}`),
    onProgress: (p) => {
      if (p.bytesTotal && p.bytesDone) {
        const pct = ((p.bytesDone / p.bytesTotal) * 100).toFixed(1);
        process.stdout.write(`\r  下载 ${pct}% (${Math.round(p.bytesDone / 1048576)}MB)`);
      }
    },
  });
  process.stdout.write('\n');
  const state = await Versions.getInstallState(version);
  if (!state.installed) throw new Error(`安装状态异常: ${state.reason}`);
  console.log(`[冒烟] 安装完成，用时 ${Math.round((Date.now() - started) / 1000)}s，资源 ${result.assets.objects} 个`);

  const instance = await Instances.createInstance({ name: '冒烟实例', versionId: version, mcVersion: version });
  const account = {
    id: 'offline:smoke',
    type: 'offline',
    name: 'SmokePlayer',
    uuid: '00000000-0000-3000-8000-000000000000',
    accessToken: '0',
  };
  const command = await buildLaunchCommand(instance, account, { memoryMb: 2048 });
  console.log(`[冒烟] 主类: ${command.mainClass}`);
  console.log(`[冒烟] Java: ${command.javaPath} (${command.javaInfo.version})`);
  console.log(`[冒烟] 参数数量: ${command.args.length}`);
  console.log(`[冒烟] 工作目录: ${command.cwd}`);
  console.log(`[冒烟] natives: ${command.nativesDir}`);
  if (!command.args.includes(command.mainClass)) throw new Error('启动命令缺少主类');
  if (!command.args.some((arg) => arg.includes('SmokePlayer'))) throw new Error('启动命令缺少用户名');
  console.log('[冒烟] 通过');
  console.log(`[冒烟] 数据目录保留在 ${dataRoot}，可手动删除`);
}

main().catch((err) => {
  console.error('\n[冒烟] 失败:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
