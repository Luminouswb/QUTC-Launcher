'use strict';

/**
 * 启动命令构建冒烟测试（不启动游戏）。
 * 用法：node scripts/smoke-launchcmd.js <QUTCData> <版本 ID>
 */

const path = require('node:path');
const fs = require('node:fs');

const dataRoot = process.argv[2];
const versionId = process.argv[3];
if (!dataRoot || !versionId) {
  console.error('用法: node scripts/smoke-launchcmd.js <QUTCData> <版本 ID>');
  process.exit(1);
}
process.env.QUTC_DATA = dataRoot;

const Paths = require('../src/core/paths');
const Config = require('../src/core/config');
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
  const instance = await Instances.createInstance({ name: '命令测试', versionId, mcVersion: versionId });
  const account = {
    id: 'offline:test',
    type: 'offline',
    name: 'CommandTest',
    uuid: '00000000-0000-3000-8000-000000000000',
    accessToken: '0',
  };
  const command = await buildLaunchCommand(instance, account, { memoryMb: 2048 });
  console.log(`版本: ${versionId}`);
  console.log(`主类: ${command.mainClass}`);
  console.log(`Java: ${command.javaPath} (${command.javaInfo.version})`);
  console.log(`参数: ${command.args.length}`);
  console.log(`classpath 条目: ${command.args.find((a) => a.startsWith('-cp') || a.includes(';')) ? '有' : '无'}`);
  const cp = command.args.find((arg) => arg.includes(';') && arg.includes('libraries'));
  if (!cp) throw new Error('启动命令缺少 classpath');
  const entries = cp.split(';');
  console.log(`classpath 数量: ${entries.length}`);
  const required = entries.filter((entry) => entry.includes('forge') || entry.includes('fabric') || entry.includes('client'));
  console.log(`关键条目: ${required.slice(0, 3).join(' | ')}`);
  if (!command.args.includes(command.mainClass)) throw new Error('缺少主类参数');
  if (!command.args.some((arg) => arg.includes('CommandTest'))) throw new Error('缺少用户名参数');
  if (!fs.existsSync(command.nativesDir)) throw new Error('natives 目录不存在');
  console.log('[启动命令冒烟] 通过');
}

main().catch((err) => {
  console.error('[启动命令冒烟] 失败:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
