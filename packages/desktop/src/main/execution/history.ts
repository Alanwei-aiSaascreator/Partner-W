import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { ExecutionEvent, ExecutionEventType } from '@clawwork/core';
import {
  EXECUTION_HISTORY_DIR_BUDGET_BYTES,
  EXECUTION_HISTORY_ENTRY_BUDGET_BYTES,
  EXECUTION_HISTORY_QUEUE_BUDGET_BYTES,
  EXECUTION_HISTORY_QUEUE_LIMIT_ENTRIES,
  EXECUTION_HISTORY_RETENTION_DAYS,
  EXECUTION_HISTORY_RUN_BUDGET_BYTES,
  executionEventPriority,
} from '@clawwork/core';

/**
 * V4（2026-10-13 step 5）· **有界执行证据历史**（main 侧适配器）。
 *
 * 复用 `debug/logger.ts` 的既有经验：写链串行（pendingWrites）、diskError 闩锁
 * （**日志器永远不该弄崩应用** —— 这里同理：磁盘失败只记诊断）、关闭后降级丢弃。
 *
 * ## 硬口径（计划 114–122）
 *
 * - debug 日志有过滤/丢弃，**不能当完整可重放事件库** —— 本模块只存**已收到的
 *   状态边缘**（稳定 eventId + 关联 + 脱敏摘要），不存高频累计 thinking 正文/原始参数；
 * - **fire-and-forget**：`append` 只入队（同步、绝不碰盘）；flush 由外部定时器驱动
 *   （发送与 ack 解耦），renderer 永不等待磁盘；
 * - 队列/单 run/目录三档预算；耗尽时**显式记 gap / 降级诊断**，不静默丢；
 * - 恢复只还原本地证据：缺口保留，不补造"执行中"或"审批通过"；
 * - 按 workspace/account 隔离（实例绑定 workspaceKey + 根目录；跨 workspace 读不到）；
 * - 保留期只清理**本模块自有**的 ndjson 文件（绝不删用户文件/旧 debug 资产）。
 *
 * ## 2026-10-14 集中修复（R1/R3/R4/history-order）
 *
 * - **R1 身份映射**：业务身份（原生 sessionKey/runId）与物理路径组件分离 —— 文件系统用
 *   base64url 稳定编码（append/list/read 同一映射），记录内校验 runId 原始身份；
 * - **R3 队列预算**：条数+字节双项、入队前反复腾位/拒收；缺口按 (session,run) 有界聚合，
 *   flush 时物化一条 `evidence.gap`；`queueStats()` 让不变式可被直接断言；
 * - **R4 listRuns**：按 mtime（可信元数据）最新在前 —— 调用方限额 slice 之前即可确定最新；
 * - **history-order**：readRun 不按来源 seq 重排（seq 只在同生产者域内可比），
 *   文件行序 = 接收顺序 = 重放顺序。
 */

export interface ExecutionHistoryDiagnostic {
  source: 'execution-history';
  reason:
    | 'queue-full'
    | 'run-budget'
    | 'dir-budget'
    | 'write-error'
    | 'closed-drop'
    | 'entry-budget'
    | 'invalid-key'
    | 'retention';
  queueDepth?: number;
  queueBytes?: number;
  dropped?: number;
  runId?: string;
  message?: string;
}

export interface ExecutionHistoryOptions {
  rootDir: string;
  workspaceKey: string;
  now?: () => number;
  flushIntervalMs?: number;
  maxQueueEntries?: number;
  maxQueueBytes?: number;
  maxEntryBytes?: number;
  maxRunBytes?: number;
  maxDirBytes?: number;
  retentionDays?: number;
  onDiagnostic?: (diagnostic: ExecutionHistoryDiagnostic) => void;
}

export interface ExecutionHistoryGap {
  reason: string;
  dropped: number;
  at: number;
}

export interface ExecutionHistoryReadResult {
  workspaceKey: string;
  sessionKey: string;
  runId: string;
  records: ExecutionEvent[];
  gaps: ExecutionHistoryGap[];
  /** 该 run 因预算被截断（此后进度不再落盘）。 */
  truncated: boolean;
}

