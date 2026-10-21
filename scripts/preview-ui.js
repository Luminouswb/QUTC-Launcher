'use strict';

/**
 * 生成 UI 预览截图：用 Edge/Chrome headless 加载带 mock 数据的 index.html。
 * 用法：node scripts/preview-ui.js [输出 png] [页面 home|versions|accounts|settings]
 * 需要系统安装 Edge（或设置 EDGE_PATH）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const renderer = path.join(root, 'src', 'renderer');
const previewDir = path.join(root, 'ui-preview');
const out = path.resolve(process.argv[2] || path.join(root, 'shot-home.png'));
const page = process.argv[3] || 'home';

const edge =
  process.env.EDGE_PATH ||
  [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].find((p) => fs.existsSync(p));
if (!edge) {
  console.error('未找到 Edge/Chrome，无法生成预览。');
  process.exit(1);
}

fs.rmSync(previewDir, { recursive: true, force: true });
fs.mkdirSync(previewDir, { recursive: true });
for (const file of ['styles.css', 'logo.png', 'app.js']) {
  fs.copyFileSync(path.join(renderer, file), path.join(previewDir, file));
}
let html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
html = html.replace('<script src="app.js"></script>', '<script src="mock-qutc.js"></script>\n    <script src="app.js"></script>');
fs.writeFileSync(path.join(previewDir, 'index.html'), html, 'utf8');

const mock = `
window.qutc = {
  bootstrap: async () => ({
    appVersion: '1.0.0',
    dataRoot: 'C:\\\\Users\\\\Player\\\\QUTCData',
    portable: true,
    platform: { os: 'win32', arch: 'x64' },
    config: {
      memoryMb: 4096, autoMemory: true, javaPath: '', mirror: 'bmclapi', downloadConcurrency: 12,
      closeOnLaunch: false, showGameLog: true,
      customResolution: { enabled: false, width: 1280, height: 720 },
      jvmArgsExtra: '', gameArgsExtra: '', acceptedSecurityNotice: true, showSnapshots: false
    },
    installedVersions: ['1.20.1', '1.20.1-forge-47.3.0', '1.20.1-fabric-loader-0.15.11-1.20.1'],
    accounts: [
      { id: 'msa:1', type: 'microsoft', name: 'QUTC_Steve', uuid: '00000000-0000-0000-0000-000000000001', selected: true },
      { id: 'offline:2', type: 'offline', name: 'ClubBuilder', uuid: '00000000-0000-0000-0000-000000000002', selected: false }
    ],
    selectedAccountId: 'msa:1',
    logs: [],
    instances: [
      { id: 'i1', name: '社团生存服', versionId: '1.20.1-forge-47.3.0', mcVersion: '1.20.1',
        loader: { type: 'forge', version: '47.3.0' }, lastPlayedAt: '2026-10-18T12:00:00Z', modpack: null },
      { id: 'i2', name: 'QUTC 轻量整合', versionId: '1.20.1-fabric-loader-0.15.11-1.20.1', mcVersion: '1.20.1',
        loader: { type: 'fabric', version: '0.15.11' }, lastPlayedAt: '2026-10-20T09:00:00Z', modpack: { name: 'Adrenaline' } },
      { id: 'i3', name: '原版测试', versionId: '1.20.1', mcVersion: '1.20.1',
        loader: { type: 'vanilla', version: '' }, lastPlayedAt: '', modpack: null }
    ]
  }),
  openExternal: async () => {}, openDataDir: async () => {}, openLogs: async () => {}, openLauncherLog: async () => {},
  config: { save: async (patch) => ({ ...patch, customResolution: patch.customResolution || { enabled: false, width: 1280, height: 720 } }) },
  java: { detect: async () => [{ major: 17, version: '17.0.10' }], choosePath: async () => '' },
  versions: { manifest: async () => ({ latest: { release: '1.21.4', snapshot: '25w01a' }, versions: [
    { id: '1.21.4', type: 'release', releaseTime: '2025-12-02T10:00:00Z' },
    { id: '1.21.1', type: 'release', releaseTime: '2024-08-08T10:00:00Z' },
    { id: '1.20.6', type: 'release', releaseTime: '2024-04-29T10:00:00Z' },
    { id: '1.20.1', type: 'release', releaseTime: '2023-06-12T10:00:00Z' },
    { id: '1.19.4', type: 'release', releaseTime: '2023-03-14T10:00:00Z' },
    { id: '1.18.2', type: 'release', releaseTime: '2022-02-28T10:00:00Z' },
    { id: '1.16.5', type: 'release', releaseTime: '2021-01-14T10:00:00Z' },
    { id: '1.12.2', type: 'release', releaseTime: '2017-09-18T10:00:00Z' },
    { id: '1.8.9', type: 'release', releaseTime: '2015-12-09T10:00:00Z' },
    { id: '1.7.10', type: 'release', releaseTime: '2014-05-14T10:00:00Z' }
  ] }), installed: async () => ['1.20.1'], state: async () => ({ installed: true }), install: async () => {}, remove: async () => {} },
  loaders: { versions: async () => [{ version: '0.15.11', stable: true }, { version: '0.16.0', stable: false }] },
  instances: {
    list: async () => window.__previewInstances || [], create: async () => {}, update: async () => {}, remove: async () => {},
    duplicate: async () => {}, openFolder: async () => {}, launch: async () => {}, stop: async () => {}, export: async () => null, import: async () => null
  },
  accounts: { list: async () => ({ accounts: [], selectedId: null }), addOffline: async () => {}, yggdrasilLogin: async () => {}, msLogin: async () => {}, select: async () => {}, remove: async () => {}, refresh: async () => {} },
  modpack: { search: async () => ({ hits: [] }), versions: async () => [], install: async () => {}, pickLocal: async () => null, installLocal: async () => {} },
  mods: {
    search: async () => ({ hits: [
      { projectId: 'AANobbMI', slug: 'sodium', title: 'Sodium', description: '现代化渲染优化模组，大幅提升帧率并减少卡顿。', downloads: 42000000, iconUrl: '', categories: ['optimization'], loaders: ['fabric'], projectType: 'mod' },
      { projectId: 'YL57xq9U', slug: 'sodium-extra', title: 'Sodium Extra', description: '为 Sodium 增加更多画面与性能选项。', downloads: 18000000, iconUrl: '', categories: ['optimization'], loaders: ['fabric'], projectType: 'mod' },
      { projectId: 'P7dR8mSH', slug: 'fabric-api', title: 'Fabric API', description: '大多数 Fabric 模组需要的核心 API。', downloads: 90000000, iconUrl: '', categories: ['library'], loaders: ['fabric'], projectType: 'mod' }
    ] }),
    versions: async () => [{ id: 'abc123', name: 'Sodium 0.5.12', versionNumber: '0.5.12', gameVersions: ['1.20.1'], loaders: ['fabric'], files: [] }],
    install: async () => ({ installed: [], warnings: [] }),
    importLocal: async () => null
  },
  game: { status: async () => ({ running: false }), onLog: () => {}, onExit: () => {} },
  tasks: { cancel: async () => {}, status: async () => ({ active: false }), onStart: () => {}, onProgress: () => {}, onLog: () => {}, onDone: () => {} },
  events: { onInstancesChanged: () => {}, onVersionsChanged: () => {}, onAccountsChanged: () => {} }
};
setTimeout(() => {
  if ('${page}' === 'newinstance') {
    document.getElementById('btn-new-instance').click();
    return;
  }
  const target = document.querySelector('[data-view="${page}"]');
  if (target && '${page}' !== 'home') target.click();
  if ('${page}' === 'mods') {
    setTimeout(() => {
      const input = document.getElementById('mod-search');
      if (input) {
        input.value = 'sodium';
        document.getElementById('btn-mod-search').click();
      }
    }, 150);
  }
}, 900);
`;
fs.writeFileSync(path.join(previewDir, 'mock-qutc.js'), mock, 'utf8');

const url = pathToFileURL(path.join(previewDir, 'index.html')).href;
const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1180,760',
  '--virtual-time-budget=2500',
  `--screenshot=${out}`,
  url,
];
const result = spawnSync(edge, args, { stdio: 'inherit' });
if (result.status !== 0) console.error('Edge 截图退出码', result.status);
if (!fs.existsSync(out)) {
  console.error('截图未生成');
  process.exit(1);
}
console.log(`已生成预览: ${out}`);
process.exit(0);
