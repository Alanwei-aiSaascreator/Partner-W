import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../src/main/runtime/zip.js';

/**
 * 测试内**现造**一个真 zip（能被本仓库的解析器解开，不需要 7-Zip、不需要网络）。
 *
 * 为什么不用现成的打包库：`extract-zip` / `yauzl` / `7zip-bin` 全在 devDependency 链上，
 * 用它们造 fixture 会让"测试通过"依赖于一个**打包后并不存在**的依赖 —— 那正是我们自写
 * 解析器的理由。这里只用 `zlib` + 手写结构，零额外依赖。
 *
 * ⚠️ 刻意复现真实包的两条特征（见 `runtime/zip.ts` 文件头）：
 *   ① 本地头 extraLen = 0，中央目录 extraLen = 36（NTFS 时间戳）—— 复用 CD 的长度会错位
 *   ② 中央目录在文件末尾，条目偏移是**绝对**偏移
 */

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

export interface SeedEntry {
  name: string;
  content?: Buffer;
  /** 故意写错的 CRC，用来测「CRC 不符必须报错」。 */
  badCrc?: number;
  /** 故意写错的解压后长度。 */
  badSize?: number;
  /** 用 Store（不压缩）。目录条目自动走 Store。 */
  store?: boolean;
}

/** 造一个结构完整的小 zip：本地头 + 数据 + 中央目录 + EOCD。 */
export function makeZip(entries: SeedEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const isDir = e.name.endsWith('/');
    const raw = isDir ? Buffer.alloc(0) : (e.content ?? Buffer.alloc(0));
    const method = isDir || e.store ? 0 : 8;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const crc = e.badCrc ?? crc32(raw);
    const uncompressedSize = e.badSize ?? raw.length;
    const nameBuf = Buffer.from(e.name, 'utf8');

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0x5d2b),
      u32(crc),
      u32(data.length),
      u32(uncompressedSize),
      u16(nameBuf.length),
      u16(0), // 本地头 extra 长度 = 0（与中央目录的 36 不同，正是要测的那条）
      nameBuf,
      data,
    ]);
    locals.push(local);

    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(method),
        u16(0),
        u16(0x5d2b),
        u32(crc),
        u32(data.length),
        u32(uncompressedSize),
        u16(nameBuf.length),
        u16(36), // ⚠️ 中央目录的 extraLen 故意给 36，本地头给 0 —— 复现真实包的差异
        u16(0),
        u16(0),
        u16(0),
        u32(isDir ? 0x10 : 0),
        u32(offset),
        nameBuf,
        Buffer.alloc(36),
      ]),
    );

    offset += local.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}
