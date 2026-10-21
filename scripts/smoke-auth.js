'use strict';

/**
 * 微软登录链冒烟测试（完全离线，通过 mock fetch 验证协议字段与状态机）。
 * 运行：node scripts/smoke-auth.js
 */

const assert = require('node:assert');

const originalFetch = global.fetch;
const calls = [];

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
  const params = new URLSearchParams(options.body || '');
  calls.push({ href, method: options.method || 'GET', grant: params.get('grant_type') || '' });
  if (href.includes('login.live.com/oauth20_token.srf')) {
    assert.strictEqual(params.get('client_id'), '00000000402b5328');
    assert.strictEqual(params.get('redirect_uri'), 'https://login.live.com/oauth20_desktop.srf');
    assert.strictEqual(params.has('client_secret'), false);
    if (params.get('grant_type') === 'refresh_token') {
      return jsonResponse({ access_token: 'ms-refreshed', refresh_token: 'refresh-2', expires_in: 3600 });
    }
    assert.strictEqual(params.get('grant_type'), 'authorization_code');
    assert.strictEqual(params.get('code'), 'auth-code');
    return jsonResponse({ access_token: 'ms-access', refresh_token: 'refresh-1', expires_in: 3600 });
  }
  if (href.includes('user.auth.xboxlive.com')) {
    const body = JSON.parse(options.body);
    assert.ok(body.Properties.RpsTicket === 't=ms-access' || body.Properties.RpsTicket === 't=ms-refreshed');
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
  const authUrl = new URL(Auth.buildAuthorizeUrl());
  assert.strictEqual(authUrl.origin + authUrl.pathname, 'https://login.live.com/oauth20_authorize.srf');
  assert.strictEqual(authUrl.searchParams.get('client_id'), Auth.CLIENT_ID);
  assert.strictEqual(authUrl.searchParams.get('response_type'), 'code');
  assert.strictEqual(authUrl.searchParams.get('prompt'), 'select_account');
  assert.strictEqual(authUrl.searchParams.has('client_secret'), false);
  console.log('  ok  授权地址（公开客户端，无 client_secret）');

  assert.strictEqual(
    Auth.parseRedirectUrl('https://login.live.com/oauth20_desktop.srf?code=auth-code'),
    'auth-code',
  );
  assert.strictEqual(Auth.parseRedirectUrl('https://login.live.com/oauth20_authorize.srf?code=nope'), null);
  console.log('  ok  只识别官方桌面回调');

  const tokens = await Auth.exchangeAuthCode('auth-code');
  assert.strictEqual(tokens.accessToken, 'ms-access');
  assert.strictEqual(tokens.refreshToken, 'refresh-1');
  console.log('  ok  授权码换取令牌');

  const result = await Auth.finishMicrosoftLogin({
    msAccessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });
  assert.strictEqual(result.account.name, 'QUTC_Steve');
  assert.strictEqual(result.account.type, 'microsoft');
  assert.strictEqual(result.account.uuid, '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.strictEqual(result.account.xuid, '1234567890');
  assert.strictEqual(result.refreshToken, 'refresh-1');
  console.log('  ok  Xbox Live → XSTS → Minecraft → 玩家档案');

  const refreshed = await Auth.refreshMicrosoftAccount('refresh-1');
  assert.strictEqual(refreshed.refreshToken, 'refresh-2');
  assert.strictEqual(refreshed.account.name, 'QUTC_Steve');
  console.log('  ok  refresh_token 刷新');

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