export interface ExecutionHistoryStore {
  /** 入队（同步、不碰盘）。 */
  append(sessionKey: string, records: readonly ExecutionEvent[]): void;
  /** 外部定时驱动的落盘循环。 */
  start(): void;
  stop(): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  readRun(sessionKey: string, runId: string): Promise<ExecutionHistoryReadResult>;
  listRuns(sessionKey: string): Promise<string[]>;
  /**
   * 诊断/测试观测点：当前待写队列的条数与字节。
   *
   * 不变式（R3）：`entries ≤ maxQueueEntries`、`bytes ≤ maxQueueBytes`，
   * 且 `bytes` ≡ 队列里每条记录**实际编码字节**的总和（缺口/诊断不占队列）。
   */
  queueStats(): { entries: number; bytes: number };
}

interface PendingEntry {
  sessionKey: string;
  runId: string;
  record: ExecutionEvent;
  bytes: number;
  priority: 'terminal' | 'progress';
}

const GAP_TYPE = 'evidence.gap' as const;

/**
 * R1（2026-10-14 集中修复）· **业务身份 ≠ 物理路径组件**。
 *
 * 原生 sessionKey/runId（多段冒号的任务会话键、含设备域的长键）带冒号且可能远超
 * 64 字符 —— 直接当文件名既非法（Windows）又被旧正则整体拒绝（R1：真实键静默丢）。
 * 这里：**业务身份保留原样**（记录内校验用），文件系统用 base64url **稳定可逆编码**
 * （同一映射用于 append/list/read；编码字母表无 `/ \ .`，天然不可穿越）。
 * 禁止「仅放开冒号」与「特殊字符全替换 `_`」（后者会让 `a:b` 与 `a_b` 撞同一个文件）。
 */
const IDENTITY_MAX_CHARS = 180; // 编码后 ≤240，加 `.ndjson` 仍 < 单组件 255 上限
const RUN_FILE_SUFFIX = '.ndjson';

function encodeIdentityComponent(identity: string): string {
  return Buffer.from(identity, 'utf8').toString('base64url');
}

/** 解码物理组件；非规范编码（往返不一致）一律 null（拒收）。 */
function decodeIdentityComponent(component: string): string | null {
  try {
    const decoded = Buffer.from(component, 'base64url').toString('utf8');
    return encodeIdentityComponent(decoded) === component ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * 业务身份合法性（与文件系统无关的那部分）：非空、有界、无控制字符、无路径分隔符。
 * 分隔符从来不是合法业务身份（原生键都是 `agent:…:task:…`），拒掉是纵深防线。
 *
 * 控制字符拒收另有一层理由：Windows 目录不区分大小写，而 base64url **区分** ——
 * 首字节落入 0x00–0x17（C0 控制区）与 0x68+ 的两串身份能编出"仅大小写不同"的组件名，
 * 在大小写不敏感的文件系统上撞同一个文件。ASCII 身份里这条路径被控制字符拒收堵死；
 * 残留边界（非 ASCII 身份 × 大小写不敏感文件系统）如实记录，不声称数学上无碰撞。
 */
function isValidIdentity(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > IDENTITY_MAX_CHARS) return false;
  if (key === '.' || key === '..') return false;
  if (key.includes('/') || key.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex -- 拒收 C0/DEL 正是本行的目的
  if (/[\u0000-\u001f\u007f]/.test(key)) return false;
  return true;
}

function isGapType(type: ExecutionEventType): type is 'evidence.gap' {
  return type === GAP_TYPE;
}

function gapRecord(
  runId: string,
  taskId: string,
  sessionKey: string,
  reason: string,
  dropped: number,
  now: number,
): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId: `gap:${runId}:${now}:${reason}`,
    seq: Number.MAX_SAFE_INTEGER - 1,
    runId,
    taskId,
    source: {
      gatewayId: 'local',
      channel: 'local',
      nativeSessionKey: sessionKey,
      nativeRunId: runId,
      event: 'local',
      derivedIndex: 0,
    },
    evidence: 'observed',
    receivedAt: now,
    type: GAP_TYPE,
    payload: { reason, dropped },
  };
}

