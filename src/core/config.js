'use strict';

/**
 * QUTC Launcher - 全局配置
 */

const crypto = require('node:crypto');
const path = require('node:path');
const Paths = require('./paths');
const { readJson, writeJsonAtomic, ensureDirAsync } = require('./util');

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  memoryMb: 4096,
  autoMemory: true,
  javaPath: '',
  autoDownloadJava: true,
  mirror: 'official', // official | bmclapi
  downloadConcurrency: 12,
  closeOnLaunch: false,
  showGameLog: true,
  customResolution: { enabled: false, width: 1280, height: 720 },
  jvmArgsExtra: '',
  gameArgsExtra: '',
  installationId: '',
  showSnapshots: false,
  language: 'zh-CN',
  acceptedSecurityNotice: false,
});

let cached = null;

function normalize(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw || {}) };
  config.memoryMb = clampInt(config.memoryMb, 512, 65536, DEFAULT_CONFIG.memoryMb);
  config.downloadConcurrency = clampInt(config.downloadConcurrency, 1, 32, 12);
  config.mirror = config.mirror === 'bmclapi' ? 'bmclapi' : 'official';
  config.autoDownloadJava = config.autoDownloadJava !== false;
  config.autoMemory = config.autoMemory !== false;
  config.closeOnLaunch = Boolean(config.closeOnLaunch);
  config.showGameLog = config.showGameLog !== false;
  config.showSnapshots = Boolean(config.showSnapshots);
  config.jvmArgsExtra = String(config.jvmArgsExtra || '').slice(0, 4000);
  config.gameArgsExtra = String(config.gameArgsExtra || '').slice(0, 2000);
  config.javaPath = String(config.javaPath || '').trim();
  if (!config.customResolution || typeof config.customResolution !== 'object') {
    config.customResolution = { ...DEFAULT_CONFIG.customResolution };
  }
  config.customResolution.enabled = Boolean(config.customResolution.enabled);
  config.customResolution.width = clampInt(config.customResolution.width, 320, 7680, 1280);
  config.customResolution.height = clampInt(config.customResolution.height, 240, 4320, 720);
  delete config.msClientId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(config.installationId || ''))) {
    config.installationId = crypto.randomUUID();
  }
  return config;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function load() {
  const file = Paths.getPaths().configFile;
  const raw = await readJson(file, null);
  cached = normalize(raw);
  if (!raw || raw.installationId !== cached.installationId || raw.msClientId) await save(cached);
  return cached;
}

function get() {
  return cached || normalize(null);
}

async function save(patch) {
  const current = get();
  const next = normalize({ ...current, ...(patch || {}) });
  const file = Paths.getPaths().configFile;
  await ensureDirAsync(path.dirname(file));
  await writeJsonAtomic(file, next);
  cached = next;
  return next;
}

/** 配置是否完整（首次启动引导用） */
function needsSetup() {
  return !get().acceptedSecurityNotice;
}

module.exports = {
  DEFAULT_CONFIG,
  load,
  get,
  save,
  normalize,
  needsSetup,
};
