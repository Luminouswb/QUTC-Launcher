'use strict';

/**
 * QUTC Launcher - Minecraft 版本规则 / Maven 坐标
 */

const path = require('node:path');

const PLATFORM_NAME =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';

const ARCH_NAME = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x86_64';

function osArchBits() {
  return process.arch === 'ia32' ? '32' : '64';
}

/** 判断单条规则是否匹配当前环境 */
function matchRule(rule, context) {
  if (!rule || typeof rule !== 'object') return true;
  const os = rule.os;
  if (os) {
    if (os.name && os.name !== context.osName) return false;
    if (os.arch) {
      const wanted = String(os.arch).toLowerCase();
      const actual = context.osArch;
      const ok =
        wanted === actual ||
        (wanted === 'x86' && actual === 'x86') ||
        (wanted === 'x86_64' && actual === 'x86_64') ||
        (wanted === 'amd64' && actual === 'x86_64') ||
        (wanted === 'arm64' && actual === 'arm64');
      if (!ok) return false;
    }
    if (os.version) {
      try {
        if (!new RegExp(os.version).test(context.osVersion)) return false;
      } catch {
        return false;
      }
    }
  }
  if (rule.features) {
    for (const [key, value] of Object.entries(rule.features)) {
      if (Boolean(context.features[key]) !== Boolean(value)) return false;
    }
  }
  return true;
}

/**
 * 评估 rules 数组（遵循官方 “最后一条匹配规则生效” 语义）。
 * rules 为空 / 缺失 → allow。
 */
function isAllowed(rules, context = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  const ctx = {
    osName: PLATFORM_NAME,
    osArch: ARCH_NAME,
    osVersion: '',
    features: {},
    ...context,
    features: { ...(context.features || {}) },
  };
  let allowed = false;
  for (const rule of rules) {
    if (matchRule(rule, ctx)) allowed = rule.action === 'allow';
  }
  return allowed;
}

function parseMavenName(name) {
  const parts = String(name || '').split(':');
  if (parts.length < 3) return null;
  let classifier = parts[3] || '';
  let extension = 'jar';
  const at = classifier.indexOf('@');
  if (at >= 0) {
    extension = classifier.slice(at + 1) || 'jar';
    classifier = classifier.slice(0, at);
  } else if (parts[4]) {
    extension = parts[4];
  }
  return {
    group: parts[0],
    artifact: parts[1],
    version: parts[2],
    classifier,
    extension,
  };
}

function mavenRelPath(name) {
  const parsed = typeof name === 'string' ? parseMavenName(name) : name;
  if (!parsed) throw new Error(`非法 Maven 坐标: ${name}`);
  const { group, artifact, version, classifier } = parsed;
  const extension = parsed.extension || 'jar';
  const dir = `${group.replace(/\./g, '/')}/${artifact}/${version}`;
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
  return `${dir}/${file}`;
}

function mavenBaseUrl(lib) {
  const base = lib.url || 'https://libraries.minecraft.net/';
  return base.endsWith('/') ? base : `${base}/`;
}

/** 返回库文件描述（不判断规则） */
function libraryArtifact(lib) {
  if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) {
    return {
      path: lib.downloads.artifact.path,
      url: lib.downloads.artifact.url,
      sha1: lib.downloads.artifact.sha1,
      size: lib.downloads.artifact.size,
    };
  }
  if (!lib.name) return null;
  // 只有 natives 分类器、没有主 artifact 的库（例如旧版 jinput-platform / twitch-platform）
  if (!(lib.downloads && lib.downloads.artifact) && (lib.natives || (lib.downloads && lib.downloads.classifiers))) {
    return null;
  }
  const parsed = parseMavenName(lib.name);
  if (!parsed) return null;
  const rel = mavenRelPath(parsed);
  return {
    path: rel,
    url: `${mavenBaseUrl(lib)}${rel}`,
    sha1: undefined,
    size: undefined,
  };
}

/** 旧版 natives classifier（lib.natives.windows = "natives-windows-${arch}"） */
function nativeClassifier(lib) {
  if (!lib.natives) return '';
  const raw = lib.natives[PLATFORM_NAME];
  if (!raw) return '';
  return String(raw).replace('${arch}', osArchBits());
}

function nativeArtifact(lib) {
  const classifier = nativeClassifier(lib);
  if (classifier) {
    const fromClassifiers = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[classifier];
    if (fromClassifiers && fromClassifiers.path) {
      return {
        path: fromClassifiers.path,
        url: fromClassifiers.url,
        sha1: fromClassifiers.sha1,
        size: fromClassifiers.size,
        classifier,
      };
    }
    if (lib.name) {
      const parsed = parseMavenName(lib.name);
      if (parsed) {
        const rel = mavenRelPath({ ...parsed, classifier });
        return {
          path: rel,
          url: `${mavenBaseUrl(lib)}${rel}`,
          sha1: undefined,
          size: undefined,
          classifier,
        };
      }
    }
  }
  const parsed = lib.name ? parseMavenName(lib.name) : null;
  if (parsed && parsed.classifier.startsWith('natives-')) {
    return { ...libraryArtifact(lib), classifier: parsed.classifier };
  }
  return null;
}

function libraryKey(lib) {
  const parsed = lib.name ? parseMavenName(lib.name) : null;
  if (!parsed) return lib.name || JSON.stringify(lib).slice(0, 120);
  return `${parsed.group}:${parsed.artifact}:${parsed.classifier}`;
}

/** 合并父/子版本依赖：同 key 子版本覆盖，其他保持顺序 */
function mergeLibraries(parentLibs, childLibs) {
  const result = [];
  const index = new Map();
  for (const lib of [...(parentLibs || []), ...(childLibs || [])]) {
    const key = libraryKey(lib);
    if (index.has(key)) {
      result[index.get(key)] = lib;
    } else {
      index.set(key, result.length);
      result.push(lib);
    }
  }
  return result;
}

module.exports = {
  PLATFORM_NAME,
  ARCH_NAME,
  osArchBits,
  isAllowed,
  matchRule,
  parseMavenName,
  mavenRelPath,
  mavenBaseUrl,
  libraryArtifact,
  nativeClassifier,
  nativeArtifact,
  libraryKey,
  mergeLibraries,
};
