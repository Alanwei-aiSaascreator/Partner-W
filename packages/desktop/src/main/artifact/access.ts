import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ArtifactAvailability } from '@clawwork/shared';

export interface ArtifactFileInspection {
  availability: ArtifactAvailability;
  absolutePath?: string;
}

interface ArtifactAccessHooks {
  maxBytes?: number;
  afterSourceOpen?: () => void | Promise<void>;
  writeChunk?: (target: FileHandle, chunk: Buffer, position: number) => Promise<void>;
  publish?: (temporaryPath: string, destinationPath: string) => Promise<void>;
}

interface FileSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
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
    link = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('artifact missing');
    throw new Error('artifact unsafe');
  }
  if (link.isSymbolicLink() || !link.isFile()) throw new Error('artifact unsafe');
  const canonical = await realpath(candidate);
  if (!isWithin(workspace, canonical) || canonical !== candidate) throw new Error('artifact unsafe');

  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const snapshot = await handle.stat();
    const pathSnapshot = await stat(canonical);
    if (!snapshot.isFile() || !sameIdentity(snapshot, link) || !sameIdentity(snapshot, pathSnapshot)) {
      throw new Error('artifact unsafe');
    }
    if (hooks.maxBytes !== undefined && snapshot.size > hooks.maxBytes) throw new Error('artifact too large');
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
  const after = await file.handle.stat();
  let pathSnapshot: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    pathSnapshot = await lstat(file.absolutePath);
    canonical = await realpath(file.absolutePath);
  } catch {
    throw new Error('artifact changed while reading');
  }
  if (
    pathSnapshot.isSymbolicLink() ||
    canonical !== file.absolutePath ||
    !sameSnapshot(file.snapshot, after) ||
    !sameIdentity(after, pathSnapshot) ||
    (await hashHandle(file.handle, after.size)) !== expectedHash
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
      const destinationInfo = await lstat(destination);
      if (destinationInfo.isSymbolicLink() || !destinationInfo.isFile()) throw new Error('destination unsafe');
      if (sameIdentity(source.snapshot, destinationInfo)) throw new Error('destination matches source');
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
    const targetSnapshot = await target.stat();
    const targetPathSnapshot = await lstat(temporaryPath);
    if (
      !targetSnapshot.isFile() ||
      targetSnapshot.size !== source.snapshot.size ||
      !sameIdentity(targetSnapshot, targetPathSnapshot) ||
      (await hashHandle(target, targetSnapshot.size)) !== sourceDigest
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
});
