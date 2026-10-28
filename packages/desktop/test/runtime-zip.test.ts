import { describe, expect, it } from 'vitest';
import {
  crc32,
  dosDateTimeToDate,
  findEocd,
  isSafeEntryName,
  parseCentralDirectory,
  parseLocalHeader,
} from '../src/main/runtime/zip.js';

/**
 * 自写 zip 解析器（零依赖）。
 *
 * 为什么自写：`extract-zip` / `yauzl` / `7zip-bin` **全在 devDependency 链上**
 * （分别来自 electron / builder-util）—— dev 下 import 会跑通、**打包后 100% MODULE_NOT_FOUND**。
 * 而我们的包是**自家打包器**产出的窄地形（zip 格式、无 data descriptor、无 zip64、无加密、
 * 无非 ASCII 名、只有 Deflate/Store），通用库的容错价值在这里是零。
 *
 * ⚠️ 三个已实测的坑，本文件的断言逐个钉死：
 *   ① **本地头的 extraLen 与中央目录里的不同**（本包：本地=0 / CD=36）。
 *      算 `dataOffset` 必须读**本地头自己的**长度，复用 CD 的会错位 36 字节 → 全是垃圾。
 *   ② 内部路径是**正斜杠**（路线图文档写的"反斜杠"是错的，那是Partner-W的包）。
 *   ③ 路径穿越必须拦：`../x`、`C:/x`、`/abs`、`a/../../b`，以及 Windows 的 `..\x`。
 */

// ---------- 造 buffer 的小工具（对齐 pack-runtime.test.mjs：不落二进制 fixture） ----------

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

/**
 * 22 字节定长 EOCD + 可选注释。
 * ⚠️ 注释长度字段必须与实际注释一致 —— 解析器正是靠这条自洽性把「真 EOCD」
 * 与「数据段里碰巧出现的同样签名」区分开的。
 */
function makeEocd(
  opts: { entries?: number; cdSize?: number; cdOffset?: number; disk?: number; comment?: string } = {},
): Buffer {
  const { entries = 1, cdSize = 64, cdOffset = 100, disk = 0, comment = '' } = opts;
  const commentBuf = Buffer.from(comment, 'utf8');
  return Buffer.concat([
    u32(0x06054b50), // signature
    u16(disk), // 本磁盘号
    u16(disk), // 中央目录所在磁盘号
    u16(entries), // 本磁盘条目数
    u16(entries), // 总条目数
    u32(cdSize),
    u32(cdOffset),
    u16(commentBuf.length), // 注释长度
    commentBuf,
  ]);
}

/** 中央目录条目（46 字节定长头 + 文件名）。 */
function makeCentralEntry(opts: {
  name: string;
  crc?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  method?: number;
  localHeaderOffset?: number;
  externalAttrs?: number;
  dosDate?: number;
  dosTime?: number;
}): Buffer {
  const {
    name,
    crc = 0x12345678,
    compressedSize = 10,
    uncompressedSize = 20,
    method = 8,
    localHeaderOffset = 0,
    externalAttrs = 0,
    dosDate = 0,
    dosTime = 0,
  } = opts;
  const nameBuf = Buffer.from(name, 'utf8');
  return Buffer.concat([
    u32(0x02014b50), // signature
    u16(20), // version made by
    u16(20), // version needed
    u16(0), // flags
    u16(method),
    u16(dosTime),
    u16(dosDate),
    u32(crc),
    u32(compressedSize),
    u32(uncompressedSize),
    u16(nameBuf.length),
    u16(0), // extraLen
    u16(0), // commentLen
    u16(0), // disk number start
    u16(0), // internal attrs
    u32(externalAttrs),
    u32(localHeaderOffset),
    nameBuf,
  ]);
}

/** 本地文件头（30 字节定长头 + 文件名 + extra）。 */
function makeLocalHeader(opts: {
  name: string;
  extra?: Buffer;
  method?: number;
  compressedSize?: number;
  uncompressedSize?: number;
}): Buffer {
  const { name, extra = Buffer.alloc(0), method = 8, compressedSize = 10, uncompressedSize = 20 } = opts;
  const nameBuf = Buffer.from(name, 'utf8');
  return Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0), // flags
    u16(method),
    u16(0),
    u16(0),
    u32(0),
    u32(compressedSize),
    u32(uncompressedSize),
    u16(nameBuf.length),
    u16(extra.length),
    nameBuf,
    extra,
  ]);
}

describe('findEocd', () => {
  it('从尾部反向扫出 EOCD', () => {
    const eocd = findEocd(makeEocd({ entries: 7, cdSize: 123, cdOffset: 456 }));
    expect(eocd.entryCount).toBe(7);
    expect(eocd.centralDirectorySize).toBe(123);
    expect(eocd.centralDirectoryOffset).toBe(456);
  });

  it('EOCD 带注释也能找到（真实 zip 允许，注释长度字段会自洽）', () => {
    const buf = makeEocd({ entries: 2, comment: 'trailing comment here' });
    expect(findEocd(buf).entryCount).toBe(2);
  });

  it('数据段里碰巧出现同样签名时不会被误判（注释长度对不上 ⇒ 继续往前找）', () => {
    // 造一个「假 EOCD」：签名对但注释长度与缓冲区末尾对不上，
    // 后面跟着真 EOCD。解析器必须跳过假的、命中真的。
    const fake = Buffer.concat([u32(0x06054b50), Buffer.alloc(18, 0xff)]);
    const real = makeEocd({ entries: 3 });
    expect(findEocd(Buffer.concat([fake, real])).entryCount).toBe(3);
  });

  it('没有 EOCD ⇒ 报错（不是一个 zip）', () => {
    expect(() => findEocd(Buffer.from('PK\x03\x04 not really a zip'))).toThrow(/EOCD|zip/i);
  });

  it('分卷 zip（磁盘号非 0）⇒ 拒绝', () => {
    expect(() => findEocd(makeEocd({ disk: 2 }))).toThrow(/分卷|multi|disk/i);
  });
});

