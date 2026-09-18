/**
 * 便携（U 盘）形态的**换包引擎**（T-U2）：暂存 → 校验 → 备份 → 原子替换 → 回滚。
 *
 * ## 为什么单独一层
 *
 * 换包是**就地改用户盘上的文件**，而且盘上那份往往是他唯一的一份 —— 换到一半没换成，
 * 用户手里就只剩一个打不开的应用。所以这里的每一步都按"随时可能断电/拔盘"来排：
 *
 * ```
 *   下载 → <fileName>.part-<rand>        ← 半截文件绝不能冒充"下好了"
 *   校验 → 通过才 rename 成正式名         ← 坏包当场删，不留到下次换包时顶掉好文件
 *   换包 → ① rename(target, target.bak)   ← 先把旧的**原子**保住
 *          ② rename(staged, target)      ← 再**原子**换入
 *          ③ ②失败 ⇒ rename(bak, target)  ← 顶回去
 * ```
 *
 * ①② 之间是**唯一**一个"盘上那份应用不存在了"的窗口，靠 ③ 和下次启动的
 * `recoverPortableSwap` 两道兜。
 *
 * ## ⚠️ sha256 的语义边界（沿用 `runtime/deploy.ts:34` 那条）
 *
 * feed 与包都在可写的盘上、且走的是可被替换的信道时，hash 一致只证明**没损坏、没被改过**，
 * **不构成发行方真实性** —— 那是签名 manifest 的事。这里不假装它是签名验证。
 *
 * ## 这一层**不决定**的事（留给接线时拍板）
 *
 * **什么时候**换：进程正跑着的时候 `app.asar` 是被占用的，换不动。所以真正落地得选一种
 * 触发方式（启动器先换再拉起 / 退出时交给一个外部小工具 / 下次启动前由壳层换），
 * 那会决定交付包的目录布局 ⇒ 属于要用户拍板的事，本模块刻意不含任何触发逻辑，
 * 只做"给我一个校验过的文件和一个目标，我把它安全地换上去"。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * 路径风格：Windows 上按 `win32` 解析盘符，其它平台按 `posix`。
 * 与 `workspace/portable.ts` 同款（那边解释了为什么现取、不写死）。
 */
function P(): typeof path.win32 {
  return process.platform === 'win32' ? path.win32 : path.posix;
}

/** 暂存文件的后缀前缀（`.part-` 开头的永远不是可用产物）。 */
export const PART_PREFIX = '.part-';
/** 备份后缀（`.bak` 在 = 有一次换包还没被确认）。 */
export const BACKUP_SUFFIX = '.bak';
/** 卷根（`E:\a\b` → `E:\`）；相对路径/空返回 null。 */
function volumeRootOf(target: string): string | null {
  if (!target) return null;
  const root = P().parse(target).root;
  return root || null;
}

/**
 * 两个路径在不在**同一个卷**上。
 *
 * ⚠️ 为什么必须在换包前查：`rename` 跨卷会变成"复制 + 删"，**不再是原子的** ——
 *    拔盘/断电就会留下半个 asar。而 ①②两步里 ①已经成功、②跨卷失败是最坏形态，
 *    所以宁可一开始就拒绝，也不要在半路炸。
 *
 * ⚠️ 局限（如实记）：比的是**路径前缀**（盘符 / POSIX 的 `/`），不是真正的卷 ID。
 *    同一个盘符挂到不同卷（`subst`、网络驱动器重映射）它看不出来。
 *    POSIX 上一切都归 `/`，于是这道检查恒为"同卷" —— 那是**对的**（本来就是一棵树）。
 */
export function isSameVolume(a: string, b: string): boolean {
  const ra = volumeRootOf(a);
  const rb = volumeRootOf(b);
  if (!ra || !rb) return false;
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  return fold(ra) === fold(rb);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  // 流式：包有上百 MB，不能整个读进内存
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** 默认下载器：流式落盘（不把整个 asar 读进内存）。 */
async function downloadToFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error('响应没有 body');
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}

// ------------------------------------------------------------------ 暂存

export type StageFailureReason = 'download-failed' | 'checksum-mismatch' | 'staging-failed' | 'not-same-volume';

export type StageResult =
  | { ok: true; path: string; sha256: string; bytes: number }
  | { ok: false; reason: StageFailureReason; message: string };

