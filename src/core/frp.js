'use strict';

/**
 * QUTC Launcher - 樱花内网穿透（Sakura Frp）核心
 *
 * 纯 Node.js，无 Electron 依赖，方便单元/冒烟测试（fetch / spawn 均可注入）。
 *
 * 官方 OpenAPI（https://api.natfrp.com/docs/，spec 见 /docs/openapi.yaml）：
 *   base: https://api.natfrp.com/v4
 *   鉴权: Authorization: Bearer <访问密钥>（也可用 ?token= 查询参数，POST）
 *   GET  /user/info        获取用户基本信息
 *   GET  /tunnels          列出所有隧道（数组）
 *   POST /tunnel/config    获取隧道配置文件（表单 query、frpc，返回 ini/toml 文本）
 *   GET  /system/clients   获取 frpc 等客户端下载信息（无需鉴权，含 url/hash/size）
 *
 * frpc 启动（依据 https://doc.natfrp.com/frpc/manual.html 与 usage.html）：
 *   frpc -f <访问密钥>:<隧道ID>[,隧道ID...]
 *   或环境变量 NATFRP_TOKEN=<访问密钥> NATFRP_TARGET=<隧道ID 列表>（自 v0.39.1-sakura-1.1 起）
 * 这里使用环境变量方式，避免访问密钥出现在命令行参数（进程列表）里；并加 --disable_log_color。
 */

const { spawn } = require('node:child_process');
const { downloadFile } = require('./http');
const { verifyFile } = require('./hash');

const API_BASE = 'https://api.natfrp.com/v4';
// 生成 frpc 配置时上报的 frpc 版本；实际下载以 /system/clients 返回的版本为准
const FRPC_CONFIG_VERSION = '0.51.0-sakura-14';
const USER_AGENT = 'QUTC-Launcher/1.0';
const MAX_LOG_LINES = 400;
const STATES = ['idle', 'starting', 'running', 'error', 'stopping'];

/** Windows 下选择 frpc 架构键；非 Windows 返回 null（本功能仅面向 Windows） */
function windowsArchKey() {
  if (process.platform !== 'win32') return null;
  if (process.arch === 'arm64') return 'windows_arm64';
  if (process.arch === 'ia32' || process.arch === 'x86') return 'windows_386';
  return 'windows_amd64';
}

class FrpManager {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.spawnImpl = options.spawn || spawn;
    this.onLog = options.onLog || null; // (line: string) => void
    this.onStateChange = options.onStateChange || null; // (state: string) => void

