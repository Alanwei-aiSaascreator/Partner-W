import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
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

function sameIdentity(left: Stats, right: Stats, requireStrong: boolean): boolean {
  const hasDevAndIno =
    Number.isFinite(left.dev) &&
    Number.isFinite(left.ino) &&
    Number.isFinite(right.dev) &&
    Number.isFinite(right.ino) &&
    left.dev > 0 &&
    left.ino > 0 &&
    right.dev > 0 &&
    right.ino > 0;
  if (hasDevAndIno) return left.dev === right.dev && left.ino === right.ino;
  if (requireStrong) return false;

  const hasFallback =
    Number.isFinite(left.birthtimeMs) &&
    Number.isFinite(right.birthtimeMs) &&
    left.birthtimeMs > 0 &&
    right.birthtimeMs > 0 &&
    Number.isFinite(left.size) &&
    Number.isFinite(right.size) &&
    Number.isFinite(left.mtimeMs) &&
    Number.isFinite(right.mtimeMs);
  return (
    hasFallback && left.birthtimeMs === right.birthtimeMs && left.size === right.size && left.mtimeMs === right.mtimeMs
  );
}

function validateRoot(canonicalRoot: string, expectedIdentity?: Stats): Stats {
  let currentRoot: string;
  let identity: Stats;
  try {
    currentRoot = canonicalPath(canonicalRoot);
    identity = statSync(currentRoot);
  } catch {
    throw new Error('context folder is unavailable');
  }
  if (relative(canonicalRoot, currentRoot) !== '' || !identity.isDirectory()) {
    throw new Error('context folder changed');
  }
  if (expectedIdentity && !sameIdentity(expectedIdentity, identity, false)) throw new Error('context folder changed');
  return identity;
}

function validateTarget(canonicalRoot: string, targetPath: string): { realPath: string; identity: Stats } {
  let realPath: string;
  let identity: Stats;
  try {
    realPath = canonicalPath(targetPath);
    identity = statSync(realPath);
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
  let selected: { canonicalRoot: string; rootIdentity: Stats; targetIdentity: Stats; realTarget: string } | undefined;
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
    const openedIdentity = fstatSync(fd);
    if (!sameIdentity(selected.targetIdentity, openedIdentity, true)) throw new Error('context file changed');
    if (maxBytes !== undefined && openedIdentity.size > maxBytes) throw new Error('context file is too large to send');

    validateRoot(selected.canonicalRoot, selected.rootIdentity);
    const fdRealPath = resolveFdRealPath(fd, absolutePath);
    if (!isContained(selected.canonicalRoot, fdRealPath)) throw new Error('path outside allowed context folders');
    const currentTarget = validateTarget(selected.canonicalRoot, fdRealPath);
    if (!sameIdentity(openedIdentity, currentTarget.identity, true)) throw new Error('context file changed');

    const ext = extname(selected.realTarget).toLowerCase();
    const tier = classifyTier(ext);
    if (tier === 'unsupported') throw new Error(`unsupported file type: ${ext}`);

    const { size } = openedIdentity;
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
    if (!sameIdentity(openedIdentity, finalTarget.identity, true)) throw new Error('context file changed');
    const finalOpenedIdentity = fstatSync(fd);
    if (maxBytes !== undefined && (finalOpenedIdentity.size > maxBytes || finalTarget.identity.size > maxBytes)) {
      throw new Error('context file is too large to send');
    }
    return result;
  } finally {
    closeSync(fd);
  }
}

export function readContextFile(absolutePath: string, contextFolders: string[]): FileReadResult {
  return readContextFileInternal(absolutePath, contextFolders);
}

export function readContextFileForSend(absolutePath: string, contextFolders: string[]): FileReadResult {
  return readContextFileInternal(absolutePath, contextFolders, undefined, MAX_SEND_FILE_BYTES);
}

export const __testing = Object.freeze({
  readContextFileWithHooks: (absolutePath: string, contextFolders: string[], hooks: ReadHooks): FileReadResult =>
    readContextFileInternal(absolutePath, contextFolders, hooks),
  readContextFileForSendWithHooks: (absolutePath: string, contextFolders: string[], hooks: ReadHooks): FileReadResult =>
    readContextFileInternal(absolutePath, contextFolders, hooks, MAX_SEND_FILE_BYTES),
});
