'use strict';

/**
 * QUTC Launcher - 轻量 ZIP 读写（仅依赖 Node 内置 zlib）
 *
 * 为什么自己实现？
 * - 启动器需要导入/导出版本与整合包，但为了安全审计，不引入第三方解压库；
 * - 解压侧强制路径穿越检查、符号链接拒绝、体积/压缩比炸弹限制。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { Writable, Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { crc32 } = require('./hash');
const { ensureDirAsync, safeJoin, assertSafeRelative, CancelledError } = require('./util');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;
const FLAG_UTF8 = 0x0800;
const FLAG_DATA_DESCRIPTOR = 0x0008;

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

class FileSink {
  constructor(handle) {
    this.handle = handle;
    this.position = 0;
  }
  async write(buffer) {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await this.handle.write(
        buffer,
        offset,
        buffer.length - offset,
        this.position,
      );
      offset += bytesWritten;
      this.position += bytesWritten;
    }
  }
}

function sinkStream(sink) {
  return new Writable({
    write(chunk, _enc, cb) {
      sink.write(chunk).then(() => cb(), (err) => cb(err));
    },
  });
}

class ZipWriter {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.handle = null;
    this.sink = null;
    this.closed = false;
  }

  async open() {
    await ensureDirAsync(path.dirname(this.file));
    this.handle = await fsp.open(this.file, 'w');
    this.sink = new FileSink(this.handle);
    return this;
  }

  async _writeLocalHeader(nameBuffer, method, timeDate) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAG_UTF8 | FLAG_DATA_DESCRIPTOR, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(timeDate.dosTime, 10);
    header.writeUInt16LE(timeDate.dosDate, 12);
    header.writeUInt32LE(0, 14); // crc
    header.writeUInt32LE(0, 18); // compressed size
    header.writeUInt32LE(0, 22); // uncompressed size
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(0, 28);
    await this.sink.write(header);
    await this.sink.write(nameBuffer);
  }

  /**
   * 添加一个文件。source 可以是磁盘路径或 Buffer。
   */
  async addFile(name, source, options = {}) {
    if (this.closed) throw new Error('ZIP 已关闭');
    const entryName = String(name).replace(/\\/g, '/');
    assertSafeRelative(entryName, 'ZIP 条目名');
    const nameBuffer = Buffer.from(entryName, 'utf8');
    if (nameBuffer.length > 0xffff) throw new Error('ZIP 条目名过长');

    let size;
    if (Buffer.isBuffer(source)) {
      size = source.length;
    } else {
      const stat = await fsp.stat(source);
      if (!stat.isFile()) throw new Error(`不是普通文件: ${source}`);
      size = stat.size;
    }
    if (size > 0xfffffff0) throw new Error(`文件超过 4GB，暂不支持: ${entryName}`);

    const method = size === 0 ? 0 : 8;
    const timeDate = dosDateTime();
    const offset = this.sink.position;
    await this._writeLocalHeader(nameBuffer, method, timeDate);

    let crc = 0;
    let uncompressed = 0;
    let compressed = 0;
    const crcCounter = new Transform({
      transform(chunk, _enc, cb) {
        crc = crc32(chunk, crc);
        uncompressed += chunk.length;
        cb(null, chunk);
      },
    });
    const compressedCounter = new Transform({
      transform(chunk, _enc, cb) {
        compressed += chunk.length;
        cb(null, chunk);
      },
    });

    const source$ = Buffer.isBuffer(source)
      ? Readable.from(source)
      : fs.createReadStream(source);
    const stages = [source$, crcCounter];
    if (method === 8) stages.push(zlib.createDeflateRaw({ level: 6 }));
    stages.push(compressedCounter, sinkStream(this.sink));
    try {
      await pipeline(...stages);
    } catch (err) {
      throw new Error(`写入 ZIP 失败 (${entryName}): ${err.message}`);
    }

    if (uncompressed > 0xfffffff0 || compressed > 0xfffffff0) {
      throw new Error('ZIP 超过 4GB，暂不支持');
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(uncompressed, 12);
    await this.sink.write(descriptor);

    this.entries.push({
      name: nameBuffer,
      method,
      crc: crc >>> 0,
      compressed,
      uncompressed,
      offset,
      timeDate,
    });
  }

  async addText(name, text) {
    await this.addFile(name, Buffer.from(String(text), 'utf8'));
  }

  async addJson(name, data) {
    await this.addText(name, JSON.stringify(data, null, 2));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const centralStart = this.sink.position;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(SIG_CENTRAL, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(FLAG_UTF8 | FLAG_DATA_DESCRIPTOR, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.timeDate.dosTime, 12);
      header.writeUInt16LE(entry.timeDate.dosDate, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressed, 20);
      header.writeUInt32LE(entry.uncompressed, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(0, 30); // extra
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk
      header.writeUInt16LE(0, 36); // internal attr
      header.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attr (unix regular file)
      header.writeUInt32LE(entry.offset, 42);
      await this.sink.write(header);
      await this.sink.write(entry.name);
    }
    const centralSize = this.sink.position - centralStart;
    if (this.sink.position > 0xfffffff0 || centralStart > 0xfffffff0) {
      throw new Error('导出内容超过 4GB，暂不支持');
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    await this.sink.write(eocd);
    await this.handle.sync();
    await this.handle.close();
    this.handle = null;
  }

  async abort() {
    try {
      if (this.handle) await this.handle.close();
    } catch {
      /* ignore */
    }
    this.handle = null;
    this.closed = true;
  }
}

async function createZip(file) {
  const writer = new ZipWriter(file);
  await writer.open();
  return writer;
}

/** 读取 EOCD 与中央目录，返回条目元数据 */
async function listZip(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size < 22) throw new Error('不是有效的 ZIP 文件');
    const tailSize = Math.min(stat.size, 65557);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, stat.size - tailSize);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('ZIP 缺少中央目录');
    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式');
    }
    if (centralOffset + centralSize > stat.size) throw new Error('ZIP 中央目录损坏');
    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);

    const entries = [];
    let pos = 0;
    for (let i = 0; i < entryCount; i += 1) {
      if (pos + 46 > central.length) throw new Error('ZIP 中央目录损坏');
      if (central.readUInt32LE(pos) !== SIG_CENTRAL) throw new Error('ZIP 中央目录项损坏');
      const flags = central.readUInt16LE(pos + 8);
      const method = central.readUInt16LE(pos + 10);
      const crc = central.readUInt32LE(pos + 16);
      const compressed = central.readUInt32LE(pos + 20);
      const uncompressed = central.readUInt32LE(pos + 24);
      const nameLen = central.readUInt16LE(pos + 28);
      const extraLen = central.readUInt16LE(pos + 30);
      const commentLen = central.readUInt16LE(pos + 32);
      const externalAttr = central.readUInt32LE(pos + 38);
      const localOffset = central.readUInt32LE(pos + 42);
      const nameBuf = central.subarray(pos + 46, pos + 46 + nameLen);
      const name = nameBuf.toString('utf8').replace(/\\/g, '/');
      const unixMode = externalAttr >>> 16;
      entries.push({
        name,
        rawName: nameBuf,
        flags,
        method,
        crc,
        compressed,
        uncompressed,
        localOffset,
        isSymlink: (unixMode & 0xf000) === 0xa000,
        isDirectory: name.endsWith('/') || (unixMode & 0xf000) === 0x4000,
        encrypted: Boolean(flags & 0x1),
      });
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function openEntryData(handle, entry) {
  const local = Buffer.alloc(30);
  await handle.read(local, 0, 30, entry.localOffset);
  if (local.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`ZIP 条目损坏: ${entry.name}`);
  const nameLen = local.readUInt16LE(26);
  const extraLen = local.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  if (dataStart + entry.compressed > (await handle.stat()).size) {
    throw new Error(`ZIP 条目越界: ${entry.name}`);
  }
  return { dataStart, nameLen, extraLen };
}

/**
 * 解压 ZIP
 * @param {string} file
 * @param {string} destDir
 * @param {{filter?:(name:string,entry:object)=>boolean, maxTotalBytes?:number, maxEntries?:number, abort?:object}} options
 */
async function extractZip(file, destDir, options = {}) {
  const {
    filter,
    maxTotalBytes = 20 * 1024 * 1024 * 1024,
    maxEntries = 200000,
    abort,
  } = options;
  const entries = await listZip(file);
  if (entries.length > maxEntries) throw new Error(`ZIP 条目过多: ${entries.length}`);
  let planned = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    assertSafeRelative(entry.name, 'ZIP 条目名');
    if (entry.isSymlink) throw new Error(`拒绝符号链接条目: ${entry.name}`);
    if (entry.encrypted) throw new Error(`不支持加密 ZIP: ${entry.name}`);
    if (![0, 8].includes(entry.method)) throw new Error(`不支持的压缩算法: ${entry.method}`);
    planned += entry.uncompressed;
    if (planned > maxTotalBytes) throw new Error('ZIP 解压后体积超过限制');
    if (entry.uncompressed > 64 * 1024 * 1024) {
      const ratio = entry.compressed > 0 ? entry.uncompressed / entry.compressed : Infinity;
      if (ratio > 1000) throw new Error(`疑似压缩炸弹: ${entry.name}`);
    }
  }
  if (planned > maxTotalBytes) throw new Error('ZIP 解压后体积超过限制');

  const handle = await fsp.open(file, 'r');
  let extracted = 0;
  try {
    for (const entry of entries) {
      if (abort && abort.cancelled) throw new CancelledError();
      if (entry.isDirectory) {
        await ensureDirAsync(safeJoin(destDir, entry.name.replace(/\/+$/, '')));
        continue;
      }
      if (filter && !filter(entry.name, entry)) continue;
      const target = safeJoin(destDir, entry.name);
      await ensureDirAsync(path.dirname(target));
      const { dataStart } = await openEntryData(handle, entry);
      if (entry.uncompressed === 0) {
        await fsp.writeFile(target, Buffer.alloc(0));
        extracted += 1;
        continue;
      }
      const tmp = `${target}.qutc-${process.pid}.part`;
      let crc = 0;
      let written = 0;
      const verifier = new Transform({
        transform(chunk, _enc, cb) {
          written += chunk.length;
          if (written > entry.uncompressed) {
            cb(new Error(`ZIP 条目体积异常: ${entry.name}`));
            return;
          }
          crc = crc32(chunk, crc);
          cb(null, chunk);
        },
      });
      const source = fs.createReadStream(file, {
        start: dataStart,
        end: dataStart + entry.compressed - 1,
      });
      const stages = [source];
      if (entry.method === 8) stages.push(zlib.createInflateRaw());
      stages.push(verifier, fs.createWriteStream(tmp));
      try {
        await pipeline(...stages);
        if (written !== entry.uncompressed) throw new Error(`解压大小不符: ${entry.name}`);
        if ((crc >>> 0) !== entry.crc >>> 0) throw new Error(`CRC 校验失败: ${entry.name}`);
        await fsp.rm(target, { force: true }).catch(() => {});
        await fsp.rename(tmp, target);
        extracted += 1;
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    }
  } finally {
    await handle.close();
  }
  return { entries: entries.length, extracted };
}

/** 读取 ZIP 内单个小文件的原始内容（用于 modrinth.index.json 等） */
async function readZipEntry(file, wantedName, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const entries = await listZip(file);
  const entry = entries.find((e) => e.name === wantedName.replace(/\\/g, '/'));
  if (!entry) return null;
  if (entry.uncompressed > maxBytes) throw new Error('ZIP 内文件过大');
  const handle = await fsp.open(file, 'r');
  try {
    const { dataStart } = await openEntryData(handle, entry);
    const buffer = Buffer.alloc(entry.compressed);
    await handle.read(buffer, 0, entry.compressed, dataStart);
    let data;
    if (entry.method === 0) data = buffer;
    else if (entry.method === 8) data = zlib.inflateRawSync(buffer);
    else throw new Error('不支持的压缩算法');
    if (data.length !== entry.uncompressed) throw new Error('解压大小不符');
    if ((crc32(data) >>> 0) !== entry.crc >>> 0) throw new Error('CRC 校验失败');
    return data;
  } finally {
    await handle.close();
  }
}

/** 递归列出目录下所有文件（相对路径） */
async function listFilesRecursive(rootDir) {
  const result = [];
  async function walk(dir, prefix) {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const full = path.join(dir, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(full, rel);
      else if (item.isFile()) result.push({ path: full, rel, size: (await fsp.stat(full)).size });
    }
  }
  await walk(rootDir, '');
  return result;
}

module.exports = {
  createZip,
  listZip,
  extractZip,
  readZipEntry,
  listFilesRecursive,
};
