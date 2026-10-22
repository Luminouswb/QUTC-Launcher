'use strict';

/* QUTC Launcher - Renderer
 * 无框架、无第三方依赖。所有远程数据都先用 textContent 写入，避免 XSS。
 */

const $ = (id) => document.getElementById(id);
const api = window.qutc;

const state = {
  view: 'home',
  config: null,
  instances: [],
  installed: new Set(),
  accounts: [],
  selectedAccountId: null,
  skinCache: {},
  manifest: null,
  manifestAt: 0,
  versionLimit: 200,
  versionQuery: '',
  versionType: 'release',
  packs: [],
  mods: [],
  modInstanceId: '',
  task: null,
  gameRunning: false,
  gameInstanceId: '',
  frp: null,
  bootstrapped: false,
};

const VIEW_META = {
  home: ['主页', 'QUTC Minecraft 社团专属启动器'],
  directories: ['项目目录', '原地注册已有的 Minecraft 目录，多个版本共享同一份资源'],
  versions: ['下载版本', '原版全版本下载，全部校验 Mojang 官方 SHA-1'],
  modpacks: ['整合包', '从 Modrinth 安装或导入本地 .mrpack'],
  mods: ['MOD', '从 Modrinth 下载 MOD 到指定版本，自动处理依赖'],
  accounts: ['账户', '微软正版、authlib-injector 外置登录与离线模式'],
  settings: ['设置', 'Java、内存、下载源、外观与安全选项'],
};

const LOADER_NAMES = {
  vanilla: '原版',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function fmtNumber(n) {
  const value = Number(n) || 0;
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

function toast(message, type = '') {
  const node = el('div', `toast ${type}`.trim(), message);
  $('toast-root').appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 250);
  }, type === 'error' ? 6000 : 3200);
}

function showError(err) {
  toast((err && err.message) || '操作失败', 'error');
}

/* ------------------------------------------------------------------ */
/* 模态框                                                              */
/* ------------------------------------------------------------------ */

function openModal({ title, subtitle, build, actions, wide = false }) {
  const root = $('modal-root');
  root.hidden = false;
  clear(root);
  const modal = el('div', `modal${wide ? ' wide' : ''}`);
  modal.appendChild(el('h2', '', title));
  if (subtitle) modal.appendChild(el('div', 'sub', subtitle));
  const body = el('div', 'modal-body');
  if (build) build(body);
  modal.appendChild(body);
  const footer = el('div', 'modal-actions');
  const close = () => {
    root.hidden = true;
    clear(root);
  };
  for (const action of actions || []) {
    const btn = el('button', `btn ${action.kind || ''}`.trim(), action.label);
    btn.addEventListener('click', async () => {
      if (action.onClick) {
        try {
          await action.onClick(close);
        } catch (err) {
          showError(err);
        }
      } else {
        close();
      }
    });
    footer.appendChild(btn);
  }
  modal.appendChild(footer);
  root.appendChild(modal);
  return { close, body };
}

function confirmDialog(title, message, { okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openModal({
      title,
      subtitle: message,
      actions: [
        { label: '取消', kind: 'ghost', onClick: (close) => { finish(false); close(); } },
        {
          label: okText,
          kind: danger ? 'danger' : 'primary',
          onClick: (close) => { finish(true); close(); },
        },
      ],
    });
    const root = $('modal-root');
    const observer = new MutationObserver(() => {
      if (root.hidden) {
        observer.disconnect();
        finish(false);
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ['hidden'] });
  });
}

/* ------------------------------------------------------------------ */
/* 导航                                                                */
/* ------------------------------------------------------------------ */

function bindNav() {
  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
}

