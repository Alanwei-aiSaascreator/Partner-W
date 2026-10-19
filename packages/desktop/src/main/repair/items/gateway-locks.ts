/**
 * 修复项 #1 · 坏锁 / 半写锁（SPEC 二·MVP 1，事故背书 BUG-035 / BUG-039）。
 *
 * ## 现场
 *
 * 内核把"谁在跑这个网关"写成一份 JSON 锁（`<state>/tmp/openclaw/gateway.<hash>.lock`
 * 与 `gateway.state.lock`，实测两份同形）。**半写**（断电/被容器杀在半路）或 **pid 复用**
 * 之后，那份锁会永远说"已经有一个网关在跑"，于是整块盘卡在"启动准备"——
 * 用户什么都没做错，换台机器就再也起不来（BUG-035 现场：同事盘卡 17%）。
 *
 * ## 判据链（与 `runtime/portable-state-migration.ts` 的 `resolveLockOwnerProbe` 同源）
 *
 * ① 读不出 / 不是 JSON / 不是对象 / `pid` 不是正整数 ⇒ **corrupt**（可以隔离）
 * ② `pid` 已经不活着（只发信号 0，`ESRCH`）⇒ **stale**（可以隔离）
 * ③ `pid` 活着 + 锁里的 `startTime` 与真实进程启动时间**对得上** ⇒ **live**（一个字都不动）
 * ④ `pid` 活着 + `startTime` **对不上** ⇒ **stale**（pid 被系统回收复用了）
 * ⑤ 判不了（`EPERM` / 拿不到启动时间 / 非 Windows）⇒ **live**（保守：**绝不**动可能真在跑的锁）
 *
 * ⚠️ ⑤ 这条是全部安全性所在：把"问不出来"当成"死了"会去隔离一个**真的活锁**，
 *    那一步动的就是用户正在跑的网关的数据。
 *
 * ## 修法
 *
 * **重命名隔离**（`<原名>.corrupt-<时间戳>`），**不删**（SPEC 二·1「保留现场」）。
 * 重命名后文件名不再以 `.lock` 结尾 ⇒ 第二次跑扫描时它不会被再认成锁（幂等）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RepairAction, RepairMessage } from '@clawwork/shared';
import { probePidLiveness, processStartTimeMatches, readProcessStartTime } from '../../runtime/process-liveness.js';
import { UNSAFE_TARGET_REASON, isRegularFileNoFollow } from '../safe-fs.js';

/** 锁文件所在的相对位置（`<state>/tmp/openclaw/`，实测自真机运行数据）。 */
export const GATEWAY_LOCK_DIR_SEGMENTS = ['tmp', 'openclaw'] as const;

/** 只认这个名字族 —— `gateway.*.lock`（与 `portable-state-migration.ts` 同一把尺）。 */
export const GATEWAY_LOCK_NAME = /^gateway\..*\.lock$/u;

/** 隔离后缀（SPEC 二·1）。 */
export const QUARANTINE_SUFFIX_PREFIX = '.corrupt-';

export type GatewayLockVerdict =
  /** 真网关的锁（或判不出来）—— 绝不动。 */
  | { kind: 'live'; pid: number | null; reason: 'start-time-match' | 'unverifiable' }
  /** 死锁 / pid 复用 —— 可以隔离。 */
  | { kind: 'stale'; pid: number | null; reason: 'pid-gone' | 'pid-reused' }
  /** 读不懂 —— 可以隔离。 */
  | { kind: 'corrupt'; pid: null; reason: 'unreadable' | 'not-json' | 'not-object' | 'bad-pid' };

export interface GatewayLockProbe {
  liveness: (pid: number) => 'alive' | 'gone' | 'unknown';
  startTime: (pid: number) => number | null;
}

const defaultProbe: GatewayLockProbe = {
  liveness: probePidLiveness,
  startTime: (pid) => readProcessStartTime(pid),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 一份锁文本 → 判决（**纯函数**；`probe` 注入，测试不打真进程）。
 */
export function classifyGatewayLock(raw: string, probe: GatewayLockProbe = defaultProbe): GatewayLockVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt', pid: null, reason: 'not-json' };
  }
  if (!isRecord(parsed)) return { kind: 'corrupt', pid: null, reason: 'not-object' };

  const pid = parsed.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { kind: 'corrupt', pid: null, reason: 'bad-pid' };
  }

  const liveness = probe.liveness(pid);
  if (liveness === 'gone') return { kind: 'stale', pid, reason: 'pid-gone' };
  if (liveness === 'unknown') return { kind: 'live', pid, reason: 'unverifiable' };

  const declared = parsed.startTime;
  if (typeof declared !== 'number' || !Number.isFinite(declared)) {
    // 锁里没记启动时间 ⇒ 核验不了"它还是不是写锁那个进程" ⇒ 保守当活锁
    return { kind: 'live', pid, reason: 'unverifiable' };
  }
  const actual = probe.startTime(pid);
  if (actual === null) return { kind: 'live', pid, reason: 'unverifiable' };
  return processStartTimeMatches(declared, actual)
    ? { kind: 'live', pid, reason: 'start-time-match' }
    : { kind: 'stale', pid, reason: 'pid-reused' };
}

export interface GatewayLockFinding {
  path: string;
  stateDir: string;
  verdict: GatewayLockVerdict;
}

/** 锁文件所在的目录（`<state>/tmp/openclaw`）。 */
export function gatewayLockDir(stateDir: string): string {
  return path.join(stateDir, ...GATEWAY_LOCK_DIR_SEGMENTS);
}

