'use strict';

/**
 * QUTC Launcher - Preload
 *
 * 只向页面暴露固定的方法，不暴露 ipcRenderer 本身、不暴露文件系统、不暴露 require。
 * 页面无法调用任意 IPC channel。
 */

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result || result.ok !== true) {
    const info = (result && result.error) || {};
    const err = new Error(info.message || '操作失败');
    err.code = info.code || '';
    err.cancelled = Boolean(info.cancelled);
    throw err;
  }
  return result.data;
}

function on(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('qutc', {
  bootstrap: () => invoke('app:bootstrap'),
  openExternal: (url) => invoke('app:open-external', { url }),
  openDataDir: () => invoke('app:open-data-dir'),
  openLogs: () => invoke('app:open-logs'),
  openLauncherLog: () => invoke('app:open-launcher-log'),

  config: {
    save: (patch) => invoke('config:save', patch),
  },

  java: {
    detect: () => invoke('system:java'),
    choosePath: () => invoke('dialog:choose-java'),
  },

  versions: {
    manifest: (options) => invoke('versions:manifest', options || {}),
    installed: () => invoke('versions:installed'),
    state: (id) => invoke('versions:state', { id }),
    install: (id, label) => invoke('versions:install', { id, label }),
    remove: (id) => invoke('versions:delete', { id }),
  },

  loaders: {
    versions: (loader, mcVersion) => invoke('loaders:versions', { loader, mcVersion }),
  },

  instances: {
    list: () => invoke('instances:list'),
    create: (options) => invoke('instances:create', options),
    pickExternalFolder: () => invoke('instances:pick-external-folder'),
    scanExternal: (folder) => invoke('instances:scan-external', { folder }),
    createExternal: (options) => invoke('instances:create-external', options),
    update: (id, patch) => invoke('instances:update', { id, ...patch }),
    remove: (id) => invoke('instances:delete', { id }),
    duplicate: (id, name) => invoke('instances:duplicate', { id, name }),
    openFolder: (id) => invoke('instances:open-folder', { id }),
    openSubfolder: (id, kind) => invoke('instances:open-subfolder', { id, kind }),
    launch: (id) => invoke('instances:launch', { id }),
    stop: () => invoke('instances:stop'),
    export: (id) => invoke('instances:export', { id }),
    import: () => invoke('instances:import'),
  },

  accounts: {
    list: () => invoke('accounts:list'),
    addOffline: (name) => invoke('accounts:offline', { name }),
    yggdrasilResolve: (url) => invoke('accounts:yggdrasil-resolve', { url }),
    yggdrasilLogin: (username, password, authServer) => invoke('accounts:yggdrasil-login', { username, password, authServer }),
    msLogin: () => invoke('accounts:ms-login'),
    select: (id) => invoke('accounts:select', { id }),
    remove: (id) => invoke('accounts:remove', { id }),
    refresh: () => invoke('accounts:refresh'),
    skin: (id) => invoke('accounts:skin', { id }),
  },

  appearance: {
    pickBackground: () => invoke('appearance:pick-background'),
    clearBackground: () => invoke('appearance:clear-background'),
  },

  modpack: {
    search: (options) => invoke('modpack:search', options),
    versions: (options) => invoke('modpack:versions', options),
    install: (versionId, consent) => invoke('modpack:install', { mrVersionId: versionId, consent: consent === true }),
    pickLocal: () => invoke('modpack:pick-local'),
    installLocal: (file, consent) => invoke('modpack:install-local', { file, consent: consent === true }),
  },

  mods: {
    search: (options) => invoke('mods:search', options),
    versions: (options) => invoke('mods:versions', options),
    install: (options) => invoke('mods:install', options),
    importLocal: (instanceId) => invoke('mods:import-local', { instanceId }),
  },

  frp: {
    status: () => invoke('frp:status'),
    saveCredentials: (account, accessKey) => invoke('frp:save-credentials', { account, accessKey }),
    tunnels: () => invoke('frp:tunnels'),
    start: (tunnelId) => invoke('frp:start', { tunnelId }),
    stop: () => invoke('frp:stop'),
    clearCredentials: () => invoke('frp:clear-credentials'),
    onLog: (cb) => on('frp:log', cb),
    onState: (cb) => on('frp:state', cb),
  },

  game: {
    status: () => invoke('game:status'),
    onLog: (cb) => on('game:log', cb),
    onExit: (cb) => on('game:exit', cb),
  },

  tasks: {
    cancel: () => invoke('task:cancel'),
    status: () => invoke('task:status'),
    onStart: (cb) => on('task:start', cb),
    onProgress: (cb) => on('task:progress', cb),
    onLog: (cb) => on('task:log', cb),
    onDone: (cb) => on('task:done', cb),
  },

  events: {
    onInstancesChanged: (cb) => on('instances:changed', cb),
    onVersionsChanged: (cb) => on('versions:changed', cb),
    onAccountsChanged: (cb) => on('accounts:changed', cb),
  },
});
