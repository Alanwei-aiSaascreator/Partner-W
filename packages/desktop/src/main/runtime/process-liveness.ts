/**
 * 进程存活 / 进程身份（启动时间）探测 —— BUG-039 的判据层。
 *
 * 为什么必须"身份"而不只是"存活"：`process.kill(pid, 0)` 只能回答"**这个数字**
 * 现在还对应着某个进程吗"，回答不了"它还是写锁的那个进程吗"。Windows 的 pid
 * 会被系统回收复用（现场实锤：`unreachable` 的旧锁让整块盘卡在"启动准备"），
 * 于是"pid 活着"被当成"网关还在跑"，**换台机器就再也起不来** —— 而用户什么错都
 * 没做。上游 OpenClaw 内核（`gateway-lock-*.mjs` 的 `resolveGatewayOwnerStatus`）
 * 用的正是同一条判据：**锁里记的 `startTime` 与真实进程启动时间比对**，不一致
 * 就是"pid 被复用了，写锁的那个网关早没了"。
 *
 * ⚠️ 三条纪律：
 *  1. **绝不 kill 任何进程** —— 本模块只有信号 0（纯查询）。
 *  2. **绝不抛** —— 探测失败是常态（权限、超时、非 Windows），一律回落成
 *     "无法核验"（`unknown` / `null`），由调用方决定保守到什么程度。
 *  3. **查不到 ≠ 死了** —— "无法核验"必须与"确认已死"分开，否则会把还在跑的
 *     网关判成陈旧锁（那一步是**迁移**，写坏的是用户的数据）。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** 内核（`pid-alive-*.mjs` 的 `isPidAlive`）同款三态。 */
export type PidLiveness = 'alive' | 'gone' | 'unknown';

/** 启动时间比对容差（毫秒）：同一个进程的两次读取可能差毫秒级（取整/精度）。 */
export const PROCESS_START_TOLERANCE_MS = 5_000;

/**
 * 存活探测（**只发信号 0**）。
 *
 * - `ESRCH` ⇒ `gone`（数字不再对应任何进程）
 * - `EPERM` ⇒ `alive`（进程在，只是探不动 —— 内核同样把 EPERM 当存活）
 * - 其它错误 ⇒ `unknown`（"问不出来"，与"确认已死"分开）
 */
export function probePidLiveness(pid: number): PidLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return 'gone';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'gone';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/** 锁里的 `startTime` 与真实进程启动时间是不是同一个进程（容差内）。 */
export function processStartTimeMatches(lockStartTime: number, actualStartTime: number): boolean {
  if (!Number.isFinite(lockStartTime) || !Number.isFinite(actualStartTime)) return false;
  return Math.abs(actualStartTime - lockStartTime) <= PROCESS_START_TOLERANCE_MS;
}

/**
 * 同一个 pid 的启动时间在**一次进程生命周期内**缓存一次。
 *
 * 迁移链上同一条锁会被探两遍（隔离阶段 + 阻断阶段），而每次真实读取是一次
 * PowerShell 调用（百毫秒级）。pid 复用发生在**别的进程死掉之后**，本次运行里
 * 同一个 pid 对应同一个进程 —— 缓存不会掩盖复用。
 */
const startTimeCache = new Map<number, number | null>();

/** 只给测试：清掉启动时间缓存。 */
export function resetProcessStartTimeCache(): void {
  startTimeCache.clear();
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows';
  const normalized = path.win32.normalize(root);
  const safe = /^[A-Za-z]:\\/u.test(normalized) && !normalized.startsWith('\\\\') ? normalized : 'C:\\Windows';
  return path.win32.join(safe, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * 真实进程启动时间（epoch ms）；读不到 `null`（**不抛**）。
 *
 * 只在 Windows 上实现 —— 与内核一致（那边 Linux 读 /proc、macOS 用 ps；
 * 我们产品的现场全部是 Windows，其余平台如实回 `null` = 无法核验）。
 */
export function readProcessStartTime(
  pid: number,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; timeoutMs?: number; cache?: boolean } = {},
): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = opts.platform ?? process.platform;
  const cached = startTimeCache.get(pid);
  if (cached !== undefined) return cached;
  if (platform !== 'win32') return null;

  const timeoutMs = Math.max(200, Math.min(opts.timeoutMs ?? 2_500, 10_000));
  let value: number | null = null;
  try {
    const result = spawnSync(
      windowsPowerShellPath(opts.env ?? process.env),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$process = [System.Diagnostics.Process]::GetProcessById(${pid}); try { [Console]::Out.Write($process.StartTime.ToUniversalTime().ToString('o')) } finally { $process.Dispose() }`,
      ],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (!result.error && result.status === 0 && typeof result.stdout === 'string') {
      const parsed = Date.parse(result.stdout.trim());
      if (Number.isFinite(parsed)) value = parsed;
    }
  } catch {
    value = null;
  }
  // 只缓存"读到了"的结果：读不到往往是暂时性的（超时/权限），缓存它会把一次
  // 抖动钉死成整轮的"无法核验"。
  if (value !== null) startTimeCache.set(pid, value);
  return value;
}
