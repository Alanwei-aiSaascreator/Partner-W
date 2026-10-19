/**
 * 极简 zip **写**器（零依赖，store 不压缩）—— 诊断包用。
 *
 * 为什么自写：本仓库的 zipper 生态全在 devDependency 链上（`extract-zip` / `yauzl` /
 * `7zip-bin`），打包后 100% `MODULE_NOT_FOUND` —— 这与 `runtime/zip.ts` 自写**解析器**
 * 的理由完全一样（见那个文件头）。诊断包要能在一台"什么都没有的客户机"上生成。
 *
 * ⚠️ 本模块是**纯函数**（吃 Buffer / 吐 Buffer），由调用方决定落盘；
 *    CRC32 复用 `runtime/zip.ts` 的那一份（同一套多项式，解出来才对得上）。
 *
 * ⚠️ 只写 **store**（不压缩）：诊断包的内容是日志与 JSON，体积不敏感，
 *    而 Deflate 要么引依赖、要么再自写一个压缩器 —— 不值得。
 */

import { crc32 } from '../runtime/zip.js';

export interface ZipEntry {
  /** zip 内部路径，**正斜杠**、相对、不含 `..`（调用方负责，这里只写）。 */
  name: string;
  data: Buffer;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
/** bit 11：文件名是 UTF-8（诊断包里会有中文工作区名）。 */
const FLAG_UTF8 = 0x0800;
const VERSION_STORE = 20;

/** Date → DOS 时间/日期（zip 的老格式；1980 年之前一律按 1980-01-01 处理）。 */
export function toDosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: 0x0021 };
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

/** 条目名里的反斜杠一律换成正斜杠（zip 规范）；空名字直接丢掉。 */
export function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/u, '');
}

/**
 * 打包。返回完整 zip 字节；`entries` 为空时返回一个**合法**的空 zip（不是 null）。
 */
export function buildZip(entries: readonly ZipEntry[], now: Date = new Date()): Buffer {
  const { time, date } = toDosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeEntryName(entry.name);
    if (name.length === 0) continue;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_STORE, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION_STORE, 4);
    central.writeUInt16LE(VERSION_STORE, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, entry.data);
    centrals.push(central);
    offset += local.length + size;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}
