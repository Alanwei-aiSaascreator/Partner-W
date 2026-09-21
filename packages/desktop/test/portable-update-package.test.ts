import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortableUpdateFileManifestV1 } from '@clawwork/shared';
import { PortableUpdateFailure } from '../src/main/update/portable-manifest.js';
import {
  calculatePortableSpaceBudget,
  downloadPortablePackage,
  extractPortablePackage,
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