function setView(view) {
  if (!VIEW_META[view]) return;
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((node) => {
    node.classList.toggle('active', node.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach((node) => {
    node.hidden = node.id !== `view-${view}`;
  });
  $('view-title').textContent = VIEW_META[view][0];
  $('view-subtitle').textContent = VIEW_META[view][1];
  if (view === 'home') renderInstances();
  if (view === 'directories') renderDirectories();
  if (view === 'versions') renderVersions();
  if (view === 'mods') renderMods();
  if (view === 'accounts') renderAccounts();
  if (view === 'settings') {
    fillSettings();
    refreshFrp();
  }
}

/* ------------------------------------------------------------------ */
/* 版本                                                                */
/* ------------------------------------------------------------------ */

function loaderLabel(loader) {
  if (!loader) return '原版';
  return LOADER_NAMES[loader.type] || loader.type || '原版';
}

function directoryName(folder) {
  return String(folder).split(/[\\/]/).filter(Boolean).pop() || folder;
}

function renderInstances() {
  const grid = $('instance-grid');
  clear(grid);
  const normal = state.instances.filter((instance) => !(instance.external && instance.externalPath));
  $('instance-count').textContent = `${state.instances.length} 个版本`;
  $('instance-empty').hidden = state.instances.length > 0;
  grid.hidden = normal.length === 0;
  for (const instance of normal) grid.appendChild(instanceCard(instance));
  const selected = state.accounts.find((a) => a.selected);
  $('hero-name').textContent = selected ? selected.name : '冒险家';
}

function directoryGroups() {
  const groups = [];
  const managed = state.instances.filter((instance) => !instance.external);
  if (managed.length) {
    groups.push({
      key: 'qutc-managed',
      name: 'QUTC 下载版本',
      path: 'QUTCData/instances',
      managed: true,
      instances: managed,
    });
  }
  const external = new Map();
  for (const instance of state.instances) {
    if (!instance.external || !instance.externalPath) continue;
    if (!external.has(instance.externalPath)) external.set(instance.externalPath, []);
    external.get(instance.externalPath).push(instance);
  }
  for (const [folder, instances] of external) {
    groups.push({ key: folder, name: directoryName(folder), path: folder, managed: false, instances });
  }
  return groups;
}

function renderDirectories() {
  const grid = $('directory-grid');
  const empty = $('directory-empty');
  clear(grid);
  const groups = directoryGroups();
  $('directory-count').textContent = `${groups.length} 个项目目录`;
  grid.hidden = groups.length === 0;
  empty.hidden = groups.length > 0;
  for (const group of groups) grid.appendChild(directoryCard(group));
}

function directoryCard(group) {
  const card = el('div', 'instance-card');
  const top = el('div', 'instance-top');
  top.appendChild(el('div', 'instance-icon', 'DIR'));
  const title = el('div', 'instance-title');
  title.appendChild(el('strong', '', group.name));
  title.appendChild(el('span', 'directory-path', group.path));
  top.appendChild(title);
  card.appendChild(top);

  const meta = el('div', 'instance-meta');
  meta.appendChild(el('span', 'pill blue', `${group.instances.length} 个版本`));
  meta.appendChild(el('span', 'pill', group.managed ? '启动器管理' : '原地使用'));
  card.appendChild(meta);

  const actions = el('div', 'instance-actions');
  const manage = el('button', 'btn primary', '管理版本');
  manage.addEventListener('click', () => openDirectoryModal(group));
  actions.appendChild(manage);
  if (group.managed) {
    const create = el('button', 'btn ghost small', '新建版本');
    create.addEventListener('click', () => openCreateInstance());
    actions.appendChild(create);
  } else {
    const open = el('button', 'btn ghost small', '打开目录');
    open.addEventListener('click', () => api.instances.openFolder(group.instances[0].id).catch(showError));
    actions.appendChild(open);
  }
  card.appendChild(actions);
  return card;
}

function openDirectoryModal(group) {
  openModal({
    title: group.name,
    subtitle: group.path,
    wide: true,
    build: (body) => {
      body.appendChild(
        el(
          'div',
          'hint',
          group.managed
            ? `本启动器下载的 ${group.instances.length} 个版本，每个版本有独立游戏目录。`
            : `这个目录下有 ${group.instances.length} 个版本，共享同一份 mods / saves / 配置。`,
        ),
      );
      for (const instance of group.instances) {
        const row = el('div', 'dir-version');
        const head = el('div', 'dir-version-head');
        head.appendChild(el('strong', '', instance.name));
        head.appendChild(el('span', '', `${instance.mcVersion || instance.versionId} · ${loaderLabel(instance.loader)}`));
        row.appendChild(head);
        const actions = el('div', 'instance-actions');
        const launch = el('button', 'btn primary', '开始游戏');
        launch.addEventListener('click', () => launchInstance(instance.id));
        actions.appendChild(launch);
        const manage = el('button', 'btn ghost small', '管理版本');
        manage.addEventListener('click', () => instanceMenu(instance));
        actions.appendChild(manage);
        row.appendChild(actions);
        body.appendChild(row);
      }
    },
    actions: [
      {
        label: group.managed ? '新建版本' : '添加版本到此目录',
        kind: 'primary',
        onClick: (close) => {
          close();
          if (group.managed) openCreateInstance();
          else addExistingFolder(group.path);
        },
      },
      { label: '关闭', kind: 'ghost', onClick: (close) => close() },
    ],
  });
}

function instanceCard(instance) {
  const card = el('div', 'instance-card');
  const top = el('div', 'instance-top');
  const icon = el('div', 'instance-icon', (instance.name || '?').slice(0, 1).toUpperCase());
  const title = el('div', 'instance-title');
  title.appendChild(el('strong', '', instance.name));
  title.appendChild(el('span', '', `${instance.mcVersion || instance.versionId} · ${loaderLabel(instance.loader)}`));
  top.appendChild(icon);
  top.appendChild(title);
  card.appendChild(top);

  const meta = el('div', 'instance-meta');
  meta.appendChild(
    el('span', 'pill accent', instance.loader && instance.loader.type !== 'vanilla' ? loaderLabel(instance.loader) : '原版'),
  );
  if (instance.loader && instance.loader.version) meta.appendChild(el('span', 'pill', instance.loader.version));
  if (instance.external) meta.appendChild(el('span', 'pill blue', '外部目录'));
  meta.appendChild(el('span', 'pill', instance.lastPlayedAt ? `上次 ${fmtDate(instance.lastPlayedAt)}` : '从未启动'));
  card.appendChild(meta);

  const actions = el('div', 'instance-actions');
  const running = state.gameRunning && state.gameInstanceId === instance.id;
  const launch = el('button', 'btn primary', running ? '停止游戏' : '开始游戏');
  launch.addEventListener('click', () => (running ? stopGame() : launchInstance(instance.id)));
  actions.appendChild(launch);

  const manage = el('button', 'btn ghost small', '管理版本');
  manage.addEventListener('click', () => instanceMenu(instance));
  actions.appendChild(manage);
  card.appendChild(actions);
  return card;
}

function instanceMenu(instance) {
  const ui = {};
  openModal({
    title: instance.name,
    subtitle: `${instance.versionId} · ${loaderLabel(instance.loader)}${instance.modpack ? ' · 整合包版本' : ''}`,
    wide: true,
    build: (body) => {
      body.appendChild(
        el(
          'div',
          'hint',
          instance.external
            ? `外部游戏目录（原地使用）: ${instance.externalPath}`
            : `游戏目录: instances/${instance.id}/minecraft`,
        ),
      );

      const nameField = el('label', 'field');
      nameField.appendChild(el('span', '', '版本名称'));
      const nameInput = el('input', 'input');
      nameInput.value = instance.name;
      nameInput.maxLength = 48;
      nameField.appendChild(nameInput);
      body.appendChild(nameField);

      const memField = el('label', 'field');
      memField.appendChild(el('span', '', '本版本内存（MB，0 表示使用全局设置）'));
      const memInput = el('input', 'input');
      memInput.type = 'number';
      memInput.min = '0';
      memInput.max = '65536';
      memInput.step = '512';
      memInput.value = String(instance.memoryMb || 0);
      memField.appendChild(memInput);
      body.appendChild(memField);

      const resField = el('label', 'field');
      resField.appendChild(el('span', '', '本版本分辨率'));
      const resRow = el('div', 'row');
      const resEnabled = el('input');
      resEnabled.type = 'checkbox';
      resEnabled.checked = Boolean(instance.customResolution && instance.customResolution.enabled);
      resRow.appendChild(resEnabled);
      resRow.appendChild(el('span', 'muted', '启用'));
      const widthInput = el('input', 'input');
      widthInput.type = 'number';
      widthInput.min = '320';
      widthInput.max = '7680';
      widthInput.value = String((instance.customResolution && instance.customResolution.width) || 1280);
      widthInput.style.width = '90px';
      const heightInput = el('input', 'input');
      heightInput.type = 'number';
      heightInput.min = '240';
      heightInput.max = '4320';
      heightInput.value = String((instance.customResolution && instance.customResolution.height) || 720);
      heightInput.style.width = '90px';
      resRow.appendChild(widthInput);
      resRow.appendChild(el('span', 'muted', '×'));
      resRow.appendChild(heightInput);
      resField.appendChild(resRow);
      body.appendChild(resField);

      const jvmField = el('label', 'field');
      jvmField.appendChild(el('span', '', '本版本额外 JVM 参数'));
      const jvmInput = el('input', 'input');
      jvmInput.value = instance.jvmArgsExtra || '';
      jvmInput.placeholder = '例如 -Dfml.ignoreInvalidMinecraftCertificates=true';
      jvmField.appendChild(jvmInput);
      body.appendChild(jvmField);

      const gameField = el('label', 'field');
      gameField.appendChild(el('span', '', '本版本额外游戏参数'));
      const gameInput = el('input', 'input');
      gameInput.value = instance.gameArgsExtra || '';
      gameInput.placeholder = '例如 --fullscreen';
      gameField.appendChild(gameInput);
      body.appendChild(gameField);

      const notesField = el('label', 'field');
      notesField.appendChild(el('span', '', '备注'));
      const notesInput = el('input', 'input');
      notesInput.value = instance.notes || '';
      notesInput.maxLength = 500;
      notesField.appendChild(notesInput);
      body.appendChild(notesField);

      body.appendChild(el('div', 'hint', '快捷打开：'));
      const shortcuts = el('div', 'row');
      for (const [kind, label] of [
        ['version', '版本文件夹'],
        ['saves', '存档文件夹'],
        ['resourcepacks', '资源包文件夹'],
        ['mods', 'MOD 文件夹'],
        ['instance', '版本目录'],
      ]) {
        const btn = el('button', 'btn ghost small', label);
        btn.addEventListener('click', () => api.instances.openSubfolder(instance.id, kind).catch(showError));
        shortcuts.appendChild(btn);
      }
      body.appendChild(shortcuts);
      body.appendChild(el('div', 'hint', '外部版本的版本文件夹是 QUTC 管理的版本目录；存档/资源包/MOD 会打开外部原目录。'));
      ui.values = { nameInput, memInput, resEnabled, widthInput, heightInput, jvmInput, gameInput, notesInput };
    },
    actions: [
      {
        label: '保存设置',
        kind: 'primary',
        onClick: async (close) => {
          const v = ui.values;
          try {
            await api.instances.update(instance.id, {
              name: v.nameInput.value.trim() || instance.name,
              memoryMb: Number(v.memInput.value) || 0,
              jvmArgsExtra: v.jvmInput.value,
              gameArgsExtra: v.gameInput.value,
              notes: v.notesInput.value,
              customResolution: {
                enabled: v.resEnabled.checked,
                width: Number(v.widthInput.value) || 1280,
                height: Number(v.heightInput.value) || 720,
              },
            });
            close();
            await refreshInstances();
            toast('版本设置已保存', 'ok');
          } catch (err) {
            showError(err);
          }
        },
      },
      {
        label: '导出',
        kind: 'ghost',
        onClick: (close) => {
          close();
          exportInstance(instance);
        },
      },
      {
        label: '删除',
        kind: 'danger',
        onClick: (close) => {
          close();
          deleteInstance(instance);
        },
      },
      { label: '关闭', kind: 'ghost', onClick: (close) => close() },
    ],
  });
}

function renameInstance(instance) {
  const ui = {};
  openModal({
    title: '重命名版本',
    build: (body) => {
      const input = el('input', 'input');
      input.style.width = '100%';
      input.value = instance.name;
      input.maxLength = 48;
      body.appendChild(input);
      input.focus();
      ui.input = input;
    },
    actions: [
      { label: '取消', kind: 'ghost', onClick: (close) => close() },
      {
        label: '保存',
        kind: 'primary',
        onClick: async (close) => {
          const name = ui.input.value.trim();
          if (!name) throw new Error('名称不能为空');
          await api.instances.update(instance.id, { name });
          close();
          await refreshInstances();
        },
      },
    ],
  });
}

async function addExistingFolder(presetFolder) {
  let folder = typeof presetFolder === 'string' ? presetFolder : '';
  if (!folder) {
    try {
      folder = await api.instances.pickExternalFolder();
    } catch (err) {
      showError(err);
      return;
    }
  }
  if (!folder) return;
  let versions = [];
  try {
    versions = await api.versions.installed();
  } catch (err) {
    showError(err);
    return;
  }
  if (!versions.length) {
    showError(new Error('还没有安装任何版本。请先在「下载版本」安装一个版本，再添加已有文件夹。'));
    return;
  }
  const baseName = String(folder).split(/[\\/]/).filter(Boolean).pop() || '外部版本';
  const sameFolder = state.instances.filter((item) => item.externalPath === folder).length;
  const ui = {};
  openModal({
    title: '添加已有文件夹',
    subtitle: '原地使用：只注册目录，不复制、不移动原文件。',
    build: (body) => {
      body.appendChild(el('div', 'hint', `游戏目录：${folder}`));
      const nameField = el('label', 'field');
      nameField.appendChild(el('span', '', '版本名称'));
      const nameInput = el('input', 'input');
      nameInput.value = sameFolder ? `${baseName} - ${versions[0]}` : baseName;
      nameInput.maxLength = 48;
      nameField.appendChild(nameInput);
      body.appendChild(nameField);
      const versionField = el('label', 'field');
      versionField.appendChild(el('span', '', '使用已安装的版本 / 加载器'));
      const select = el('select', 'input');
      for (const version of versions) select.appendChild(new Option(version, version));
      versionField.appendChild(select);
      versionField.appendChild(el('span', 'hint', 'MOD、存档、配置都从你选择的文件夹读取；版本库和资源仍由 QUTC 管理。'));
      body.appendChild(versionField);
      body.appendChild(el('div', 'hint', '外部版本删除时只移除注册，不会删除原文件夹。'));
      ui.values = { nameInput, select };
    },
    actions: [
      { label: '取消', kind: 'ghost', onClick: (close) => close() },
      {
        label: '添加',
        kind: 'primary',
        onClick: async (close) => {
          const v = ui.values;
          const name = v.nameInput.value.trim() || baseName;
          const duplicate = state.instances.some(
            (item) => item.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
          );
          if (duplicate) throw new Error(`版本名称「${name}」已存在，请修改名称`);
          try {
            await api.instances.createExternal({
              name,
              folder,
              versionId: v.select.value,
            });
            close();
            await refreshInstances();
            toast('已添加外部文件夹版本', 'ok');
          } catch (err) {
            showError(err);
          }
        },
      },
    ],
  });
}

async function duplicateInstance(instance) {
  try {
    await api.instances.duplicate(instance.id, `${instance.name} 副本`);
    await refreshInstances();
    toast('版本已复制', 'ok');
  } catch (err) {
    showError(err);
  }
}

async function deleteInstance(instance) {
  const message = instance.external
    ? `确定移除「${instance.name}」的外部目录注册吗？只删除 QUTC 的注册信息，不会删除原文件夹。`
    : `确定删除「${instance.name}」吗？文件会移入回收目录，不会立即永久删除。`;
  const ok = await confirmDialog('删除版本', message, {
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.instances.remove(instance.id);
    await refreshInstances();
    toast('版本已删除', 'ok');
  } catch (err) {
    showError(err);
  }
}

async function exportInstance(instance) {
  try {
    const result = await api.instances.export(instance.id);
    if (result) toast(`已导出 ${result.files} 个文件`, 'ok');
  } catch (err) {
    showError(err);
  }
}

async function launchInstance(id) {
  const instance = state.instances.find((i) => i.id === id);
  if (!instance) return;
  try {
    $('log-body').textContent = '';
    $('log-drawer').hidden = false;
    await api.instances.launch(id);
    state.gameRunning = true;
    state.gameInstanceId = id;
    renderInstances();
    toast('游戏启动中，请稍候…', 'ok');
  } catch (err) {
    showError(err);
  }
}

async function stopGame() {
  try {
    await api.instances.stop();
  } catch (err) {
    showError(err);
  }
}

/* ------------------------------------------------------------------ */
/* 创建版本                                                            */
/* ------------------------------------------------------------------ */

async function ensureManifest(force = false) {
  if (!force && state.manifest && Date.now() - state.manifestAt < 10 * 60 * 1000) return state.manifest;
  const data = await api.versions.manifest({ force });
  state.manifest = data;
  state.manifestAt = Date.now();
  return data;
}

async function openCreateInstance(presetVersion) {
  let manifest;
  try {
    manifest = await ensureManifest();
  } catch (err) {
    showError(err);
    return;
  }
  const versions = manifest.versions;
  const ui = {};
  openModal({
    title: '新建版本',
    subtitle: '选择 Minecraft 版本；需要模组时可同时安装加载器。安装过程会逐文件校验官方哈希。',
    build: (body) => {
      const nameField = el('label', 'field');
      nameField.appendChild(el('span', '', '版本名称（留空则使用 MC 版本号）'));
      const nameInput = el('input', 'input');
      nameInput.value = '';
      nameInput.placeholder = '例如 1.12.2 / 生存服';
      nameInput.maxLength = 48;
      nameField.appendChild(nameInput);
      body.appendChild(nameField);

      const versionField = el('label', 'field');
      versionField.appendChild(el('span', '', 'Minecraft 版本'));
      const versionSelect = el('select', 'input');
      const releases = versions.filter((v) => v.type === 'release');
      const others = versions.filter((v) => v.type !== 'release');
      const groupRelease = document.createElement('optgroup');
      groupRelease.label = '正式版';
      for (const v of releases.slice(0, 120)) groupRelease.appendChild(new Option(v.id, v.id));
      versionSelect.appendChild(groupRelease);
      const groupOther = document.createElement('optgroup');
      groupOther.label = '快照 / 远古版本';
      for (const v of others.slice(0, 80)) groupOther.appendChild(new Option(v.id, v.id));
      versionSelect.appendChild(groupOther);
      if (presetVersion) versionSelect.value = presetVersion;
      nameInput.value = presetVersion || versionSelect.value;
      nameInput.addEventListener('input', () => {
        nameInput.dataset.touched = '1';
      });
      versionField.appendChild(versionSelect);
      body.appendChild(versionField);

      const loaderField = el('label', 'field');
      loaderField.appendChild(el('span', '', '模组加载器'));
      const loaderSelect = el('select', 'input');
      for (const type of ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']) {
        loaderSelect.appendChild(new Option(LOADER_NAMES[type], type));
      }
      loaderField.appendChild(loaderSelect);
      body.appendChild(loaderField);

      const loaderVersionField = el('label', 'field');
      loaderVersionField.appendChild(el('span', '', '加载器版本'));
      const loaderVersionInput = el('input', 'input');
      loaderVersionInput.placeholder = '选择加载器后自动加载最新稳定版';
      loaderVersionInput.disabled = true;
      const datalist = document.createElement('datalist');
      datalist.id = 'loader-version-list';
      loaderVersionInput.setAttribute('list', 'loader-version-list');
      loaderVersionField.appendChild(loaderVersionInput);
      loaderVersionField.appendChild(datalist);
      const loaderHint = el('span', 'hint', '');
      loaderVersionField.appendChild(loaderHint);
      body.appendChild(loaderVersionField);

      const consentField = el('label', 'check');
      consentField.hidden = true;
      const consent = el('input');
      consent.type = 'checkbox';
      consentField.appendChild(consent);
      consentField.appendChild(
        el('span', '', '我了解并同意运行 Forge/NeoForge 官方安装器（jar 来自官方 Maven，优先校验 SHA-1）'),
      );
      body.appendChild(consentField);

      ui.values = { nameInput, versionSelect, loaderSelect, loaderVersionInput, datalist, loaderHint, consent, consentField };

      const loadLoaderVersions = async () => {
        const type = loaderSelect.value;
        const mc = versionSelect.value;
        consentField.hidden = !(type === 'forge' || type === 'neoforge');
        consent.checked = false;
        clear(datalist);
        loaderVersionInput.value = '';
        if (type === 'vanilla') {
          loaderVersionInput.disabled = true;
          loaderHint.textContent = '纯原版，不安装任何加载器。';
          return;
        }
        loaderVersionInput.disabled = false;
        loaderHint.textContent = '正在获取版本列表…';
        try {
          const list = await api.loaders.versions(type, mc);
          clear(datalist);
          for (const item of list.slice(0, 300)) {
            const option = document.createElement('option');
            option.value = item.version;
            option.label = `${item.version}${item.stable ? ' (稳定)' : ''}${item.recommended ? ' · 推荐' : ''}`;
            datalist.appendChild(option);
          }
          if (list.length) {
            loaderVersionInput.value = list[0].version;
            loaderHint.textContent = `共 ${list.length} 个版本，已填入最新版本。`;
          } else {
            loaderHint.textContent = '该 Minecraft 版本没有可用的加载器版本。';
          }
        } catch (err) {
          loaderHint.textContent = `获取失败：${err.message}`;
        }
      };

      loaderSelect.addEventListener('change', loadLoaderVersions);
      versionSelect.addEventListener('change', () => {
        if (!nameInput.dataset.touched) nameInput.value = versionSelect.value;
        loadLoaderVersions();
      });
      loadLoaderVersions();
    },
    actions: [
      { label: '取消', kind: 'ghost', onClick: (close) => close() },
      {
        label: '创建并安装',
        kind: 'primary',
        onClick: async (close) => {
          const v = ui.values;
          const name = v.nameInput.value.trim() || v.versionSelect.value;
          if (!name) throw new Error('请输入版本名称');
          const duplicate = state.instances.some(
            (item) => item.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
          );
          if (duplicate) throw new Error(`版本名称「${name}」已存在，请修改名称`);
          const loader = v.loaderSelect.value;
          const loaderVersion = v.loaderVersionInput.value.trim();
          if (loader !== 'vanilla' && !loaderVersion) throw new Error('请选择加载器版本');
          if ((loader === 'forge' || loader === 'neoforge') && !v.consent.checked) {
            throw new Error('安装 Forge/NeoForge 需要先勾选同意运行官方安装器');
          }
          try {
            await api.instances.create({
              name,
              mcVersion: v.versionSelect.value,
              loader,
              loaderVersion,
              consent: v.consent.checked,
            });
            close();
            await refreshInstances();
            await refreshInstalled();
            toast('版本创建完成', 'ok');
          } catch (err) {
            showError(err);
          }
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 版本列表                                                            */
/* ------------------------------------------------------------------ */

function filteredVersions() {
  if (!state.manifest) return [];
  const query = state.versionQuery.trim().toLowerCase();
  return state.manifest.versions.filter((v) => {
    const typeOk =
      state.versionType === 'all'
        ? true
        : state.versionType === 'old'
          ? v.type === 'old_beta' || v.type === 'old_alpha'
          : v.type === state.versionType;
    return typeOk && (!query || v.id.toLowerCase().includes(query));
  });
}

function renderVersions() {
  const listNode = $('version-list');
  clear(listNode);
  if (!state.manifest) {
    listNode.appendChild(el('div', 'hint', '正在获取 Mojang 版本清单…'));
    ensureManifest()
      .then(renderVersions)
      .catch((err) => {
        clear(listNode);
        listNode.appendChild(el('div', 'hint', `获取失败：${err.message}`));
      });
    return;
  }
  const list = filteredVersions();
  const shown = list.slice(0, state.versionLimit);
  for (const version of shown) {
    const row = el('div', 'list-row');
    row.appendChild(el('div', 'id', version.id));
    const badge = el(
      'span',
      `badge ${version.type === 'release' ? 'release' : 'snapshot'}`,
      version.type === 'release' ? '正式版' : version.type,
    );
    row.appendChild(badge);
    row.appendChild(el('div', 'date', fmtDate(version.releaseTime)));
    const action = el('div', 'actions');
    if (state.installed.has(version.id)) {
      action.appendChild(el('span', 'badge installed', '已安装'));
    } else {
      const btn = el('button', 'btn small', '安装');
      btn.addEventListener('click', () => installVanilla(version.id));
      action.appendChild(btn);
    }
    row.appendChild(action);
    listNode.appendChild(row);
  }
  if (!list.length) listNode.appendChild(el('div', 'hint', '没有匹配的版本'));
  const foot = $('version-foot');
  clear(foot);
  if (list.length > shown.length) {
    const more = el('button', 'btn ghost small', `显示更多（剩余 ${list.length - shown.length}）`);
    more.addEventListener('click', () => {
      state.versionLimit += 200;
      renderVersions();
    });
    foot.appendChild(more);
  } else if (list.length) {
    foot.appendChild(el('span', 'hint', `共 ${list.length} 个版本`));
  }
}

async function installVanilla(id) {
  try {
    await api.versions.install(id);
    await refreshInstalled();
    toast(`${id} 安装完成`, 'ok');
  } catch (err) {
    showError(err);
  }
}

/* ------------------------------------------------------------------ */
/* 整合包                                                              */
/* ------------------------------------------------------------------ */

async function searchPacks() {
  const query = $('pack-search').value.trim();
  const grid = $('pack-grid');
  const empty = $('pack-empty');
  if (!query) {
    showError(new Error('请输入搜索关键词'));
    return;
  }
  clear(grid);
  empty.hidden = true;
  grid.appendChild(el('div', 'hint', '正在搜索 Modrinth…'));
  try {
    const result = await api.modpack.search({ query, limit: 12 });
    clear(grid);
    state.packs = result.hits;
    if (!result.hits.length) {
      empty.hidden = false;
      empty.querySelector('h4').textContent = '没有找到整合包';
      empty.querySelector('p').textContent = '试试其他关键词，或直接导入本地 .mrpack。';
      return;
    }
    for (const pack of result.hits) grid.appendChild(packCard(pack));
  } catch (err) {
    clear(grid);
    grid.appendChild(el('div', 'hint', `搜索失败：${err.message}`));
  }
}

function packCard(pack) {
  const card = el('div', 'pack-card');
  if (pack.iconUrl) {
    const img = el('img', 'pack-icon');
    img.src = pack.iconUrl;
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(packFallback(pack.title)));
    card.appendChild(img);
  } else {
    card.appendChild(packFallback(pack.title));
  }
  const info = el('div', 'pack-info');
  info.appendChild(el('strong', '', pack.title));
  info.appendChild(el('p', '', pack.description));
  const meta = el('div', 'pack-meta');
  meta.appendChild(el('span', 'pill', `${fmtNumber(pack.downloads)} 下载`));
  for (const loader of pack.loaders.slice(0, 3)) meta.appendChild(el('span', 'pill accent', LOADER_NAMES[loader] || loader));
  info.appendChild(meta);
  card.appendChild(info);
  const btn = el('button', 'btn primary small', '安装');
  btn.addEventListener('click', () => openPackModal(pack));
  card.appendChild(btn);
  return card;
}

function packFallback(title) {
  return el('div', 'pack-icon pack-icon-fallback', (title || '?').slice(0, 1).toUpperCase());
}

async function openPackModal(pack) {
  let versions;
  try {
    versions = await api.modpack.versions({ projectId: pack.projectId });
  } catch (err) {
    showError(err);
    return;
  }
  if (!versions.length) {
    showError(new Error('该整合包没有可用版本'));
    return;
  }
  const ui = {};
  openModal({
    title: `安装 ${pack.title}`,
    subtitle: pack.description || '选择要安装的整合包版本。',
    build: (body) => {
      const field = el('label', 'field');
      field.appendChild(el('span', '', '整合包版本'));
      const select = el('select', 'input');
      for (const version of versions) {
        const label = `${version.versionNumber} · ${version.gameVersions.slice(0, 3).join(', ')} · ${version.loaders.join(', ')}`;
        select.appendChild(new Option(label, version.id));
      }
      field.appendChild(select);
      body.appendChild(field);
      const consentField = el('label', 'check');
      const consent = el('input');
      consent.type = 'checkbox';
      consentField.appendChild(consent);
      consentField.appendChild(el('span', '', '若该整合包使用 Forge/NeoForge，我同意运行官方安装器'));
      body.appendChild(consentField);
      ui.values = { select, consent };
    },
    actions: [
      { label: '取消', kind: 'ghost', onClick: (close) => close() },
      {
        label: '开始安装',
        kind: 'primary',
        onClick: async (close) => {
          const v = ui.values;
          close();
          try {
            const result = await api.modpack.install(v.select.value, v.consent.checked);
            await refreshInstances();
            await refreshInstalled();
            toast(`整合包「${result.instance.name}」安装完成`, 'ok');
          } catch (err) {
            showError(err);
          }
        },
      },
    ],
  });
}

async function importLocalPack() {
  try {
    const picked = await api.modpack.pickLocal();
    if (!picked) return;
    const info = picked.info;
    const ui = {};
    openModal({
      title: `导入 ${info.name}`,
      subtitle: `Minecraft ${info.mcVersion} · ${LOADER_NAMES[info.loader.type] || info.loader.type} ${info.loader.version} · ${info.fileCount} 个文件`,
      build: (body) => {
        const consentField = el('label', 'check');
        const consent = el('input');
        consent.type = 'checkbox';
        consentField.appendChild(consent);
        consentField.appendChild(
          el('span', '', '若需要 Forge/NeoForge，我同意运行官方安装器（会联网下载并执行官方 jar）'),
        );
        body.appendChild(consentField);
        body.appendChild(el('div', 'hint', '整合包内的脚本不会被执行，只解压 overrides 与下载带哈希的文件。'));
        ui.values = { consent };
      },
      actions: [
        { label: '取消', kind: 'ghost', onClick: (close) => close() },
        {
          label: '开始导入',
          kind: 'primary',
          onClick: async (close) => {
            close();
            try {
              const result = await api.modpack.installLocal(picked.file, ui.values.consent.checked);
              await refreshInstances();
              await refreshInstalled();
              toast(`整合包「${result.instance.name}」导入完成`, 'ok');
            } catch (err) {
              showError(err);
            }
          },
        },
      ],
    });
  } catch (err) {
    showError(err);
  }
}

/* ------------------------------------------------------------------ */
/* MOD 下载                                                            */
/* ------------------------------------------------------------------ */

function selectedModInstance() {
  return state.instances.find((instance) => instance.id === state.modInstanceId) || null;
}

function modInstanceUsable(instance) {
  return Boolean(instance && instance.loader && instance.loader.type !== 'vanilla');
}

function updateModHint() {
  const instance = selectedModInstance();
  const hint = $('mod-hint');
  const button = $('btn-mod-search');
  const input = $('mod-search');
  if (!instance) {
    hint.textContent = '还没有版本。请先在「主页」创建版本，再下载 MOD。';
    button.disabled = true;
    input.disabled = true;
    return;
  }
  if (!modInstanceUsable(instance)) {
    hint.textContent = `「${instance.name}」是原版版本，不能安装 MOD。请选择 Fabric/Quilt/Forge/NeoForge 版本。`;
    button.disabled = true;
    input.disabled = true;
    return;
  }
  hint.textContent = `目标：${instance.name} · MC ${instance.mcVersion} · ${loaderLabel(instance.loader)}${instance.loader.version ? ` ${instance.loader.version}` : ''}。只显示适配该版本的 MOD。`;
  button.disabled = false;
  input.disabled = false;
}

function renderMods() {
  const select = $('mod-instance');
  const previous = state.modInstanceId || select.value;
  clear(select);
  state.mods = [];
  const grid = $('mod-grid');
  clear(grid);
  const empty = $('mod-empty');
  empty.hidden = false;
  empty.querySelector('h4').textContent = '下载 MOD';

  if (!state.instances.length) {
    select.disabled = true;
    select.appendChild(new Option('暂无版本', ''));
    state.modInstanceId = '';
    updateModHint();
    return;
  }

  select.disabled = false;
  for (const instance of state.instances) {
    const label = `${instance.name} · MC ${instance.mcVersion} · ${loaderLabel(instance.loader)}`;
    select.appendChild(new Option(label, instance.id));
  }
  const chosen =
    state.instances.find((instance) => instance.id === previous) ||
    state.instances.find((instance) => modInstanceUsable(instance)) ||
    state.instances[0];
  state.modInstanceId = chosen.id;
  select.value = chosen.id;
  updateModHint();
}

async function searchMods() {
  const instance = selectedModInstance();
  if (!instance) {
    showError(new Error('请先选择版本'));
    return;
  }
  if (!modInstanceUsable(instance)) {
    showError(new Error('原版版本不能安装 MOD'));
    return;
  }
  const query = $('mod-search').value.trim();
  if (!query) {
    showError(new Error('请输入 MOD 名称'));
    return;
  }
  const grid = $('mod-grid');
  const empty = $('mod-empty');
  clear(grid);
  empty.hidden = true;
  grid.appendChild(el('div', 'hint', '正在搜索 Modrinth…'));
  try {
    const result = await api.mods.search({ query, instanceId: instance.id, limit: 18 });
    clear(grid);
    state.mods = result.hits;
    const expanded = Array.isArray(result.expanded) ? result.expanded : [];
    if (expanded.length > 1) {
      $('mod-hint').textContent = `已同时搜索：${expanded.join(' / ')}。目标：${instance.name} · MC ${instance.mcVersion} · ${loaderLabel(instance.loader)}。`;
    }
    if (!result.hits.length) {
      empty.hidden = false;
      empty.querySelector('h4').textContent = '没有找到 MOD';
      empty.querySelector('p').textContent = `没有适配 MC ${instance.mcVersion} / ${loaderLabel(instance.loader)} 的结果，换个关键词试试。`;
      return;
    }
    for (const mod of result.hits) grid.appendChild(modCard(mod));
  } catch (err) {
    clear(grid);
    empty.hidden = false;
    empty.querySelector('h4').textContent = '搜索失败';
    empty.querySelector('p').textContent = err.message;
  }
}

function modCard(mod) {
  const card = el('div', 'pack-card');
  if (mod.iconUrl) {
    const img = el('img', 'pack-icon');
    img.src = mod.iconUrl;
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(packFallback(mod.title)));
    card.appendChild(img);
  } else {
    card.appendChild(packFallback(mod.title));
  }
  const info = el('div', 'pack-info');
  info.appendChild(el('strong', '', mod.title));
  info.appendChild(el('p', '', mod.description));
  const meta = el('div', 'pack-meta');
  meta.appendChild(el('span', 'pill', `${fmtNumber(mod.downloads)} 下载`));
  for (const loader of mod.loaders.slice(0, 3)) meta.appendChild(el('span', 'pill accent', LOADER_NAMES[loader] || loader));
  info.appendChild(meta);
  card.appendChild(info);
  const btn = el('button', 'btn primary small', '选择版本');
  btn.addEventListener('click', () => openModModal(mod));
  card.appendChild(btn);
  return card;
}

async function openModModal(mod) {
  const instance = selectedModInstance();
  if (!instance) {
    showError(new Error('请先选择版本'));
    return;
  }
  let versions;
  try {
    versions = await api.mods.versions({ projectId: mod.projectId, instanceId: instance.id });
  } catch (err) {
    showError(err);
    return;
  }
  if (!versions.length) {
    showError(new Error(`该 MOD 没有适配 MC ${instance.mcVersion} / ${loaderLabel(instance.loader)} 的版本`));
    return;
  }
  const ui = {};
  openModal({
    title: `安装 ${mod.title}`,
    subtitle: `目标版本：${instance.name} · MC ${instance.mcVersion} · ${loaderLabel(instance.loader)}`,
    build: (body) => {
      const field = el('label', 'field');
      field.appendChild(el('span', '', 'MOD 版本'));
      const select = el('select', 'input');
      for (const version of versions) {
        const label = `${version.versionNumber || version.name} · ${version.gameVersions.slice(0, 2).join(', ')} · ${version.loaders.join(', ')}`;
        select.appendChild(new Option(label, version.id));
      }
      field.appendChild(select);
      body.appendChild(field);
      const checkLabel = el('label', 'check');
      const check = el('input');
      check.type = 'checkbox';
      check.checked = true;
      checkLabel.appendChild(check);
      checkLabel.appendChild(el('span', '', '自动下载 required 依赖（推荐）'));
      body.appendChild(checkLabel);
      body.appendChild(el('div', 'hint', '文件会下载到版本的 mods/ 目录，并校验 Modrinth 提供的 SHA-1。'));
      ui.values = { select, check };
    },
    actions: [
      { label: '取消', kind: 'ghost', onClick: (close) => close() },
      {
        label: '安装',
        kind: 'primary',
        onClick: async (close) => {
          const v = ui.values;
          close();
          try {
            const result = await api.mods.install({
              instanceId: instance.id,
              versionId: v.select.value,
              installDependencies: v.check.checked,
            });
            const count = result.installed.length;
            toast(`已安装 ${count} 个 MOD 文件${v.check.checked ? '（含依赖）' : ''}`, 'ok');
            if (result.warnings && result.warnings.length) {
              toast(result.warnings[0], 'error');
            }
          } catch (err) {
            showError(err);
          }
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 账户                                                                */
/* ------------------------------------------------------------------ */

function skinUrlOf(account) {
  return account ? state.skinCache[account.id] || null : null;
}

function setAvatar(node, account) {
  clear(node);
  const url = skinUrlOf(account);
  const fallback = account ? (account.name || '?').slice(0, 1).toUpperCase() : 'Q';
  if (url) {
    const img = el('img', 'avatar-img');
    img.src = url;
    img.alt = '';
    img.addEventListener('error', () => {
      clear(node);
      node.textContent = fallback;
    });
    node.appendChild(img);
  } else {
    node.textContent = fallback;
  }
}

function avatarElement(account) {
  const node = el('div', 'avatar');
  setAvatar(node, account);
  return node;
}

function renderAccounts() {
  const list = $('account-list');
  clear(list);
  $('account-count').textContent = `${state.accounts.length} 个账号`;
  if (!state.accounts.length) {
    list.appendChild(el('div', 'hint', '还没有账户。可以在右侧添加微软正版账号或离线账号。'));
  }
  for (const account of state.accounts) {
    const row = el('div', `account-row${account.selected ? ' selected' : ''}`);
    row.appendChild(avatarElement(account));
    const meta = el('div', 'meta');
    meta.appendChild(el('strong', '', account.name));
    meta.appendChild(
      el(
        'span',
        '',
        account.type === 'microsoft'
          ? '微软正版'
          : account.type === 'yggdrasil'
            ? `外置登录${account.authServerName ? ` · ${account.authServerName}` : ''}`
            : '离线模式',
      ),
    );
    row.appendChild(meta);
    if (account.selected) row.appendChild(el('span', 'badge installed', '当前'));
    const select = el('button', 'btn ghost small', '使用');
    select.disabled = account.selected;
    select.addEventListener('click', async () => {
      try {
        await api.accounts.select(account.id);
        await refreshAccounts();
        toast(`已切换到 ${account.name}`, 'ok');
      } catch (err) {
        showError(err);
      }
    });
    row.appendChild(select);
    if (account.type === 'microsoft') {
      const refresh = el('button', 'btn ghost small', '刷新');
      refresh.addEventListener('click', async () => {
        try {
          await api.accounts.refresh();
          await refreshAccounts();
          toast('正版会话已刷新', 'ok');
        } catch (err) {
          showError(err);
        }
      });
      row.appendChild(refresh);
    }
    const remove = el('button', 'btn ghost small', '移除');
    remove.addEventListener('click', async () => {
      const ok = await confirmDialog('移除账户', `确定移除「${account.name}」吗？`, { okText: '移除', danger: true });
      if (!ok) return;
      try {
        await api.accounts.remove(account.id);
        await refreshAccounts();
      } catch (err) {
        showError(err);
      }
    });
    row.appendChild(remove);
    list.appendChild(row);
  }
  renderAccountChip();
}

function renderAccountChip() {
  const selected = state.accounts.find((a) => a.selected);
  $('account-name').textContent = selected ? selected.name : '未登录';
  $('account-type').textContent = selected ? (selected.type === 'microsoft' ? '微软正版账户' : selected.type === 'yggdrasil' ? `外置登录${selected.authServerName ? ` · ${selected.authServerName}` : ''}` : '离线账户') : '点击添加账户';
  setAvatar($('account-avatar'), selected);
}

async function ensureSelectedSkin() {
  const selected = state.accounts.find((a) => a.selected);
  if (!selected) return;
  if (state.skinCache[selected.id] !== undefined) return;
  state.skinCache[selected.id] = null;
  try {
    const result = await api.accounts.skin(selected.id);
    state.skinCache[selected.id] = (result && result.url) || null;
  } catch {
    state.skinCache[selected.id] = null;
  }
  renderAccountChip();
  if (state.view === 'accounts') renderAccounts();
}

async function addOfflineAccount() {
  const input = $('offline-name');
  const name = input.value.trim();
  try {
    await api.accounts.addOffline(name);
    input.value = '';
    await refreshAccounts();
    renderAccountChip();
    toast('离线账户已添加', 'ok');
  } catch (err) {
    showError(err);
  }
}

async function yggdrasilLogin() {
  const username = $('ygg-username').value.trim();
  const passwordInput = $('ygg-password');
  const password = passwordInput.value;
  const authServer = $('ygg-auth-server').value.trim();
  if (!authServer || !username || !password) {
    showError(new Error('请填写验证服务器地址、账号和密码'));
    return;
  }
  const button = $('btn-ygg-login');
  button.disabled = true;
  button.textContent = '登录中…';
  try {
    await api.accounts.yggdrasilLogin(username, password, authServer);
    passwordInput.value = '';
    await refreshAccounts();
    renderAccountChip();
    toast('外置登录成功', 'ok');
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
    button.textContent = '登录外置账号';
  }
}

async function resolveYggServer(url, { silent = false } = {}) {
  const input = $('ygg-auth-server');
  const status = $('ygg-server-status');
  const value = String(url || input.value || '').trim();
  if (!value) return null;
  status.textContent = '正在校验验证服务器…';
  try {
    const server = await api.accounts.yggdrasilResolve(value);
    input.value = server.apiRoot;
    status.textContent = `${server.serverName} · ${server.apiRoot}`;
    if (!silent) toast(`已识别验证服务器：${server.serverName}`, 'ok');
    return server;
  } catch (err) {
    status.textContent = '验证服务器不可用';
    if (!silent) showError(err);
    return null;
  }
}

function bindYggdrasilDnd() {
  const zone = $('ygg-drop');
  const hasText = (event) => Array.from(event.dataTransfer.types || []).includes('text/plain');
  document.addEventListener('dragover', (event) => {
    if (!hasText(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    zone.classList.add('dragover');
  });
  document.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null) zone.classList.remove('dragover');
  });
  document.addEventListener('drop', async (event) => {
    if (!hasText(event)) return;
    event.preventDefault();
    zone.classList.remove('dragover');
    const raw = event.dataTransfer.getData('text/plain') || event.dataTransfer.getData('text/uri-list') || '';
    if (!raw) return;
    let url = raw.trim();
    const prefix = 'authlib-injector:yggdrasil-server:';
    if (url.toLowerCase().startsWith(prefix)) {
      try {
        url = decodeURIComponent(url.slice(prefix.length));
      } catch {
        /* 保留原文，交给主进程报错 */
      }
    }
    setView('accounts');
    $('ygg-auth-server').value = url;
    const server = await resolveYggServer(url);
    if (server) {
      const existing = state.accounts.find(
        (account) => account.type === 'yggdrasil' && account.authServer === server.apiRoot,
      );
      if (existing) {
        try {
          await api.accounts.select(existing.id);
          await refreshAccounts();
          toast(`已切换到 ${server.serverName} 账号：${existing.name}`, 'ok');
          return;
        } catch (err) {
          showError(err);
        }
      }
      $('ygg-username').focus();
      toast(`已添加 ${server.serverName}，请输入账号密码登录`, 'ok');
    }
  });
}

async function startMsLogin() {
  const btn = $('btn-ms-login');
  const status = $('ms-status');
  btn.disabled = true;
  status.textContent = '请在弹出的窗口中登录微软账号。关闭窗口即取消。';
  try {
    await api.accounts.msLogin();
    status.textContent = '';
    await refreshAccounts();
    toast('正版登录成功', 'ok');
  } catch (err) {
    if (err && err.code === 'cancelled') {
      status.textContent = '已取消登录';
    } else {
      status.textContent = '';
      showError(err);
    }
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

function applyThemeColor(color) {
  const value = /^#[0-9a-fA-F]{6}$/.test(String(color || '')) ? String(color) : '#5bf0c8';
  document.documentElement.style.setProperty('--accent', value);
}

function applyBackground() {
  const img = $('app-bg');
  const has = Boolean(state.config && state.config.backgroundImage);
  img.hidden = !has;
  if (has) img.src = `qutc-asset://background?v=${Date.now()}`;
}

function updateBgStatus() {
  const config = state.config;
  $('bg-status').textContent = config && config.backgroundImage ? '已设置背景图' : '未设置背景图';
}

async function pickBackground() {
  try {
    const result = await api.appearance.pickBackground();
    if (!result) return;
    if (state.config) state.config.backgroundImage = result.backgroundImage;
    applyBackground();
    updateBgStatus();
    toast('背景图已更新', 'ok');
  } catch (err) {
    showError(err);
  }
}

async function clearBackground() {
  try {
    await api.appearance.clearBackground();
    if (state.config) state.config.backgroundImage = '';
    applyBackground();
    updateBgStatus();
    toast('背景图已清除', 'ok');
  } catch (err) {
    showError(err);
  }
}

function fillSettings() {
  const config = state.config;
  if (!config) return;
  $('set-memory').value = String(config.memoryMb);
  $('memory-label').textContent = `${config.memoryMb} MB`;
  $('set-java').value = config.javaPath || '';
  $('set-width').value = String(config.customResolution.width);
  $('set-height').value = String(config.customResolution.height);
  $('set-resolution-on').checked = Boolean(config.customResolution.enabled);
  $('set-close-launch').checked = Boolean(config.closeOnLaunch);
  $('set-show-log').checked = config.showGameLog !== false;
  $('set-mirror').value = config.mirror;
  $('set-concurrency').value = String(config.downloadConcurrency);
  $('set-jvm').value = config.jvmArgsExtra || '';
  $('set-gameargs').value = config.gameArgsExtra || '';
  $('set-theme-color').value = config.themeColor || '#5bf0c8';
  updateBgStatus();
}

async function saveSettings() {
  const width = Number($('set-width').value) || 1280;
  const height = Number($('set-height').value) || 720;
  if (width < 320 || height < 240) {
    showError(new Error('分辨率过小'));
    return;
  }
  const patch = {
    memoryMb: Number($('set-memory').value) || 4096,
    javaPath: $('set-java').value.trim(),
    downloadConcurrency: Number($('set-concurrency').value) || 8,
    mirror: $('set-mirror').value,
    closeOnLaunch: $('set-close-launch').checked,
    showGameLog: $('set-show-log').checked,
    customResolution: { enabled: $('set-resolution-on').checked, width, height },
    jvmArgsExtra: $('set-jvm').value.trim(),
    gameArgsExtra: $('set-gameargs').value.trim(),
    themeColor: $('set-theme-color').value,
  };
  try {
    state.config = await api.config.save(patch);
    fillSettings();
    toast('设置已保存', 'ok');
  } catch (err) {
    showError(err);
  }
}

async function detectJava() {
  const node = $('java-detect-result');
  node.textContent = '检测中…';
  try {
    const list = await api.java.detect();
    if (!list.length) {
      node.textContent = '未找到 Java。启动游戏时会自动下载 Mojang 官方运行时。';
      return;
    }
    node.textContent = list.map((j) => `Java ${j.major} (${j.version})`).join(' · ');
  } catch (err) {
    node.textContent = `检测失败：${err.message}`;
  }
}

/* ------------------------------------------------------------------ */
/* 樱花内网穿透                                                        */
/* ------------------------------------------------------------------ */

const FRP_STATE_LABEL = {
  idle: '未启动',
  starting: '启动中…',
  running: '运行中',
  error: '出错',
  stopping: '停止中…',
};

function frpLog(line) {
  const log = $('frp-log');
  log.hidden = false;
  log.textContent += `${line}\n`;
  const lines = log.textContent.split('\n');
  if (lines.length > 400) log.textContent = lines.slice(-300).join('\n');
  log.scrollTop = log.scrollHeight;
}

function frpApplyState(snapshot) {
  if (!snapshot) return;
  if (!state.frp) state.frp = {};
  Object.assign(state.frp, snapshot);
  renderFrpStatus();
}

function renderFrpStatus() {
  const data = state.frp || {};
  const configured = Boolean(data.configured);
  $('frp-unconfigured').hidden = configured;
  $('frp-configured').hidden = !configured;
  const st = data.state || 'idle';
  const badge = $('frp-state-badge');
  badge.textContent = FRP_STATE_LABEL[st] || st;
  badge.className =
    'badge' +
    (st === 'running'
      ? ' installed'
      : st === 'error'
        ? ' snapshot'
        : st === 'starting' || st === 'stopping'
          ? ' release'
          : '');
  const busy = st === 'running' || st === 'starting' || st === 'stopping';
  const canStop = configured && (st === 'running' || st === 'starting');
  $('btn-frp-start').disabled = !configured || busy;
  $('btn-frp-stop').disabled = !canStop;
  $('btn-frp-refresh').disabled = !configured || busy;
  $('frp-tunnel').disabled = !configured || busy;
  if (!configured) return;
  $('frp-account-label').textContent = data.account || '（未填写账号）';
  if (st === 'error' && data.error) {
    $('frp-status').textContent = `错误：${data.error}`;
  } else if (st === 'running') {
    $('frp-status').textContent = `隧道已开启（#${data.tunnelId || '?'}），PID ${data.pid || '?'}。`;
  } else {
    $('frp-status').textContent = '';
  }
}

function renderFrpTunnels(tunnels) {
  const select = $('frp-tunnel');
  const previous = select.value;
  clear(select);
  if (!tunnels || !tunnels.length) {
    select.appendChild(new Option('没有可用隧道（请先在 natfrp.com 创建）', ''));
    return;
  }
  for (const t of tunnels) {
    const label = `#${t.id} ${t.name}${t.type ? ` · ${t.type}` : ''}${t.node ? ` · 节点 ${t.node}` : ''}${t.remote ? ` · ${t.remote}` : ''}`;
    select.appendChild(new Option(label, String(t.id)));
  }
  if (previous && [...select.options].some((o) => o.value === previous)) select.value = previous;
}

async function refreshFrp() {
  try {
    const data = await api.frp.status();
    state.frp = data;
    if (Array.isArray(data.logs) && data.logs.length) {
      $('frp-log').hidden = false;
      $('frp-log').textContent = `${data.logs.slice(-300).join('\n')}\n`;
    }
    renderFrpStatus();
    if (data.configured) {
      try {
        const result = await api.frp.tunnels();
        renderFrpTunnels(result.tunnels || []);
        const last = data.lastTunnelId || '';
        if (last && [...$('frp-tunnel').options].some((o) => o.value === last)) {
          $('frp-tunnel').value = last;
        }
      } catch (err) {
        renderFrpTunnels([]);
        frpLog(`获取隧道失败：${err.message}`);
      }
    }
  } catch {
    /* 面板状态拉取失败不打断页面 */
  }
}

async function frpSaveCredentials() {
  const account = $('frp-account').value.trim();
  const accessKey = $('frp-access-key').value;
  if (!account || !accessKey) {
    showError(new Error('请填写樱花账号和访问密钥'));
    return;
  }
  const btn = $('btn-frp-save');
  btn.disabled = true;
  try {
    await api.frp.saveCredentials(account, accessKey);
    $('frp-access-key').value = '';
    toast('樱花凭据已加密保存', 'ok');
    await refreshFrp();
  } catch (err) {
    showError(err);
  } finally {
    btn.disabled = false;
  }
}

async function frpClearCredentials() {
  const ok = await confirmDialog('清除樱花凭据', '确定清除已保存的樱花账号与访问密钥吗？', { okText: '清除', danger: true });
  if (!ok) return;
  try {
    await api.frp.clearCredentials();
    await refreshFrp();
    toast('已清除樱花凭据', 'ok');
  } catch (err) {
    showError(err);
  }
}

async function frpStart() {
  const id = $('frp-tunnel').value;
  if (!id) {
    showError(new Error('请选择要开启的隧道'));
    return;
  }
  const btn = $('btn-frp-start');
  btn.disabled = true;
  try {
    await api.frp.start(id);
    toast('正在开启樱花隧道…', 'ok');
  } catch (err) {
    showError(err);
  } finally {
    btn.disabled = false;
    await refreshFrp();
  }
}

async function frpStop() {
  try {
    await api.frp.stop();
  } catch (err) {
    showError(err);
  }
}

/* ------------------------------------------------------------------ */
/* 任务进度                                                            */
/* ------------------------------------------------------------------ */

function bindTaskEvents() {
  api.tasks.onStart((payload) => {
    state.task = { name: payload.task, label: payload.label, bytesDone: 0, bytesTotal: 0 };
    $('task-panel').hidden = false;
    $('task-label').textContent = payload.label || '正在处理…';
    $('task-phase').textContent = '准备中';
    $('task-bar').style.width = '0%';
    $('task-stats').textContent = '';
    $('task-log').textContent = '';
    $('task-log').hidden = true;
    $('btn-task-toggle').textContent = '⌃';
  });
  api.tasks.onProgress((payload) => {
    if (!state.task) return;
    if (payload.phase) $('task-phase').textContent = payload.phase;
    if (payload.bytesTotal > 0) {
      const pct = Math.max(0, Math.min(100, (payload.bytesDone / payload.bytesTotal) * 100));
      $('task-bar').style.width = `${pct.toFixed(1)}%`;
    } else if (payload.filesTotal > 0) {
      const pct = Math.max(0, Math.min(100, (payload.filesDone / payload.filesTotal) * 100));
      $('task-bar').style.width = `${pct.toFixed(1)}%`;
    }
    if (payload.filesTotal) {
      $('task-stats').textContent = `${payload.filesDone || 0}/${payload.filesTotal} 个文件${
        payload.bytesTotal ? ` · ${fmtBytes(payload.bytesDone)} / ${fmtBytes(payload.bytesTotal)}` : ''
      }`;
    } else if (payload.bytesTotal) {
      $('task-stats').textContent = `${fmtBytes(payload.bytesDone)} / ${fmtBytes(payload.bytesTotal)}`;
    }
  });
  api.tasks.onLog((payload) => {
    const log = $('task-log');
    log.textContent += `${payload.line}\n`;
    const lines = log.textContent.split('\n');
    if (lines.length > 400) log.textContent = lines.slice(-300).join('\n');
    log.scrollTop = log.scrollHeight;
  });
  api.tasks.onDone(async (payload) => {
    state.task = null;
    if (payload.ok) {
      $('task-phase').textContent = '已完成';
      $('task-bar').style.width = '100%';
      setTimeout(() => {
        if (!state.task) $('task-panel').hidden = true;
      }, 900);
    } else {
      $('task-phase').textContent = `失败：${payload.message || ''}`;
      toast(payload.message || '任务失败', 'error');
    }
    await refreshInstalled();
    await refreshInstances();
    if (state.view === 'versions') renderVersions();
  });

  $('btn-task-cancel').addEventListener('click', async () => {
    try {
      await api.tasks.cancel();
      $('task-phase').textContent = '正在取消…';
    } catch (err) {
      showError(err);
    }
  });
  $('btn-task-toggle').addEventListener('click', () => {
    const log = $('task-log');
    log.hidden = !log.hidden;
    $('btn-task-toggle').textContent = log.hidden ? '⌃' : '⌄';
  });
}

/* ------------------------------------------------------------------ */
/* 游戏日志                                                            */
/* ------------------------------------------------------------------ */

function bindGameEvents() {
  api.game.onLog((payload) => {
    const body = $('log-body');
    body.textContent += `${payload.line}\n`;
    const lines = body.textContent.split('\n');
    if (lines.length > 5000) body.textContent = lines.slice(-4000).join('\n');
    body.scrollTop = body.scrollHeight;
  });
  api.game.onExit(async (info) => {
    state.gameRunning = false;
    state.gameInstanceId = '';
    renderInstances();
    const minutes = Math.max(1, Math.round((info.durationMs || 0) / 60000));
    toast(info.code === 0 ? `游戏已正常退出（${minutes} 分钟）` : `游戏退出，代码 ${info.code}`, info.code === 0 ? 'ok' : 'error');
    await refreshInstances();
  });
}

async function refreshGameStatus() {
  try {
    const status = await api.game.status();
    state.gameRunning = Boolean(status.running);
    state.gameInstanceId = status.instanceId || '';
    if (state.gameRunning) $('log-drawer').hidden = false;
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 数据刷新                                                            */
/* ------------------------------------------------------------------ */

async function refreshInstances() {
  try {
    state.instances = await api.instances.list();
    renderInstances();
    renderDirectories();
    if (state.view === 'mods') renderMods();
  } catch (err) {
    showError(err);
  }
}

async function refreshInstalled() {
  try {
    const list = await api.versions.installed();
    state.installed = new Set(list);
    if (state.view === 'versions') renderVersions();
  } catch {
    /* ignore */
  }
}

async function refreshAccounts() {
  try {
    const data = await api.accounts.list();
    state.accounts = data.accounts;
    state.selectedAccountId = data.selectedId;
    renderAccounts();
    renderAccountChip();
    ensureSelectedSkin();
  } catch (err) {
    showError(err);
  }
}

/* ------------------------------------------------------------------ */
/* 引导与事件绑定                                                      */
/* ------------------------------------------------------------------ */

function bindStaticEvents() {
  $('btn-new-instance').addEventListener('click', () => openCreateInstance());
  $('btn-add-folder').addEventListener('click', () => addExistingFolder());
  $('btn-new-instance-2').addEventListener('click', () => openCreateInstance());
  $('btn-import').addEventListener('click', async () => {
    try {
      const result = await api.instances.import();
      if (result) {
        await refreshInstances();
        toast('版本导入完成', 'ok');
      }
    } catch (err) {
      showError(err);
    }
  });

  $('version-search').addEventListener('input', (event) => {
    state.versionQuery = event.target.value;
    state.versionLimit = 200;
    renderVersions();
  });
  $('version-type').addEventListener('change', (event) => {
    state.versionType = event.target.value;
    state.versionLimit = 200;
    renderVersions();
  });
  $('btn-refresh-manifest').addEventListener('click', async () => {
    try {
      await ensureManifest(true);
      renderVersions();
      toast('版本清单已刷新', 'ok');
    } catch (err) {
      showError(err);
    }
  });

  $('btn-pack-search').addEventListener('click', searchPacks);
  $('pack-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') searchPacks();
  });
  $('btn-pack-local').addEventListener('click', importLocalPack);

  $('btn-mod-search').addEventListener('click', searchMods);
  $('btn-mod-new-instance').addEventListener('click', () => openCreateInstance());
  $('btn-mod-local').addEventListener('click', async () => {
    const instance = selectedModInstance();
    if (!instance || !modInstanceUsable(instance)) {
      showError(new Error('请先选择一个带加载器的版本'));
      return;
    }
    try {
      const result = await api.mods.importLocal(instance.id);
      if (result) toast(`已导入 ${result.filename}`, 'ok');
    } catch (err) {
      showError(err);
    }
  });
  const externalSearch = (base) => {
    const query = $('mod-search').value.trim();
    if (!query) {
      showError(new Error('请先输入搜索关键词'));
      return;
    }
    api.openExternal(`${base}${encodeURIComponent(query)}`).catch(showError);
  };
  $('btn-mod-mcmod').addEventListener('click', () => externalSearch('https://search.mcmod.cn/s?key='));
  $('btn-mod-minebbs').addEventListener('click', () => externalSearch('https://www.minebbs.com/search/?q='));
  $('mod-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') searchMods();
  });
  $('mod-instance').addEventListener('change', (event) => {
    state.modInstanceId = event.target.value;
    state.mods = [];
    clear($('mod-grid'));
    $('mod-empty').hidden = false;
    $('mod-empty').querySelector('h4').textContent = '下载 MOD';
    $('mod-empty').querySelector('p').textContent = '输入关键词搜索 Modrinth；安装时会自动下载 required 依赖并校验 SHA-1。';
    updateModHint();
  });

  $('btn-ms-login').addEventListener('click', startMsLogin);
  $('btn-offline-add').addEventListener('click', addOfflineAccount);
  $('offline-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addOfflineAccount();
  });
  $('btn-ygg-login').addEventListener('click', yggdrasilLogin);
  $('ygg-password').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') yggdrasilLogin();
  });
  $('btn-ygg-littleskin').addEventListener('click', () => {
    $('ygg-auth-server').value = 'https://littleskin.cn/api/yggdrasil';
    resolveYggServer('https://littleskin.cn/api/yggdrasil');
  });
  $('ygg-auth-server').addEventListener('change', () => {
    resolveYggServer($('ygg-auth-server').value, { silent: true });
  });
  bindYggdrasilDnd();

  $('set-memory').addEventListener('input', (event) => {
    $('memory-label').textContent = `${event.target.value} MB`;
  });
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('set-theme-color').addEventListener('input', (event) => applyThemeColor(event.target.value));
  $('btn-pick-bg').addEventListener('click', pickBackground);
  $('btn-clear-bg').addEventListener('click', clearBackground);
  $('app-bg').addEventListener('error', () => {
    $('app-bg').hidden = true;
  });
  $('btn-java-browse').addEventListener('click', async () => {
    try {
      const file = await api.java.choosePath();
      if (file) $('set-java').value = file;
    } catch (err) {
      showError(err);
    }
  });
  $('btn-java-detect').addEventListener('click', detectJava);
  $('btn-open-data').addEventListener('click', () => api.openDataDir().catch(showError));
  $('btn-open-logs').addEventListener('click', () => api.openLogs().catch(showError));
  $('btn-show-log').addEventListener('click', () => api.openLauncherLog().catch(showError));

  $('btn-frp-save').addEventListener('click', frpSaveCredentials);
  $('btn-frp-clear').addEventListener('click', frpClearCredentials);
  $('btn-frp-refresh').addEventListener('click', () => refreshFrp().catch(showError));
  $('btn-frp-start').addEventListener('click', frpStart);
  $('btn-frp-stop').addEventListener('click', frpStop);
  api.frp.onLog((payload) => frpLog(payload && payload.line ? payload.line : ''));
  api.frp.onState((snapshot) => frpApplyState(snapshot));

  $('btn-close-log').addEventListener('click', () => {
    $('log-drawer').hidden = true;
  });
  $('btn-stop-game').addEventListener('click', stopGame);

  api.events.onInstancesChanged(() => refreshInstances());
  api.events.onVersionsChanged(() => refreshInstalled());
  api.events.onAccountsChanged(() => refreshAccounts());
}

function showSecurityNotice() {
  return new Promise((resolve) => {
    openModal({
      title: '使用前请了解',
      subtitle: 'QUTC Launcher 是社团内部工具，代码完全本地运行。首次使用请确认以下安全设置。',
      build: (body) => {
        const list = el('ul', 'security-list');
        for (const text of [
          '启动器不收集任何账号密码；微软登录使用设备码，外置登录密码只发送给所选验证服务器且不保存。',
          '原版游戏、资源、Java 运行时均来自 Mojang 官方并校验 SHA-1。',
          'Forge/NeoForge 安装需要运行官方安装器，必须由你勾选同意。',
          '版本导入会检查路径穿越、符号链接和压缩炸弹，包内脚本不会执行。',
          '离线模式仅用于社团内部服务器，请勿用于盗版公共服务器。',
        ]) {
          list.appendChild(el('li', '', text));
        }
        body.appendChild(list);
        const label = el('label', 'check');
        const check = el('input');
        check.type = 'checkbox';
        label.appendChild(check);
        label.appendChild(el('span', '', '我已阅读并同意以上说明'));
        body.appendChild(label);
        const btn = el('button', 'btn primary', '进入启动器');
        btn.disabled = true;
        btn.style.marginTop = '12px';
        btn.addEventListener('click', async () => {
          if (!check.checked) return;
          btn.disabled = true;
          try {
            state.config = await api.config.save({ acceptedSecurityNotice: true });
          } catch (err) {
            showError(err);
            btn.disabled = false;
            return;
          }
          const root = $('modal-root');
          root.hidden = true;
          clear(root);
          resolve(true);
        });
        check.addEventListener('change', () => {
          btn.disabled = !check.checked;
        });
        body.appendChild(btn);
      },
      actions: [],
    });
  });
}

async function init() {
  bindStaticEvents();
  bindTaskEvents();
  bindGameEvents();
  bindNav();
  try {
    const boot = await api.bootstrap();
    state.config = boot.config;
    state.instances = boot.instances;
    state.installed = new Set(boot.installedVersions);
    state.accounts = boot.accounts;
    state.selectedAccountId = boot.selectedAccountId;
    $('app-version').textContent = `v${boot.appVersion}`;
    applyThemeColor(state.config.themeColor);
    applyBackground();
    $('app').hidden = false;
    $('loading').hidden = true;
    renderInstances();
    renderDirectories();
    renderAccountChip();
    ensureSelectedSkin();
    await refreshGameStatus();
    refreshFrp();
    if (!boot.config.acceptedSecurityNotice) await showSecurityNotice();
    if (boot.config.showSnapshots) {
      state.versionType = 'all';
      $('version-type').value = 'all';
    }
    state.bootstrapped = true;
  } catch (err) {
    $('loading').hidden = true;
    $('app').hidden = false;
    showError(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
