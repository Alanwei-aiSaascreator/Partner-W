import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ArtifactAvailability, ArtifactRootKind } from '@clawwork/shared';
import { ArtifactTooLargeError } from './too-large.js';

export interface ArtifactFileInspection {
  availability: ArtifactAvailability;
  absolutePath?: string;
}

/**
 * 一个任务能用到的那几个**受信根**。
 *
 * ## 为什么会有第二个根（2026-09-27 真机取证）
 *
 * 产物原先是单一根的：所有 `localPath` 都当作相对**应用工作区**
 * （`<appWorkspace>/<taskId>/…`）。但助手把文件写在**它自己的工作区**里
 * （网关的 `agents.entries.<id>.workspace`：`main` = `<state>/workspace`，
 * 预置助手 = `<appWorkspace>/rongying-agents/<id>`）—— 那与 `<appWorkspace>/<taskId>`
 * 是**兄弟目录**，永不重叠。
 *
 * 结果：助手用 exec 直接生成的文件**从来没有进过产物表**
 * （真机 `.clawwork.db` 实测 `SELECT COUNT(*) FROM artifacts` = **0**，
 * 用户看到的就是"文件在那儿、产物面板空的"）。
 *
 * ⚠️ 把助手工作区认作受信根，**不是**"放开绝对路径"：下面 `openVerifiedArtifactFile`
 *    的五道校验**一条不减**（必须相对、realpath 归一后落在根内、拒符号链接、
 *    dev/ino 强身份、`O_NOFOLLOW` 打开）。变的只是**允许的根**从一个变成两个 ——
 *    而第二个根本来就是**我们自己建的目录**（网关建的，或
 *    `preset-agent-installer.ts:144` 建的）。
 */
export interface ArtifactRoots {
  /** 应用工作区。任务目录与库都在它下面（`db/index.ts:91`）。 */
  workspacePath: string;
  /**
   * 该任务所属**助手的工作区**。
   *
   * ⚠️ `null` = **读不到**（网关没连 / RPC 失败 / agent 没有显式 workspace）
   *    ⇒ 调用方必须当作"**没有这个根**"：不扫、不预览、不打开。
   *    **绝不回落到 `workspacePath`** —— 那会把 `root:'agent'` 的行解析到错误目录，
   *    而出错的方向恰好是"把别的目录的文件当成这个任务的产物"。
   */
  agentWorkspacePath: string | null;
}

/**
 * 某个根的实际目录；`'agent'` 且读不到时回 `null`。
 *
 * ⚠️ 缺省（`undefined`）= `'workspace'`：老行、老 IPC 载荷不改，语义与加这一列之前**逐字相同**。
 */
export function rootDirFor(roots: ArtifactRoots, kind: ArtifactRootKind | undefined): string | null {
  if (kind === 'agent') return roots.agentWorkspacePath;
  return roots.workspacePath;
}

interface ArtifactAccessHooks {
  maxBytes?: number;
  afterSourceOpen?: () => void | Promise<void>;
  writeChunk?: (target: FileHandle, chunk: Buffer, position: number) => Promise<void>;
  publish?: (temporaryPath: string, destinationPath: string) => Promise<void>;
}

interface FileSnapshot {
  /**
   * ⚠️ `dev` / `ino` 存**字符串**，不是 number —— 见 `snapshotOf`。
   * 其余字段保持 number：调用方到处按 number 用（读循环、`hashHandle(size)`）。
   */
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/**
 * 从 **bigint** 的 stat 结果造快照。
 *
 * ## 🔴 为什么必须用 bigint（2026-09-19 查出的偶发失败真因）
 *
 * `ino` 是 **64 位**文件索引，而 Node 默认用 **JS Number** 暴露它。本机（NTFS）的真实值
 * 在 ~1.1e16，**超过 2^53**（9.007e15）⇒ Number 的间距是 **2** ⇒ **相邻的两个 ino 会舍入成
 * 同一个 Number**。实测连开 200 个文件撞了 **5 次**（约 2.5%）。
 *
 * 后果：`sameIdentity` 把两个毫不相干的文件判成"同一个文件"，`copyArtifactToDestination`
 * 于是在 `destination matches source` 上**拒绝保存**（或 `openVerifiedArtifactFile` 报
 * `artifact unsafe`）—— 表现为"偶尔就是存不了"，重试一下又好了。
 *
 * ⚠️ 丢精度只会让**不同**的值相等，不会让**相同**的值不等（舍入是确定的函数）
 *    ⇒ 硬链接那类"本该判相同"的保护**不受影响**，出错方向是**保守的**（宁可不存也不写坏）。
 *    这也正是它一直没被当成 bug、只被记成"测试抖动"的原因。
 *
 * ⚠️ 别改回 number：`Number(stats.ino)` 一旦超 2^53 就再也回不来，
 *    而"偶尔失败"在真机上极难复现（这次是靠单文件连跑 30 遍才逮到）。
 */
function snapshotOf(stats: Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>): FileSnapshot {
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    ctimeMs: Number(stats.ctimeMs),
  };
}

