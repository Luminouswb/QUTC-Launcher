'use strict';

/**
 * QUTC Launcher - 账号皮肤贴图
 *
 * 只返回皮肤贴图 URL，不做任何本地缓存：
 * - microsoft：读取新接口 skins[0].url；
 * - yggdrasil：读取 sessionserver profile 的 properties[0].value（base64 JSON）里
 *   textures.SKIN.url；
 * - offline：返回 null。
 *
 * 皮肤 URL 只允许 HTTPS，任何失败都返回 null（不抛错，渲染层回退到首字母头像）。
 */

const { assertSafeRemoteUrl } = require('../security');

const UA = 'QUTC-Launcher/1.0 (Minecraft club launcher)';

async function fetchJson(url, headers = {}) {
  const safe = assertSafeRemoteUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(safe, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': UA,
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function skinUrlFromMicrosoftProfile(profile) {
  const skins = profile && Array.isArray(profile.skins) ? profile.skins : [];
  const skin = skins[0];
  return skin && typeof skin.url === 'string' ? skin.url : null;
}

function skinUrlFromTextures(properties) {
  if (!Array.isArray(properties)) return null;
  const textures = properties.find((p) => p && p.name === 'textures');
  if (!textures || typeof textures.value !== 'string' || !textures.value) return null;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(textures.value, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const skin = decoded && decoded.textures && decoded.textures.SKIN;
  return skin && typeof skin.url === 'string' ? skin.url : null;
}

/** 只允许 HTTPS 皮肤 URL，并校验不是内网/无凭据地址 */
function normalizeSkinUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return assertSafeRemoteUrl(parsed.href);
  } catch {
    return null;
  }
}

/**
 * @param {object} account 存储层账号对象（含 type / uuid / authServer）
 * @param {string|null} accessToken 主进程解析出的 accessToken（offline 为 null）
 * @returns {Promise<string|null>} 皮肤贴图 URL 或 null
 */
async function fetchSkinTexture(account, accessToken) {
  if (!account) return null;
  if (account.type === 'offline') return null;
  try {
    if (account.type === 'microsoft') {
      if (!accessToken) return null;
      const profile = await fetchJson('https://api.minecraftservices.com/minecraft/profile', {
        authorization: `Bearer ${accessToken}`,
      });
      return normalizeSkinUrl(skinUrlFromMicrosoftProfile(profile));
    }
    if (account.type === 'yggdrasil') {
      const authServer = String(account.authServer || 'https://littleskin.cn/api/yggdrasil').replace(/\/+$/, '');
      const uuid = String(account.uuid || '').replace(/-/g, '').toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(uuid)) return null;
      const url = `${authServer}/sessionserver/session/minecraft/profile/${uuid}?unsigned=false`;
      const data = await fetchJson(
        url,
        accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      );
      return normalizeSkinUrl(skinUrlFromTextures(data && data.properties));
    }
  } catch {
    return null;
  }
  return null;
}

module.exports = { fetchSkinTexture, normalizeSkinUrl };
