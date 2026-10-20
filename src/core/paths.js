'use strict';

/**
 * QUTC Launcher - 目录布局
 *
 * 默认便携模式：数据保存在启动器目录下的 QUTCData/。
 * 若程序目录不可写（例如装在 Program Files），自动回退到用户数据目录。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureDir, exists } = require('./util');

const state = {
  initialized: false,
  root: '',
  portable: true,
  appRoot: '',
  appVersion: '0.0.0',
};

function canWrite(dir) {
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function init({ appRoot, exeDir, isPackaged, userDataDir, appVersion }) {
  if (state.initialized) return getPaths();
  state.appRoot = appRoot;
  state.appVersion = appVersion || '0.0.0';

  const envRoot = process.env.QUTC_DATA;
  if (envRoot) {
    state.root = path.resolve(envRoot);
    state.portable = true;
  } else if (!isPackaged) {
    state.root = path.join(appRoot, 'data');
    state.portable = true;
  } else {
    const portableDir = path.join(exeDir, 'QUTCData');
    if (canWrite(portableDir)) {
      state.root = portableDir;
      state.portable = true;
    } else {
      state.root = path.join(userDataDir, 'QUTCData');
      state.portable = false;
    }
  }

  for (const dir of subdirs(state.root)) ensureDir(dir);
  state.initialized = true;
  return getPaths();
}

function subdirs(root) {
  return [
    root,
    path.join(root, 'cache'),
    path.join(root, 'cache', 'version-json'),
    path.join(root, 'cache', 'manifests'),
    path.join(root, 'cache', 'icons'),
    path.join(root, 'cache', 'downloads'),
    path.join(root, 'versions'),
    path.join(root, 'libraries'),
    path.join(root, 'assets'),
    path.join(root, 'assets', 'indexes'),
    path.join(root, 'assets', 'objects'),
    path.join(root, 'assets', 'log_configs'),
    path.join(root, 'java'),
    path.join(root, 'instances'),
    path.join(root, 'logs'),
  ];
}

function root() {
  return state.root;
}

function getPaths() {
  const r = state.root;
  return {
    root: r,
    portable: state.portable,
    appRoot: state.appRoot,
    appVersion: state.appVersion,
    cache: path.join(r, 'cache'),
    versions: path.join(r, 'versions'),
    libraries: path.join(r, 'libraries'),
    assets: path.join(r, 'assets'),
    assetsIndexes: path.join(r, 'assets', 'indexes'),
    assetsObjects: path.join(r, 'assets', 'objects'),
    logConfigs: path.join(r, 'assets', 'log_configs'),
    java: path.join(r, 'java'),
    instances: path.join(r, 'instances'),
    logs: path.join(r, 'logs'),
    configFile: path.join(r, 'config.json'),
    accountsFile: path.join(r, 'accounts.json'),
    launcherLog: path.join(r, 'logs', 'launcher.log'),
    versionDir: (id) => path.join(r, 'versions', id),
    versionJson: (id) => path.join(r, 'versions', id, `${id}.json`),
    versionJar: (id) => path.join(r, 'versions', id, `${id}.jar`),
    libraryFile: (rel) => path.join(r, 'libraries', rel),
    assetObject: (hash) => path.join(r, 'assets', 'objects', hash.slice(0, 2), hash),
    assetIndex: (id) => path.join(r, 'assets', 'indexes', `${id}.json`),
    instanceDir: (id) => path.join(r, 'instances', id),
    instanceFile: (id) => path.join(r, 'instances', id, 'instance.json'),
    instanceGameDir: (id) => path.join(r, 'instances', id, 'minecraft'),
    instanceNatives: (id) => path.join(r, 'instances', id, 'natives'),
    avatarCache: (uuid) => path.join(r, 'cache', 'icons', `avatar-${uuid}.png`),
  };
}

function systemInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    hostname: os.hostname(),
    totalMemMb: Math.floor(os.totalmem() / 1024 / 1024),
    freeMemMb: Math.floor(os.freemem() / 1024 / 1024),
    cpus: os.cpus().length,
    dataRoot: state.root,
    portable: state.portable,
  };
}

function defaultMemoryMb() {
  const total = Math.floor(os.totalmem() / 1024 / 1024);
  // 默认分配系统内存的 1/4，限制在 2G - 8G，避免整机卡死
  return Math.max(2048, Math.min(8192, Math.floor(total / 4 / 512) * 512));
}

module.exports = {
  init,
  getPaths,
  root,
  systemInfo,
  defaultMemoryMb,
  exists,
};