    this.state = 'idle';
    this.tunnelId = '';
    this.error = '';
    this.proc = null;
    this.pid = 0;
    this.logs = [];
  }

  /* ------------------------------ 状态 ------------------------------ */

  _log(line) {
    const text = String(line).replace(/\r?\n$/, '');
    this.logs.push(text);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    if (this.onLog) {
      try {
        this.onLog(text);
      } catch {
        /* 回调异常不影响主流程 */
      }
    }
  }

  _setState(state, error = '') {
    const next = STATES.includes(state) ? state : 'idle';
    this.state = next;
    this.error = error || '';
    if (this.onStateChange) {
      try {
        this.onStateChange(next);
      } catch {
        /* ignore */
      }
    }
  }

  status() {
    return {
      state: this.state,
      tunnelId: this.tunnelId,
      pid: this.pid,
      error: this.error,
      running: this.state === 'starting' || this.state === 'running',
      logs: this.logs.slice(-200),
    };
  }

  /* ------------------------------ API ------------------------------- */

  /** 底层请求：返回 { ok, status, text, json }；不抛业务错误（交给 _apiJson 处理） */
  async _request(requestPath, { accessKey, method = 'GET', body, accept = 'application/json' } = {}) {
    const headers = { 'user-agent': USER_AGENT, accept };
    if (accessKey) headers.authorization = `Bearer ${accessKey}`;
    const opts = { method, headers };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(body).toString();
    }
    let res;
    try {
      res = await this.fetch(`${API_BASE}${requestPath}`, opts);
    } catch (err) {
      throw new Error(`无法连接樱花服务器：${err && err.message ? err.message : err}`);
    }
    const text = await res.text().catch(() => '');
    let json;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { ok: Boolean(res.ok), status: res.status || 0, text, json };
  }

  /** JSON 接口：业务错误（HTTP 非 2xx 且 body 含 code）统一转成中文 Error */
  async _apiJson(requestPath, opts) {
    const r = await this._request(requestPath, opts);
    if (!r.ok) {
      const data = r.json;
      if (data && typeof data === 'object' && typeof data.code === 'number') {
        if (data.code === 401) throw new Error('访问密钥无效，请重新输入');
        throw new Error(data.msg || `请求失败（代码 ${data.code}）`);
      }
      throw new Error(`请求失败（HTTP ${r.status}）`);
    }
    return r.json;
  }

  async getUserInfo(accessKey) {
    const data = await this._apiJson('/user/info', { accessKey });
    // 字段未完全验证；优先取昵称/邮箱用于展示
    return {
      id: data && data.id,
      name: (data && (data.name || data.nickname || data.email)) || '',
    };
  }

  /** 列出隧道；返回归一化后的数组，便于渲染层使用 */
  async listTunnels(accessKey) {
    const data = await this._apiJson('/tunnels', { accessKey });
    if (!Array.isArray(data)) throw new Error('隧道列表格式异常');
    return data.map((t) => ({
      id: Number(t && t.id),
      name: String((t && t.name) || ''),
      type: String((t && t.type) || ''),
      node: Number(t && t.node),
      online: Boolean(t && t.online),
      status: Number(t && t.status) || 0,
      remote: String((t && t.remote) || ''),
      localIp: String((t && t.local_ip) || ''),
      localPort: Number((t && t.local_port)) || 0,
    }));
  }

  /**
   * 生成 frpc 配置文件（ini/toml 文本）。
   * 未验证：正常启动走 frpc -f / 环境变量由 frpc 自行拉取，此接口仅作备用。
   */
  async getFrpcConfig(accessKey, query) {
    const r = await this._request('/tunnel/config', {
      accessKey,
      method: 'POST',
      body: { query: String(query || ''), frpc: FRPC_CONFIG_VERSION },
      accept: 'text/plain, text/toml',
    });
    if (!r.ok) {
      const data = r.json;
      if (data && typeof data === 'object' && typeof data.code === 'number') {
        if (data.code === 401) throw new Error('访问密钥无效，请重新输入');
        throw new Error(data.msg || `请求失败（代码 ${data.code}）`);
      }
      throw new Error(`请求失败（HTTP ${r.status}）`);
    }
    return r.text;
  }

  /* ----------------------------- 下载 frpc -------------------------- */

  /** 获取 frpc 下载信息（无需鉴权）：{ version, url, hash, size } */
  async getFrpcDownload(arch = 'windows_amd64') {
    const data = await this._apiJson('/system/clients');
    const frpc = data && data.frpc;
    if (!frpc || !frpc.archs || !frpc.archs[arch]) {
      throw new Error('未找到适配当前系统的 frpc 下载地址');
    }
    const item = frpc.archs[arch];
    return {
      version: String(frpc.ver || ''),
      url: String(item.url || ''),
      hash: String(item.hash || ''), // 官方返回 32 位十六进制 = MD5
      size: Number(item.size) || 0,
    };
  }

  /**
   * 下载 frpc 到 dest（缓存）。HTTPS + 大小校验 + MD5 校验。
   * 返回 { version, url, size, skipped }。
   */
  async downloadFrpc({ dest, onProgress } = {}) {
    if (!dest) throw new Error('frpc 下载路径为空');
    const info = await this.getFrpcDownload(windowsArchKey() || 'windows_amd64');
    if (!info.url) throw new Error('未找到 frpc 下载地址');

    // 已有文件且 MD5 校验通过则跳过
    if (info.hash && (await verifyFile(dest, info.hash, 'md5'))) {
      return { ...info, skipped: true };
    }

    // downloadFile 内部强制 HTTPS 公网地址并做大小校验
    await downloadFile(info.url, dest, {
      size: info.size,
      force: true,
      timeout: 120000,
      onChunk: (n, total) => {
        if (onProgress) onProgress({ bytesDone: n, bytesTotal: total });
      },
    });
    if (info.hash && !(await verifyFile(dest, info.hash, 'md5'))) {
      throw new Error('frpc 下载文件 MD5 校验失败，请重试');
    }
    return { ...info, skipped: false };
  }

  /* ---------------------------- 启动 / 停止 ------------------------- */

  /** 附加 stdout/stderr 与退出处理 */
  _attach(child) {
    this.proc = child;
    this.pid = child.pid || 0;
    if (child.stdout) child.stdout.on('data', (d) => this._log(String(d)));
    if (child.stderr) child.stderr.on('data', (d) => this._log(String(d)));
    child.once('exit', (code, signal) => {
      if (this.proc !== child) return;
      this.proc = null;
      this.pid = 0;
      this.tunnelId = '';
      this._log(`[启动器] frpc 已退出（code=${code}${signal ? `, signal=${signal}` : ''}）`);
      this._setState('idle');
    });
  }

  /**
   * 启动 frpc 子进程。DSH 下 Node 子进程用 stdio pipe 可能 EPERM，
   * 先尝试 ['ignore','pipe','pipe'] 捕获日志，失败回退 'ignore'（静默运行）。
   */
  _startProcess(frpcPath, args, env) {
    const launch = (stdio) => {
      const child = this.spawnImpl(frpcPath, args, { env, stdio, windowsHide: true });
      if (stdio !== 'ignore') {
        if (child.stdout) child.stdout.on('data', (d) => this._log(String(d)));
        if (child.stderr) child.stderr.on('data', (d) => this._log(String(d)));
      }
      this._attach(child);
      return child;
    };

    try {
      const child = launch(['ignore', 'pipe', 'pipe']);
      child.once('error', (err) => {
        if (this.proc === child) {
          const code = err && err.code ? err.code : err && err.message ? err.message : '未知';
          this._log(`[启动器] 捕获日志失败（${code}），已回退为静默运行`);
          try {
            launch('ignore');
          } catch {
            /* ignore */
          }
        }
      });
      return child;
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
        this._log(`[启动器] 捕获日志失败（${err.code}），已回退为静默运行`);
        return launch('ignore');
      }
      throw err;
    }
  }

  /** 启动隧道：spawn frpc，访问密钥通过环境变量传入，不写入命令行参数 */
  async start({ accessKey, tunnelId, frpcPath }) {
    if (this.state === 'starting' || this.state === 'running') throw new Error('樱花隧道已在运行');
    const id = String(tunnelId || '').trim();
    if (!id) throw new Error('请选择要开启的隧道');
    if (!accessKey) throw new Error('缺少访问密钥');
    if (!frpcPath) throw new Error('frpc 路径为空');
    if (process.platform !== 'win32') throw new Error('樱花内网穿透目前仅支持 Windows');

    this.tunnelId = id;
    this._setState('starting');
    this._log(`[启动器] 正在启动隧道 ${id} …`);

    const env = { ...process.env, NATFRP_TOKEN: accessKey, NATFRP_TARGET: id };
    const args = ['--disable_log_color'];

    let child;
    try {
      child = this._startProcess(frpcPath, args, env);
    } catch (err) {
      const message = err && err.message ? err.message : err;
      this._setState('error', message);
      this._log(`[启动器] 启动失败：${message}`);
      throw new Error(`启动失败：${message}`);
    }

    this.pid = child.pid || 0;
    this._log(`[启动器] frpc 进程已启动（pid=${this.pid}）`);
    this._setState('running');
    return { pid: this.pid, tunnelId: id };
  }

  /** 结束进程树（Windows 用 taskkill /PID <pid> /T /F） */
  _taskkill(pid) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      let child;
      try {
        child = this.spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        return done();
      }
      child.once('error', done);
      child.once('exit', done);
      const timer = setTimeout(done, 3000);
      if (timer.unref) timer.unref();
    });
  }

  async stop() {
    const pid = this.pid || (this.proc && this.proc.pid) || 0;
    if (!this.proc && !pid) {
      this._setState('idle');
      return false;
    }
    this._setState('stopping');
    this._log('[启动器] 正在结束 frpc 进程树…');
    if (process.platform === 'win32' && pid) {
      await this._taskkill(pid);
    } else if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }
    // 进程树被结束后，frpc 子进程会触发 exit，状态在那里切回 idle
    return true;
  }
}

module.exports = { FrpManager, API_BASE, FRPC_CONFIG_VERSION, STATES, windowsArchKey };