export interface StagePortableUpdateInput {
  url: string;
  /** feed 声明的 sha256（十六进制，大小写不敏感）。 */
  expectedSha256: string;
  /** 暂存目录。**必须与目标同卷**，否则最后那次 rename 不是原子的。 */
  stagingDir: string;
  /** 暂存文件名（与目标同名，如 `app.asar`）。 */
  fileName: string;
  /** 目标目录（给了才做同卷检查；不给则跳过，由 `applyPortableSwap` 兜）。 */
  targetDir?: string;
  /** 注入下载器（测试用）。 */
  download?: (url: string, dest: string) => Promise<void>;
}

/**
 * 下载到暂存区并校验。
 *
 * ⚠️ **任何失败都必须把暂存区恢复成原样**。留着半截或校验不过的文件，下一次换包会
 *    把它当成"下好了的包"拿去顶掉好端端的那份 —— 那就从"更新失败"升级成"应用损坏"。
 */
export async function stagePortableUpdate(input: StagePortableUpdateInput): Promise<StageResult> {
  if (input.targetDir && !isSameVolume(input.stagingDir, input.targetDir)) {
    return {
      ok: false,
      reason: 'not-same-volume',
      message: `暂存目录与目标不在同一个卷上（${volumeRootOf(input.stagingDir)} ≠ ${volumeRootOf(input.targetDir)}）——跨卷 rename 不是原子的`,
    };
  }

  const download = input.download ?? downloadToFile;
  const partPath = P().join(input.stagingDir, `${input.fileName}${PART_PREFIX}${randomUUID()}`);
  const finalPath = P().join(input.stagingDir, input.fileName);

  try {
    await fs.mkdir(input.stagingDir, { recursive: true });
    await download(input.url, partPath);
  } catch (err) {
    await removeQuietly(partPath);
    return { ok: false, reason: 'download-failed', message: messageOf(err) };
  }

  let actual: string;
  let bytes: number;
  try {
    actual = await sha256File(partPath);
    bytes = (await fs.stat(partPath)).size;
  } catch (err) {
    await removeQuietly(partPath);
    return { ok: false, reason: 'staging-failed', message: messageOf(err) };
  }

  if (actual.toLowerCase() !== input.expectedSha256.trim().toLowerCase()) {
    // ⚠️ 坏包**当场删**：它冒充"下好了"的代价是顶掉一个好端端的应用
    await removeQuietly(partPath);
    return {
      ok: false,
      reason: 'checksum-mismatch',
      message: `包 sha256 与声明不符（期望 ${input.expectedSha256}，实际 ${actual}）——已丢弃`,
    };
  }

  try {
    // 校验通过才落成正式名：`.part-` 开头的永远不是可用产物
    await fs.rename(partPath, finalPath);
  } catch (err) {
    await removeQuietly(partPath);
    return { ok: false, reason: 'staging-failed', message: messageOf(err) };
  }

  return { ok: true, path: finalPath, sha256: actual, bytes };
}

// ------------------------------------------------------------------ 换包

export type SwapFailureReason = 'checksum-mismatch' | 'not-same-volume' | 'replace-failed';

export type SwapResult =
  | { ok: true; backupPath: string | null }
  | { ok: false; reason: SwapFailureReason; message: string; restored: boolean };

export interface PortableSwapOps {
  rename: (from: string, to: string) => Promise<void>;
}

export interface ApplyPortableSwapInput {
  /** 校验过的暂存文件（`stagePortableUpdate` 的产物）。 */
  stagedFile: string;
  /** 要替换的目标（如 `<app>/resources/app.asar`）。 */
  targetFile: string;
  /** 换包前的**再校验**：暂存到现在可能隔了一次重启，期间盘上的文件可能被动过。 */
  expectedSha256: string;
  ops?: PortableSwapOps;
}

/**
 * 备份 + 原子替换 + 失败回滚。
 *
 * ⚠️ `expectedSha256` 在**这一刻**再查一遍，不是多余的：暂存与换包之间隔着一次重启是常态，
 *    而 U 盘上的文件随时可能被拷坏、被清理工具动过。查到不符就**原地不动** ——
 *    宁可不更新，也不能把一份坏包换上去。
 */
