'use strict';

/**
 * QUTC Launcher - Modrinth 整合包 / 资源 API
 *
 * 仅使用 Modrinth 官方 API（https://api.modrinth.com/v2）。
 * 所有下载文件都必须带官方 SHA-1/SHA-512，校验失败直接丢弃。
 * 不使用 CurseForge（其 API 需要私钥，不适合社团内置启动器）。
 */

const { getJson, downloadFile } = require('./http');
const { assertSafeRemoteUrl } = require('./security');
const { hashFile } = require('./hash');
const { createFileProgress } = require('./util');

const API = 'https://api.modrinth.com/v2';
const UA = 'QUTC-Launcher/1.0 (Minecraft club launcher)';

function apiHeaders(extra = {}) {
  return {
    'user-agent': UA,
    ...extra,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitizeQuery(query) {
  return String(query || '').trim().slice(0, 120);
}

function facetsFor({ gameVersion, loader, loaders, projectType = 'modpack' }) {
  const facets = [[`project_type:${projectType}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  const loaderList = Array.isArray(loaders) && loaders.length ? loaders : loader && loader !== 'vanilla' ? [loader] : [];
  if (loaderList.length) facets.push(loaderList.map((item) => `categories:${item}`));
  return facets;
}

/**
 * 搜索 Modrinth 项目（整合包 / MOD 共用）
 */
async function searchProjects(query, options = {}) {
  const limit = clampInt(options.limit, 1, 20, 12);
  const offset = clampInt(options.offset, 0, 1000, 0);
  const params = new URLSearchParams();
  params.set('query', sanitizeQuery(query));
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  params.set('index', options.sort === 'downloads' ? 'downloads' : options.sort === 'newest' ? 'newest' : 'relevance');
  params.set('facets', JSON.stringify(facetsFor({ ...options, projectType: options.projectType || 'modpack' })));
  const data = await getJson(`${API}/search?${params.toString()}`, {
    headers: apiHeaders(),
    retries: 3,
    timeout: 25000,
    abort: options.abort,
  });
  if (!data || !Array.isArray(data.hits)) throw new Error('Modrinth 返回格式异常');
  return {
    hits: data.hits.map(publicSearchHit).filter(Boolean),
    total_hits: Number(data.total_hits) || data.hits.length,
    offset: Number(data.offset) || offset,
    limit: Number(data.limit) || limit,
  };
}

/**
 * 搜索整合包
 * @returns {Promise<{hits:object[], total_hits:number, offset:number, limit:number}>}
 */
async function searchModpacks(query, options = {}) {
  return searchProjects(query, { ...options, projectType: 'modpack' });
}

/** 搜索 MOD */
async function searchMods(query, options = {}) {
  return searchProjects(query, { ...options, projectType: 'mod' });
}

function publicSearchHit(hit) {
  if (!hit || !hit.project_id) return null;
  return {
    projectId: String(hit.project_id),
    slug: String(hit.slug || ''),
    title: String(hit.title || ''),
    description: String(hit.description || ''),
    author: String(hit.author || ''),
    downloads: Number(hit.downloads) || 0,
    follows: Number(hit.follows) || 0,
    iconUrl: safeUrl(hit.icon_url),
    categories: Array.isArray(hit.categories) ? hit.categories.slice(0, 8).map(String) : [],
    versions: Array.isArray(hit.versions) ? hit.versions.slice(-12).map(String) : [],
    loaders: Array.isArray(hit.loaders) ? hit.loaders.map(String) : [],
    projectType: String(hit.project_type || ''),
  };
}

function safeUrl(input) {
  if (!input) return '';
  try {
    return assertSafeRemoteUrl(String(input));
  } catch {
    return '';
  }
}

async function getProject(idOrSlug, options = {}) {
  const id = normalizeProjectId(idOrSlug);
  const data = await getJson(`${API}/project/${encodeURIComponent(id)}`, {
    headers: apiHeaders(),
    retries: 3,
    timeout: 25000,
    abort: options.abort,
  });
  if (!data || !data.id) throw new Error('Modrinth 项目信息异常');
  return {
    id: String(data.id),
    slug: String(data.slug || ''),
    title: String(data.title || ''),
    description: String(data.description || ''),
    body: String(data.body || '').slice(0, 20000),
    iconUrl: safeUrl(data.icon_url),
    downloads: Number(data.downloads) || 0,
    followers: Number(data.followers) || 0,
    categories: Array.isArray(data.categories) ? data.categories.map(String) : [],
    gameVersions: Array.isArray(data.game_versions) ? data.game_versions.map(String) : [],
    loaders: Array.isArray(data.loaders) ? data.loaders.map(String) : [],
    projectType: String(data.project_type || ''),
  };
}

async function getProjectVersions(idOrSlug, options = {}) {
  const id = normalizeProjectId(idOrSlug);
  const params = new URLSearchParams();
  if (options.gameVersion) params.set('game_versions', JSON.stringify([String(options.gameVersion)]));
  if (options.loader && options.loader !== 'vanilla') {
    params.set('loaders', JSON.stringify([String(options.loader)]));
  }
  const qs = params.toString();
  const data = await getJson(`${API}/project/${encodeURIComponent(id)}/version${qs ? `?${qs}` : ''}`, {
    headers: apiHeaders(),
    retries: 3,
    timeout: 25000,
    abort: options.abort,
  });
  if (!Array.isArray(data)) throw new Error('Modrinth 版本列表异常');
  return data.map(publicVersion).filter(Boolean);
}

async function getVersion(versionId, options = {}) {
  const id = String(versionId || '').trim();
  if (!/^[A-Za-z0-9]{6,32}$/.test(id)) throw new Error('Modrinth 版本 ID 非法');
  const data = await getJson(`${API}/version/${encodeURIComponent(id)}`, {
    headers: apiHeaders(),
    retries: 3,
    timeout: 25000,
    abort: options.abort,
  });
  const version = publicVersion(data);
  if (!version) throw new Error('Modrinth 版本信息异常');
  return version;
}

function publicVersion(data) {
  if (!data || !data.id) return null;
  return {
    id: String(data.id),
    projectId: String(data.project_id || ''),
    name: String(data.name || ''),
    versionNumber: String(data.version_number || ''),
    versionType: String(data.version_type || ''),
    datePublished: String(data.date_published || ''),
    gameVersions: Array.isArray(data.game_versions) ? data.game_versions.map(String) : [],
    loaders: Array.isArray(data.loaders) ? data.loaders.map(String) : [],
    downloads: Number(data.downloads) || 0,
    files: Array.isArray(data.files)
      ? data.files.map((file) => ({
          filename: String(file.filename || ''),
          url: safeUrl(file.url),
          size: Number(file.size) || 0,
          primary: Boolean(file.primary),
          hashes: {
            sha1: file.hashes && /^[0-9a-f]{40}$/i.test(file.hashes.sha1 || '') ? String(file.hashes.sha1).toLowerCase() : '',
            sha512:
              file.hashes && /^[0-9a-f]{128}$/i.test(file.hashes.sha512 || '')
                ? String(file.hashes.sha512).toLowerCase()
                : '',
          },
        }))
      : [],
    dependencies: Array.isArray(data.dependencies)
      ? data.dependencies
          .map((dep) => ({
            projectId: dep && dep.project_id ? String(dep.project_id) : '',
            versionId: dep && dep.version_id ? String(dep.version_id) : '',
            fileName: dep && dep.file_name ? String(dep.file_name) : '',
            dependencyType: dep && dep.dependency_type ? String(dep.dependency_type) : '',
          }))
          .filter((dep) => dep.projectId || dep.versionId)
      : [],
  };
}

function normalizeProjectId(input) {
  const value = String(input || '').trim();
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(value)) throw new Error('Modrinth 项目 ID 非法');
  return value;
}

/** 从 Modrinth 版本中选择一个 .mrpack 文件 */
function pickMrpackFile(version) {
  if (!version || !Array.isArray(version.files)) return null;
  const packs = version.files.filter((file) => file && /\.mrpack$/i.test(file.filename) && file.url);
  return packs.find((file) => file.primary) || packs[0] || null;
}

/** 下载 .mrpack，校验 Modrinth 提供的哈希 */
async function downloadMrpackFile(file, dest, ctx = {}) {
  if (!file || !file.url) throw new Error('整合包文件缺少下载地址');
  if (!file.hashes || !file.hashes.sha1) throw new Error('整合包文件缺少 SHA-1，已拒绝下载');
  if (ctx.onPhase) ctx.onPhase(`下载整合包 ${file.filename}`);
  const packProgress = createFileProgress(ctx.onProgress, 'modpack');
  await downloadFile(file.url, dest, {
    sha1: file.hashes.sha1,
    size: file.size || undefined,
    mirror: ctx.mirror,
    abort: ctx.abort,
    retries: 3,
    timeout: 600000,
    onChunk: (n, total) => packProgress.add(n, total),
  });
  if (ctx.onLog) ctx.onLog(`[Modrinth] 已校验整合包 SHA-1: ${file.hashes.sha1}`);
  return dest;
}

module.exports = {
  searchModpacks,
  searchMods,
  searchProjects,
  getProject,
  getProjectVersions,
  getVersion,
  pickMrpackFile,
  downloadMrpackFile,
  normalizeProjectId,
  publicVersion,
};
