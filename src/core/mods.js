'use strict';

/**
 * QUTC Launcher - MOD 下载
 *
 * 数据来自 Modrinth 官方 API；文件必须带 SHA-1 才下载。
 * 依赖只处理 dependency_type === "required" 的 MOD，并限制深度/数量，避免循环。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const Paths = require('./paths');
const Instances = require('./instances');
const Modrinth = require('./modrinth');
const { expandModQuery } = require('./mod-aliases');
const { downloadFile } = require('./http');
const { hashFile } = require('./hash');
const { ensureDirAsync, createFileProgress, readJson, writeJsonAtomic } = require('./util');

const MANIFEST_NAME = '.qutc-mods.json';
const MAX_MODS = 50;
const MAX_DEPTH = 5;

function sanitizeModFilename(filename, fallback) {
  let base = path.basename(String(filename || '')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
  if (!/\.jar$/i.test(base)) base = `${base || fallback || 'mod'}.jar`;
  base = base.replace(/\s+/g, ' ').trim().slice(0, 150);
  if (!base || base === '.jar') base = `${fallback || 'mod'}.jar`;
  // Windows 保留名
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(base)) base = `_${base}`;
  return base;
}

function pickModFile(version) {
  if (!version || !Array.isArray(version.files)) return null;
  const jars = version.files.filter(
    (file) =>
      file &&
      file.url &&
      /\.jar$/i.test(file.filename) &&
      !/-sources\.jar$/i.test(file.filename) &&
      !/-javadoc\.jar$/i.test(file.filename) &&
      file.hashes &&
      file.hashes.sha1,
  );
  return jars.find((file) => file.primary) || jars[0] || null;
}

function isVersionCompatible(version, instance) {
  if (!version || !instance) return false;
  const mcVersion = String(instance.mcVersion || '');
  const loader = instance.loader && instance.loader.type;
  if (!loader || loader === 'vanilla') return false;
  const gameVersions = Array.isArray(version.gameVersions) ? version.gameVersions : [];
  if (mcVersion && !gameVersions.includes(mcVersion)) return false;
  const loaders = Array.isArray(version.loaders) ? version.loaders : [];
  if (loader === 'quilt') return loaders.includes('quilt') || loaders.includes('fabric');
  return loaders.includes(loader);
}

async function searchMods(query, options = {}) {
  const instance = options.instanceId ? await Instances.getInstance(options.instanceId) : null;
  if (instance && (!instance.loader || instance.loader.type === 'vanilla')) {
    throw new Error('该实例是原版，不能安装 MOD。请选择 Fabric/Quilt/Forge/NeoForge 实例。');
  }
  const loader = instance && instance.loader ? instance.loader.type : '';
  const queries = expandModQuery(query);
  if (!queries.length) throw new Error('请输入 MOD 名称');
  const perQuery = Math.max(5, Math.min(12, Math.ceil((options.limit || 18) / Math.min(queries.length, 3))));
  const merged = [];
  const seen = new Set();
  let total = 0;
  for (const item of queries.slice(0, 3)) {
    const result = await Modrinth.searchMods(item, {
      gameVersion: instance ? instance.mcVersion : options.gameVersion,
      loaders: loader === 'quilt' ? ['quilt', 'fabric'] : loader ? [loader] : undefined,
      limit: perQuery,
      offset: 0,
      sort: options.sort,
      abort: options.abort,
    });
    total = Math.max(total, Number(result.total_hits) || 0);
    for (const hit of result.hits) {
      if (seen.has(hit.projectId)) continue;
      seen.add(hit.projectId);
      merged.push(hit);
    }
  }
  return {
    hits: merged.slice(0, Math.max(1, options.limit || 18)),
    total_hits: total,
    expanded: queries,
  };
}

async function listVersions(projectId, options = {}) {
  const instance = await Instances.getInstance(options.instanceId);
  if (!instance.loader || instance.loader.type === 'vanilla') {
    throw new Error('该实例是原版，不能安装 MOD');
  }
  const id = Modrinth.normalizeProjectId(projectId);
  const versions = await Modrinth.getProjectVersions(id, {
    gameVersion: instance.mcVersion,
    abort: options.abort,
  });
  return versions.filter((version) => isVersionCompatible(version, instance) && pickModFile(version));
}

async function resolveDependency(dependency, instance, ctx) {
  if (!dependency || dependency.dependencyType !== 'required') return null;
  const loader = instance.loader.type;
  if (dependency.versionId && /^[A-Za-z0-9]{6,32}$/.test(dependency.versionId)) {
    try {
      const version = await Modrinth.getVersion(dependency.versionId, { abort: ctx.abort });
      if (isVersionCompatible(version, instance) && pickModFile(version)) return version;
    } catch {
      /* 版本被删除等情况，退回项目版本列表 */
    }
  }
  if (!dependency.projectId) return null;
  try {
    const projectId = Modrinth.normalizeProjectId(dependency.projectId);
    const versions = await Modrinth.getProjectVersions(projectId, {
      gameVersion: instance.mcVersion,
      abort: ctx.abort,
    });
    return versions.find((version) => isVersionCompatible(version, instance) && pickModFile(version)) || null;
  } catch (err) {
    if (ctx.onLog) ctx.onLog(`[MOD] 依赖 ${dependency.projectId} 解析失败: ${err.message}`);
    return null;
  }
}

