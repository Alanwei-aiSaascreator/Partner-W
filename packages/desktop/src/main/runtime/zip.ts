/**
 * 极简 zip 解析器（零依赖）。
 *
 * **为什么自写**：`extract-zip` / `yauzl` / `7zip-bin` 全都**只存在于 devDependency 链上**
 * （分别来自 electron / builder-util）。dev 下 `import` 会跑通，**打包后 100% MODULE_NOT_FOUND**。
 * 而我们要解的是**自家打包器**产出的窄地形包（zip 格式、无 data descriptor、无 zip64、
 * 无加密、无非 ASCII 名、只有 Deflate/Store），通用库的容错价值在这里是零。
 *
 * ⚠️ 语义边界：本包解出来的内容**只能证明「与 manifest 声明一致」**，
 * 不构成发行方真实性 —— 见 `deploy.ts` 里关于 sha256 的说明。
 *
 * ⚠️ 三个已实测的坑：
 *   ① **本地头的 extraLen 与中央目录里的不同**（本包：本地=0 / CD=36）。
 *      `dataOffset` 必须用**本地头自己的**长度，复用 CD 的会错位 → 解出垃圾。
 *   ② 内部路径是**正斜杠**（路线图文档写的"反斜杠"是错的，那是荣盈的包）。
 *   ③ 路径穿越必须拦，且要同时拦 `/` 与 `\` 两种写法。
 *
 * 本模块是**纯函数**（只吃 Buffer / 返回数据），不碰文件系统 —— 才好测。
 */

/** 中央目录尾记录（EOCD）。 */
export interface Eocd {
  entryCount: number;
  centralDirectorySize: number;
  /** 文件绝对偏移。 */
  centralDirectoryOffset: number;
}

export interface CentralEntry {
  name: string;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** 本地文件头的**绝对偏移**（算 dataOffset 要从这里读起）。 */
  localHeaderOffset: number;
  externalAttrs: number;
  dosDate: number;
  dosTime: number;
  isDirectory: boolean;
}

export interface LocalHeader {
  nameLength: number;
  extraLength: number;
  /** 该条目**数据段**的绝对偏移（相对整个归档文件）。 */
  dataOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** EOCD 定长部分 22 字节；注释最长 65535 字节。 */
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;

/**
 * 从尾部反向扫出 EOCD。
 *
 * @param tail 归档的**末尾一段**（至少 22 字节，建议给足 64KB）。
 *             EOCD 里存的是文件绝对偏移，所以只传尾巴不影响解析结果。
 */
export function findEocd(tail: Buffer): Eocd {
  const start = Math.max(0, tail.length - (EOCD_MIN_LENGTH + MAX_COMMENT_LENGTH));
  for (let i = tail.length - EOCD_MIN_LENGTH; i >= start; i--) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;

    const diskNumber = tail.readUInt16LE(i + 4);
    const cdDisk = tail.readUInt16LE(i + 6);
    const entriesOnDisk = tail.readUInt16LE(i + 8);
    const entryCount = tail.readUInt16LE(i + 10);
    const centralDirectorySize = tail.readUInt32LE(i + 12);
    const centralDirectoryOffset = tail.readUInt32LE(i + 16);
    const commentLength = tail.readUInt16LE(i + 20);

    // 候选必须自洽：注释长度要正好顶到缓冲区末尾（否则可能是数据段里碰巧出现的同样的字节）
    if (i + EOCD_MIN_LENGTH + commentLength !== tail.length) continue;
    if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== entryCount) {
      throw new Error(
        `这不是单卷 zip（磁盘号 ${diskNumber}/${cdDisk}、条目数 ${entriesOnDisk}/${entryCount}）—— 本装载器不支持分卷`,
      );
    }
    if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
      throw new Error('看起来是 zip64 归档 —— 本装载器不支持（我们的打包器不会产出 zip64）');
    }
    return { entryCount, centralDirectorySize, centralDirectoryOffset };
  }
  throw new Error('没找到 EOCD 记录 —— 这不是一个 zip 归档（我们的运行时包扩展名是 .7z，但格式是 zip）');
}

/**
 * 解析中央目录。
 *
 * @param cd **恰好**是中央目录那一段（长度 = EOCD 的 `centralDirectorySize`）。
 */
