'use strict';

/**
 * 樱花内网穿透核心冒烟测试（不启动 Electron、不联网、不真正下载/spawn）。
 * 通过注入 mock fetch / spawn 验证：
 *  1. 隧道列表解析与归一化（listTunnels）
 *  2. 访问密钥通过 Bearer 传递、且绝不落入日志
 *  3. frpc 下载信息解析（/system/clients）
 *  4. start / stop 状态机（idle → starting → running → stopping → idle）
 *  5. start 参数校验
 */

const { EventEmitter } = require('node:events');
const { FrpManager, windowsArchKey } = require('../src/core/frp');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }

  kill() {
    this.killed = true;
    // 不自动触发 exit，交给测试手动触发，以便观察 stopping 中间状态
  }
}

function makeManager({ fetchImpl, spawnImpl }) {
  const logs = [];
  const states = [];
  const manager = new FrpManager({
    fetch: fetchImpl,
    spawn: spawnImpl,
    onLog: (line) => logs.push(line),
    onStateChange: (state) => states.push(state),
  });
  return { manager, logs, states };
}

/** 构造返回固定 JSON 的 mock fetch */
function jsonFetch(body, { status = 200, ok = true } = {}) {
  return async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

async function main() {
  console.log('樱花内网穿透（Sakura Frp）冒烟测试\n');

  await test('隧道列表解析与归一化', async () => {
    const fetchImpl = jsonFetch([
      { id: 123, name: '我的世界服务器', type: 'tcp', node: 3, online: true, status: 0, remote: '10001', local_ip: '127.0.0.1', local_port: 25565 },
      { id: 456, name: 'Web 面板', type: 'http', node: 7, online: false, status: 1, remote: 'example.natfrp.com', local_ip: '127.0.0.1', local_port: 80 },
    ]);
    const { manager } = makeManager({ fetchImpl });
    const tunnels = await manager.listTunnels('SECRETTOKEN123');
    if (tunnels.length !== 2) throw new Error(`隧道数量错误: ${tunnels.length}`);
    if (tunnels[0].id !== 123 || tunnels[0].name !== '我的世界服务器') throw new Error('隧道字段解析错误');
    if (tunnels[0].node !== 3 || tunnels[0].localPort !== 25565) throw new Error('节点/端口解析错误');
    if (tunnels[1].remote !== 'example.natfrp.com') throw new Error('HTTP 隧道 remote 解析错误');
  });

  await test('访问密钥通过 Bearer 传递且不落日志', async () => {
    let seenAuth = null;
    const fetchImpl = async (_url, opts) => {
      seenAuth = opts && opts.headers && opts.headers.authorization;
      return { ok: true, status: 200, statusText: 'OK', text: async () => '[]', json: async () => [] };
    };
    const { manager, logs } = makeManager({ fetchImpl });
    await manager.listTunnels('SECRETTOKEN123');
    if (seenAuth !== 'Bearer SECRETTOKEN123') throw new Error(`鉴权头错误: ${seenAuth}`);
    if (logs.some((l) => String(l).includes('SECRETTOKEN123'))) throw new Error('访问密钥落入了日志');
  });

  await test('frpc 下载信息解析（/system/clients）', async () => {
    const fetchImpl = jsonFetch({
      frpc: {
        ver: '0.51.0-sakura-14',
        archs: {
          windows_amd64: { url: 'https://cdn.example/frpc_windows_amd64.exe', hash: 'a'.repeat(32), size: 12345678 },
        },
      },
    });
    const { manager } = makeManager({ fetchImpl });
    const info = await manager.getFrpcDownload('windows_amd64');
    if (!info.url || info.hash !== 'a'.repeat(32) || info.size !== 12345678) throw new Error('下载信息解析错误');
    if (info.version !== '0.51.0-sakura-14') throw new Error('版本解析错误');
    if (!windowsArchKey()) throw new Error('Windows 下 windowsArchKey 不应为空');
  });

  await test('start/stop 状态机：idle→starting→running→stopping→idle', async () => {
    const frpcChild = new FakeChild(4242);
    const taskkillChild = new FakeChild(0);
    const spawnCalls = [];
    const spawnImpl = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      if (String(cmd).toLowerCase().includes('taskkill')) {
        setImmediate(() => taskkillChild.emit('exit', 0));
        return taskkillChild;
      }
      return frpcChild;
    };
    const { manager, logs, states } = makeManager({
      fetchImpl: async () => {
        throw new Error('start 不应触发 fetch');
      },
      spawnImpl,
    });

    if (manager.status().state !== 'idle') throw new Error(`初始状态应为 idle，实际 ${manager.status().state}`);

    await manager.start({ accessKey: 'SECRETTOKEN123', tunnelId: '123', frpcPath: 'C:\\fake\\frpc.exe' });
    if (manager.status().state !== 'running') throw new Error(`start 后应为 running，实际 ${manager.status().state}`);
    if (manager.status().pid !== 4242) throw new Error('pid 未记录');

    const frpcSpawn = spawnCalls.find((c) => !String(c.cmd).toLowerCase().includes('taskkill'));
    if (!frpcSpawn) throw new Error('未调用 spawn frpc');
    if (frpcSpawn.opts.env.NATFRP_TOKEN !== 'SECRETTOKEN123') throw new Error('NATFRP_TOKEN 未正确传入 env');
    if (frpcSpawn.opts.env.NATFRP_TARGET !== '123') throw new Error('NATFRP_TARGET 未正确传入 env');
    if (frpcSpawn.args.some((a) => String(a).includes('SECRETTOKEN123'))) throw new Error('访问密钥出现在命令行参数');
    if (logs.some((l) => String(l).includes('SECRETTOKEN123'))) throw new Error('访问密钥落入了日志');

    const stopped = await manager.stop();
    if (stopped !== true) throw new Error('stop 应返回 true');
    if (manager.status().state !== 'stopping') throw new Error(`stop 后应为 stopping，实际 ${manager.status().state}`);
    const tk = spawnCalls.find((c) => String(c.cmd).toLowerCase().includes('taskkill'));
    if (!tk) throw new Error('未调用 taskkill');
    if (tk.args.join(' ') !== '/PID 4242 /T /F') throw new Error(`taskkill 参数错误: ${tk.args.join(' ')}`);

    frpcChild.emit('exit', 0, null);
    if (manager.status().state !== 'idle') throw new Error(`进程退出后应为 idle，实际 ${manager.status().state}`);
    if (!states.includes('running') || !states.includes('stopping')) throw new Error('状态回调缺失');
  });

  await test('start 参数校验', async () => {
    const { manager } = makeManager({
      fetchImpl: async () => {
        throw new Error('不应触发 fetch');
      },
      spawnImpl: () => {
        throw new Error('不应触发 spawn');
      },
    });
    const cases = [
      ['空访问密钥', { accessKey: '', tunnelId: '123', frpcPath: 'x' }, /缺少访问密钥/],
      ['空隧道 ID', { accessKey: 'SECRETTOKEN123', tunnelId: '', frpcPath: 'x' }, /请选择要开启的隧道/],
      ['空 frpc 路径', { accessKey: 'SECRETTOKEN123', tunnelId: '123', frpcPath: '' }, /frpc 路径为空/],
    ];
    for (const [label, opts, re] of cases) {
      let threw = false;
      try {
        await manager.start(opts);
      } catch (err) {
        threw = true;
        if (!re.test(err.message)) throw new Error(`${label} 报错信息不符: ${err.message}`);
      }
      if (!threw) throw new Error(`${label} 未被拒绝`);
    }
  });

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  if (failed) {
    for (const item of failures) console.error(`\n${item.name}\n${item.err.stack}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[樱花冒烟] 失败:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
