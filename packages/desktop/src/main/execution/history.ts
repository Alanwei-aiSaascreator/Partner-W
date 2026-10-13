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
}

interface PendingEntry {
  sessionKey: string;
  runId: string;
  record: ExecutionEvent;
  bytes: number;
  priority: 'terminal' | 'progress';
}

const GAP_TYPE = 'evidence.gap' as const;
const VALID_KEY_RE = /^[^/\\:*?"<>|]{1,64}$/;

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

  function recordDiskError(error: unknown): void {
    if (diskError) return;
    diskError = error instanceof Error ? error : new Error(String(error));
    diagnostic({ source: 'execution-history', reason: 'write-error', message: diskError.message });
  }

  function validKey(key: string): boolean {
    return VALID_KEY_RE.test(key) && key !== '.' && key !== '..';
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
      return;
    }
    // 队列预算：溢出时先丢进度（从队尾倒序找），丢不掉再丢本条目；无论如何显式记 gap。
    if (queue.length >= maxQueueEntries || queueBytes + entry.bytes > maxQueueBytes) {
      let madeRoom = false;
      let droppedProgress = 0;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const candidate = queue[i];
        if (candidate.priority === 'progress') {
          queue.splice(i, 1);
          queueBytes -= candidate.bytes;
          droppedProgress += 1;
          madeRoom = true;
          break;
        }
      }
      if (!madeRoom) {
        // 全是终态：丢本条目（若本条目是终态也只能丢 —— 显式记 gap，不静默）
        const dropped = 1;
        diagnostic({
          source: 'execution-history',
          reason: 'queue-full',
          queueDepth: queue.length,
          queueBytes,
          dropped,
        });
        return;
      }
      queue.push(enqueueGap(entry.sessionKey, entry.runId, 'queue-full', droppedProgress, 'overflow'));
      void droppedProgress;
    }
    queue.push(entry);
    queueBytes += entry.bytes;
  }

  function enqueueGap(
    sessionKey: string,
    runId: string,
    reason: string,
    dropped: number,
    _label: string,
  ): PendingEntry {
    const record = gapRecord(runId, '', sessionKey, reason, dropped, now());
    return { sessionKey, runId, record, bytes: entryBytes(record), priority: 'terminal' };
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
          const gap = enqueueGap(entry.sessionKey, entry.runId, 'run-budget', dropped + 1, 'run');
          await writeOne(gap);
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
    const dir = join(workspaceDir, entry.sessionKey);
    const filePath = join(dir, `${entry.runId}.ndjson`);
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
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    queueBytes = 0;
    // ⚠️ 写失败绝不冒泡给调用方（与 logger 同纪律：日志器永远不该弄崩应用）——
    // 失败已由 recordDiskError 闩锁记诊断。
    await enqueueWrite(async () => {
      await writeBatch(batch);
    }).catch(() => undefined);
  }

  function append(sessionKey: string, records: readonly ExecutionEvent[]): void {
    if (!validKey(sessionKey)) {
      diagnostic({ source: 'execution-history', reason: 'invalid-key', message: sessionKey });
      return;
    }
    for (const record of records) {
      if (!validKey(record.runId)) {
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

  async function readRun(sessionKey: string, runId: string): Promise<ExecutionHistoryReadResult> {
    if (!validKey(sessionKey) || !validKey(runId)) {
      return { workspaceKey: options.workspaceKey, sessionKey, runId, records: [], gaps: [], truncated: false };
    }
    const filePath = resolve(join(workspaceDir, sessionKey, `${runId}.ndjson`));
    // 路径围栏：只允许本 workspace 目录内的文件（跨 workspace / 穿越一律拒）。
    if (!filePath.startsWith(resolve(workspaceDir) + sep)) {
      return { workspaceKey: options.workspaceKey, sessionKey, runId, records: [], gaps: [], truncated: false };
    }
    let raw = '';
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return { workspaceKey: options.workspaceKey, sessionKey, runId, records: [], gaps: [], truncated: false };
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
        records.push(parsed);
      } catch {
        // 半行 JSON（崩溃残留）：只容忍**最后一行**，中段损坏显式记缺口。
        if (i === lines.length - 1) continue;
        gaps.push({ reason: 'corrupt-line', dropped: 0, at: now() });
      }
    }
    if (runTruncated.has(`${sessionKey}|${runId}`)) truncated = true;
    if (gaps.some((g) => g.reason === 'run-budget')) truncated = true;
    records.sort((a, b) => a.seq - b.seq);
    return { workspaceKey: options.workspaceKey, sessionKey, runId, records, gaps, truncated };
  }

  async function listRuns(sessionKey: string): Promise<string[]> {
    if (!validKey(sessionKey)) return [];
    try {
      const files = await readdir(join(workspaceDir, sessionKey));
      return files.filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, -'.ndjson'.length));
    } catch {
      return [];
    }
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
    return enqueueWrite(async () => {
      if (!diskError && queue.length > 0) {
        const batch = queue.splice(0, queue.length);
        queueBytes = 0;
        await writeBatch(batch);
      }
    }).catch(() => undefined);
  }

  return { append, start, stop, flush, close, readRun, listRuns };
}
