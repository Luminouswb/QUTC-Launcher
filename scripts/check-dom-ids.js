'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const refs = new Set([...js.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]));
const missing = [...refs].filter((ref) => !ids.has(ref));

console.log(`HTML ids: ${ids.size}, app.js refs: ${refs.size}`);
console.log('缺失的 id:', missing);
if (missing.length) process.exitCode = 1;
