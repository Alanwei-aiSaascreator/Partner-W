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

export async function downloadPortablePackage(input: {
  url: string;
  destinationPart: string;
  expectedSize: number;
  expectedSha256: string;
  signal: AbortSignal;
  onProgress: (transferred: number, total: number) => void;
}): Promise<void> {
  const space = await statfs(dirname(input.destinationPart));
  const available = space.bavail * space.bsize;
  if (!Number.isSafeInteger(input.expectedSize) || available < input.expectedSize) {
    throw new PortableUpdateFailure('disk-space');
  }

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
}): Promise<{ programRoot: string }> {
  const extractRoot = join(input.temporaryRoot, 'extract');
  const programRoot = join(input.temporaryRoot, 'program');

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
