'use strict';

/**
 * QUTC Launcher - 安全策略
 *
 * 设计原则：
 * 1. 启动器只从 HTTPS 下载内容，且下载后校验官方哈希；
 * 2. 渲染进程没有 Node 权限，所有能力通过白名单 IPC 暴露；
 * 3. 外来压缩包解压前做路径穿越 / 符号链接 / 体积检查；
 * 4. 不执行从网络下载的任意程序（Forge/NeoForge 安装器除外，需用户显式同意，
 *    并校验官方 Maven 发布的 SHA-1）。
 */

const { URL } = require('node:url');

/** 允许在系统浏览器中打开的站点（仅文档/官方页面） */
const EXTERNAL_ALLOWLIST = [
  'qutc.club',
  'www.qutc.club',
  'minecraft.net',
  'www.minecraft.net',
  'help.minecraft.net',
  'account.microsoft.com',
  'www.microsoft.com',
  'learn.microsoft.com',
  'modrinth.com',
  'www.modrinth.com',
  'fabricmc.net',
  'quiltmc.org',
  'minecraftforge.net',
  'neoforged.net',
  'github.com',
  'bmclapi2.bangbang93.com',
  'authlib-injector.yushi.moe',
  'littleskin.cn',
  'www.littleskin.cn',
  'mcmod.cn',
  'www.mcmod.cn',
  'search.mcmod.cn',
  'minebbs.com',
  'www.minebbs.com',
];

const API_HOSTS = new Set([
  'piston-meta.mojang.com',
  'launchermeta.mojang.com',
  'piston-data.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
  'api.modrinth.com',
  'cdn.modrinth.com',
  'api.minecraftservices.com',
  'login.microsoftonline.com',
  'user.auth.xboxlive.com',
  'xsts.auth.xboxlive.com',
  'meta.fabricmc.net',
  'meta.quiltmc.org',
  'maven.fabricmc.net',
  'maven.quiltmc.org',
  'maven.minecraftforge.net',
  'maven.neoforged.net',
  'littleskin.cn',
  'authlib-injector.yushi.moe',
  'files.minecraftforge.net',
  'bmclapi2.bangbang93.com',
  'launchermeta.mojang.com',
]);

const PRIVATE_V4 =
  /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some((n) => n > 255)) return true;
    if (PRIVATE_V4.test(host)) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
  }
  return false;
}

/**
 * 校验远程 URL：必须 HTTPS、无内嵌凭据、非内网地址。
 * 返回值是规范化后的 URL 字符串。
 */
function assertSafeRemoteUrl(input, { allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error(`非法下载地址: ${String(input).slice(0, 200)}`);
  }
  const protocolOk = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
  if (!protocolOk) throw new Error(`拒绝非 HTTPS 地址: ${url.href}`);
  if (url.username || url.password) throw new Error('下载地址不得包含凭据');
  if (isPrivateHostname(url.hostname)) throw new Error(`拒绝内网地址: ${url.hostname}`);
  return url.href;
}

/** 外部链接白名单校验（用于 shell.openExternal） */
function isAllowedExternalUrl(input) {
  try {
    const url = new URL(String(input));
    if (url.protocol !== 'https:') return false;
    if (isPrivateHostname(url.hostname)) return false;
    const host = url.hostname.toLowerCase();
    return EXTERNAL_ALLOWLIST.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

/** 判断是否为官方 API 主机（用于提示/日志，不强制） */
function isApiHost(input) {
  try {
    return API_HOSTS.has(new URL(String(input)).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** 校验 Minecraft 用户名（离线模式） */
function validateOfflineName(name) {
  const value = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(value)) {
    throw new Error('用户名需为 3-16 位英文、数字或下划线');
  }
  return value;
}

/** 校验 Microsoft OAuth Client ID（GUID） */
function validateClientId(clientId) {
  const value = String(clientId || '').trim();
  if (!value) return '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('OAuth Client ID 格式不正确（应为 GUID）');
  }
  return value.toLowerCase();
}

module.exports = {
  EXTERNAL_ALLOWLIST,
  API_HOSTS,
  isPrivateHostname,
  assertSafeRemoteUrl,
  isAllowedExternalUrl,
  isApiHost,
  validateOfflineName,
  validateClientId,
};