describe('parseCentralDirectory', () => {
  it('按顺序解析多个条目，名字与字段都对', () => {
    const cd = Buffer.concat([
      makeCentralEntry({ name: 'node_modules/', method: 0, compressedSize: 0, uncompressedSize: 0 }),
      makeCentralEntry({ name: 'node_modules/openclaw/openclaw.mjs', crc: 0xaabbccdd, compressedSize: 5 }),
    ]);
    const entries = parseCentralDirectory(cd);
    expect(entries.map((e) => e.name)).toEqual(['node_modules/', 'node_modules/openclaw/openclaw.mjs']);
    expect(entries[0].isDirectory).toBe(true); // 尾斜杠
    expect(entries[1].isDirectory).toBe(false);
    expect(entries[1].crc32).toBe(0xaabbccdd);
    expect(entries[1].compressionMethod).toBe(8);
  });

  it('目录也认 externalAttrs 的 DOS 目录位（尾斜杠与属性位在本包里永远一致，两条路都要对）', () => {
    const cd = makeCentralEntry({ name: 'some-dir', externalAttrs: 0x10, method: 0 });
    expect(parseCentralDirectory(cd)[0].isDirectory).toBe(true);
  });

  it('截断的中央目录 ⇒ 报错而不是静默少解析', () => {
    const cd = makeCentralEntry({ name: 'a.txt' });
    expect(() => parseCentralDirectory(cd.subarray(0, 20))).toThrow();
  });
});

describe('parseLocalHeader', () => {
  it('⭐ dataOffset 用的是**本地头自己的** extraLen（本包里它与 CD 的不同）', () => {
    const name = 'node_modules/.bin/acorn';
    const extra = Buffer.alloc(36); // 故意给一段 extra，模拟与 CD 不同的情况
    const header = makeLocalHeader({ name, extra });
    const info = parseLocalHeader(header);
    expect(info.nameLength).toBe(Buffer.byteLength(name));
    expect(info.extraLength).toBe(36);
    expect(info.dataOffset).toBe(30 + Buffer.byteLength(name) + 36);
  });

  it('没有 extra 时 dataOffset = 30 + 名字长度', () => {
    const info = parseLocalHeader(makeLocalHeader({ name: 'a.txt' }));
    expect(info.dataOffset).toBe(30 + 5);
  });

  it('签名不对 ⇒ 报错', () => {
    expect(() => parseLocalHeader(Buffer.alloc(30))).toThrow();
  });
});

describe('dosDateTimeToDate', () => {
  it('解出正确的年月日时分秒（本包实测值：0x5d2b / 0xaf1d → 2026-09-11 21:56:58）', () => {
    const d = dosDateTimeToDate(0x5d2b, 0xaf1d);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth() + 1).toBe(9);
    expect(d.getDate()).toBe(11);
    expect(d.getHours()).toBe(21);
    expect(d.getMinutes()).toBe(56);
    expect(d.getSeconds()).toBe(58);
  });

  it('DOS 的 0 值不炸（会得到 1980 起点，不是 Invalid Date）', () => {
    const d = dosDateTimeToDate(0, 0);
    expect(Number.isNaN(d.getTime())).toBe(false);
    expect(d.getFullYear()).toBe(1980);
  });
});

describe('isSafeEntryName', () => {
  it.each(['node_modules/openclaw/openclaw.mjs', 'node_modules/.bin/acorn', 'a.txt', 'deep/nested/path/to/file.js'])(
    '放行正常路径：%s',
    (n) => {
      expect(isSafeEntryName(n)).toBe(true);
    },
  );

  it.each([
    ['父目录穿越', '../evil.txt'],
    ['深一点的穿越', 'a/../../evil.txt'],
    ['Windows 反斜杠穿越', '..\\evil.txt'],
    ['混合分隔符穿越', 'a/..\\../evil.txt'],
    ['绝对路径', '/etc/passwd'],
    ['Windows 盘符', 'C:/Windows/System32/x.dll'],
    ['盘符（反斜杠）', 'C:\\Windows\\x.dll'],
    ['UNC 路径', '//server/share/x'],
    ['裸 ..', '..'],
    ['空名', ''],
    ['NUL 字节', 'a\u0000b'],
  ])('拒绝：%s（%s）', (_label, n) => {
    expect(isSafeEntryName(n)).toBe(false);
  });

  it('`a..b/c` 这种含点但不成段的要放行（别过度拦截）', () => {
    expect(isSafeEntryName('a..b/c.txt')).toBe(true);
  });
});

describe('crc32', () => {
  it('公开测试向量：crc32("123456789") === 0xCBF43926', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('空输入 ⇒ 0', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('⭐ 支持增量累加：分块算与一次算结果相同（流式解压要靠这条）', () => {
    const data = Buffer.from('the quick brown fox jumps over the lazy dog');
    const whole = crc32(data);
    let running = 0;
    for (let i = 0; i < data.length; i += 7) {
      running = crc32(data.subarray(i, Math.min(i + 7, data.length)), running);
    }
    expect(running).toBe(whole);
  });
});
