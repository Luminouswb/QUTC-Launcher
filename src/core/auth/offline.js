'use strict';

/**
 * QUTC Launcher - 离线账号
 * 使用与 Minecraft 原版一致的离线 UUID 算法：md5("OfflinePlayer:" + name) 并设置版本位。
 */

const { offlineUuid } = require('../hash');
const { validateOfflineName } = require('../security');
const { nowIso } = require('../util');

function createOfflineAccount(name) {
  const clean = validateOfflineName(name);
  const uuid = offlineUuid(clean);
  return {
    id: `offline:${uuid}`,
    type: 'offline',
    name: clean,
    uuid,
    accessToken: '0',
    createdAt: nowIso(),
    lastLoginAt: nowIso(),
  };
}

module.exports = { createOfflineAccount };