/**
 * 安装一个 MOD（可选自动安装 required 依赖）
 * @param {{instanceId:string, versionId:string, installDependencies?:boolean}} options
 */
async function installMod(options, ctx = {}) {
  const instance = await Instances.getInstance(options.instanceId);
  const loader = instance.loader && instance.loader.type;
  if (!loader || loader === 'vanilla') {
    throw new Error('该实例是原版，不能安装 MOD。请选择带加载器的实例。');
  }
  const rootVersion = await Modrinth.getVersion(String(options.versionId || ''), { abort: ctx.abort });
  if (!isVersionCompatible(rootVersion, instance)) {
    throw new Error(
      `该 MOD 版本不适配当前实例（需要 ${instance.mcVersion} / ${loader}）`,
    );
  }
  if (!pickModFile(rootVersion)) throw new Error('该 MOD 版本没有可下载的 .jar 文件');

  const modsDir = path.join(Instances.gameDirForInstance(instance), 'mods');
  await ensureDirAsync(modsDir);
  const manifestPath = path.join(modsDir, MANIFEST_NAME);
  let manifest = await readJson(manifestPath, { version: 1, projects: {} });
  if (!manifest || typeof manifest !== 'object' || !manifest.projects || typeof manifest.projects !== 'object') {
    manifest = { version: 1, projects: {} };
  }

  const installed = [];
  const warnings = [];
  const seenProjects = new Set();
  const seenFiles = new Set();
  const withDependencies = options.installDependencies !== false;

  async function installOne(version, depth, dependency) {
    if (!version || !version.projectId) return null;
    if (seenProjects.has(version.projectId)) return null;
    if (installed.length >= MAX_MODS) throw new Error(`一次最多安装 ${MAX_MODS} 个 MOD`);
    const file = pickModFile(version);
    if (!file) {
      warnings.push(`${version.name || version.id} 没有可下载的 .jar`);
      return null;
    }
    if (!file.hashes.sha1) {
      warnings.push(`${version.name || version.id} 缺少 SHA-1，已跳过`);
      return null;
    }
    const filename = sanitizeModFilename(file.filename, `${version.projectId}-${version.id}`);
    const dest = path.join(modsDir, filename);
    if (seenFiles.has(dest)) return null;
    seenFiles.add(dest);
    seenProjects.add(version.projectId);

    if (ctx.onPhase) ctx.onPhase(`下载 ${version.name || filename}`);
    const progress = createFileProgress(ctx.onProgress, 'mods');
    await downloadFile(file.url, dest, {
      sha1: file.hashes.sha1,
      size: file.size || undefined,
      mirror: ctx.mirror,
      abort: ctx.abort,
      retries: 3,
      timeout: 300000,
      onChunk: (n, total) => progress.add(n, total),
    });
    const item = {
      projectId: version.projectId,
      versionId: version.id,
      name: version.name || filename,
      versionNumber: version.versionNumber || '',
      filename,
      dependency: Boolean(dependency),
    };
    installed.push(item);
    const previous = manifest.projects[version.projectId];
    if (previous && previous.filename && previous.filename !== filename) {
      const previousPath = path.join(modsDir, path.basename(String(previous.filename)));
      try {
        if (fs.existsSync(previousPath)) {
          await fsp.unlink(previousPath);
          if (ctx.onLog) ctx.onLog(`[MOD] 已移除旧版本 mods/${path.basename(previousPath)}`);
        }
      } catch (err) {
        warnings.push(`旧版本清理失败: ${err.message}`);
      }
    }
    manifest.projects[version.projectId] = {
      filename,
      versionId: version.id,
      name: item.name,
      versionNumber: item.versionNumber,
      installedAt: new Date().toISOString(),
    };
    if (ctx.onLog) {
      ctx.onLog(`[MOD] 已安装 ${item.name} ${item.versionNumber} -> mods/${filename}`);
    }

    if (withDependencies && depth < MAX_DEPTH) {
      for (const dep of version.dependencies || []) {
        if (dep.dependencyType !== 'required') continue;
        try {
          const depVersion = await resolveDependency(dep, instance, ctx);
          if (depVersion) await installOne(depVersion, depth + 1, true);
          else warnings.push(`缺少必要依赖 ${dep.projectId || dep.versionId}，可能无法启动`);
        } catch (err) {
          if (err && err.cancelled) throw err;
          warnings.push(`依赖安装失败: ${err.message}`);
        }
      }
    }
    return item;
  }

  const main = await installOne(rootVersion, 0, false);
  try {
    await writeJsonAtomic(manifestPath, manifest);
  } catch (err) {
    warnings.push(`MOD 清单写入失败: ${err.message}`);
  }
  const result = {
    instanceId: instance.id,
    instanceName: instance.name,
    modsDir,
    installed,
    warnings,
    root: main,
  };
  if (ctx.onLog) {
    ctx.onLog(`[MOD] 完成：${installed.length} 个文件，${warnings.length} 条警告`);
  }
  return result;
}

