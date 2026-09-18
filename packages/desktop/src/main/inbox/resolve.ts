import { realpathSync } from 'fs';
import { open, realpath, stat } from 'fs/promises';
import { hasStrongIdentity, identityOf, sameIdentity } from '../util/file-identity.js';
import { isAbsolute, resolve, sep } from 'path';

interface InboxPathInfo {
  base: string;
  full: string;
  inboxDir: string;
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function parseInboxPath(workspacePath: string, localPath: string): InboxPathInfo | null {
  if (!localPath || isAbsolute(localPath)) return null;
  const parts = localPath.replaceAll('\\', '/').split('/');
  if (
    parts.length !== 3 ||
    !parts[0] ||
    parts[0] === '.' ||
    parts[0] === '..' ||
    parts[1] !== 'inbox' ||
    !parts[2] ||
    parts[2] === '.' ||
    parts[2] === '..' ||
    parts[2] === '.import-staging' ||
    /^\.import-.*\.partial$/i.test(parts[2])
  ) {
    return null;
  }
  const base = resolve(workspacePath);
  const full = resolve(base, ...parts);
  if (!isWithin(base, full)) return null;
  return {
    base,
    full,
    inboxDir: resolve(base, parts[0], 'inbox'),
  };
}

async function resolveValidatedPath(
  info: InboxPathInfo,
  pathToResolve: string,
  requireFile = false,
): Promise<string | null> {
  try {
    const [realBase, realInboxDir, realTarget] = await Promise.all([
      realpath(info.base),
      realpath(info.inboxDir),
      realpath(pathToResolve),
    ]);
    if (!isWithin(realBase, realInboxDir)) return null;
    if (!isWithin(realInboxDir, realTarget)) return null;
    if (requireFile && !(await stat(realTarget, { bigint: true })).isFile()) return null;
    return realTarget;
  } catch {
    return null;
  }
}

export async function resolveInboxPath(workspacePath: string, localPath: string): Promise<string | null> {
  const info = parseInboxPath(workspacePath, localPath);
  if (!info) return null;
  return resolveValidatedPath(info, info.full, true);
}

interface InboxFileReadResult {
  content: string;
  byteLength: number;
}

async function readInboxFileInternal(
  workspacePath: string,
  localPath: string,
  maxBytes?: number,
): Promise<InboxFileReadResult | null> {
  const info = parseInboxPath(workspacePath, localPath);
  if (!info) return null;
  const handle = await open(info.full, 'r').catch(() => null);
  if (!handle) return null;
  try {
    // ⚠️ 身份一律走 bigint：`ino` 是 64 位，Number 版在超过 2^53 后会把**相邻的两个文件**
    //    舍入成同一个值 ⇒ "这个文件被换过吗"会答成"没换"（fail-open，见 util/file-identity.ts）
    const openedStats = await handle.stat({ bigint: true });
    const openedIdentity = identityOf(openedStats);
    const openedSize = Number(openedStats.size);
    if (!openedStats.isFile() || !hasStrongIdentity(openedIdentity)) return null;
    if (maxBytes !== undefined && openedSize > maxBytes) return null;
    const pathToResolve = process.platform === 'win32' ? info.full : `/dev/fd/${handle.fd}`;
    const realTarget =
      process.platform === 'win32'
        ? await resolveValidatedPath(info, pathToResolve)
        : (() => {
            try {
              return realpathSync(pathToResolve);
            } catch {
              return null;
            }
          })();
    if (!realTarget) return null;
    const resolvedStats = await stat(realTarget, { bigint: true });
    if (!resolvedStats.isFile() || !sameIdentity(openedIdentity, identityOf(resolvedStats))) return null;
    const realInboxDir = await resolveValidatedPath(info, info.inboxDir);
    if (!realInboxDir || !isWithin(realInboxDir, realTarget)) return null;
    const [finalHandleStats, finalPathStats] = await Promise.all([
      handle.stat({ bigint: true }),
      stat(realTarget, { bigint: true }),
    ]);
    const finalHandleSize = Number(finalHandleStats.size);
    const finalPathSize = Number(finalPathStats.size);
    if (
      !finalHandleStats.isFile() ||
      !finalPathStats.isFile() ||
      !sameIdentity(openedIdentity, identityOf(finalHandleStats)) ||
      !sameIdentity(openedIdentity, identityOf(finalPathStats)) ||
      (maxBytes !== undefined &&
        (finalHandleSize > maxBytes ||
          finalPathSize > maxBytes ||
          finalHandleSize !== openedSize ||
          finalPathSize !== openedSize))
    ) {
      return null;
    }
    if (maxBytes === undefined) {
      return { content: await handle.readFile({ encoding: 'base64' }), byteLength: finalHandleSize };
    }

    const expectedBytes = openedSize;
    const buffer = Buffer.alloc(expectedBytes);
    let totalBytesRead = 0;
    while (totalBytesRead < expectedBytes) {
      const { bytesRead } = await handle.read(buffer, totalBytesRead, expectedBytes - totalBytesRead, totalBytesRead);
      if (bytesRead <= 0) return null;
      totalBytesRead += bytesRead;
    }
    const [afterReadStats, afterReadPathStats] = await Promise.all([
      handle.stat({ bigint: true }),
      stat(realTarget, { bigint: true }),
    ]);
    if (
      Number(afterReadStats.size) !== expectedBytes ||
      Number(afterReadPathStats.size) !== expectedBytes ||
      !sameIdentity(openedIdentity, identityOf(afterReadStats)) ||
      !sameIdentity(openedIdentity, identityOf(afterReadPathStats))
    ) {
      return null;
    }
    return { content: buffer.toString('base64'), byteLength: totalBytesRead };
  } finally {
    await handle.close();
  }
}

export async function readInboxFile(workspacePath: string, localPath: string): Promise<string | null> {
  return (await readInboxFileInternal(workspacePath, localPath))?.content ?? null;
}

export async function readInboxFileForSend(
  workspacePath: string,
  localPath: string,
  maxBytes: number,
): Promise<InboxFileReadResult | null> {
  return readInboxFileInternal(workspacePath, localPath, maxBytes);
}