export function createExecutionHistory(options: ExecutionHistoryOptions): ExecutionHistoryStore {
  const now = options.now ?? Date.now;
  const maxQueueEntries = options.maxQueueEntries ?? EXECUTION_HISTORY_QUEUE_LIMIT_ENTRIES;
  const maxQueueBytes = options.maxQueueBytes ?? EXECUTION_HISTORY_QUEUE_BUDGET_BYTES;
  const maxEntryBytes = options.maxEntryBytes ?? EXECUTION_HISTORY_ENTRY_BUDGET_BYTES;
  const maxRunBytes = options.maxRunBytes ?? EXECUTION_HISTORY_RUN_BUDGET_BYTES;
  const maxDirBytes = options.maxDirBytes ?? EXECUTION_HISTORY_DIR_BUDGET_BYTES;
  const retentionDays = options.retentionDays ?? EXECUTION_HISTORY_RETENTION_DAYS;
  const workspaceDir = join(options.rootDir, options.workspaceKey);

  const diagnostic = (diag: ExecutionHistoryDiagnostic): void => {
    options.onDiagnostic?.(diag);
  };

  const queue: PendingEntry[] = [];
  let queueBytes = 0;
  let pendingWrites = Promise.resolve();
  let diskError: Error | undefined;
  let closing = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let dirBytesCache: { value: number; at: number } | undefined;
  let dirBudgetExhausted = false;
  const runWrittenBytes = new Map<string, number>();
  const runTruncated = new Set<string>();
  const runGapDropped = new Map<string, number>();
  /**
   * R3：队列丢载的缺口**不占队列槽位**（否则缺口本身就把有界承诺撑破，正是旧缺陷
   * 「删一、加二」），而是按 (session,run) 有界聚合，flush 时每条 run 至多物化一条
   * `evidence.gap`（dropped = 合并计数）。键表有界：超限逐出最旧。
   */
  const pendingGaps = new Map<string, { sessionKey: string; runId: string; reason: string; dropped: number }>();
  const PENDING_GAP_RUN_LIMIT = 64;

  function sessionDirOf(sessionKey: string): string {
    return join(workspaceDir, encodeIdentityComponent(sessionKey));
  }

  function runFileOf(sessionKey: string, runId: string): string {
    return join(sessionDirOf(sessionKey), `${encodeIdentityComponent(runId)}${RUN_FILE_SUFFIX}`);
  }

  function recordDiskError(error: unknown): void {
    if (diskError) return;
    diskError = error instanceof Error ? error : new Error(String(error));
    diagnostic({ source: 'execution-history', reason: 'write-error', message: diskError.message });
  }

  function noteDropped(sessionKey: string, runId: string, reason: string, count = 1): void {
    const key = `${sessionKey}|${runId}`;
    const existing = pendingGaps.get(key);
    if (existing) {
      existing.dropped += count;
      return;
    }
    if (pendingGaps.size >= PENDING_GAP_RUN_LIMIT) {
      const oldest = pendingGaps.keys().next().value;
      if (oldest !== undefined) pendingGaps.delete(oldest);
    }
    pendingGaps.set(key, { sessionKey, runId, reason, dropped: count });
  }

  /** 取出并清空待物化的缺口（按 run 有界）。 */
  function takePendingGaps(): PendingEntry[] {
    const entries: PendingEntry[] = [];
    for (const gap of pendingGaps.values()) {
      const record = gapRecord(gap.runId, '', gap.sessionKey, gap.reason, gap.dropped, now());
      entries.push({
        sessionKey: gap.sessionKey,
        runId: gap.runId,
        record,
        bytes: entryBytes(record),
        priority: 'terminal',
      });
    }
    pendingGaps.clear();
    return entries;
  }

  function entryBytes(record: ExecutionEvent): number {
    try {
      return Buffer.byteLength(JSON.stringify(record));
    } catch {
      return maxEntryBytes + 1;
    }
  }

  async function workspaceDirBytes(): Promise<number> {
    if (dirBytesCache && now() - dirBytesCache.at < 30_000) return dirBytesCache.value;
    let total = 0;
    try {
      for (const entry of await readdir(workspaceDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sessionDir = join(workspaceDir, entry.name);
        for (const file of await readdir(sessionDir)) {
          if (!file.endsWith('.ndjson')) continue;
          try {
            total += (await stat(join(sessionDir, file))).size;
          } catch {
            /* 文件可能刚被清理 */
          }
        }
      }
    } catch {
      /* 目录不存在 ⇒ 0 */
    }
    dirBytesCache = { value: total, at: now() };
    return total;
  }

  /** 保留期清理：只删本模块自有的过期 ndjson（模式匹配 + 位于本 workspace 目录内）。 */
  async function pruneExpired(): Promise<void> {
    if (retentionDays <= 0) return;
    const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000;
    try {
      for (const entry of await readdir(workspaceDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sessionDir = join(workspaceDir, entry.name);
        for (const file of await readdir(sessionDir)) {
          if (!file.endsWith('.ndjson')) continue;
          const full = join(sessionDir, file);
          try {
            const info = await stat(full);
            if (info.mtimeMs < cutoff) {
              await rm(full, { force: true });
              diagnostic({ source: 'execution-history', reason: 'retention', message: file });
            }
          } catch {
            /* 忽略单文件失败 */
          }
        }
      }
    } catch {
      /* 目录不存在 */
    }
  }

  /**
   * R3（2026-10-14 集中修复）· 入队预算：**条数 + 字节双项、反复腾位/拒收**。
   *
   * 旧缺陷：「删一条 progress、再塞 gap + incoming」净增一条，且 gap 字节不计入
   * queueBytes ⇒ 持续追加可突破条数与字节两个上限（有界承诺失效）。
   * 现在：丢载只丢队列里**已有的进度**（先丢最早的 —— 新进度取代旧进度），缺口
   * 走有界待物化表；无论如何腾不出位（队列全是终态 / 单条超剩余预算）⇒ 拒收本条目
   * 并显式报告缺证（诊断 + 持久化缺口），**不吹「永不丢终态」**。
   */
  function enqueue(entry: PendingEntry): void {
    if (closing) {
      diagnostic({ source: 'execution-history', reason: 'closed-drop', queueDepth: queue.length });
      return;
    }
    if (entry.bytes > maxEntryBytes) {
      diagnostic({
        source: 'execution-history',
        reason: 'entry-budget',
        runId: entry.runId,
        message: `${entry.bytes} > ${maxEntryBytes}`,
      });
      noteDropped(entry.sessionKey, entry.runId, 'entry-budget');
      return;
    }
    let droppedProgress = 0;
    while (queue.length + 1 > maxQueueEntries || queueBytes + entry.bytes > maxQueueBytes) {
      const index = queue.findIndex((candidate) => candidate.priority === 'progress');
      if (index < 0) break; // 没有可丢的进度槽位
      const [evicted] = queue.splice(index, 1);
      queueBytes -= evicted.bytes;
      droppedProgress += 1;
      noteDropped(evicted.sessionKey, evicted.runId, 'queue-full');
    }
    if (queue.length + 1 > maxQueueEntries || queueBytes + entry.bytes > maxQueueBytes) {
      // 腾不到位：拒收本条目（哪怕它是终态）—— 缺证显式报告，不静默、不越界。
      diagnostic({
        source: 'execution-history',
        reason: 'queue-full',
        runId: entry.runId,
        queueDepth: queue.length,
        queueBytes,
        dropped: 1 + droppedProgress,
      });
      noteDropped(entry.sessionKey, entry.runId, 'queue-full');
      return;
    }
    if (droppedProgress > 0) {
      diagnostic({
        source: 'execution-history',
        reason: 'queue-full',
        runId: entry.runId,
        queueDepth: queue.length,
        queueBytes,
        dropped: droppedProgress,
      });
    }
    queue.push(entry);
    queueBytes += entry.bytes;
  }

  async function writeBatch(entries: PendingEntry[]): Promise<void> {
    for (const entry of entries) {
      const runKey = `${entry.sessionKey}|${entry.runId}`;
      const truncated = runTruncated.has(runKey);
      const isProgress = entry.priority === 'progress';
      const isGap = isGapType(entry.record.type);

      if (!truncated && isProgress) {
        const written = runWrittenBytes.get(runKey) ?? 0;
        if (written + entry.bytes > maxRunBytes) {
          runTruncated.add(runKey);
          const dropped = runGapDropped.get(runKey) ?? 0;
          runGapDropped.set(runKey, dropped + 1);
          // 写一条 run-budget gap（终端路径不受此限）
          const record = gapRecord(entry.runId, '', entry.sessionKey, 'run-budget', dropped + 1, now());
          await writeOne({
            sessionKey: entry.sessionKey,
            runId: entry.runId,
            record,
            bytes: entryBytes(record),
            priority: 'terminal',
          });
          diagnostic({ source: 'execution-history', reason: 'run-budget', runId: entry.runId, dropped: dropped + 1 });
          continue; // 进度丢弃（显式已记）
        }
      }
      if (truncated && isProgress) continue; // 已截断：进度不再落盘（gap 已记）
      if (isGap) {
        await writeOne(entry);
        continue;
      }
      await writeOne(entry);
    }
  }

  async function writeOne(entry: PendingEntry): Promise<void> {
    if (dirBudgetExhausted) {
      diagnostic({ source: 'execution-history', reason: 'dir-budget', runId: entry.runId });
      return;
    }
    const dirBytes = await workspaceDirBytes();
    if (dirBytes + entry.bytes > maxDirBytes) {
      dirBudgetExhausted = true;
      diagnostic({
        source: 'execution-history',
        reason: 'dir-budget',
        runId: entry.runId,
        message: `${dirBytes} + ${entry.bytes} > ${maxDirBytes}`,
      });
      return;
    }
    const dir = sessionDirOf(entry.sessionKey);
    const filePath = runFileOf(entry.sessionKey, entry.runId);
    await mkdir(dir, { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry.record)}\n`, 'utf8');
    const runKey = `${entry.sessionKey}|${entry.runId}`;
    runWrittenBytes.set(runKey, (runWrittenBytes.get(runKey) ?? 0) + entry.bytes);
    dirBytesCache = undefined;
  }

  function enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = pendingWrites.then(operation);
    pendingWrites = next.catch(recordDiskError);
    return next;
  }

  async function flush(): Promise<void> {
    if (diskError) return; // 磁盘已坏：只留诊断，不重试风暴
    const gaps = takePendingGaps();
    if (queue.length === 0 && gaps.length === 0) return;
    const batch = [...gaps, ...queue.splice(0, queue.length)];
    queueBytes = 0;
    // ⚠️ 写失败绝不冒泡给调用方（与 logger 同纪律：日志器永远不该弄崩应用）——
    // 失败已由 recordDiskError 闩锁记诊断。
    await enqueueWrite(async () => {
      await writeBatch(batch);
    }).catch(() => undefined);
  }

  function append(sessionKey: string, records: readonly ExecutionEvent[]): void {
    if (!isValidIdentity(sessionKey)) {
      diagnostic({ source: 'execution-history', reason: 'invalid-key', message: sessionKey });
      return;
    }
    for (const record of records) {
      if (!isValidIdentity(record.runId)) {
        diagnostic({ source: 'execution-history', reason: 'invalid-key', message: record.runId });
        continue;
      }
      enqueue({
        sessionKey,
        runId: record.runId,
        record,
        bytes: entryBytes(record),
        priority: executionEventPriority(record.type),
      });
    }
  }

  function emptyRead(sessionKey: string, runId: string): ExecutionHistoryReadResult {
    return { workspaceKey: options.workspaceKey, sessionKey, runId, records: [], gaps: [], truncated: false };
  }

  async function readRun(sessionKey: string, runId: string): Promise<ExecutionHistoryReadResult> {
    if (!isValidIdentity(sessionKey) || !isValidIdentity(runId)) {
      return emptyRead(sessionKey, runId);
    }
    const filePath = resolve(runFileOf(sessionKey, runId));
    // 路径围栏：只允许本 workspace 目录内的文件（跨 workspace / 穿越一律拒）。
    if (!filePath.startsWith(resolve(workspaceDir) + sep)) {
      return emptyRead(sessionKey, runId);
    }
    let raw = '';
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return emptyRead(sessionKey, runId);
    }
    const records: ExecutionEvent[] = [];
    const gaps: ExecutionHistoryGap[] = [];
    let truncated = false;
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as ExecutionEvent;
        // 判别联合：内联字面量比较才能收窄（helper 只收窄 type 本身，收不了对象）。
        if (parsed.type === 'evidence.gap') {
          gaps.push({
            reason: parsed.payload.reason,
            dropped: parsed.payload.dropped ?? 0,
            at: parsed.receivedAt,
          });
          continue;
        }
        // R1：记录内校验**原始身份** —— 文件里混进的其它 run 记录不得冒充本 run 证据。
        //（物理目录身份由同一编码映射决定；记录身份以 runId 为准。）
        if (parsed.runId !== runId) {
          gaps.push({ reason: 'identity-mismatch', dropped: 0, at: now() });
          continue;
        }
        records.push(parsed);
      } catch {
        // 半行 JSON（崩溃残留）：只容忍**最后一行**，中段损坏显式记缺口。
        if (i === lines.length - 1) continue;
        gaps.push({ reason: 'corrupt-line', dropped: 0, at: now() });
      }
    }
    if (runTruncated.has(`${sessionKey}|${runId}`)) truncated = true;
    if (gaps.some((g) => g.reason === 'run-budget')) truncated = true;
    // history-order（2026-10-14）：**不按来源 seq 重排** —— seq 是各生产者实例自己的
    // 计数域（dispatcher 与 main 各从 0 起、重建还会重置），跨域不可比。文件里的
    // 行序 ≡ writer 串行落盘顺序 ≡ 事件接收顺序，恢复重放必须按这个顺序。
    return { workspaceKey: options.workspaceKey, sessionKey, runId, records, gaps, truncated };
  }

  /**
   * R4：**在应用限额之前**按可信元数据（文件 mtime）确定最新候选 —— readdir 顺序与
   * UUID 字典序都不代表时间顺序，调用方 `slice(0,8)` 必须拿到最新 8 个 run。
   * 只 stat 元数据，不读正文；同 mtime 用 runId 升序做**确定性**平局判据。
   */
  async function listRuns(sessionKey: string): Promise<string[]> {
    if (!isValidIdentity(sessionKey)) return [];
    try {
      const dir = sessionDirOf(sessionKey);
      const entries = await readdir(dir, { withFileTypes: true });
      const runs: Array<{ runId: string; mtimeMs: number }> = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(RUN_FILE_SUFFIX)) continue;
        const runId = decodeIdentityComponent(entry.name.slice(0, -RUN_FILE_SUFFIX.length));
        if (!runId || !isValidIdentity(runId)) continue;
        try {
          const info = await stat(join(dir, entry.name));
          runs.push({ runId, mtimeMs: info.mtimeMs });
        } catch {
          /* 文件刚被清理：跳过 */
        }
      }
      runs.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
      return runs.map((run) => run.runId);
    } catch {
      return [];
    }
  }

  function queueStats(): { entries: number; bytes: number } {
    return { entries: queue.length, bytes: queueBytes };
  }

  function start(): void {
    void pruneExpired();
    if (timer) return;
    timer = setInterval(() => {
      void flush();
    }, options.flushIntervalMs ?? 1000);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function close(): Promise<void> {
    closing = true;
    stop();
    const gaps = takePendingGaps();
    const batch = [...gaps, ...queue.splice(0, queue.length)];
    queueBytes = 0;
    return enqueueWrite(async () => {
      if (!diskError && batch.length > 0) {
        await writeBatch(batch);
      }
    }).catch(() => undefined);
  }

  return { append, start, stop, flush, close, readRun, listRuns, queueStats };
}
