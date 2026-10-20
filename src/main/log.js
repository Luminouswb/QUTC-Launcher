'use strict';

/**
 * QUTC Launcher - 启动器日志
 * 只记录启动器自身事件，写入 QUTCData/logs/launcher.log，并保留内存环形缓冲。
 */

const fs = require('node:fs');
const path = require('node:path');
const Paths = require('../core/paths');

const MAX_TAIL = 800;
const tail = [];

function logFile() {
  try {
    return Paths.getPaths().launcherLog;
  } catch {
    return '';
  }
}

function appendLauncherLog(message) {
  const line = `[${new Date().toISOString()}] ${String(message)}`;
  tail.push(line);
  if (tail.length > MAX_TAIL) tail.splice(0, tail.length - MAX_TAIL);
  // 控制台输出方便开发调试
  try {
    // eslint-disable-next-line no-console
    console.log(line);
  } catch {
    /* ignore */
  }
  const file = logFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFile(file, `${line}\n`, () => {});
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function getLogTail() {
  return tail.slice(-400);
}

module.exports = { appendLauncherLog, getLogTail };
