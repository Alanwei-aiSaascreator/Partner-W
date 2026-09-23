import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import type { PortableUpdateFileManifestV1 } from '@clawwork/shared';
import { PortableUpdateFailure } from './portable-manifest.js';

const SPACE_HEADROOM_BYTES = 64 * 1024 * 1024;
const UNIX_TYPE_MASK = 0xf000;
const UNIX_REGULAR_FILE = 0x8000;
const UNIX_DIRECTORY = 0x4000;
const DEVICE_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

const FORBIDDEN_SIBLINGS = new Set([
  '\u8363\u76c8\u9b54\u65b9-\u8fd0\u884c\u6570\u636e',
  '\u8363\u76c8\u9b54\u65b9\u5de5\u4f5c\u533a',
  '.\u8363\u76c8\u9b54\u65b9\u66f4\u65b0',
  '\u8363\u76c8\u9b54\u65b9\u542f\u52a8\u5668.exe',
]);

interface ValidatedEntry {
  entry: Entry;
  relativePath: string;
  isDirectory: boolean;
}

function unsafeArchive(): PortableUpdateFailure {
  return new PortableUpdateFailure('archive-unsafe');
}

function collisionKey(relativePath: string): string {
  return relativePath
    .split('\\')
    .map((segment) => segment.replace(/[ .]+$/, '').toLowerCase())
    .join('\\');
}

function normalizeRelativePath(rawName: string): string {
  const trimmed = rawName.replace(/[/\\]+$/, '');
  if (trimmed.length === 0 || trimmed.includes('\u0000')) throw unsafeArchive();
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) throw unsafeArchive();
  if (/^[A-Za-z]:/.test(trimmed)) throw unsafeArchive();
  if (win32.isAbsolute(trimmed)) throw unsafeArchive();

  const normalized = win32.normalize(trimmed);
  if (normalized.length === 0 || normalized === '.' || normalized === '..') throw unsafeArchive();
  if (win32.isAbsolute(normalized)) throw unsafeArchive();
  if (normalized.startsWith('..\\')) throw unsafeArchive();

  const segments = normalized.split('\\');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') throw unsafeArchive();
    const stem = segment.split('.')[0] ?? '';
    if (DEVICE_NAME_PATTERN.test(stem)) throw unsafeArchive();
  }
  if (FORBIDDEN_SIBLINGS.has((segments[0] ?? '').toLowerCase())) throw unsafeArchive();
  return normalized;
}

function openZipFile(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false, decodeStrings: false }, (error, zipfile) => {
      if (error || zipfile === undefined) reject(new PortableUpdateFailure('package-integrity'));
      else resolve(zipfile);
    });
  });
}

function decodeEntryName(entry: Entry): string {
  const isUtf8 = (entry.generalPurposeBitFlag & 0x800) !== 0;
  return entry.fileNameRaw.toString(isUtf8 ? 'utf8' : 'latin1');
}

function collectEntries(zipfile: ZipFile): Promise<ValidatedEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ValidatedEntry[] = [];
    const seen = new Set<string>();

    zipfile.on('entry', (entry: Entry) => {
      try {
        const rawName = decodeEntryName(entry);
        const relativePath = normalizeRelativePath(rawName);
        const unixType = (entry.externalFileAttributes >>> 16) & UNIX_TYPE_MASK;
        if (unixType !== 0 && unixType !== UNIX_REGULAR_FILE && unixType !== UNIX_DIRECTORY) {
          throw unsafeArchive();
        }
        const key = collisionKey(relativePath);
        if (seen.has(key)) throw unsafeArchive();
        seen.add(key);
        entries.push({
          entry,
          relativePath,
          isDirectory: rawName.endsWith('/') || unixType === UNIX_DIRECTORY,
        });
        zipfile.readEntry();
      } catch (error) {
        reject(error);
      }
    });

    zipfile.on('end', () => resolve(entries));
    zipfile.on('error', () => reject(new PortableUpdateFailure('package-integrity')));
    zipfile.readEntry();
  });
}

function openEntryStream(zipfile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || stream === undefined) reject(new PortableUpdateFailure('package-integrity'));
      else resolve(stream);
    });
  });
}

async function writeEntries(zipfile: ZipFile, entries: ValidatedEntry[], extractRoot: string): Promise<void> {
  for (const item of entries) {
    const target = join(extractRoot, item.relativePath);
    if (item.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const stream = await openEntryStream(zipfile, item.entry);
    await pipeline(stream, createWriteStream(target, { flags: 'wx' }));
  }
}

function mapFileSystemFailure(error: unknown): PortableUpdateFailure {
  if (error instanceof PortableUpdateFailure) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOSPC') return new PortableUpdateFailure('disk-space');
  if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
    return new PortableUpdateFailure('volume-readonly');
  }
  if (code === 'EBUSY') return new PortableUpdateFailure('file-in-use');
  return unsafeArchive();
}