export async function applyPortableSwap(input: ApplyPortableSwapInput): Promise<SwapResult> {
  if (!isSameVolume(input.stagedFile, input.targetFile)) {
    return {
      ok: false,
      reason: 'not-same-volume',
      message: '暂存文件与目标不在同一个卷上——跨卷 rename 不是原子的',
      restored: true, // 什么都没动
    };
  }

  let actual: string;
  try {
    actual = await sha256File(input.stagedFile);
  } catch (err) {
    return { ok: false, reason: 'checksum-mismatch', message: messageOf(err), restored: true };
  }
  if (actual.toLowerCase() !== input.expectedSha256.trim().toLowerCase()) {
    return {
      ok: false,
      reason: 'checksum-mismatch',
      message: `暂存文件 sha256 与声明不符（期望 ${input.expectedSha256}，实际 ${actual}）`,
      restored: true,
    };
  }

  const rename = input.ops?.rename ?? fs.rename;
  const backupPath = `${input.targetFile}${BACKUP_SUFFIX}`;
  const hadTarget = existsSync(input.targetFile);

  // ① 先把旧的原子保住。⚠️ 目标本来就不存在（首次部署形态）时跳过：
  //    不给没有的东西凭空造一个备份，否则收尾那步会删掉一份假的"旧版本"。
  if (hadTarget) {
    try {
      await rename(input.targetFile, backupPath);
    } catch (err) {
      return { ok: false, reason: 'replace-failed', message: messageOf(err), restored: true };
    }
  }

  // ② 换入
  try {
    await rename(input.stagedFile, input.targetFile);
  } catch (err) {
    // ③ 回滚。这一瞬间盘上是"目标不存在、只有 .bak" —— 顶不回去用户就没有应用了。
    if (!hadTarget) {
      return { ok: false, reason: 'replace-failed', message: messageOf(err), restored: true };
    }
    try {
      await rename(backupPath, input.targetFile);
      return { ok: false, reason: 'replace-failed', message: messageOf(err), restored: true };
    } catch (rollbackErr) {
      // 回滚也失败：**如实报 false**，别谎称好了。盘上留着 `.bak`，
      // 下次启动的 `recoverPortableSwap` 还会再试一次。
      return {
        ok: false,
        reason: 'replace-failed',
        message: `${messageOf(err)}；回滚也失败：${messageOf(rollbackErr)}`,
        restored: false,
      };
    }
  }

  return { ok: true, backupPath: hadTarget ? backupPath : null };
}

// ------------------------------------------------------------------ 恢复与收尾

/**
 * 启动时的崩溃恢复：**只有**"目标不存在、`.bak` 在"才动手。
 *
 * ⚠️ 判据不能放宽成"`.bak` 在就恢复"：换包**成功**之后 `.bak` 也是存在的
 *（那是留给收尾用的退路），那时把 `.bak` 顶回去等于把刚换好的新版本又退回旧版 ——
 * 每次启动都白换一遍。
 */
export function recoverPortableSwap(input: { targetFile: string }): 'restored' | 'no-op' {
  const backupPath = `${input.targetFile}${BACKUP_SUFFIX}`;
  if (existsSync(input.targetFile)) return 'no-op';
  if (!existsSync(backupPath)) return 'no-op';
  try {
    // ⚠️ 用同步 rename：这一步发生在启动早期，异步失败会沉进未捕获的 rejection，
    //    而"盘上那份应用回不来"必须当场知道。
    renameSync(backupPath, input.targetFile);
    return 'restored';
  } catch {
    return 'no-op';
  }
}

export type FinalizeResult = 'finalized' | 'kept' | 'no-marker';

/**
 * 启动收尾：跑起来的版本**就是**换进去的那版 ⇒ 换包确实生效了 ⇒ 删掉 `.bak` 与字条。
 *
 * ⚠️ 反过来说，跑起来的**不是**那一版时什么都别删：那说明换包没生效（或者被谁退回去了），
 *    `.bak` 是用户唯一的退路、字条是唯一的线索，都得留着。
 */
export function finalizePortableSwap(input: {
  targetFile: string;
  markerPath: string;
  runningVersion: string;
}): FinalizeResult {
  const marker = readMarker(input.markerPath);
  if (!marker || typeof marker.version !== 'string') return 'no-marker';
  if (normalizeVersion(marker.version) !== normalizeVersion(input.runningVersion)) return 'kept';

  removeQuietlySync(`${input.targetFile}${BACKUP_SUFFIX}`);
  removeQuietlySync(input.markerPath);
  return 'finalized';
}

/** 换包字条。只认 `version`，其余字段是排障线索、读不出来也不影响判断。 */
export interface PortableUpdateMarker {
  version: string;
  [key: string]: unknown;
}

function readMarker(markerPath: string): PortableUpdateMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as PortableUpdateMarker) : null;
  } catch {
    return null; // 没有/读不动/坏 JSON 一律当"没有字条"
  }
}

function normalizeVersion(v: string): string {
  return v.replace(/^v/i, '').trim();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.rm(target, { force: true });
  } catch {
    // 删不掉也得往下走：调用方已经拿到失败结果了
  }
}

function removeQuietlySync(target: string): void {
  try {
    rmSync(target, { force: true });
  } catch {
    // 同上
  }
}