export function parseCentralDirectory(cd: Buffer): CentralEntry[] {
  const entries: CentralEntry[] = [];
  let offset = 0;
  while (offset < cd.length) {
    const remaining = cd.length - offset;
    if (remaining < 46) {
      throw new Error(`中央目录被截断：偏移 ${offset} 处只剩 ${remaining} 字节，不足一个定长头`);
    }
    if (cd.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new Error(`中央目录偏移 ${offset} 处的签名不对（0x${cd.readUInt32LE(offset).toString(16)}）`);
    }
    const nameLength = cd.readUInt16LE(offset + 28);
    const extraLength = cd.readUInt16LE(offset + 30);
    const commentLength = cd.readUInt16LE(offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > cd.length) {
      throw new Error(`中央目录条目越界：偏移 ${offset} 处声明长度超出缓冲区`);
    }

    const name = cd.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const compressionMethod = cd.readUInt16LE(offset + 10);
    const dosTime = cd.readUInt16LE(offset + 12);
    const dosDate = cd.readUInt16LE(offset + 14);
    const externalAttrs = cd.readUInt32LE(offset + 38);

    entries.push({
      name,
      compressionMethod,
      crc32: cd.readUInt32LE(offset + 16),
      compressedSize: cd.readUInt32LE(offset + 20),
      uncompressedSize: cd.readUInt32LE(offset + 24),
      localHeaderOffset: cd.readUInt32LE(offset + 42),
      externalAttrs,
      dosDate,
      dosTime,
      // 两条判据在本包里**永远一致**（尾斜杠 ↔ DOS 目录位 0x10，实测 2072 条 0 分歧）；
      // 都认是为了对将来的打包器保持诚实，不是为了迁就某个特例。
      isDirectory: name.endsWith('/') || (externalAttrs & 0x10) !== 0,
    });
    offset = end;
  }
  if (entries.length === 0) throw new Error('中央目录是空的');
  return entries;
}

/**
 * 解析本地文件头 —— **只取长度字段**，用来算数据段偏移。
 *
 * ⚠️ 这里读的是**本地头自己的** nameLen / extraLen。本包里本地头的 extraLen 是 0，
 * 而中央目录里是 36（NTFS 时间戳）。复用 CD 的长度会错位 36 字节。
 *
 * @param buf 从**本地头起始处**开始的字节（至少要含完整定长头）。
 */
export function parseLocalHeader(buf: Buffer): LocalHeader {
  if (buf.length < 30) {
    throw new Error(`本地文件头被截断：只有 ${buf.length} 字节`);
  }
  if (buf.readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error(`本地文件头签名不对（0x${buf.readUInt32LE(0).toString(16)}）`);
  }
  const nameLength = buf.readUInt16LE(26);
  const extraLength = buf.readUInt16LE(28);
  return { nameLength, extraLength, dataOffset: 30 + nameLength + extraLength };
}

/** DOS 日期时间 → JS Date。0 值不炸（落到 1980-01-01，而不是 Invalid Date）。 */
export function dosDateTimeToDate(dosDate: number, dosTime: number): Date {
  const year = 1980 + ((dosDate >> 9) & 0x7f);
  const month = Math.max(1, (dosDate >> 5) & 0x0f); // 1..12
  const day = Math.max(1, dosDate & 0x1f); // 1..31
  const hours = (dosTime >> 11) & 0x1f;
  const minutes = (dosTime >> 5) & 0x3f;
  const seconds = (dosTime & 0x1f) * 2;
  // 用本地时间构造：DOS 时间戳没有时区语义，用本地时间最接近「解压工具看到的样子」
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

/**
 * 条目名是否安全（可以安全地拼到目标目录下）。
 *
 * 拒绝：空名、含 NUL、绝对路径、盘符、UNC、以及任何 `.` / `..` / 空 段。
 * ⚠️ 反斜杠**先归一成正斜杠再判段** —— 只拦 `/` 会放过 Windows 风格的 `..\evil`。
 */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.includes('\u0000')) return false;

  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false; // 绝对路径 / UNC
  if (/^[a-zA-Z]:/.test(normalized)) return false; // 盘符

  // 目录条目允许一个尾斜杠，其余位置不允许空段
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  if (trimmed.length === 0) return false;
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

// ---------- CRC32（表驱动，标准多项式 0xEDB88320） ----------

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

/**
 * CRC32，**支持增量**：`crc32(chunk2, crc32(chunk1))` === `crc32(concat)`。
 *
 * 流式解压靠这条 —— 边写盘边累加，最后与条目头里的 CRC 比对。
 */
export function crc32(buf: Buffer, seed = 0): number {
  const t = table();
  let c = ~seed >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}
