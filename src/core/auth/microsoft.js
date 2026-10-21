'use strict';

/**
 * QUTC Launcher - 微软正版登录
 *
 * 使用 Minecraft 启动器公开客户端（client_id 00000000402b5328）的授权码流程：
 * 登录窗口打开微软页面，用户在页面上输入密码，回调地址里的 code 换取令牌。
 * 启动器不保存微软密码，只保存加密后的 refresh_token。
 *
 * 流程：授权码 → Xbox Live → XSTS → Minecraft Services → 玩家档案
 */

const { assertSafeRemoteUrl } = require('../security');
const { uuidDashed } = require('../hash');
const { sleep } = require('../util');

const CLIENT_ID = '00000000402b5328';
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const AUTHORIZE_URL = 'https://login.live.com/oauth20_authorize.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

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
          const host = new URL(safe).host;
          const xerr = json && json.XErr;
          const described = json && (json.error_description || json.errorMessage || json.error);
          const detail = described ? String(described).replace(/\s+/g, ' ').slice(0, 180) : '';
          const message = xerr
            ? `${host} 返回 ${res.status}（XErr ${xerr}）`
            : detail
              ? `${host} 返回 ${res.status}: ${detail}`
              : `${host} 返回 ${res.status}`;
          const err = new AuthError(message, (json && json.error) || '');
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

function buildAuthorizeUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    prompt: 'select_account',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * 识别微软登录回调。不是回调地址时返回 null。
 * 回调带 error 或缺少 code 时抛出 AuthError。不记录 code。
 */
function parseRedirectUrl(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'login.live.com' || url.pathname !== '/oauth20_desktop.srf') {
    return null;
  }
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description') || '微软登录被拒绝';
    throw new AuthError(String(description).slice(0, 300), String(error).slice(0, 80));
  }
  const code = queryParam(url, 'code');
  if (!code || code.length > 4096) throw new AuthError('授权回调缺少有效的 code', 'bad_code');
  return code;
}

/** 保留授权码里的 +。URLSearchParams 会把 + 当成空格，导致换票 401。 */
function queryParam(url, name) {
  const query = url.search.startsWith('?') ? url.search.slice(1) : '';
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const key = decodeURIComponent(eq === -1 ? part : part.slice(0, eq));
    if (key !== name) continue;
    const raw = eq === -1 ? '' : part.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return '';
}

function normalizeTokens(json, previousRefresh) {
  if (!json || !json.access_token) throw new AuthError('微软登录未返回访问令牌');
  const refreshToken = json.refresh_token || previousRefresh || '';
  if (!refreshToken) throw new AuthError('微软登录未返回刷新令牌，请重试');
  return {
    accessToken: json.access_token,
    refreshToken,
    expiresIn: Number(json.expires_in) || 3600,
  };
}

async function exchangeAuthCode(code) {
  const value = String(code || '');
  if (!value || value.length > 4096) throw new AuthError('授权码无效', 'bad_code');
  const json = await postForm(TOKEN_URL, {
    client_id: CLIENT_ID,
    code: value,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
  });
  return normalizeTokens(json);
}

/** 用 refresh_token 刷新微软令牌 */
async function refreshMicrosoftToken(refreshToken) {
  try {
    const json = await postForm(TOKEN_URL, {
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
    });
    return normalizeTokens(json, refreshToken);
  } catch (err) {
    if (err && err.code === 'invalid_grant') {
      throw new AuthError('微软登录已失效，请在「账户」页重新登录', 'invalid_grant');
    }
    throw err;
  }
}

/**
 * Xbox Live 用户认证。
 * 00000000402b5328 是 Xbox 官方客户端，RpsTicket 用 t=。
 * 自建 Azure 应用才用 d=，这里只在 t= 被拒绝时再试一次。
 */
async function authenticateXboxLive(msAccessToken) {
  let lastError;
  for (const prefix of ['t=', 'd=']) {
    try {
      return await requestXboxUserToken(`${prefix}${msAccessToken}`);
    } catch (err) {
      lastError = err;
      if (!err || err.status !== 401) throw err;
    }
  }
  throw lastError || new AuthError('Xbox Live 认证失败');
}

async function requestXboxUserToken(rpsTicket) {
  const json = await postJson(
    'https://user.auth.xboxlive.com/user/authenticate',
    {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: rpsTicket,
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
async function finishMicrosoftLogin({ msAccessToken, refreshToken }) {
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
async function refreshMicrosoftAccount(refreshToken) {
  const tokens = await refreshMicrosoftToken(refreshToken);
  return finishMicrosoftLogin({
    msAccessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });
}

module.exports = {
  AuthError,
  CLIENT_ID,
  REDIRECT_URI,
  buildAuthorizeUrl,
  parseRedirectUrl,
  exchangeAuthCode,
  refreshMicrosoftToken,
  finishMicrosoftLogin,
  refreshMicrosoftAccount,
  getProfile,
  checkOwnership,
};
