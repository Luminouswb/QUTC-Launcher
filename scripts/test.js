'use strict';

/**
 * QUTC Launcher - 核心单元测试
 * 运行：node scripts/test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const { crc32, offlineUuid, uuidDashed, verifyFile } = require('../src/core/hash');
const Security = require('../src/core/security');
const Rules = require('../src/core/rules');
const Util = require('../src/core/util');
const Config = require('../src/core/config');
const { createZip, listZip, readZipEntry, extractZip } = require('../src/core/zip');
const Loaders = require('../src/core/loaders');
const Modpack = require('../src/core/modpack');
const Mods = require('../src/core/mods');
const ModAliases = require('../src/core/mod-aliases');
const Yggdrasil = require('../src/core/auth/yggdrasil');
const Versions = require('../src/core/versions');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qutc-test-'));
}

/** 手工构造最小 ZIP，用于测试解压器的安全校验 */
function rawZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data || '');
    const compressed = entry.store ? data : zlib.deflateRawSync(data);
    const method = entry.store ? 0 : 8;
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localBuf = Buffer.concat([local, name, compressed]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.externalAttr || 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    locals.push(localBuf);
    offset += localBuf.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

async function main() {
  console.log('QUTC Launcher 核心测试\n');

  await test('安全：拒绝 HTTP 下载地址', () => {
    assert.throws(() => Security.assertSafeRemoteUrl('http://piston-meta.mojang.com/x'), /HTTPS/);
  });

  await test('安全：拒绝内网/环回地址', () => {
    for (const url of [
      'https://127.0.0.1/a',
      'https://localhost/a',
      'https://192.168.1.10/a',
      'https://10.0.0.1/a',
    ]) {
      assert.throws(() => Security.assertSafeRemoteUrl(url), /内网/);
    }
  });

  await test('安全：接受官方 HTTPS 地址', () => {
    assert.strictEqual(
      Security.assertSafeRemoteUrl('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'),
      'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    );
  });

  await test('安全：外链白名单', () => {
    assert.strictEqual(Security.isAllowedExternalUrl('https://modrinth.com/project/x'), true);
    assert.strictEqual(Security.isAllowedExternalUrl('https://evil.example.com/'), false);
    assert.strictEqual(Security.isAllowedExternalUrl('javascript:alert(1)'), false);
  });

  await test('安全：离线用户名规则', () => {
    assert.strictEqual(Security.validateOfflineName('Steve_01'), 'Steve_01');
    for (const name of ['ab', 'a'.repeat(17), '中文名', 'bad name', 'bad-name']) {
      assert.throws(() => Security.validateOfflineName(name));
    }
  });

  await test('安全：Client ID 必须是 GUID', () => {
    assert.strictEqual(
      Security.validateClientId('00000000-0000-0000-0000-000000000000'),
      '00000000-0000-0000-0000-000000000000',
    );
    assert.throws(() => Security.validateClientId('not-a-guid'));
  });

  await test('路径：safeJoin 拒绝穿越', () => {
    assert.throws(() => Util.safeJoin('C:\\data', '..\\windows\\system32'), /非法|越界/);
    assert.throws(() => Util.safeJoin('C:\\data', 'C:\\windows\\system32'), /绝对路径|非法/);
  });

  await test('Maven：坐标解析与默认地址', () => {
    const dep = Rules.parseMavenName('org.lwjgl:lwjgl:3.3.2:natives-windows');
    assert.strictEqual(dep.group, 'org.lwjgl');
    assert.strictEqual(dep.artifact, 'lwjgl');
    assert.strictEqual(dep.version, '3.3.2');
    assert.strictEqual(dep.classifier, 'natives-windows');
    assert.strictEqual(Rules.mavenRelPath(dep), 'org/lwjgl/lwjgl/3.3.2/lwjgl-3.3.2-natives-windows.jar');
    assert.strictEqual(Rules.mavenBaseUrl(dep), 'https://libraries.minecraft.net/');
  });

  await test('Maven：mappings@txt 扩展名', () => {
    const dep = Rules.parseMavenName('de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412:mappings@txt');
    assert.strictEqual(dep.classifier, 'mappings');
    assert.strictEqual(dep.extension, 'txt');
    assert.strictEqual(
      Rules.mavenRelPath(dep),
      'de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412-mappings.txt',
    );
  });

  await test('Maven：只有 natives 分类器的库不伪造主 jar', () => {
    const lib = {
      name: 'net.java.jinput:jinput-platform:2.0.5',
      natives: { windows: 'natives-windows' },
      downloads: {
        classifiers: {
          'natives-windows': {
            path: 'net/java/jinput/jinput-platform/2.0.5/jinput-platform-2.0.5-natives-windows.jar',
            url: 'https://libraries.minecraft.net/net/java/jinput/jinput-platform/2.0.5/jinput-platform-2.0.5-natives-windows.jar',
            sha1: '385ee093e01f587f30ee1c8a2ee7d408fd732e16',
            size: 155179,
          },
        },
      },
    };
    assert.strictEqual(Rules.libraryArtifact(lib), null);
    const native = Rules.nativeArtifact(lib);
    assert.ok(native.path.endsWith('jinput-platform-2.0.5-natives-windows.jar'));
  });

  await test('规则：Windows 库筛选', () => {
    const ctx = Versions.ruleContext();
    assert.strictEqual(Rules.isAllowed([{ action: 'allow', os: { name: 'windows' } }], ctx), true);
    assert.strictEqual(Rules.isAllowed([{ action: 'allow', os: { name: 'osx' } }], ctx), false);
    assert.strictEqual(Rules.isAllowed([{ action: 'disallow' }], ctx), false);
    assert.strictEqual(Rules.isAllowed(undefined, ctx), true);
  });

  await test('UUID：离线 UUID 稳定且为 v3', () => {
    const a = offlineUuid('QUTC_Player');
    const b = offlineUuid('QUTC_Player');
    assert.strictEqual(a, b);
    assert.match(uuidDashed(a), /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.strictEqual(offlineUuid('QUTC_Player'), offlineUuid('QUTC_Player'));
  });

  await test('哈希：SHA-1 校验', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'a.txt');
    await fsp.writeFile(file, 'qutc');
    const expected = crypto.createHash('sha1').update('qutc').digest('hex');
    assert.strictEqual(await verifyFile(file, expected, 'sha1'), true);
    assert.strictEqual(await verifyFile(file, '0'.repeat(40), 'sha1'), false);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await test('压缩包：写入/读取/解压往返', async () => {
    const dir = tmpdir();
    const zip = path.join(dir, 'a.qutc');
    const writer = await createZip(zip);
    await writer.addJson('instance.json', { format: 'qutc-instance', hello: '世界' });
    await writer.addText('minecraft/mods/a.txt', 'content-123');
    await writer.close();

    const entries = await listZip(zip);
    assert.ok(entries.some((e) => e.name === 'instance.json'));
    const manifest = JSON.parse((await readZipEntry(zip, 'instance.json')).toString('utf8'));
    assert.strictEqual(manifest.hello, '世界');

    const out = path.join(dir, 'out');
    await extractZip(zip, out);
    assert.strictEqual(await fsp.readFile(path.join(out, 'minecraft', 'mods', 'a.txt'), 'utf8'), 'content-123');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await test('压缩包：拒绝 ../ 路径穿越', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'evil.zip');
    await fsp.writeFile(file, rawZip([{ name: '../evil.txt', data: 'pwn' }]));
    await assert.rejects(() => extractZip(file, path.join(dir, 'out')), /非法|越界/);
    assert.strictEqual(fs.existsSync(path.join(dir, 'evil.txt')), false);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await test('压缩包：拒绝符号链接条目', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'link.zip');
    // external attr 高 16 位 = Unix mode 0o120777
    await fsp.writeFile(file, rawZip([{ name: 'link', data: 'target', externalAttr: 0o120777 << 16 }]));
    await assert.rejects(() => extractZip(file, path.join(dir, 'out')), /符号链接/);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await test('配置：数值/枚举归一化', () => {
    const config = Config.normalize({
      memoryMb: 999999,
      downloadConcurrency: 0,
      mirror: 'evil',
      customResolution: { enabled: true, width: 10, height: 99999 },
      jvmArgsExtra: 'x'.repeat(9999),
    });
    assert.strictEqual(config.memoryMb, 65536);
    assert.strictEqual(config.downloadConcurrency, 1);
    assert.strictEqual(config.mirror, 'official');
    assert.strictEqual(config.customResolution.width, 320);
    assert.strictEqual(config.customResolution.height, 4320);
    assert.ok(config.jvmArgsExtra.length <= 4000);
  });

  await test('实例 ID：只允许安全字符', () => {
    const Instances = require('../src/core/instances');
    assert.throws(() => Instances.assertInstanceId('../../etc'), /非法/);
    assert.throws(() => Instances.assertInstanceId('abc'), /非法/);
    assert.strictEqual(Instances.assertInstanceId('i1a2b3c4d5e'), 'i1a2b3c4d5e');
    assert.throws(() => Instances.assertVersionId('../../windows/system32'), /非法/);
    assert.throws(() => Instances.assertVersionId('1.20.1/../x'), /非法/);
    assert.strictEqual(Instances.assertVersionId('1.20.1-forge-47.3.0'), '1.20.1-forge-47.3.0');
  });

  await test('加载器：NeoForge 版本前缀映射', () => {
    assert.strictEqual(Loaders.neoForgePrefix('1.20.1'), '');
    assert.strictEqual(Loaders.neoForgePrefix('1.20.2'), '20.2.');
    assert.strictEqual(Loaders.neoForgePrefix('1.20.4'), '20.4.');
    assert.strictEqual(Loaders.neoForgePrefix('1.21'), '21.0.');
    assert.strictEqual(Loaders.neoForgePrefix('1.21.1'), '21.1.');
  });

  await test('加载器：版本号比较', () => {
    assert.ok(Loaders.compareVersions('47.3.0', '47.2.0') > 0);
    assert.ok(Loaders.compareVersions('0.15.0', '0.9.0') > 0);
    assert.strictEqual(Loaders.compareVersions('1.20.1', '1.20.1'), 0);
  });

  await test('Modrinth 整合包：索引解析', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'pack.mrpack');
    const writer = await createZip(file);
    await writer.addJson('modrinth.index.json', {
      formatVersion: 1,
      game: 'minecraft',
      name: 'Test Pack',
      versionId: '1.0.0',
      dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' },
      files: [
        {
          path: 'mods/a.jar',
          hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
          downloads: ['https://cdn.modrinth.com/a.jar'],
          fileSize: 10,
        },
        {
          path: 'mods/server-only.jar',
          hashes: { sha1: 'c'.repeat(40) },
          downloads: ['https://cdn.modrinth.com/s.jar'],
          env: { client: 'unsupported' },
        },
      ],
    });
    await writer.addText('overrides/config/a.txt', 'x');
    await writer.close();

    const info = await Modpack.readMrpackIndex(file);
    assert.strictEqual(info.name, 'Test Pack');
    assert.strictEqual(info.mcVersion, '1.20.1');
    assert.deepStrictEqual(info.loader, { type: 'fabric', version: '0.15.11' });
    assert.strictEqual(info.files.length, 1);
    assert.strictEqual(info.files[0].path, 'mods/a.jar');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await test('Modrinth 整合包：拒绝缺少 SHA-1 的文件', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'bad.mrpack');
    const writer = await createZip(file);
    await writer.addJson('modrinth.index.json', {
      formatVersion: 1,
      game: 'minecraft',
      dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' },
      files: [{ path: 'mods/a.jar', hashes: {}, downloads: ['https://cdn.modrinth.com/a.jar'] }],
    });
    await writer.close();
    await assert.rejects(() => Modpack.readMrpackIndex(file), /SHA-1/);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await test('MOD：文件名清理与路径穿越防护', () => {
    const name = Mods.sanitizeModFilename('..\\..\\evil/sodium.jar', 'fallback');
    assert.ok(name.endsWith('.jar'));
    assert.ok(!name.includes('/'));
    assert.ok(!name.includes('\\'));
    assert.ok(!name.startsWith('..'));
    assert.strictEqual(Mods.sanitizeModFilename('CON.jar', 'x'), '_CON.jar');
    assert.ok(Mods.sanitizeModFilename('', 'project-version').endsWith('.jar'));
  });

  await test('MOD：优先选择主 jar，跳过 sources/javadoc', () => {
    const version = {
      files: [
        { filename: 'mod-1.0-sources.jar', url: 'https://cdn.modrinth.com/sources.jar', primary: true, hashes: { sha1: 'a'.repeat(40) } },
        { filename: 'mod-1.0.jar', url: 'https://cdn.modrinth.com/mod.jar', primary: false, hashes: { sha1: 'b'.repeat(40) } },
      ],
    };
    const file = Mods.pickModFile(version);
    assert.strictEqual(file.filename, 'mod-1.0.jar');
    assert.strictEqual(Mods.pickModFile({ files: [{ filename: 'x.jar', url: 'https://x/y.jar', hashes: {} }] }), null);
  });

  await test('MOD：加载器与游戏版本兼容性', () => {
    const quilt = { mcVersion: '1.20.1', loader: { type: 'quilt' } };
    const fabric = { mcVersion: '1.20.1', loader: { type: 'fabric' } };
    const forge = { mcVersion: '1.20.1', loader: { type: 'forge' } };
    const version = { gameVersions: ['1.20.1'], loaders: ['fabric'] };
    assert.strictEqual(Mods.isVersionCompatible(version, quilt), true);
    assert.strictEqual(Mods.isVersionCompatible(version, fabric), true);
    assert.strictEqual(Mods.isVersionCompatible(version, forge), false);
    assert.strictEqual(Mods.isVersionCompatible({ gameVersions: ['1.19.2'], loaders: ['fabric'] }, fabric), false);
  });

  await test('MOD：中文别名扩展为英文搜索词', () => {
    assert.ok(ModAliases.expandModQuery('钠').includes('sodium'));
    assert.ok(ModAliases.expandModQuery('物品管理器').includes('jei'));
    assert.ok(ModAliases.expandModQuery('sodium').includes('钠'));
    assert.strictEqual(ModAliases.expandModQuery('不存在的词汇').length, 1);
    assert.ok(ModAliases.expandModQuery('机械动力').includes('create'));
  });

  await test('外置登录：拖拽 URI、HTTPS 补全与协议限制', () => {
    const dropped = Yggdrasil.parseDnd(`authlib-injector:yggdrasil-server:${encodeURIComponent('https://example.com/api/yggdrasil/')}`);
    assert.strictEqual(dropped, 'https://example.com/api/yggdrasil/');
    assert.strictEqual(Yggdrasil.normalizeInput('example.com/api/yggdrasil/'), 'https://example.com/api/yggdrasil/');
    assert.throws(() => Yggdrasil.normalizeInput('http://example.com/api/yggdrasil'), /HTTPS/);
    assert.throws(() => Yggdrasil.normalizeInput('http://127.0.0.1/api/yggdrasil'), /HTTPS|内网|私有/);
  });

  await test('版本：Java 主版本推断', () => {
    assert.strictEqual(Versions.getJavaMajor({ id: '1.8.9' }), 8);
    assert.strictEqual(Versions.getJavaMajor({ id: '1.16.5' }), 8);
    assert.strictEqual(Versions.getJavaMajor({ id: '1.17.1' }), 16);
    assert.strictEqual(Versions.getJavaMajor({ id: '1.20.1' }), 17);
    assert.strictEqual(Versions.getJavaMajor({ javaVersion: { majorVersion: 21 }, id: '1.21' }), 21);
  });

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  if (failed) {
    for (const item of failures) console.error(`\n${item.name}\n${item.err.stack}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
