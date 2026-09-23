import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortableUpdateFileManifestV1 } from '@clawwork/shared';
import { PortableUpdateFailure } from '../src/main/update/portable-manifest.js';
import {
  calculatePortableSpaceBudget,
  downloadPortablePackage,
  mapFileSystemFailure,
  extractPortablePackage,
  sumExpandedBytes,
  verifyPortableProgramTree,
} from '../src/main/update/portable-package.js';

interface ZipEntryFixture {
  name: string;
  content?: string | Buffer;
  mode?: number;
  directory?: boolean;
}

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mofang-portable-package-'));
  roots.push(root);
  return root;
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: ZipEntryFixture[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const fixture of entries) {
    const name = Buffer.from(fixture.name, 'utf8');
    const content = fixture.directory
      ? Buffer.alloc(0)
      : Buffer.isBuffer(fixture.content)
        ? fixture.content
        : Buffer.from(fixture.content ?? '', 'utf8');
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = fixture.mode ?? (fixture.directory ? 0o040755 : 0o100644);
    central.writeUInt32LE(((mode << 16) | (fixture.directory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileManifest(files: Array<{ path: string; content: string | Buffer }>): PortableUpdateFileManifestV1 {
  return {
    schemaVersion: 1,
    version: '0.0.26',
    files: files.map(({ path, content }) => ({
      path,
      size: Buffer.byteLength(content),
      sha256: sha256(content),
    })),
  };
}

async function writeZip(root: string, entries: ZipEntryFixture[]): Promise<string> {
  const archivePath = join(root, 'update.zip');
  await writeFile(archivePath, createZip(entries));
  return archivePath;
}

function expectFailure(error: unknown, code: PortableUpdateFailure['code']): void {
  expect(error).toBeInstanceOf(PortableUpdateFailure);
  expect(error).toMatchObject({ code });
}

describe('portable package space and download', () => {
  it('calculates package, expanded tree, backup, and safety headroom', async () => {
    await expect(
      calculatePortableSpaceBudget({ packageSize: 100, expandedSize: 400, currentProgramSize: 300 }),
    ).resolves.toBe(100 + 400 + 300 + 64 * 1024 * 1024);
  });

  it('rejects an insufficient destination before starting fetch', async () => {
    const root = await makeRoot();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadPortablePackage({
        url: 'https://example.com/update.zip',
        destinationPart: join(root, 'update.part'),
        expectedSize: Number.MAX_SAFE_INTEGER,
        requiredFreeBytes: Number.MAX_SAFE_INTEGER,
        expectedSha256: 'a'.repeat(64),
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'disk-space' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams bytes, reports progress, and verifies size plus SHA-256', async () => {
    const root = await makeRoot();
    const destinationPart = join(root, 'update.part');
    const bytes = Buffer.from('portable-update-payload');
    const progress: Array<[number, number]> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 8));
                controller.enqueue(bytes.subarray(8));
                controller.close();
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await downloadPortablePackage({
      url: 'https://example.com/update.zip',
      destinationPart,
      expectedSize: bytes.length,
      expectedSha256: sha256(bytes),
      requiredFreeBytes: 1,
      signal: new AbortController().signal,
      onProgress: (transferred, total) => progress.push([transferred, total]),
    });

    expect(await readFile(destinationPart)).toEqual(bytes);
    expect(progress).toEqual([
      [8, bytes.length],
      [bytes.length, bytes.length],
    ]);
  });

  it('cancels a streaming download and removes the partial file', async () => {
    const root = await makeRoot();
    const destinationPart = join(root, 'update.part');
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(Buffer.from('first'));
                stream.enqueue(Buffer.from('second'));
                stream.close();
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      downloadPortablePackage({
        url: 'https://example.com/update.zip',
        destinationPart,
        expectedSize: 11,
        expectedSha256: sha256('firstsecond'),
        requiredFreeBytes: 1,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await expect(stat(destinationPart)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['byte count', 99, sha256('payload')],
    ['SHA-256', 7, 'a'.repeat(64)],
  ])('rejects a wrong %s and removes the partial file', async (_name, expectedSize, expectedHash) => {
    const root = await makeRoot();
    const destinationPart = join(root, 'update.part');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('payload', { status: 200 })),
    );

    await expect(
      downloadPortablePackage({
        url: 'https://example.com/update.zip',
        destinationPart,
        expectedSize,
        expectedSha256: expectedHash,
        requiredFreeBytes: 1,
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'package-integrity' });
    await expect(stat(destinationPart)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('portable ZIP extraction safety', () => {
  it.each([
    ['absolute POSIX path', '/escape.txt'],
    ['parent traversal', '../escape.txt'],
    ['drive path', 'C:/escape.txt'],
    ['UNC path', '\\\\server\\share\\escape.txt'],
    ['Windows device name', 'app/CON.txt'],
    ['forbidden data sibling', '\u8363\u76c8\u9b54\u65b9-\u8fd0\u884c\u6570\u636e/secret.txt'],
    ['forbidden workspace sibling', '\u8363\u76c8\u9b54\u65b9\u5de5\u4f5c\u533a/secret.txt'],
    ['forbidden update sibling', '.\u8363\u76c8\u9b54\u65b9\u66f4\u65b0/state.json'],
    ['forbidden launcher sibling', '\u8363\u76c8\u9b54\u65b9\u542f\u52a8\u5668.exe'],
  ])('rejects %s before creating a promoted program tree', async (_name, path) => {
    const root = await makeRoot();
    const archivePath = await writeZip(root, [{ name: path, content: 'unsafe' }]);
    const temporaryRoot = join(root, 'transaction');

    await expect(
      extractPortablePackage({
        archivePath,
        temporaryRoot,
        fileManifest: fileManifest([{ path: 'app/safe.txt', content: 'safe' }]),
        requiredFreeBytes: 1,
      }),
    ).rejects.toMatchObject({ code: 'archive-unsafe' });
    await expect(stat(join(temporaryRoot, 'program'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    [
      'duplicate normalized path',
      [
        { name: 'app\\same.txt', content: 'one' },
        { name: 'app/same.txt', content: 'two' },
      ],
    ],
    [
      'case collision',
      [
        { name: 'app/File.txt', content: 'one' },
        { name: 'app/file.txt', content: 'two' },
      ],
    ],
  ])('rejects a %s', async (_name, entries) => {
    const root = await makeRoot();
    const archivePath = await writeZip(root, entries);

    await expect(
      extractPortablePackage({
        archivePath,
        temporaryRoot: join(root, 'transaction'),
        fileManifest: fileManifest([{ path: 'app/same.txt', content: 'one' }]),
        requiredFreeBytes: 1,
      }),
    ).rejects.toMatchObject({ code: 'archive-unsafe' });
  });

  it('rejects a Unix symlink entry', async () => {
    const root = await makeRoot();
    const archivePath = await writeZip(root, [{ name: 'app/link', content: 'target.txt', mode: 0o120777 }]);

    await expect(
      extractPortablePackage({
        archivePath,
        temporaryRoot: join(root, 'transaction'),
        fileManifest: fileManifest([{ path: 'app/link', content: 'target.txt' }]),
        requiredFreeBytes: 1,
      }),
    ).rejects.toMatchObject({ code: 'archive-unsafe' });
  });

  it('extracts and promotes only an exact verified program tree', async () => {
    const root = await makeRoot();
    const files = [
      { path: '\u8363\u76c8\u9b54\u65b9.exe', content: 'binary' },
      { path: 'resources/app.asar', content: 'asar' },
      { path: 'resources/runtime/node.exe', content: 'node' },
    ];
    const archivePath = await writeZip(root, [
      { name: 'resources/', directory: true },
      ...files.map(({ path, content }) => ({ name: path, content })),
    ]);

    const result = await extractPortablePackage({
      archivePath,
      temporaryRoot: join(root, 'transaction'),
      fileManifest: fileManifest(files),
      requiredFreeBytes: 1,
    });

    expect(await readFile(join(result.programRoot, 'resources', 'app.asar'), 'utf8')).toBe('asar');
    await expect(
      verifyPortableProgramTree({ programRoot: result.programRoot, fileManifest: fileManifest(files) }),
    ).resolves.toBeUndefined();
  });

  it('leaves protected data and workspace siblings byte-identical after extraction failure', async () => {
    const root = await makeRoot();
    const dataFile = join(root, '\u8363\u76c8\u9b54\u65b9-\u8fd0\u884c\u6570\u636e', 'keep.bin');
    const workspaceFile = join(root, '\u8363\u76c8\u9b54\u65b9\u5de5\u4f5c\u533a', 'keep.bin');
    await mkdir(dirname(dataFile), { recursive: true });
    await mkdir(dirname(workspaceFile), { recursive: true });
    await writeFile(dataFile, 'data-sentinel');
    await writeFile(workspaceFile, 'workspace-sentinel');
    const before = [sha256(await readFile(dataFile)), sha256(await readFile(workspaceFile))];
    const archivePath = await writeZip(root, [{ name: '../escape.txt', content: 'unsafe' }]);

    await extractPortablePackage({
      archivePath,
      temporaryRoot: join(root, '.\u8363\u76c8\u9b54\u65b9\u66f4\u65b0', 'staged', 'txn'),
      fileManifest: fileManifest([{ path: 'safe.txt', content: 'safe' }]),
      requiredFreeBytes: 1,
    }).catch((error: unknown) => expectFailure(error, 'archive-unsafe'));

    expect([sha256(await readFile(dataFile)), sha256(await readFile(workspaceFile))]).toEqual(before);
  });
});

describe('portable program exact-tree verification', () => {
  async function makeProgram(files: Array<{ path: string; content: string }>): Promise<string> {
    const root = await makeRoot();
    const programRoot = join(root, 'program');
    for (const file of files) {
      const target = join(programRoot, ...file.path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    return programRoot;
  }

  it('rejects a missing file', async () => {
    const programRoot = await makeProgram([{ path: 'app/a.txt', content: 'a' }]);
    const manifest = fileManifest([
      { path: 'app/a.txt', content: 'a' },
      { path: 'app/b.txt', content: 'b' },
    ]);

    await expect(verifyPortableProgramTree({ programRoot, fileManifest: manifest })).rejects.toMatchObject({
      code: 'file-integrity',
    });
  });

  it('rejects extra files not in the signed file manifest', async () => {
    const programRoot = await makeProgram([
      { path: 'app/a.txt', content: 'a' },
      { path: 'app/extra.txt', content: 'extra' },
    ]);
    const manifest = fileManifest([{ path: 'app/a.txt', content: 'a' }]);

    await expect(verifyPortableProgramTree({ programRoot, fileManifest: manifest })).rejects.toMatchObject({
      code: 'file-integrity',
    });
  });

  it.each([
    ['wrong size', 'changed-size', sha256('changed-size')],
    ['wrong hash', 'b', sha256('a')],
  ])('rejects a file with %s', async (_name, content, manifestHash) => {
    const programRoot = await makeProgram([{ path: 'app/a.txt', content }]);
    const manifest: PortableUpdateFileManifestV1 = {
      schemaVersion: 1,
      version: '0.0.26',
      files: [{ path: 'app/a.txt', size: _name === 'wrong size' ? 1 : 1, sha256: manifestHash }],
    };

    await expect(verifyPortableProgramTree({ programRoot, fileManifest: manifest })).rejects.toMatchObject({
      code: 'file-integrity',
    });
  });
});

/**
 * 空间预算必须**接在真正的写盘路径上**（下载 + 解压两处），而不是只算出来没人调用。
 *
 * 背景（2026-09-23 取证）：`calculatePortableSpaceBudget` 生产零调用（只有它自己的单测），
 * 下载侧只比 `available < expectedSize`（= **zip 大小**），解压侧**完全没有检查** ——
 * 而真正吃空间的是解压后的整棵程序树（几万个文件）。于是盘会在**解压中途**满，
 * 用户看到的是半途失败 + 一句没有数字的"空间不足"。
 *
 * `statfsImpl` 是注入点：不必真把一块盘写满就能造出"盘要满了"。
 */
describe('portable space budget is wired into the real write paths', () => {
  /** 造一个"只剩 1000 字节"的卷。 */
  const nearlyFull = async (): Promise<{ bavail: number; bsize: number }> => ({ bavail: 1, bsize: 1000 });

  it('⭐ 下载：预算不够就拒绝（**即使 zip 本身放得下**），并带上"需要多少/剩多少"', async () => {
    const root = await makeRoot();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadPortablePackage({
        url: 'https://example.com/update.zip',
        destinationPart: join(root, 'update.part'),
        // zip 只有 100 字节，1000 字节的空闲**放得下包体** —— 以前这一步就放行了。
        expectedSize: 100,
        // 但整份预算（包体 + 解压后 + 现有程序 + 余量）要 5000。
        requiredFreeBytes: 5_000,
        expectedSha256: 'a'.repeat(64),
        signal: new AbortController().signal,
        onProgress: vi.fn(),
        statfsImpl: nearlyFull,
      }),
    ).rejects.toMatchObject({ code: 'disk-space', detail: { requiredBytes: 5_000, availableBytes: 1_000 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('⭐ 解压：预算不够就拒绝，且**一个文件都不写**（以前这里没有任何检查）', async () => {
    const root = await makeRoot();
    const archivePath = await writeZip(root, [{ name: 'app/ok.txt', content: 'ok' }]);
    const temporaryRoot = join(root, 'transaction');

    await expect(
      extractPortablePackage({
        archivePath,
        temporaryRoot,
        fileManifest: fileManifest([{ path: 'app/ok.txt', content: 'ok' }]),
        requiredFreeBytes: 5_000,
        statfsImpl: nearlyFull,
      }),
    ).rejects.toMatchObject({ code: 'disk-space', detail: { requiredBytes: 5_000, availableBytes: 1_000 } });

    expect(existsSync(join(temporaryRoot, 'extract'))).toBe(false);
    expect(existsSync(join(temporaryRoot, 'program'))).toBe(false);
  });

  it('预算放得下时照常通过（这道门不是无条件拒绝）', async () => {
    const root = await makeRoot();
    const archivePath = await writeZip(root, [{ name: 'app/ok.txt', content: 'ok' }]);
    const temporaryRoot = join(root, 'transaction');

    const result = await extractPortablePackage({
      archivePath,
      temporaryRoot,
      fileManifest: fileManifest([{ path: 'app/ok.txt', content: 'ok' }]),
      requiredFreeBytes: 1,
      statfsImpl: nearlyFull,
    });

    expect(existsSync(join(result.programRoot, 'app', 'ok.txt'))).toBe(true);
  });

  it('空间预算的三项相加 + 余量（公式本身就是这条）', async () => {
    await expect(
      calculatePortableSpaceBudget({ packageSize: 1, expandedSize: 2, currentProgramSize: 3 }),
    ).resolves.toBe(6 + 64 * 1024 * 1024);
  });

  it('展开体积只认签名清单里的 size 之和（manifest 不许加 expandedSize 字段）', () => {
    const manifest = fileManifest([
      { path: 'a.exe', content: 'aaaa' },
      { path: 'sub/b.txt', content: 'bb' },
    ]);

    expect(sumExpandedBytes(manifest)).toBe(manifest.files.reduce((total, file) => total + file.size, 0));
    expect(sumExpandedBytes(manifest)).toBe(6);
  });
});

describe('space failure detail stays minimal', () => {
  it('⭐ 空间失败只多带两个**数字**（不许夹带路径/URL/令牌）', async () => {
    const root = await makeRoot();

    const error = await downloadPortablePackage({
      url: 'https://example.com/update.zip',
      destinationPart: join(root, 'update.part'),
      expectedSize: 1,
      requiredFreeBytes: 5_000,
      expectedSha256: 'a'.repeat(64),
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      statfsImpl: async () => ({ bavail: 1, bsize: 1000 }),
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PortableUpdateFailure);
    // 形状是刻意的：多出来的只有字节数。manifest 那条"失败只有 code/name"的
    // 测试挡的是"失败里夹带路径/令牌"，这里把"放宽的那部分"钉死成纯数字。
    expect(Object.keys(error as object).sort()).toEqual(['code', 'detail', 'name']);
    const detail = (error as PortableUpdateFailure).detail ?? {};
    expect(Object.keys(detail).sort()).toEqual(['availableBytes', 'requiredBytes']);
    for (const value of Object.values(detail)) expect(typeof value).toBe('number');
  });

  it('不带数字的失败**没有** detail 这个属性（老形状不变）', () => {
    const error = new PortableUpdateFailure('network');

    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
    expect(error.detail).toBeUndefined();
  });
});

/**
 * 底层 fs 失败 → **用户看得懂的那一类**。
 *
 * 兜底以前是 `archive-unsafe`（"更新包里有不安全的内容"）—— 那是在**冤枉这份包**：
 * 写失败、exFAT 命名限制、半途断电的残留都会落到兜底，而用户该做的事
 * （重试一次 / 换台电脑试）与"包被人动过手脚"完全不同。
 */
describe('filesystem failures are classified, not blamed on the package', () => {
  const errno = (code: string): Error => Object.assign(new Error(code), { code });

  it.each([
    ['ENOSPC', 'disk-space'],
    ['EROFS', 'volume-readonly'],
    ['EACCES', 'volume-readonly'],
    ['EPERM', 'volume-readonly'],
    ['EBUSY', 'file-in-use'],
  ])('%s ⇒ %s（这些是**有名字的**几类）', (code, expected) => {
    expect(mapFileSystemFailure(errno(code))).toMatchObject({ code: expected });
  });

  it.each([['EISDIR'], ['EEXIST'], ['EINVAL'], ['ENAMETOOLONG'], ['EPIPE'], ['UNKNOWN']])(
    '⭐ %s ⇒ filesystem-error（**不是** archive-unsafe：别把写失败说成"包不安全"）',
    (code) => {
      const failure = mapFileSystemFailure(errno(code));

      expect(failure).toMatchObject({ code: 'filesystem-error' });
      expect(failure.code).not.toBe('archive-unsafe');
      expect(failure.code).not.toBe('disk-space');
    },
  );

  it('已经是 PortableUpdateFailure 的原样透传（不重复归类）', () => {
    const original = new PortableUpdateFailure('signature-invalid');

    expect(mapFileSystemFailure(original)).toBe(original);
  });

  it('没有 code 的异常也走 filesystem-error（兜底有名字，别丢成 unknown）', () => {
    expect(mapFileSystemFailure(new Error('boom'))).toMatchObject({ code: 'filesystem-error' });
  });
});
