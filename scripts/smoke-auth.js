'use strict';

/**
 * 微软登录链冒烟测试（完全离线，通过 mock fetch 验证协议字段与状态机）。
 * 运行：node scripts/smoke-auth.js
 */

const assert = require('node:assert');

const originalFetch = global.fetch;
const calls = [];
let tokenPolls = 0;

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

global.fetch = async (url, options = {}) => {
  const href = String(url);
  calls.push({ href, method: options.method || 'GET' });
  if (href.endsWith('/devicecode')) {
    return jsonResponse({
      device_code: 'device-code-123',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://microsoft.com/link',
      expires_in: 900,
      interval: 1,
      message: '打开链接输入代码',
    });
  }
  if (href.endsWith('/token')) {
    tokenPolls += 1;
    if (tokenPolls === 1) {
      return jsonResponse(
        { error: 'authorization_pending', error_description: '等待用户授权' },
        400,
      );
    }
    const params = new URLSearchParams(options.body || '');
    if (params.get('grant_type') === 'refresh_token') {
      return jsonResponse({ access_token: 'ms-refreshed', refresh_token: 'refresh-2', expires_in: 3600 });
    }
    return jsonResponse({ access_token: 'ms-access', refresh_token: 'refresh-1', expires_in: 3600 });
  }
  if (href.includes('user.auth.xboxlive.com')) {
    return jsonResponse({ Token: 'xbl-token', DisplayClaims: { xui: [{ uhs: 'user-hash' }] } });
  }
  if (href.includes('xsts.auth.xboxlive.com')) {
    return jsonResponse({
      Token: 'xsts-token',
      DisplayClaims: { xui: [{ uhs: 'user-hash', xid: '1234567890' }] },
    });
  }
  if (href.includes('login_with_xbox')) {
    return jsonResponse({ access_token: 'mc-access', expires_in: 86400 });
  }
  if (href.includes('api.minecraftservices.com/minecraft/profile')) {
    return jsonResponse({ id: '069a79f444e94726a5befca90e38aaf5', name: 'QUTC_Steve', skins: [], capes: [] });
  }
  throw new Error(`未预期的请求: ${href}`);
};

const Auth = require('../src/core/auth/microsoft');

async function main() {
  const clientId = '00000000-0000-0000-0000-000000000000';
  const device = await Auth.startDeviceCode(clientId);
  assert.strictEqual(device.userCode, 'ABCD-EFGH');
  assert.strictEqual(device.deviceCode, 'device-code-123');
  console.log('  ok  设备码申请');

  let statusCount = 0;
  const tokens = await Auth.pollDeviceCode(clientId, device, {
    onStatus: () => {
      statusCount += 1;
    },
  });
  assert.strictEqual(tokens.accessToken, 'ms-access');
  assert.strictEqual(tokens.refreshToken, 'refresh-1');
  assert.ok(statusCount >= 1);
  console.log('  ok  设备码轮询（authorization_pending → 成功）');

  const result = await Auth.finishMicrosoftLogin({
    msAccessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    clientId,
  });
  assert.strictEqual(result.account.name, 'QUTC_Steve');
  assert.strictEqual(result.account.type, 'microsoft');
  assert.strictEqual(result.account.uuid, '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.strictEqual(result.account.xuid, '1234567890');
  assert.strictEqual(result.refreshToken, 'refresh-1');
  console.log('  ok  Xbox Live → XSTS → Minecraft → 玩家档案');

  const refreshed = await Auth.refreshMicrosoftAccount(clientId, 'refresh-1');
  assert.strictEqual(refreshed.refreshToken, 'refresh-2');
  assert.strictEqual(refreshed.account.name, 'QUTC_Steve');
  console.log('  ok  refresh_token 刷新');

  let missing = false;
  try {
    Auth.requireClientId('');
  } catch (err) {
    missing = err.code === 'missing_client_id';
  }
  assert.strictEqual(missing, true);
  console.log('  ok  未配置 Client ID 时明确报错');

  console.log(`[登录冒烟] 通过，共 ${calls.length} 次模拟请求`);
}

main()
  .catch((err) => {
    console.error('[登录冒烟] 失败:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    global.fetch = originalFetch;
  });