async function installLocalJar(instanceId, sourceFile, ctx = {}) {
  const instance = await Instances.getInstance(instanceId);
  if (!instance.loader || instance.loader.type === 'vanilla') {
    throw new Error('该实例是原版，不能安装 MOD');
  }
  const source = String(sourceFile || '');
  if (!/\.jar$/i.test(source)) throw new Error('只支持 .jar 文件');
  const stat = await fsp.stat(source);
  if (!stat.isFile()) throw new Error('不是文件');
  if (stat.size > 100 * 1024 * 1024) throw new Error('MOD 文件超过 100MB');
  const modsDir = path.join(Instances.gameDirForInstance(instance), 'mods');
  await ensureDirAsync(modsDir);
  const filename = sanitizeModFilename(path.basename(source), `local-${Date.now()}`);
  const dest = path.join(modsDir, filename);
  if (ctx.onPhase) ctx.onPhase(`导入 ${filename}`);
  await fsp.copyFile(source, dest);
  const sha1 = await hashFile(dest, 'sha1');
  const manifestPath = path.join(modsDir, MANIFEST_NAME);
  let manifest = await readJson(manifestPath, { version: 1, projects: {} });
  if (!manifest || typeof manifest !== 'object' || !manifest.projects) manifest = { version: 1, projects: {} };
  manifest.projects[`local:${sha1}`] = {
    filename,
    versionId: '',
    name: filename,
    versionNumber: '本地导入',
    installedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(manifestPath, manifest);
  if (ctx.onLog) ctx.onLog(`[MOD] 本地导入 mods/${filename} (sha1 ${sha1})`);
  return { instanceId: instance.id, filename, sha1, modsDir };
}

module.exports = {
  sanitizeModFilename,
  pickModFile,
  isVersionCompatible,
  searchMods,
  listVersions,
  installMod,
  installLocalJar,
};
