import { constants } from 'node:fs';
import { lstat, open, realpath, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ArtifactAvailability } from '@clawwork/shared';

export interface ArtifactFileInspection {
  availability: ArtifactAvailability;
  absolutePath?: string;
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation));
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export async function inspectArtifactFile(workspacePath: string, localPath: string): Promise<ArtifactFileInspection> {
  if (!localPath || isAbsolute(localPath) || localPath.includes('\0')) return { availability: 'unsafe' };
  try {
    const workspace = await realpath(workspacePath);
    const candidate = resolve(workspace, localPath);
    if (!isWithin(workspace, candidate)) return { availability: 'unsafe' };

    const link = await lstat(candidate);
    if (link.isSymbolicLink() || !link.isFile()) return { availability: 'unsafe' };
    const canonical = await realpath(candidate);
    if (!isWithin(workspace, canonical) || canonical !== candidate) return { availability: 'unsafe' };
    const canonicalStat = await stat(canonical);
    if (!canonicalStat.isFile() || !sameIdentity(link, canonicalStat)) return { availability: 'unsafe' };
    return { availability: 'available', absolutePath: canonical };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { availability: 'missing' }
      : { availability: 'unsafe' };
  }
}

export async function copyArtifactToDestination(
  workspacePath: string,
  localPath: string,
  destinationPath: string,
): Promise<{ status: 'saved'; filePath: string }> {
  const inspected = await inspectArtifactFile(workspacePath, localPath);
  if (inspected.availability !== 'available' || !inspected.absolutePath) {
    throw new Error(`artifact ${inspected.availability}`);
  }

  const destination = resolve(destinationPath);
  const destinationParent = await realpath(dirname(destination));
  if (!isWithin(destinationParent, destination)) throw new Error('destination unsafe');
  try {
    const destinationInfo = await lstat(destination);
    if (destinationInfo.isSymbolicLink() || !destinationInfo.isFile()) throw new Error('destination unsafe');
    if ((await realpath(destination)) === inspected.absolutePath) throw new Error('destination matches source');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const source = await open(inspected.absolutePath, constants.O_RDONLY);
  let target: Awaited<ReturnType<typeof open>> | undefined;
  let wroteDestination = false;
  try {
    const before = await source.stat();
    if (!before.isFile()) throw new Error('artifact unsafe');
    const sourcePathStat = await lstat(inspected.absolutePath);
    if (sourcePathStat.isSymbolicLink() || !sameIdentity(before, sourcePathStat)) throw new Error('artifact unsafe');

    target = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    const targetStat = await target.stat();
    if (!targetStat.isFile()) throw new Error('destination unsafe');
    wroteDestination = true;

    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (bytesRead === 0) throw new Error('artifact changed while copying');
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(chunk, written, bytesRead - written, offset + written);
        if (result.bytesWritten === 0) throw new Error('destination write failed');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await target.sync();
    const after = await source.stat();
    const afterPath = await lstat(inspected.absolutePath);
    if (!sameSnapshot(before, after) || !sameIdentity(after, afterPath)) {
      throw new Error('artifact changed while copying');
    }
    return { status: 'saved', filePath: destination };
  } catch (error) {
    if (wroteDestination) await unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    await target?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}