async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(absolutePath), hash);
  return hash.digest('hex');
}

async function collectTreeFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walk(directory: string, prefix: string): Promise<void> {
    const items = await readdir(directory, { withFileTypes: true });
    for (const item of items) {
      const relativePath = prefix.length === 0 ? item.name : `${prefix}\\${item.name}`;
      const absolutePath = join(directory, item.name);
      if (item.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!item.isFile()) throw new PortableUpdateFailure('file-integrity');
      files.set(collisionKey(relativePath), absolutePath);
    }
  }

  await walk(root, '');
  return files;
}

export async function calculatePortableSpaceBudget(input: {
  packageSize: number;
  expandedSize: number;
  currentProgramSize: number;
}): Promise<number> {
  return input.packageSize + input.expandedSize + input.currentProgramSize + SPACE_HEADROOM_BYTES;
}

/**
 * 解压后会占多大 —— **只能用签名过的 `portable-files.json` 算**：
 * manifest 的键集被三层冻死（TS 精确键集 + Go `DisallowUnknownFields` + 签名负载逐键枚举），
 * 加一个 `expandedSize` 会让**已出厂的启动器**验签失败。
 * 每个 entry 都带 `size`，把它们加起来就是展开体积（目录不在清单里，只算文件）。
 */
export function sumExpandedBytes(fileManifest: PortableUpdateFileManifestV1): number {
  let total = 0;
  for (const file of fileManifest.files) total += file.size;
  return total;
}

/** 注入点：默认 `fs/promises` 的 `statfs`；单测用来造"盘快满了"，不必真写满一块盘。 */
export type StatfsLike = (target: string) => Promise<{ bavail: number; bsize: number }>;

async function assertFreeBytes(input: {
  target: string;
  requiredFreeBytes: number;
  statfsImpl: StatfsLike;
}): Promise<void> {
  const space = await input.statfsImpl(input.target);
  const available = space.bavail * space.bsize;
  if (!Number.isSafeInteger(input.requiredFreeBytes) || available < input.requiredFreeBytes) {
    throw new PortableUpdateFailure('disk-space', {
      requiredBytes: input.requiredFreeBytes,
      availableBytes: available,
    });
  }
}

export async function downloadPortablePackage(input: {
  url: string;
  destinationPart: string;
  expectedSize: number;
  expectedSha256: string;
  /**
   * 下载前必须空闲的字节数 = `calculatePortableSpaceBudget(...)`。
   * ⚠️ **不是** `expectedSize`：以前这里只比 zip 的大小，而解压后的整棵程序树
   * （几万个文件）才是真正吃空间的那部分，盘会在解压中途才满。
   */
  requiredFreeBytes: number;
  signal: AbortSignal;
  onProgress: (transferred: number, total: number) => void;
  /** 注入点（单测造磁盘满）。 */
  statfsImpl?: StatfsLike;
}): Promise<void> {
  await assertFreeBytes({
    target: dirname(input.destinationPart),
    requiredFreeBytes: input.requiredFreeBytes,
    statfsImpl: input.statfsImpl ?? statfs,
  });

  let handle;
  try {
    handle = await open(input.destinationPart, 'wx');
  } catch (error) {
    throw mapFileSystemFailure(error);
  }

  const hash = createHash('sha256');
  let transferred = 0;
  let failure: PortableUpdateFailure | null = null;

  try {
    const response = await fetch(input.url, { signal: input.signal });
    if (!response.ok || response.body === null) {
      throw new PortableUpdateFailure('network');
    }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (input.signal.aborted) throw new PortableUpdateFailure('cancelled');
      const chunk = Buffer.from(value);
      hash.update(chunk);
      transferred += chunk.length;
      await handle.write(chunk);
      input.onProgress(transferred, input.expectedSize);
    }
    if (input.signal.aborted) throw new PortableUpdateFailure('cancelled');
  } catch (error) {
    failure =
      input.signal.aborted || (error as Error | null)?.name === 'AbortError'
        ? new PortableUpdateFailure('cancelled')
        : error instanceof PortableUpdateFailure
          ? error
          : new PortableUpdateFailure('network');
  } finally {
    await handle.close();
  }

  if (failure === null && (transferred !== input.expectedSize || hash.digest('hex') !== input.expectedSha256)) {
    failure = new PortableUpdateFailure('package-integrity');
  }
  if (failure !== null) {
    await rm(input.destinationPart, { force: true });
    throw failure;
  }
}

