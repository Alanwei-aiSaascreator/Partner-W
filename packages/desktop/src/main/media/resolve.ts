import type { BigIntStats } from 'fs';
import { realpathSync } from 'fs';
import { open, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, resolve, sep } from 'path';
import { identityOf, sameIdentity } from '../util/file-identity.js';

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|avif|mp4|webm)$/i;

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/** 宿主回落只告警一次（这条函数每次读媒体都会跑，不能按次刷屏）。 */
let hostFallbackWarned = false;

/**
 * 允许读的媒体根。
 *
 * ⚠️ `OPENCLAW_STATE_DIR` 没设时**回落到宿主 `~/.openclaw`**（历史行为，保留 ——
 *    安装形态就该用宿主那份）。但便携形态下"没设"意味着**数据没跟着盘走**，
 *    表现是"聊天里的图片静默读不到"—— 所以这里必须**留下一条显式日志**（BUG-041 ⑤）：
 *    静默回落是审计里最难查的一类（同一个症状有两个完全不同的成因）。
 */
function mediaRoots(): string[] {
  if (process.env.OPENCLAW_STATE_DIR) return [resolve(process.env.OPENCLAW_STATE_DIR, 'media')];
  if (!hostFallbackWarned) {
    hostFallbackWarned = true;
    console.warn('[media] OPENCLAW_STATE_DIR 未设置 —— 媒体根回落到宿主 ~/.openclaw（便携形态下这意味着数据不在盘上）');
  }
  return [resolve(homedir(), '.openclaw', 'media')];
}

/**
 * 身份判定走 `util/file-identity.ts`（bigint，逐位比）。
 *
 * ⚠️ 原来比的是 Number 版的 `dev`/`ino`。`ino` 是 **64 位**，超过 2^53 后**相邻的两个值**
 *    会舍入成同一个（NTFS 顺序分配 inode ⇒ 连续创建的文件必然相邻 ⇒ **必然**撞），
 *    而这个判定的用途是"重算出来的路径还是我刚打开的那个文件吗" ——
 *    答错就是把**另一份文件**当成允许的媒体发出去。
 */
function isSameFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(identityOf(left), identityOf(right));
}

function isLexicallyAllowedMediaPath(sourcePath: string): boolean {
  if (
    !sourcePath ||
    sourcePath.includes('\0') ||
    !isAbsolute(sourcePath) ||
    /^[\\/]{2}/.test(sourcePath) ||
    sourcePath.split(/[\\/]+/).includes('..') ||
    sourcePath.replace(/^[a-z]:/i, '').includes(':')
  )
    return false;
  const requested = resolve(sourcePath);
  if (!MEDIA_EXT_RE.test(requested)) return false;
  return mediaRoots().some((root) => isWithin(root, requested));
}

async function resolveAllowedMediaPath(
  sourcePath: string,
  fd: number,
  openedStat: BigIntStats,
): Promise<string | null> {
  const requested = resolve(sourcePath);
  const roots = await Promise.all(
    mediaRoots().map((root) =>
      realpath(root).catch(() => {
        return null;
      }),
    ),
  );
  const fdTarget =
    process.platform === 'win32'
      ? null
      : (() => {
          try {
            const target = realpathSync(`/dev/fd/${fd}`);
            return target.startsWith('/dev/fd/') ? null : target;
          } catch {
            return null;
          }
        })();
  const realTarget = fdTarget ?? (await realpath(requested).catch(() => null));
  if (!realTarget) return null;
  if (!roots.some((root) => root !== null && isWithin(root, realTarget))) return null;
  const targetStat = await stat(realTarget, { bigint: true }).catch(() => null);
  if (!targetStat || !isSameFile(openedStat, targetStat)) return null;
  return realTarget;
}

export async function readOpenClawMediaFile(sourcePath: string): Promise<string | null> {
  if (!isLexicallyAllowedMediaPath(sourcePath)) return null;
  const handle = await open(sourcePath, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || Number(stat.size) > MAX_MEDIA_BYTES) return null;
    const realTarget = await resolveAllowedMediaPath(sourcePath, handle.fd, stat);
    if (!realTarget) return null;
    return await handle.readFile({ encoding: 'base64' });
  } finally {
    await handle.close();
  }
}

/**
 * 只给测试用：身份判定是否**精确**在真文件上验不了（造不出"只有 dev/ino 不同"的形态），
 * 只能在函数层用合成的 bigint stats 钉。
 */
export const __testing = Object.freeze({ isSameFile });
