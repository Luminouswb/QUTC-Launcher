'use strict';

/**
 * authlib-injector / Yggdrasil 登录链离线 mock 测试。
 * 运行：node scripts/smoke-yggdrasil.js
 */

const assert = require('node:assert');
const Yggdrasil = require('../src/core/auth/yggdrasil');

const originalFetch = global.fetch;
let mode = 'ok';
let lastAuthBody = null;
let lastRefreshBody = null;
const API = 'https://littleskin.cn/api/yggdrasil';

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: API,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

global.fetch = async (url, options = {}) => {
  const href = String(url);
  const method = options.method || 'GET';
  if (method === 'GET') {
    return response({
      meta: { serverName: href.includes('littleskin') ? 'LittleSkin' : 'Test Yggdrasil' },
      skinDomains: ['example.com'],
    });
  }
  const body = options.body ? JSON.parse(options.body) : null;
  if (!options.headers || !String(options.headers.origin).startsWith('https://littleskin.cn')) {
    throw new Error('缺少验证服务器 Origin 头');
  }
  if (mode === 'forbidden') {
    return response({ error: 'ForbiddenOperationException', errorMessage: '用户名或密码错误' }, 403);
  }
  if (href.endsWith('/authserver/authenticate')) {
    lastAuthBody = body;
    return response({
      accessToken: 'access-1',
      clientToken: body.clientToken,
      selectedProfile: { id: '069a79f444e94726a5befca90e38aaf5', name: 'LittleSteve' },
      availableProfiles: [{ id: '069a79f444e94726a5befca90e38aaf5', name: 'LittleSteve' }],
    });
  }
  if (href.endsWith('/authserver/validate')) {
    return response(undefined, 204);
  }
  if (href.endsWith('/authserver/refresh')) {
    lastRefreshBody = body;
    return response({
      accessToken: 'access-2',
      clientToken: body.clientToken,
      selectedProfile: { id: '069a79f444e94726a5befca90e38aaf5', name: 'LittleSteve' },
    });
  }
  throw new Error(`未预期请求 ${href}`);
};

async function main() {
  const result = await Yggdrasil.authenticate({ username: 'user@example.com', password: 'secret', authServer: API });
  assert.strictEqual(lastAuthBody.username, 'user@example.com');
  assert.strictEqual(lastAuthBody.password, 'secret');
  assert.strictEqual(lastAuthBody.agent.name, 'Minecraft');
  assert.strictEqual(result.account.type, 'yggdrasil');
  assert.strictEqual(result.account.name, 'LittleSteve');
  assert.strictEqual(result.account.uuid, '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.strictEqual(result.account.authServer, API);
  assert.strictEqual(result.account.authServerName, 'LittleSkin');
  assert.ok(result.account.yggdrasilClientToken);
  assert.strictEqual(result.accessToken, 'access-1');
  console.log('  ok  authlib-injector 登录 + ALI/元数据解析');

  const valid = await Yggdrasil.validate({
    authServer: API,
    accessToken: result.accessToken,
    clientToken: result.account.yggdrasilClientToken,
  });
  assert.strictEqual(valid, true);
  console.log('  ok  令牌验证');

  const refreshed = await Yggdrasil.refresh({
    authServer: API,
    accessToken: result.accessToken,
    clientToken: result.account.yggdrasilClientToken,
  });
  assert.strictEqual(lastRefreshBody.accessToken, 'access-1');
  assert.strictEqual(refreshed.accessToken, 'access-2');
  assert.strictEqual(refreshed.account.name, 'LittleSteve');
  console.log('  ok  令牌刷新');

  mode = 'forbidden';
  let failed = false;
  try {
    await Yggdrasil.authenticate({ username: 'bad', password: 'bad', authServer: API });
  } catch (err) {
    failed = /用户名或密码错误/.test(err.message);
  }
  assert.strictEqual(failed, true);
  console.log('  ok  错误信息透传');

  const dropped = Yggdrasil.parseDnd(`authlib-injector:yggdrasil-server:${encodeURIComponent('https://example.com/api/yggdrasil/')}`);
  assert.strictEqual(dropped, 'https://example.com/api/yggdrasil/');
  const generic = Yggdrasil.normalizeInput('example.com/api/yggdrasil/');
  assert.strictEqual(generic, 'https://example.com/api/yggdrasil/');
  assert.throws(() => Yggdrasil.normalizeInput('http://example.com/api/yggdrasil'), /HTTPS/);
  console.log('  ok  拖拽 URI / 无协议补全 / 拒绝 HTTP');

  console.log('[authlib 登录冒烟] 通过');
}

main()
  .catch((err) => {
    console.error('[authlib 登录冒烟] 失败:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    global.fetch = originalFetch;
  });
