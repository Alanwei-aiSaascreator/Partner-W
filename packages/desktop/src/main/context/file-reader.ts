import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { hasStrongIdentity, identityOf, sameIdentity } from '../util/file-identity.js';
import { extname, isAbsolute, relative, sep } from 'node:path';
import type { FileReadResult } from '@clawwork/shared';
import { classifyTier, getMimeType } from './file-types.js';

const MAX_TEXT_SIZE = 100 * 1024;
const MAX_BINARY_SIZE = 10 * 1024 * 1024;
const MAX_SEND_FILE_BYTES = 25 * 1024 * 1024;

function canonicalPath(targetPath: string): string {
  return typeof realpathSync.native === 'function' ? realpathSync.native(targetPath) : realpathSync(targetPath);
}

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

interface ReadHooks {
  beforeOpen?: () => void;
  afterOpen?: () => void;
}

/**
 * 身份判定 + 一个**弱兜底**分支。
 *
 * ⚠️ 强分支一律走 `util/file-identity.ts`（bigint，逐位比）：`ino` 是 64 位，
 *    用 Number 读会让**相邻的两个文件**舍入成同一个值 ⇒ "这个文件被换过吗"答成"没换"，
 *    而这里的调用方全是"读完再确认没被掉包"，答错 = 把**别的内容**当成用户选的那份送出去。
 *    （原来的守卫 `Number.isFinite(ino) && ino > 0` **挡不住**丢精度：舍入后照样是有限正数。）
 *
 * 兜底分支只在文件系统**没给** dev/ino（为 0）时生效：用 birthtime + size + mtime 近似。
 * 它是**弱**判据（同毫秒创建的两个文件可能撞），但没有更好的选择。
 */
