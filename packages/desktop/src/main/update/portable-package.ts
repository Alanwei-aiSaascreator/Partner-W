import { createHash } from 'node:crypto';
// ⚠️ `statfs` 走 `node:fs/promises` 就够（量的是卷根，路径里没有 `.asar`）；
//    其余**全部**走 asar 安全的那份 —— 见下面那段与 `asar-safe-fs.ts`。
import { statfs } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import type { PortableUpdateFileManifestV1 } from '@clawwork/shared';
import { asarSafeFs } from './asar-safe-fs.js';
import { PortableUpdateFailure } from './portable-manifest.js';

/**
 * ⚠️ **解压与校验这条路必须用 asar 安全的那份 fs**（2026-09-25 真机验收，发版阻断级）。
 *
 * Electron 的 `fs` 会把路径里的 `.asar` 段当成"只读的虚拟归档"，而我们的包里**就有**
 * `resources/app.asar` 与整棵 `resources/app.asar.unpacked/` ⇒ 解压写到那一步必炸
 * （真机原始报错 `failed to initialize archive` / `Invalid package …\resources\app.asar`）。
 * 纯 Node（单测、我的排障脚本）没有那个补丁，所以本地怎么跑都是好的。
 * 细节与为什么不用 `process.noAsar` 见 `asar-safe-fs.ts`。
 */
const { mkdir, open, readdir, rename, rm, stat } = asarSafeFs.promises;
const { createReadStream, createWriteStream } = asarSafeFs;

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

/**
 * 把底层 fs 错误映射成**用户看得懂的那一类**。
 *
 * ⚠️ 兜底以前是 `unsafeArchive()`（`archive-unsafe`）—— 那是在**冤枉这份包**：
 *    写失败、exFAT 命名限制、半途断电留下的残留都会落到这里，而用户看到的会是
 *    "更新包里有不安全的内容"。于是他要做的（重试一次 / 换台电脑试）与真正该做的
 *    （去查那块盘）完全对不上。现在兜底是 `filesystem-error`，
 *    **与"空间不足"分开**：清空间解决不了写失败。
 */
export function mapFileSystemFailure(error: unknown): PortableUpdateFailure {
  if (error instanceof PortableUpdateFailure) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOSPC') return new PortableUpdateFailure('disk-space');
  if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
    return new PortableUpdateFailure('volume-readonly');
  }
  if (code === 'EBUSY') return new PortableUpdateFailure('file-in-use');
  return new PortableUpdateFailure('filesystem-error');
}

/**
 * 取一次 feed 资源，**把"连不上"归类**。
 *
 * `fetch` 失败时抛的是 undici 的 `TypeError: fetch failed`（真因在 `.cause` 里）——
 * 它既不是 `PortableUpdateFailure`，也不是我们代码里造的 `Error`，
 * 服务那边 `toErrorCode` 只能给 `unknown` ⇒ 用户看到"未知错误"、**没有任何下一步**。
 * 而词表里本来就有 `network`（"连不上/超时 —— **可以重试**"）。
 *
 * ⚠️ 2026-09-25 真机验收：盘上 0.0.28 走这条路时先炸在空间检查（见 `downloadPortablePackage`），
 * 修掉之后**这一层**就是下一个会裸奔的地方 —— 所以这里一并钉住。
 */
export async function fetchFeedResponse(url: string): Promise<Response> {
  try {
    // ⚠️ **`cache: 'no-store'` 不是优化，是修 bug**：清单响应只有 `ETag`/`Last-Modified`、
    //    没有 `Cache-Control`，而主进程的 `fetch` 走 Chromium 缓存 ⇒ 启发式新鲜度会把
    //    **旧清单继续当新鲜用**。真机形状：同一个进程里重复点「检查更新」，
    //    服务器访问日志里**零请求**，却报「已是最新版本」；重启进程立刻就能看到新版。
    return await fetch(url, { cache: 'no-store' });
  } catch {
    throw new PortableUpdateFailure('network');
  }
}

/**
 * 读一次 feed 的 JSON 正文：**非 JSON ⇒ `feed-response`**。
 *
 * 网关塞回来的 HTML 错误页、被截断的正文都会让 `response.json()` 抛 `SyntaxError`
 * —— 同样不是 `PortableUpdateFailure` ⇒ 同样会掉进 `unknown`。
 */
export async function readFeedJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PortableUpdateFailure('feed-response');
  }
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
  let space: { bavail: number; bsize: number };
  try {
    space = await input.statfsImpl(input.target);
  } catch (error) {
    // ⚠️ `statfs` **自己**失败不是"空间不足"：量不出来就说这块盘读不了。
    //    裸抛的话它是个普通 `Error`，服务那边 `toErrorCode` 只能给 `unknown`
    //    ⇒ 用户看到的是"未知错误"、**没有任何下一步**（2026-09-25 真机验收实测：
    //    `statfs` 一个还没建出来的事务目录 ⇒ ENOENT ⇒ 报成 unknown）。
    throw mapFileSystemFailure(error);
  }
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
  // ⚠️ **先 mkdir 再 statfs**（2026-09-25 真机验收抓到的发版阻断级缺陷）。
  //    真机上的目标是 `<盘根>\.荣盈魔方更新\<事务 id>\download\portable.zip`，
  //    而全新的一块盘上**这棵树还不存在**；`fs.statfs` 一个不存在的路径在 Windows 上
  //    抛 ENOENT ⇒ 空间检查先炸 ⇒ **连 zip 都不去取**，用户看到"未知错误"。
  //    ⇒ 盘上的 0.0.28 **永远升不上来**（下载动作是盘上那个版本在跑，签名/频道/版本号全都无关）。
  //    隔壁 `extractPortablePackage` 早就踩过并修了（那里注释写着同一个坑），下载这条路漏了。
  await mkdir(dirname(input.destinationPart), { recursive: true });
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
    // 同一类问题：406 MB 不该落进 HTTP 缓存。清单那处错了是**静默**用旧的；
    // 这处错了至少会被 sha256 事后炸出来 —— 但两份都不该进缓存。
    const response = await fetch(input.url, { signal: input.signal, cache: 'no-store' });
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