/**
 * 走一遍盘上现有程序目录，累加**文件**大小（目录本身不占数据块）。
 *
 * 用处：空间预算里的 `currentProgramSize` —— 换目录之前现有程序一直占着那块盘。
 * 目录不存在（首装/被清理过）按 0 算：那不是错误，只是没东西可算。
 */
export async function measureProgramTreeBytes(programRoot: string): Promise<number> {
  let total = 0;

  async function walk(directory: string): Promise<void> {
    let items;
    try {
      items = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
      throw mapFileSystemFailure(error);
    }
    for (const item of items) {
      const absolutePath = join(directory, item.name);
      if (item.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!item.isFile()) continue;
      try {
        total += (await stat(absolutePath)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue;
        throw mapFileSystemFailure(error);
      }
    }
  }

  await walk(programRoot);
  return total;
}

export async function verifyPortableProgramTree(input: {
  programRoot: string;
  fileManifest: PortableUpdateFileManifestV1;
}): Promise<void> {
  const expected = new Map<string, { size: number; sha256: string }>();
  for (const file of input.fileManifest.files) {
    const relativePath = normalizeRelativePath(file.path);
    const key = collisionKey(relativePath);
    if (expected.has(key)) throw new PortableUpdateFailure('file-integrity');
    expected.set(key, { size: file.size, sha256: file.sha256 });
  }

  const actual = await collectTreeFiles(input.programRoot).catch((error: unknown) => {
    throw mapFileSystemFailure(error);
  });
  if (actual.size !== expected.size) throw new PortableUpdateFailure('file-integrity');

  for (const [key, meta] of expected) {
    const absolutePath = actual.get(key);
    if (absolutePath === undefined) throw new PortableUpdateFailure('file-integrity');
    try {
      const info = await stat(absolutePath);
      if (info.size !== meta.size) throw new PortableUpdateFailure('file-integrity');
      const digest = await hashFile(absolutePath);
      if (digest !== meta.sha256) throw new PortableUpdateFailure('file-integrity');
    } catch (error) {
      if (error instanceof PortableUpdateFailure) throw error;
      throw new PortableUpdateFailure('file-integrity');
    }
  }
}

export async function extractPortablePackage(input: {
  archivePath: string;
  temporaryRoot: string;
  fileManifest: PortableUpdateFileManifestV1;
  /**
   * 解压前必须**额外**空闲的字节数（= 展开体积 + 余量）。
   * 这里**不含**包体与现有程序目录：包那一刻已经躺在同一块盘上（已经占掉了），
   * 现有程序目录也还在原处、要等启动器最后才换 —— 把它们算进"还需要多少"会重复计数。
   */
  requiredFreeBytes: number;
  /** 注入点（单测造磁盘满）。 */
  statfsImpl?: StatfsLike;
}): Promise<{ programRoot: string }> {
  const extractRoot = join(input.temporaryRoot, 'extract');
  const programRoot = join(input.temporaryRoot, 'program');

  // 写盘**之前**先看一眼：这道检查以前完全不存在。
  // 之后写盘途中的 ENOSPC 由 `mapFileSystemFailure` 兜（映射成同一个 disk-space），
  // 所以这里是"早失败 + 带得上数字"，不是唯一一道。
  // ⚠️ 先 mkdir 再 statfs：事务目录此刻可能还不存在，`statfs` 一个不存在的路径会
  //    抛 ENOENT（那不是"空间不足"，也不是这份包的问题）——先建出来，量的才是真卷。
  await mkdir(input.temporaryRoot, { recursive: true });
  await assertFreeBytes({
    target: input.temporaryRoot,
    requiredFreeBytes: input.requiredFreeBytes,
    statfsImpl: input.statfsImpl ?? statfs,
  });

  const zipfile = await openZipFile(input.archivePath);
  try {
    const entries = await collectEntries(zipfile);
    await mkdir(extractRoot, { recursive: true });
    try {
      await writeEntries(zipfile, entries, extractRoot).catch((error: unknown) => {
        throw mapFileSystemFailure(error);
      });
      await verifyPortableProgramTree({ programRoot: extractRoot, fileManifest: input.fileManifest });
      await rm(programRoot, { recursive: true, force: true });
      await rename(extractRoot, programRoot);
    } catch (error) {
      await rm(extractRoot, { recursive: true, force: true });
      throw error;
    }
  } finally {
    zipfile.close();
  }

  return { programRoot };
}