function sameIdentityWithFallback(left: BigIntStats, right: BigIntStats, requireStrong: boolean): boolean {
  const leftId = identityOf(left);
  const rightId = identityOf(right);
  if (hasStrongIdentity(leftId) && hasStrongIdentity(rightId)) return sameIdentity(leftId, rightId);
  if (requireStrong) return false;

  return (
    left.birthtimeMs > 0n &&
    right.birthtimeMs > 0n &&
    left.birthtimeMs === right.birthtimeMs &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function validateRoot(canonicalRoot: string, expectedIdentity?: BigIntStats): BigIntStats {
  let currentRoot: string;
  let identity: BigIntStats;
  try {
    currentRoot = canonicalPath(canonicalRoot);
    identity = statSync(currentRoot, { bigint: true });
  } catch {
    throw new Error('context folder is unavailable');
  }
  if (relative(canonicalRoot, currentRoot) !== '' || !identity.isDirectory()) {
    throw new Error('context folder changed');
  }
  if (expectedIdentity && !sameIdentityWithFallback(expectedIdentity, identity, false)) {
    throw new Error('context folder changed');
  }
  return identity;
}

function validateTarget(canonicalRoot: string, targetPath: string): { realPath: string; identity: BigIntStats } {
  let realPath: string;
  let identity: BigIntStats;
  try {
    realPath = canonicalPath(targetPath);
    identity = statSync(realPath, { bigint: true });
  } catch {
    throw new Error('context file is unavailable');
  }
  if (!isContained(canonicalRoot, realPath) || !identity.isFile()) {
    throw new Error('path outside allowed context folders');
  }
  return { realPath, identity };
}

export function resolveFdRealPath(fd: number, absolutePath: string): string {
  if (process.platform === 'win32') return canonicalPath(absolutePath);
  return realpathSync(`/dev/fd/${fd}`);
}

function readContextFileInternal(
  absolutePath: string,
  contextFolders: string[],
  hooks?: ReadHooks,
  maxBytes?: number,
): FileReadResult {
  let selected:
    | { canonicalRoot: string; rootIdentity: BigIntStats; targetIdentity: BigIntStats; realTarget: string }
    | undefined;
  for (const canonicalRoot of contextFolders) {
    try {
      const rootIdentity = validateRoot(canonicalRoot);
      const target = validateTarget(canonicalRoot, absolutePath);
      selected = { canonicalRoot, rootIdentity, targetIdentity: target.identity, realTarget: target.realPath };
      break;
    } catch {
      continue;
    }
  }
  if (!selected) throw new Error('path outside allowed context folders');

  hooks?.beforeOpen?.();
  const fd = openSync(absolutePath, 'r');
  try {
    hooks?.afterOpen?.();
    const openedIdentity = fstatSync(fd, { bigint: true });
    const openedSize = Number(openedIdentity.size);
    if (!sameIdentityWithFallback(selected.targetIdentity, openedIdentity, true)) {
      throw new Error('context file changed');
    }
    if (maxBytes !== undefined && openedSize > maxBytes) throw new Error('context file is too large to send');

    validateRoot(selected.canonicalRoot, selected.rootIdentity);
    const fdRealPath = resolveFdRealPath(fd, absolutePath);
    if (!isContained(selected.canonicalRoot, fdRealPath)) throw new Error('path outside allowed context folders');
    const currentTarget = validateTarget(selected.canonicalRoot, fdRealPath);
    if (!sameIdentityWithFallback(openedIdentity, currentTarget.identity, true)) {
      throw new Error('context file changed');
    }

    const ext = extname(selected.realTarget).toLowerCase();
    const tier = classifyTier(ext);
    if (tier === 'unsupported') throw new Error(`unsupported file type: ${ext}`);

    const size = openedSize;
    let result: FileReadResult;
    if (tier === 'text') {
      const buf = Buffer.alloc(Math.min(size, MAX_TEXT_SIZE));
      readSync(fd, buf, 0, buf.length, 0);
      let content = buf.toString('utf-8');
      const truncated = size > MAX_TEXT_SIZE;
      if (truncated) content += '\n[truncated at 100KB]';
      result = { content, mimeType: getMimeType(ext), size, truncated, tier };
    } else {
      const readSize = Math.min(size, MAX_BINARY_SIZE);
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, 0);
      result = {
        content: buf.toString('base64'),
        mimeType: getMimeType(ext),
        size,
        truncated: size > MAX_BINARY_SIZE,
        tier,
      };
    }

    validateRoot(selected.canonicalRoot, selected.rootIdentity);
    const finalTarget = validateTarget(selected.canonicalRoot, fdRealPath);
    if (!sameIdentityWithFallback(openedIdentity, finalTarget.identity, true)) {
      throw new Error('context file changed');
    }
    const finalOpenedIdentity = fstatSync(fd, { bigint: true });
    if (maxBytes !== undefined) {
      if (Number(finalOpenedIdentity.size) > maxBytes || Number(finalTarget.identity.size) > maxBytes) {
        throw new Error('context file is too large to send');
      }
      if (finalOpenedIdentity.size !== openedIdentity.size || finalTarget.identity.size !== openedIdentity.size) {
        throw new Error('context file changed');
      }
    }
    return result;
  } finally {
    closeSync(fd);
  }
}

export function readContextFile(absolutePath: string, contextFolders: string[]): FileReadResult {
  return readContextFileInternal(absolutePath, contextFolders);
}

export function readContextFileForSend(
  absolutePath: string,
  contextFolders: string[],
): FileReadResult & { byteLength: number } {
  const result = readContextFileInternal(absolutePath, contextFolders, undefined, MAX_SEND_FILE_BYTES);
  return { ...result, byteLength: result.size };
}

export const __testing = Object.freeze({
  readContextFileWithHooks: (absolutePath: string, contextFolders: string[], hooks: ReadHooks): FileReadResult =>
    readContextFileInternal(absolutePath, contextFolders, hooks),
  readContextFileForSendWithHooks: (absolutePath: string, contextFolders: string[], hooks: ReadHooks): FileReadResult =>
    readContextFileInternal(absolutePath, contextFolders, hooks, MAX_SEND_FILE_BYTES),
});
