'use strict';

/**
 * QUTC Launcher - 账号存储
 *
 * refresh_token 使用 Electron safeStorage（Windows 上为 DPAPI）加密后落盘；
 * 渲染进程只能拿到昵称/UUID，永远拿不到令牌。
 */

const Paths = require('../paths');
const { readJson, writeJsonAtomic, nowIso } = require('../util');

class AccountStore {
  constructor({ encrypt, decrypt } = {}) {
    this.file = Paths.getPaths().accountsFile;
    this.encrypt = typeof encrypt === 'function' ? encrypt : null;
    this.decrypt = typeof decrypt === 'function' ? decrypt : null;
    this.data = { version: 1, selectedId: null, accounts: [] };
  }

  async load() {
    const raw = await readJson(this.file, null);
    if (raw && Array.isArray(raw.accounts)) {
      this.data = {
        version: 1,
        selectedId: raw.selectedId || null,
        accounts: raw.accounts.filter((a) => a && a.id && a.type && a.name && a.uuid),
      };
    }
    if (!this.data.selectedId && this.data.accounts.length) {
      this.data.selectedId = this.data.accounts[0].id;
    }
    return this;
  }

  async save() {
    await writeJsonAtomic(this.file, this.data);
  }

  list() {
    return this.data.accounts.map((a) => ({
      id: a.id,
      type: a.type,
      name: a.name,
      uuid: a.uuid,
      xuid: a.xuid || '',
      authServer: a.authServer || '',
      authServerName: a.authServerName || '',
      createdAt: a.createdAt || '',
      lastLoginAt: a.lastLoginAt || '',
      hasRefreshToken: Boolean(a.refreshToken),
      selected: a.id === this.data.selectedId,
    }));
  }

  selectedId() {
    return this.data.selectedId;
  }

  selected() {
    return this.data.accounts.find((a) => a.id === this.data.selectedId) || null;
  }

  get(id) {
    return this.data.accounts.find((a) => a.id === id) || null;
  }

  /** 添加或更新账号；refreshToken 会加密保存 */
  async upsert(account, { refreshToken, select = true } = {}) {
    if (!account || !account.id) throw new Error('账号数据不完整');
    let stored = this.get(account.id);
    if (!stored) {
      stored = { id: account.id, type: account.type, name: account.name, uuid: account.uuid };
      this.data.accounts.push(stored);
    }
    stored.type = account.type;
    stored.name = account.name;
    stored.uuid = account.uuid;
    if (account.xuid) stored.xuid = account.xuid;
    if (account.authServer) stored.authServer = String(account.authServer).slice(0, 200);
    if (account.authServerName) stored.authServerName = String(account.authServerName).slice(0, 80);
    if (account.yggdrasilClientToken) {
      stored.yggdrasilClientToken = String(account.yggdrasilClientToken).slice(0, 200);
    }
    stored.createdAt = stored.createdAt || account.createdAt || nowIso();
    stored.lastLoginAt = nowIso();
    if (refreshToken) {
      stored.refreshToken = await this._encrypt(refreshToken);
    }
    if (select) this.data.selectedId = account.id;
    await this.save();
    return stored;
  }

  async setRefreshToken(id, token) {
    const stored = this.get(id);
    if (!stored) return;
    stored.refreshToken = await this._encrypt(token);
    await this.save();
  }

  async getRefreshToken(id) {
    const stored = this.get(id);
    if (!stored || !stored.refreshToken) return null;
    return this._decrypt(stored.refreshToken);
  }

  async remove(id) {
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.selectedId === id) {
      this.data.selectedId = this.data.accounts.length ? this.data.accounts[0].id : null;
    }
    if (this.data.accounts.length !== before) await this.save();
  }

  async select(id) {
    if (!this.get(id)) throw new Error('账号不存在');
    this.data.selectedId = id;
    await this.save();
  }

  async _encrypt(text) {
    if (!text) return '';
    if (this.encrypt) {
      const cipher = await this.encrypt(text);
      if (cipher) return `safe:${cipher}`;
    }
    return `plain:${Buffer.from(text, 'utf8').toString('base64')}`;
  }

  async _decrypt(value) {
    if (!value) return null;
    if (value.startsWith('safe:')) {
      if (!this.decrypt) return null;
      try {
        return await this.decrypt(value.slice(5));
      } catch {
        return null;
      }
    }
    if (value.startsWith('plain:')) {
      try {
        return Buffer.from(value.slice(6), 'base64').toString('utf8');
      } catch {
        return null;
      }
    }
    return null;
  }
}

module.exports = { AccountStore };