/**
 * 扫一个 state 目录里的全部网关锁。**只读、绝不抛**。
 */
export function scanGatewayLocks(opts: { stateDir: string; probe?: GatewayLockProbe }): GatewayLockFinding[] {
  const dir = gatewayLockDir(opts.stateDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const findings: GatewayLockFinding[] = [];
  for (const name of names.sort()) {
    if (!GATEWAY_LOCK_NAME.test(name)) continue;
    const file = path.join(dir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      findings.push({
        path: file,
        stateDir: opts.stateDir,
        verdict: { kind: 'corrupt', pid: null, reason: 'unreadable' },
      });
      continue;
    }
    findings.push({ path: file, stateDir: opts.stateDir, verdict: classifyGatewayLock(raw, opts.probe) });
  }
  return findings;
}

/** 这一条要不要动（只有 stale / corrupt 动）。 */
export function isActionableLock(verdict: GatewayLockVerdict): boolean {
  return verdict.kind !== 'live';
}

/** 隔离后的目标路径（**不落盘**，只算名字）。 */
export function quarantinePathFor(lockPath: string, stamp: string): string {
  return `${lockPath}${QUARANTINE_SUFFIX_PREFIX}${stamp}`;
}

export interface QuarantineResult {
  ok: boolean;
  /** 结果码（机器码；`apply.<reason>` 直接上屏）。 */
  reason: string;
  backupPath: string | null;
}

/**
 * 执行一次隔离：**先重新核验、再备份、最后重命名**。
 *
 * ⚠️ 重新核验那一步是安全性的关键：扫描与点击之间可能过了一段时间，中间用户
 *    **把应用打开了** —— 那时这把锁已经变成活锁。拿扫描时的旧结论去隔离它，
 *    动的就是正在跑的网关。所以这里**以当下的盘面为准**。
 */
export function applyGatewayLockQuarantine(opts: {
  lockPath: string;
  stamp: string;
  probe?: GatewayLockProbe;
  backup: (file: string) => string | null;
  log: (line: string) => void;
}): QuarantineResult {
  // ① 已经不在 ⇒ 别人（或上一轮）已经处理过 —— 当作成功，不当失败
  if (!fs.existsSync(opts.lockPath)) return { ok: true, reason: 'already-gone', backupPath: null };

  // ② ⚠️ junction/symlink 红线（实现，不是注释）：这条锁必须是**普通文件本身**。
  //    对链接改名会把链接挪走、写会写到链接指向的真实文件上 —— 两者都等于动了
  //    不属于我们的东西（state 目录里确实可能有指向真实 node_modules 的 junction）。
  //    目录/链接在这里就被拦下，`readFileSync` 也读不到"内容"（EISDIR 会被误当成
  //    "文件不在了"——第一版就是这么把一次拒绝写成了成功）。
  if (!isRegularFileNoFollow(opts.lockPath)) {
    opts.log(`gateway lock refused (not a regular file) ${opts.lockPath}`);
    return { ok: false, reason: UNSAFE_TARGET_REASON, backupPath: null };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(opts.lockPath, 'utf8');
  } catch {
    // 文件在、但读不出来（被独占锁住等）—— 如实失败，**不许**报成功
    return { ok: false, reason: 'unreadable-lock', backupPath: null };
  }
  const verdict = classifyGatewayLock(raw, opts.probe);
  if (!isActionableLock(verdict)) {
    return { ok: false, reason: 'became-live', backupPath: null };
  }

  const backupPath = opts.backup(opts.lockPath);
  if (backupPath === null) return { ok: false, reason: 'backup-failed', backupPath: null };

  // 同一秒内隔离两把锁时时间戳会撞：**不覆盖**，往后加序号（旧现场永远保留）
  let target = quarantinePathFor(opts.lockPath, opts.stamp);
  for (let attempt = 1; fs.existsSync(target) && attempt <= 100; attempt += 1) {
    target = `${quarantinePathFor(opts.lockPath, opts.stamp)}.${attempt}`;
  }
  try {
    fs.renameSync(opts.lockPath, target);
  } catch {
    return { ok: false, reason: 'rename-failed', backupPath };
  }
  opts.log(`gateway lock quarantined ${opts.lockPath} -> ${target}`);
  return { ok: true, reason: 'quarantined', backupPath };
}

function reasonCode(verdict: GatewayLockVerdict): string {
  return `lock.${verdict.kind}.${verdict.reason}`;
}

/**
 * 扫描结果 → 报告片段（findings / actions）。
 *
 * `actionId` 在**同一份报告内**唯一：`gateway-locks:<序号>`。界面把用户勾中的
 * 那一串回传，`apply` 只认这一串（不认路径），所以这里不许出现"同名不同文件"的歧义。
 */
export function planGatewayLocks(findings: readonly GatewayLockFinding[]): {
  findings: RepairMessage[];
  actions: RepairAction[];
} {
  const messages: RepairMessage[] = [];
  const actions: RepairAction[] = [];
  findings.forEach((finding, index) => {
    const params = { path: finding.path };
    if (finding.verdict.pid !== null)
      messages.push({ code: reasonCode(finding.verdict), params: { ...params, pid: finding.verdict.pid } });
    else messages.push({ code: reasonCode(finding.verdict), params });
    if (!isActionableLock(finding.verdict)) return;
    actions.push({
      actionId: `gateway-locks:${index}`,
      code: 'lock.quarantine',
      params,
      requiresConfirmation: false,
      backup: true,
      targets: [finding.path],
    });
  });
  return { findings: messages, actions };
}