interface VerifiedArtifactFile {
  absolutePath: string;
  handle: FileHandle;
  snapshot: FileSnapshot;
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation));
}

function sameIdentity(left: Pick<FileSnapshot, 'dev' | 'ino'>, right: Pick<FileSnapshot, 'dev' | 'ino'>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function openVerifiedArtifactFile(
  workspacePath: string,
  localPath: string,
  hooks: ArtifactAccessHooks = {},
): Promise<VerifiedArtifactFile> {
  if (!localPath || isAbsolute(localPath) || localPath.includes('\0')) throw new Error('artifact unsafe');
  const workspace = await realpath(workspacePath);
  const candidate = resolve(workspace, localPath);
  if (!isWithin(workspace, candidate)) throw new Error('artifact unsafe');

  let link: Awaited<ReturnType<typeof lstat>>;
  try {
    link = await lstat(candidate, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('artifact missing');
    throw new Error('artifact unsafe');
  }
  if (link.isSymbolicLink() || !link.isFile()) throw new Error('artifact unsafe');
  const canonical = await realpath(candidate);
  if (!isWithin(workspace, canonical) || canonical !== candidate) throw new Error('artifact unsafe');

  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const raw = await handle.stat({ bigint: true });
    const snapshot = snapshotOf(raw);
    const pathSnapshot = await stat(canonical, { bigint: true });
    if (
      !raw.isFile() ||
      !sameIdentity(snapshot, snapshotOf(link)) ||
      !sameIdentity(snapshot, snapshotOf(pathSnapshot))
    ) {
      throw new Error('artifact unsafe');
    }
    // ⚠️ 抛**带类型的**错（不是一句字符串）：调用方要按它回一个结构化结果给界面。
    //    比字符串判的失效方向是"界面又把整份文件读进内存"，没有任何报错。
    if (hooks.maxBytes !== undefined && snapshot.size > hooks.maxBytes) {
      throw new ArtifactTooLargeError(snapshot.size);
    }
    await hooks.afterSourceOpen?.();
    return { absolutePath: canonical, handle, snapshot };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function hashHandle(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (bytesRead === 0) throw new Error('artifact changed while reading');
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest('hex');
}

async function assertStableSource(file: VerifiedArtifactFile, expectedHash: string): Promise<void> {
  const after = await file.handle.stat({ bigint: true });
  let pathSnapshot: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    pathSnapshot = await lstat(file.absolutePath, { bigint: true });
    canonical = await realpath(file.absolutePath);
  } catch {
    throw new Error('artifact changed while reading');
  }
  if (
    pathSnapshot.isSymbolicLink() ||
    canonical !== file.absolutePath ||
    !sameSnapshot(file.snapshot, snapshotOf(after)) ||
    !sameIdentity(snapshotOf(after), snapshotOf(pathSnapshot)) ||
    (await hashHandle(file.handle, Number(after.size))) !== expectedHash
  ) {
    throw new Error('artifact changed while reading');
  }
}

export async function inspectArtifactFile(workspacePath: string, localPath: string): Promise<ArtifactFileInspection> {
  let file: VerifiedArtifactFile | undefined;
  try {
    file = await openVerifiedArtifactFile(workspacePath, localPath);
    return { availability: 'available', absolutePath: file.absolutePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'artifact unsafe';
    return { availability: message === 'artifact missing' ? 'missing' : 'unsafe' };
  } finally {
    await file?.handle.close().catch(() => undefined);
  }
}

async function readVerifiedArtifactFileWithHooks(
  workspacePath: string,
  localPath: string,
  hooks: ArtifactAccessHooks = {},
): Promise<Buffer> {
  const file = await openVerifiedArtifactFile(workspacePath, localPath, hooks);
  try {
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < file.snapshot.size) {
      const { bytesRead } = await file.handle.read(
        chunk,
        0,
        Math.min(chunk.length, file.snapshot.size - offset),
        offset,
      );
      if (bytesRead === 0) throw new Error('artifact changed while reading');
      const data = Buffer.from(chunk.subarray(0, bytesRead));
      chunks.push(data);
      hash.update(data);
      offset += bytesRead;
    }
    await assertStableSource(file, hash.digest('hex'));
    return Buffer.concat(chunks, file.snapshot.size);
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

async function writeAll(target: FileHandle, chunk: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < chunk.length) {
    const result = await target.write(chunk, written, chunk.length - written, position + written);
    if (result.bytesWritten === 0) throw new Error('destination write failed');
    written += result.bytesWritten;
  }
}

async function copyArtifactToDestinationWithHooks(
  workspacePath: string,
  localPath: string,
  destinationPath: string,
  hooks: ArtifactAccessHooks = {},
): Promise<{ status: 'saved'; filePath: string }> {
  const source = await openVerifiedArtifactFile(workspacePath, localPath, hooks);
  const destination = resolve(destinationPath);
  let temporaryPath: string | undefined;
  let target: FileHandle | undefined;
  try {
    const destinationParent = await realpath(dirname(destination));
    if (!isWithin(destinationParent, destination)) throw new Error('destination unsafe');
    try {
      const destinationInfo = await lstat(destination, { bigint: true });
      if (destinationInfo.isSymbolicLink() || !destinationInfo.isFile()) throw new Error('destination unsafe');
      if (sameIdentity(source.snapshot, snapshotOf(destinationInfo))) throw new Error('destination matches source');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    temporaryPath = resolve(destinationParent, `.${basename(destination)}.mofang-${process.pid}-${randomUUID()}.tmp`);
    target = await open(
      temporaryPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );

    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < source.snapshot.size) {
      const { bytesRead } = await source.handle.read(
        chunk,
        0,
        Math.min(chunk.length, source.snapshot.size - offset),
        offset,
      );
      if (bytesRead === 0) throw new Error('artifact changed while reading');
      const data = Buffer.from(chunk.subarray(0, bytesRead));
      hash.update(data);
      if (hooks.writeChunk) await hooks.writeChunk(target, data, offset);
      else await writeAll(target, data, offset);
      offset += bytesRead;
    }
    await target.sync();
    const sourceDigest = hash.digest('hex');
    await assertStableSource(source, sourceDigest);
    const targetSnapshot = await target.stat({ bigint: true });
    const targetPathSnapshot = await lstat(temporaryPath, { bigint: true });
    if (
      !targetSnapshot.isFile() ||
      Number(targetSnapshot.size) !== source.snapshot.size ||
      !sameIdentity(snapshotOf(targetSnapshot), snapshotOf(targetPathSnapshot)) ||
      (await hashHandle(target, Number(targetSnapshot.size))) !== sourceDigest
    ) {
      throw new Error('destination verification failed');
    }
    await target.close();
    target = undefined;

    try {
      if (hooks.publish) await hooks.publish(temporaryPath, destination);
      else await rename(temporaryPath, destination);
    } catch (error) {
      throw new Error('Could not replace the selected file safely; the existing file was kept.', { cause: error });
    }
    temporaryPath = undefined;
    return { status: 'saved', filePath: destination };
  } finally {
    await target?.close().catch(() => undefined);
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
    await source.handle.close().catch(() => undefined);
  }
}

export function readVerifiedArtifactFile(
  workspacePath: string,
  localPath: string,
  options: { maxBytes?: number } = {},
): Promise<Buffer> {
  return readVerifiedArtifactFileWithHooks(workspacePath, localPath, options);
}

export function copyArtifactToDestination(
  workspacePath: string,
  localPath: string,
  destinationPath: string,
): Promise<{ status: 'saved'; filePath: string }> {
  return copyArtifactToDestinationWithHooks(workspacePath, localPath, destinationPath);
}

export const __testing = Object.freeze({
  readVerifiedArtifactFile: readVerifiedArtifactFileWithHooks,
  copyArtifactToDestination: copyArtifactToDestinationWithHooks,
  // 身份判定的那一条（2026-09-19 的 64 位 ino 丢精度）**只有**把这两个露出来才测得到：
  // 它要的是"两个不同的 64 位 ino 舍入成同一个 number"这种夹具，光靠真文件复现不了。
  snapshotOf,
  sameIdentity,
});
