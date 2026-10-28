import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { hasStrongIdentity, identityOf, sameIdentity } from '../util/file-identity.js';
import { extname, isAbsolute, relative, sep } from 'node:path';
import type { FileReadResult } from '@clawwork/shared';
import { classifyTier, getMimeType } from './file-types.js';

const MAX_TEXT_SIZE = 100 * 1024;
const MAX_BINARY_SIZE = 10 * 1024 * 1024;
/**
 * 发送读（`readContextFileForSend`）的**单文件**上限 —— 二进制 tier 专用
 *（text tier 已放开：只内联 100KB，见读取分支的注释）。
 *
 * ⚠️ 这是"单文件整份 base64 出去"的合理边界，不是**单帧**预算 —— 帧预算是渲染层
 *    按网关协商值（`hello-ok.policy.maxPayload`）折算的**聚合**闸门（2026-10-07 ·
 *    质量战役区 2 · P1-1，见 `ChatInput/constants.ts` 的 `deriveMaterialByteBudget`）。
 *    这层保持静态：IPC 形状里没有 gatewayId，且此处只需拦"单个文件离谱地大"。
 *    （text tier 走这条时 sendSizeCap=undefined：30MB 的 .log 只带 100KB 上模型。）
 */
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

    /**
     * ⭐ 2026-10-07（质量战役区 2 · P2-1）：单文件闸门**对 text tier 不适用**。
     *
     * text tier 只会内联 `min(size, 100KB)`（见下面读取分支）—— 30MB 的 .log 带上去的
     * 就是 100KB。旧口径在打开文件前就按整份体积拒掉（"file is too large to send"），
     * 用户只知道"加不进来"，完全不知道其实只有 100KB 会上模型；发送侧还按 30MB 记账。
     * 现在：text tier 放行（大小由 MAX_TEXT_SIZE 内联截断兜底），byteLength 按实际内联
     * 字节回报（`readContextFileForSend`）；二进制 tier（整份 base64 发送）照旧受闸门约束。
     */
    const sendSizeCap = tier === 'text' ? undefined : maxBytes;
    if (sendSizeCap !== undefined && openedSize > sendSizeCap) {
      throw new Error('context file is too large to send');
    }

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
      if (
        sendSizeCap !== undefined &&
        (Number(finalOpenedIdentity.size) > sendSizeCap || Number(finalTarget.identity.size) > sendSizeCap)
      ) {
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
  /**
   * ⭐ 2026-10-07（质量战役区 2 · P2-1）：`byteLength` = **实际会上模型的字节**。
   *
   *   - text tier：内容已截到 100KB（含截断标记）⇒ 按 `result.content` 的真实
   *     UTF-8 字节回报。30MB 的 .log 不再按 30MB 吃掉发送预算（旧口径 = 明文虚耗，
   *     还让「@ 大文本」在字节闸门里被冤杀）。
   *   - 二进制 tier：content 是整份 base64（上限 10MB），消费侧按 base64 折算的预算
   *     比原始字节保守 ⇒ 回报原始 `size`（宁可更早拦，不可放行超帧）。
   */
  const byteLength = result.tier === 'text' ? Buffer.byteLength(result.content, 'utf8') : result.size;
  return { ...result, byteLength };
}

export const __testing = Object.freeze({
  readContextFileWithHooks: (absolutePath: string, contextFolders: string[], hooks: ReadHooks): FileReadResult =>
    readContextFileInternal(absolutePath, contextFolders, hooks),
  readContextFileForSendWithHooks: (absolutePath: string, contextFolders: string[], hooks: ReadHooks): FileReadResult =>
    readContextFileInternal(absolutePath, contextFolders, hooks, MAX_SEND_FILE_BYTES),
});
