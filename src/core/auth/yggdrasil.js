'use strict';

/**
 * QUTC Launcher - 第三方外置登录（authlib-injector / Yggdrasil）
 *
 * 支持任意 HTTPS Yggdrasil API 地址，并实现 authlib-injector 的 ALI 服务发现：
 *   1. 无协议时补全 https；
 *   2. GET 地址，读取 X-Authlib-Injector-API-Location；
 *   3. GET API 元数据，读取 meta.serverName。
 *
 * 拖拽数据格式（authlib-injector 规范）：
 *   authlib-injector:yggdrasil-server:<encodeURIComponent(apiRoot)>
 *
 * 密码只在本次请求中使用，不写入磁盘。
 */

const crypto = require('node:crypto');
const { randomId } = require('../util');
const { uuidDashed: dash } = require('../hash');
const { assertSafeRemoteUrl } = require('../security');

const UA = 'QUTC-Launcher/1.0 (Minecraft club launcher)';
const DND_PREFIX = 'authlib-injector:yggdrasil-server:';
const LITTLESKIN = 'https://littleskin.cn/api/yggdrasil';

function parseDnd(input) {
  const text = String(input || '').trim();
  if (text.toLowerCase().startsWith(DND_PREFIX)) {
    const encoded = text.slice(DND_PREFIX.length);
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return text;
}

function normalizeInput(input) {
  let value = parseDnd(input);
  if (!value) throw new Error('请输入验证服务器 API 地址');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('验证服务器地址格式不正确');
  }
  if (url.protocol !== 'https:') {
    throw new Error('验证服务器必须使用 HTTPS，不能使用明文 HTTP');
  }
  url.hash = '';
  return assertSafeRemoteUrl(url.href);
}

async function fetchWithTimeout(url, options = {}, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      ...options,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': UA,
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('验证服务器请求超时，请检查网络');
    throw new Error(`无法连接验证服务器：${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const reason =
      (data && (data.errorMessage || data.error_description || data.error)) ||
      `HTTP ${response.status}${response.headers.get('x-error-info') ? ` (${response.headers.get('x-error-info')})` : ''}`;
    throw new Error(`${label}失败：${reason}`);
  }
  return data;
}

/** 解析 API 地址（ALI + 元数据） */
async function resolveAuthServer(input) {
  const start = normalizeInput(input);
  const first = await fetchWithTimeout(start);
  const ali = first.headers.get('x-authlib-injector-api-location');
  const base = first.url || start;
  let apiRoot = start;
  if (ali) {
    try {
      apiRoot = new URL(ali, base).href;
    } catch {
      throw new Error('验证服务器返回的 API 地址指示无效');
    }
  }
  apiRoot = normalizeInput(apiRoot).replace(/\/+$/, '');
  const response = await fetchWithTimeout(apiRoot);
  const meta = await readJsonResponse(response, '读取验证服务器元数据');
  if (!meta || typeof meta !== 'object' || !meta.meta || typeof meta.meta.serverName !== 'string') {
    throw new Error('该地址不是有效的 Yggdrasil 验证服务器（缺少 meta.serverName）');
  }
  return {
    apiRoot,
    serverName: String(meta.meta.serverName).slice(0, 80),
    meta,
  };
}

function accountId(apiRoot, uuid) {
  const serverHash = crypto.createHash('sha1').update(String(apiRoot)).digest('hex').slice(0, 16);
  return `yggdrasil:${serverHash}:${uuid}`;
}

async function postJson(apiRoot, pathname, body, timeout = 20000) {
  const url = new URL(`${String(apiRoot).replace(/\/+$/, '')}${pathname}`);
  const response = await fetchWithTimeout(
    url.href,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: url.origin,
        referer: `${url.origin}/`,
      },
      body: JSON.stringify(body),
    },
    timeout,
  );
  return { response, data: await readJsonResponse(response, '验证服务器请求') };
}

function pickProfile(data, apiRoot, serverName) {
  if (!data || typeof data !== 'object') throw new Error('验证服务器返回格式异常');
  const profile =
    (data.selectedProfile && data.selectedProfile.id && data.selectedProfile.name && data.selectedProfile) ||
    (Array.isArray(data.availableProfiles) &&
      data.availableProfiles.find((item) => item && item.id && item.name)) ||
    null;
  if (!profile) throw new Error('该账号还没有角色，请先在验证服务器创建一个角色');
  const uuid = String(profile.id).replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(uuid)) throw new Error('验证服务器返回的角色 UUID 非法');
  return {
    id: accountId(apiRoot, uuid),
    type: 'yggdrasil',
    name: String(profile.name).slice(0, 32),
    uuid: dash(uuid),
    authServer: apiRoot,
    authServerName: serverName,
    yggdrasilClientToken: '',
  };
}

async function authenticate({ username, password, authServer } = {}) {
  const server = await resolveAuthServer(authServer);
  const name = String(username || '').trim();
  const pass = String(password || '');
  if (!name) throw new Error('请输入验证服务器账号');
  if (!pass) throw new Error('请输入验证服务器密码');
  if (name.length > 128 || pass.length > 256) throw new Error('账号或密码过长');
  const clientToken = randomId(16) + randomId(16);
  const { data } = await postJson(server.apiRoot, '/authserver/authenticate', {
    username: name,
    password: pass,
    clientToken,
    agent: { name: 'Minecraft', version: 1 },
    requestUser: true,
  });
  const account = pickProfile(data, server.apiRoot, server.serverName);
  if (!data.accessToken) throw new Error('验证服务器没有返回 accessToken');
  account.yggdrasilClientToken = clientToken;
  return { account, accessToken: String(data.accessToken) };
}

async function validate({ authServer, accessToken, clientToken } = {}) {
  const root = normalizeInput(authServer);
  if (!accessToken) return false;
  try {
    await postJson(root, '/authserver/validate', {
      accessToken: String(accessToken),
      clientToken: String(clientToken || ''),
    });
    return true;
  } catch {
    return false;
  }
}

async function refresh({ authServer, accessToken, clientToken } = {}) {
  const root = normalizeInput(authServer);
  if (!accessToken) throw new Error('外置登录令牌缺失，请重新登录');
  const { data } = await postJson(root, '/authserver/refresh', {
    accessToken: String(accessToken),
    clientToken: String(clientToken || ''),
    requestUser: true,
  });
  const resolved = await resolveAuthServer(root);
  const account = pickProfile(data, root, resolved.serverName);
  if (!data.accessToken) throw new Error('验证服务器刷新令牌失败');
  account.yggdrasilClientToken = String(data.clientToken || clientToken || '');
  return { account, accessToken: String(data.accessToken) };
}

module.exports = {
  DND_PREFIX,
  LITTLESKIN,
  parseDnd,
  normalizeInput,
  normalizeAuthServer: normalizeInput,
  resolveAuthServer,
  authenticate,
  validate,
  refresh,
};
