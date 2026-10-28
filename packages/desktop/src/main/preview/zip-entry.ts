/**
 * 从 ZIP 里**按名字取一条**。`.docx` / `.pptx` / `.xlsx` 全是 ZIP，预览要的就是这一层。
 *
 * 为什么自己写而不是装 `jszip`：它在这个仓库里**不可达**（只是 `pptxgenjs` 的传递依赖），
 * 而加依赖有前科 —— 打包态压平 pnpm 树会丢嵌套依赖
 * （[[pnpm-flattening-drops-nested-deps]]：`require('exceljs')` 当场炸、开发态全绿）。
 * `node:zlib` 是内置的 ⇒ 零依赖、零打包风险。
 *
 * ⚠️ 走**中央目录**（文件尾部的 `PK\x01\x02` 表）而不是扫本地头：
 *    流式写出的 zip 在本地头里**压缩长度可能是 0**（真值在数据描述符里或中央目录里），
 *    按本地头的 0 去解压会得到空。
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/**
 * 找中央目录的起点。
 *
 * ⚠️ ZIP 尾部可能有注释（最长 65535）⇒ 从尾巴往前扫，不是固定偏移。
 * ⚠️ **压成 0 字节的条目**（空文件）在表里也是合法条目，别把它当"没找到"。
 */
function findCentralDirectory(buf: Buffer): CentralEntry[] | null {
  const minEocd = 22;
  if (buf.length < minEocd) return null;
  const scanFrom = Math.max(0, buf.length - minEocd - 0xffff);
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= scanFrom; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset >= buf.length) return null;

  const entries: CentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function listZipEntries(buffer: Buffer): string[] {
  return (findCentralDirectory(buffer) ?? []).map((e) => e.name);
}

/**
 * 取一条。**取不到就 `null`** —— 不抛、不猜、不返回最近的同名。
 *
 * ⚠️ 这里**不抛**是刻意的：调用方（预览）要的是"这个文件里没有这一条"，
 *    那是一个正常的答案，不是异常。真正的坏文件在更外层判。
 */
export function readZipEntry(buffer: Buffer, entryName: string): Buffer | null {
  const entry = (findCentralDirectory(buffer) ?? []).find((e) => e.name === entryName);
  if (!entry) return null;
  const p = entry.localHeaderOffset;
  if (p + 30 > buffer.length || buffer.readUInt32LE(p) !== LOC_SIG) return null;

  const nameLen = buffer.readUInt16LE(p + 26);
  const extraLen = buffer.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  // ⚠️ 本地头里的压缩长度可能是 0 ⇒ **以中央目录为准**（上面那条注释说的就是这件事）
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) return null;
  const raw = buffer.subarray(dataStart, dataEnd);

  if (entry.method === 0) return Buffer.from(raw); // stored
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw);
    } catch {
      return null;
    }
  }
  return null; // 其它压缩方式我们不认（docx/pptx/xlsx 只会是 0 或 8）
}
