'use strict';

/**
 * 代码安全审计脚本：扫描常见后门/动态执行/不安全网络模式。
 * 运行：node scripts/audit.js
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
}
walk(src);

const failures = [];
const warnings = [];
const allowedProcess = new Set([
  path.join(src, 'core', 'java.js'),
  path.join(src, 'core', 'launch.js'),
  path.join(src, 'core', 'loaders.js'),
]);

for (const file of files) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  if (/\beval\s*\(/.test(text)) failures.push(`${rel}: 使用 eval`);
  if (/new\s+Function\s*\(/.test(text)) failures.push(`${rel}: 使用 new Function`);
  if (/vm\.run|vm\.compileFunction/.test(text)) failures.push(`${rel}: 使用 vm 执行代码`);
  if (/require\s*\(\s*['"]http['"]\s*\)/.test(text)) failures.push(`${rel}: 引用非加密 http 模块`);
  // http://auth.xboxlive.com 是 XSTS 的 RelyingParty 标识，不是网络请求地址
  const plainHttp = text.match(/['"]http:\/\/[^'"]+['"]/g) || [];
  for (const hit of plainHttp) {
    if (!hit.includes('http://auth.xboxlive.com')) {
      failures.push(`${rel}: 包含明文 http:// 地址 ${hit}`);
    }
  }
  if (/innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML/.test(text)) {
    failures.push(`${rel}: 使用 HTML 注入 sink`);
  }
  if (/child_process|spawn\s*\(|execFile\s*\(/.test(text) && !allowedProcess.has(file)) {
    failures.push(`${rel}: 不在允许列表中的子进程调用`);
  }
  if (/process\.env\.(QUTC_DATA)/.test(text)) warnings.push(`${rel}: 读取 QUTC_DATA（预期）`);
}

// Electron 安全基线
const main = fs.readFileSync(path.join(src, 'main', 'main.js'), 'utf8');
for (const line of [
  'contextIsolation: true',
  'nodeIntegration: false',
  'sandbox: true',
  'webSecurity: true',
]) {
  if (!main.includes(line)) failures.push(`main.js: 缺少安全配置 ${line}`);
}
if (!main.includes("will-navigate")) failures.push('main.js: 缺少导航拦截');
if (!main.includes('setWindowOpenHandler')) failures.push('main.js: 缺少 window.open 拦截');

const html = fs.readFileSync(path.join(src, 'renderer', 'index.html'), 'utf8');
if (/unsafe-eval/.test(html)) failures.push('index.html: CSP 允许 unsafe-eval');
if (!/Content-Security-Policy/.test(html)) failures.push('index.html: 缺少 CSP');

console.log(`扫描 ${files.length} 个 JS 文件`);
if (warnings.length) {
  console.log('\n提示:');
  for (const warning of warnings) console.log(`  - ${warning}`);
}
if (failures.length) {
  console.error('\n发现安全问题:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\n通过：未发现动态执行、明文 HTTP、HTML 注入或未授权的子进程调用。');
}
