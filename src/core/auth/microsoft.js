'use strict';

/**
 * QUTC Launcher - 微软正版登录（OAuth 2.0 设备码流程）
 *
 * 流程：Microsoft OAuth → Xbox Live → XSTS → Minecraft Services → 玩家档案
 * 不在本地保存微软密码，仅保存加密后的 refresh_token。
 *
 * 需要社团管理员在 Azure 门户注册一个“公共客户端”应用，并将 Client ID 填入设置。
 * 详细步骤见 README.md「正版登录配置」。
 */

const { assertSafeRemoteUrl } = require('../security');
const { uuidDashed } = require('../hash');
const { sleep } = require('../util');

const OAUTH_BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';
const UA = 'QUTC-Launcher/1.0';

class AuthError extends Error {
  constructor(message, code = '') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

async function requestJson(url, options, { timeout = 20000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const safe = assertSafeRemoteUrl(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(safe, {
          ...options,
          signal: controller.signal,
          headers: {
            'user-agent': UA,
            accept: 'application/json',
            ...(options.headers || {}),
          },
        });
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { raw: text };
        }
        if (!res.ok) {
          const detail =
            (json && (json.error_description || json.error || json.message)) ||
            `${res.status} ${res.statusText}`;
          const err = new AuthError(`微软服务返回错误: ${detail}`, json && json.error);
          err.status = res.status;
          err.body = json;
          err.retryAfter = Number(res.headers.get('retry-after')) || 0;
          throw err;
        }
        return json;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastError = err;
      if (err && (err.status === 429 || err.status >= 500) && attempt < retries) {
        await sleep((err.retryAfter || 1) * 1000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function postForm(url, params) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

function postJson(url, body, extraHeaders = {}) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function requireClientId(clientId) {
  const value = String(clientId || '').trim();
  if (!value) {
    throw new AuthError(
      '尚未配置微软 OAuth Client ID。请在「设置 → 正版登录」中填写社团的 Azure 应用 Client ID（见 README）。',
      'missing_client_id',
    );
  }
  return value;
}

/** 第一步：申请设备码 */
async function startDeviceCode(clientId) {
  const id = requireClientId(clientId);
  const json = await postForm(`${OAUTH_BASE}/devicecode`, {
    client_id: id,
    scope: SCOPE,
  });
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    expiresIn: Number(json.expires_in) || 900,
    interval: Number(json.interval) || 5,
    message: json.message || '',
  };
}

/**
 * 轮询设备码换取 Microsoft 令牌。
 * 返回 { accessToken, refreshToken, expiresIn }
 */
async function pollDeviceCode(clientId, device, { signal, onStatus } = {}) {
  const id = requireClientId(clientId);
  const deadline = Date.now() + (device.expiresIn || 900) * 1000;
  let interval = Math.max(2, device.interval || 5);
  for (;;) {
    if (signal && signal.cancelled) throw new AuthError('登录已取消', 'cancelled');
    if (Date.now() > deadline) throw new AuthError('设备码已过期，请重新开始登录', 'expired');
    if (onStatus) onStatus('等待浏览器中完成微软账号授权…');
    try {
      const json = await postForm(`${OAUTH_BASE}/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: id,
        device_code: device.deviceCode,
      });
      return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresIn: Number(json.expires_in) || 3600,
      };
    } catch (err) {
      const code = err.code || '';
      if (code === 'authorization_pending') {
        await sleep(interval * 1000);
        continue;
      }
      if (code === 'slow_down') {
        interval += 5;
        await sleep(interval * 1000);
        continue;
      }
      if (code === 'expired_token') throw new AuthError('设备码已过期，请重新开始登录', 'expired');
      if (code === 'authorization_declined') throw new AuthError('用户拒绝了授权', 'declined');
      if (code === 'bad_verification_code') throw new AuthError('设备码无效，请重新开始登录', 'bad_code');
      throw err;
    }
  }
}

/** 用 refresh_token 刷新微软令牌 */
async function refreshMicrosoftToken(clientId, refreshToken) {
  const id = requireClientId(clientId);
  const json = await postForm(`${OAUTH_BASE}/token`, {
    grant_type: 'refresh_token',
    client_id: id,
    refresh_token: refreshToken,
    scope: SCOPE,
  });
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || refreshToken,
    expiresIn: Number(json.expires_in) || 3600,
  };
}

/** Xbox Live 用户认证 */
async function authenticateXboxLive(msAccessToken) {
  const json = await postJson(
    'https://user.auth.xboxlive.com/user/authenticate',
    {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${msAccessToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
    { 'x-xbl-contract-version': '1' },
  );
  const claim = json.DisplayClaims && json.DisplayClaims.xui && json.DisplayClaims.xui[0];
  if (!json.Token || !claim || !claim.uhs) throw new AuthError('Xbox Live 认证返回数据异常');
  return { token: json.Token, uhs: claim.uhs };
}

/** XSTS 授权 */
async function authorizeXsts(xblToken) {
  try {
    const json = await postJson(
      'https://xsts.auth.xboxlive.com/xsts/authorize',
      {
        Properties: {
          SandboxId: 'RETAIL',
          UserTokens: [xblToken],
        },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT',
      },
      { 'x-xbl-contract-version': '1' },
    );
    const claim = json.DisplayClaims && json.DisplayClaims.xui && json.DisplayClaims.xui[0];
    if (!json.Token || !claim) throw new AuthError('XSTS 授权返回数据异常');
    return { token: json.Token, uhs: claim.uhs, xuid: claim.xid || '' };
  } catch (err) {
    const xerr = err.body && err.body.XErr;
    const messages = {
      2148916233: '该微软账号还没有 Xbox 档案，请先打开 xbox.com 登录并创建档案。',
      2148916235: '当前账号所在地区不支持 Xbox Live。',
      2148916236: '该账号需要进行成人验证（请登录 xbox.com 完成）。',
      2148916237: '该账号需要进行成人验证（请登录 xbox.com 完成）。',
      2148916238: '未成年账号需要先加入 Microsoft 家庭组。',
      2148916227: '该账号已被 Xbox Live 封禁。',
    };
    if (xerr && messages[xerr]) throw new AuthError(messages[xerr], String(xerr));
    throw err;
  }
}

/** Minecraft Services 登录 */
async function loginMinecraft(xsts) {
  const json = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${xsts.uhs};${xsts.token}`,
  });
  if (!json.access_token) throw new AuthError('Minecraft 登录失败：未获得访问令牌');
  return {
    accessToken: json.access_token,
    expiresIn: Number(json.expires_in) || 86400,
  };
}

async function getProfile(accessToken) {
  const res = await requestJson('https://api.minecraftservices.com/minecraft/profile', {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res || !res.id || !res.name) throw new AuthError('无法读取 Minecraft 玩家档案');
  return { id: uuidDashed(res.id), name: res.name, skins: res.skins || [], capes: res.capes || [] };
}

/** 检查是否拥有 Java 版（档案不存在 → 未拥有） */
async function checkOwnership(accessToken) {
  try {
    const profile = await getProfile(accessToken);
    return profile;
  } catch (err) {
    if (err.status === 404) {
      throw new AuthError(
        '该微软账号未拥有 Minecraft Java 版（或档案尚未创建）。请确认已购买并尝试在官方启动器登录一次。',
        'not_entitled',
      );
    }
    throw err;
  }
}

async function sleepRetry(ms) {
  await sleep(ms);
}

/**
 * 完整登录链：Microsoft 令牌 → Minecraft 账号
 * @returns {{account:object, refreshToken:string}}
 */
async function finishMicrosoftLogin({ msAccessToken, refreshToken, clientId }) {
  const xbl = await authenticateXboxLive(msAccessToken);
  const xsts = await authorizeXsts(xbl.token);
  const mc = await loginMinecraft(xsts);
  // 档案可能延迟创建，重试几次
  let profile;
  let lastError;
  for (let i = 0; i < 3; i += 1) {
    try {
      profile = await checkOwnership(mc.accessToken);
      break;
    } catch (err) {
      lastError = err;
      if (err.code === 'not_entitled') {
        await sleepRetry(1500);
        continue;
      }
      throw err;
    }
  }
  if (!profile) throw lastError || new AuthError('无法读取玩家档案');
  return {
    refreshToken,
    account: {
      id: `msa:${profile.id}`,
      type: 'microsoft',
      name: profile.name,
      uuid: profile.id,
      xuid: xsts.xuid,
      accessToken: mc.accessToken,
      accessTokenExpiresAt: Date.now() + mc.expiresIn * 1000,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
      skins: profile.skins,
    },
  };
}

/** 使用 refresh_token 恢复会话（启动器重启后） */
async function refreshMicrosoftAccount(clientId, refreshToken) {
  const tokens = await refreshMicrosoftToken(clientId, refreshToken);
  const result = await finishMicrosoftLogin({
    msAccessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    clientId,
  });
  return result;
}

module.exports = {
  AuthError,
  startDeviceCode,
  pollDeviceCode,
  refreshMicrosoftToken,
  finishMicrosoftLogin,
  refreshMicrosoftAccount,
  getProfile,
  checkOwnership,
  requireClientId,
};
