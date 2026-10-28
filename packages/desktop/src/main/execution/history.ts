import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readdir, readFile, rm, stat, type FileHandle } from 'node:fs/promises';
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
 *   **sha256 小写 hex（定长 64）** 定位，原始身份存**身份包络**（文件首行），
 *   append/list/read 同一映射、读写两侧都核验包络（第二轮 V 修复，见下）；
 * - **R3 队列预算**：条数+字节双项、入队前反复腾位/拒收；缺口按 (session,run) 有界聚合，
 *   flush 时物化一条 `evidence.gap`；`queueStats()` 让不变式可被直接断言；
 * - **R4 listRuns**：按 mtime（可信元数据）最新在前 —— 调用方限额 slice 之前即可确定最新；
 * - **history-order**：readRun 不按来源 seq 重排（seq 只在同生产者域内可比），
 *   文件行序 = 接收顺序 = 重放顺序。
 *
 * ## 2026-10-14 第二轮 V 修复（Codex V-ID-1 / V-ID-2）
 *
 * 第一轮的 base64url 物理组件有两个确定缺陷，本版替换为「定长哈希 + 身份包络核验」：
 *
 * - **V-ID-1 大小写折叠**：可打印 ASCII 身份 `…:aaa:…`→`YWFh…` 与 `…:aaG:…`→`YWFH…`
 *   编码**仅差大小写**；Windows 大小写不敏感文件系统把两者折叠为同一路径 ⇒ 同 runId 时
 *   `readRun` 无法区分、`listRuns` 会串列另一 session 的 run。（把 base64url 转小写只会
 *   把不同编码永久合并，不是修法。）
 * - **V-ID-2 长度判据**：旧检查只数 JS 字符串长度（180）—— `'中'.repeat(180)` 长度 180、
 *   UTF-8 540 字节、编码后 720 字符 ⇒ 物理组件超限，写盘失败被 `recordDiskError` 闩锁，
 *   该 writer 之后**整批停写**。
 *
 * 现在：物理组件 = `crypto.createHash('sha256')` 小写 hex（定长 64、单大小写、字母表无
 * `/ \ .`）；**原身份不丢** —— 每个 run 文件首行是与事件同管道写入的版本化**身份包络**；
 * 读取/列举先验包络再解析事件（路径与正文 runId 都不足以定身份），不匹配 ⇒ 拒收 + 诊断。
 * 旧实现是**未发布特性** ⇒ 不做旧文件兼容读取（旧文件在其它物理路径上且无包络）。
 *
 * ## 2026-10-14 第三轮 · V-final（Codex 第二轮残留合同边界：读头预算）
 *
 * 身份校验（4096 字节上限）与有界读头（16 KiB）原本是**两条独立判据**：`isValidIdentity`
 * 允许双引号，而 `JSON.stringify` 把每个 `"` 转义成 `\"` —— session/run 各 4096 个双引号时
 * 首行包络 16504B > 16 KiB：`readHeadLine` 截断 ⇒ `listRuns` 跳过该文件、重启后的 writer
 * 也核验不了自己写出的文件；而 `readRun`（全文件读）又能读到 ⇒ list/read 分裂。
 *
 * 现在：写入前按**实际序列化包络字节**（真实 workspaceKey/sessionKey/runId + 固定字段 +
 * createdAt 上界宽度余量，判据即 `JSON.stringify` 结果，不是拍的预算数字）统一验限 ——
 * 超预算 ⇒ 拒收该条 + 专属诊断 `identity-envelope-budget`（**不是 I/O 错误**，不闩锁
 * writer、不影响后续条目）；`readRun` 在读侧用**同一预算**对称拒收修复前遗留的超预算文件。
 * 本档未证原生正常负载会触发该边界（正常键 ~100B 包络）—— 修的是"写出自己无法识别的文件"。
 * 旧无包络/base64 文件仍不做迁移读取（身份无法核验即拒收，边界如实保留）。
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
    | 'identity-mismatch'
    | 'identity-envelope-budget'
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
 * R1（2026-10-14 集中修复 · 第二轮 V 重写）· **业务身份 ≠ 物理路径组件**。
 *
 * 原生 sessionKey/runId（多段冒号的任务会话键、含设备域的长键）带冒号且可能远超
 * 64 字符 —— 直接当文件名非法（Windows）。第一轮的 base64url 组件有两个确定缺陷
 * （V-ID-1 大小写折叠、V-ID-2 长度只数字符，见文件头），本版改为：
 *
 * - **物理组件 = sha256 小写 hex**：定长 64、单大小写输出（大小写不敏感文件系统上
 *   不再折叠）、字母表无 `/ \ .`（天然不可穿越）、长度与身份字节数无关（中文长身份
 *   不再撑爆 255 组件上限）。禁止「仅放开冒号」与「`_` 清洗」（后者让 `a:b` 与 `a_b` 撞车）。
 * - **原身份不丢失**：run 文件首行是与事件同管道写入的版本化**身份包络**（下），
 *   读取/列举**先验包络**再解析事件 —— 路径只是定位，身份以包络为准。
 *
 * ⚠️ 旧编码是**未发布特性**：不做旧文件兼容读取（旧文件在别的物理路径上且无包络，
 * 只会在保留期清理时删除）。若未来需要迁移，必须另立迁移程序，不得放宽这里的核验。
 */
const IDENTITY_MAX_BYTES = 4096; // 组件定长 64 ⇒ 与编码长度无关；仅拒绝病态超长身份
const RUN_FILE_SUFFIX = '.ndjson';
/** 身份包络（run 文件首行）字段：路径不可信，身份以它为准。 */
const ENVELOPE_FIELD = '__executionHistoryEnvelope';
const ENVELOPE_VERSION = 1;
/** 包络/文件头**有界读取**上限（单条包络远小于它；杜绝全目录正文扫描）。 */
const ENVELOPE_HEAD_BYTES = 16 * 1024;
/**
 * V-final（2026-10-14 第三轮）· createdAt 参与包络字节计算的**上界余量**。
 *
 * 身份校验发生在写入之前，此刻还没有真实的 createdAt；而包络的**实际序列化字节**
 * （含 JSON 转义）必须能在有界读头内完整读出。毫秒时间戳的序列化宽度不会超过
 * `Number.MAX_SAFE_INTEGER` 的宽度，用它参与计算即可保证：写入前接受的任何身份，
 * 无论落盘瞬间的时间戳取何值，包络都仍在预算内。判据本身仍是真实 `JSON.stringify`
 * 的结果（不是拍一个预算数字）。
 */
const ENVELOPE_CREATED_AT_MARGIN = Number.MAX_SAFE_INTEGER;

interface RunFileEnvelope {
  workspaceKey: string;
  sessionKey: string;
  runId: string;
  createdAt: number;
}

interface RunFileEnvelopeLine extends RunFileEnvelope {
  __executionHistoryEnvelope: number;
}

/** 身份 → 物理组件：sha256 小写 hex（定长 64、单大小写）。append/read/list 同一映射。 */
function identityComponent(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

/** 身份包络对象 —— 写入与字节判据**同一定义**，保证验限与落盘内容逐字节同源。 */
function buildEnvelope(
  workspaceKey: string,
  sessionKey: string,
  runId: string,
  createdAt: number,
): RunFileEnvelopeLine {
  return { __executionHistoryEnvelope: ENVELOPE_VERSION, workspaceKey, sessionKey, runId, createdAt };
}

/**
 * 一行文本的**实际 UTF-8 字节数**是否严格小于有界读头预算（写侧预检与读侧判据共用的
 * 唯一谓词）。`readHeadLine` 最多读 `ENVELOPE_HEAD_BYTES` 字节再找首个换行 ⇒ 行的字节数
 * 必须**严格小于**预算，换行才落在窗口内（CRLF 亦然：`\r` 只会计入行长）。
 */
function headLineFitsBudget(line: string): boolean {
  return Buffer.byteLength(line, 'utf8') < ENVELOPE_HEAD_BYTES;
}

/**
 * **有界**读取 run 文件头的第一行（包络/元数据用途，不读正文）。
 * 文件不存在、是目录、或读取失败 ⇒ null（调用方按"不可核验"处理，绝不猜测）。
 */
async function readHeadLine(filePath: string): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.allocUnsafe(ENVELOPE_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return null;
    const head = buffer.subarray(0, bytesRead);
    const newlineAt = head.indexOf(0x0a);
    return (newlineAt >= 0 ? head.subarray(0, newlineAt) : head).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** 解析身份包络行；非包络（含旧格式裸事件、半行 JSON）一律 null ⇒ 视为不可核验。 */
function parseEnvelope(line: string | null | undefined): RunFileEnvelope | null {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown> | null;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (parsed[ENVELOPE_FIELD] !== ENVELOPE_VERSION) return null;
    const { workspaceKey, sessionKey, runId } = parsed;
    if (typeof workspaceKey !== 'string' || typeof sessionKey !== 'string' || typeof runId !== 'string') {
      return null;
    }
    return {
      workspaceKey,
      sessionKey,
      runId,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 业务身份合法性（与文件系统无关的那部分）：非空、有界、无控制字符、无路径分隔符。
 * 分隔符从来不是合法业务身份（原生键都是 `agent:…:task:…`），拒掉是纵深防线。
 *
 * 长度判据按 **UTF-8 字节**（V-ID-2）：旧实现只数 JS 字符串长度，`'中'.repeat(180)`
 * 长度 180 却能编码出 720 字符的物理组件；现在组件是定长哈希，这里只拒绝病态超长
 * 输入（>4096 字节）并如实记诊断，不再把长度与路径组件上限挂钩。
 */
function isValidIdentity(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (key.length === 0) return false;
  if (Buffer.byteLength(key, 'utf8') > IDENTITY_MAX_BYTES) return false;
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
  /** 第二轮 V：run 文件身份包络核验结果（'ok' | 'mismatch'），按 run 缓存避免每次读头。 */
  const runFileIdentity = new Map<string, 'ok' | 'mismatch'>();
  /**
   * R3：队列丢载的缺口**不占队列槽位**（否则缺口本身就把有界承诺撑破，正是旧缺陷
   * 「删一、加二」），而是按 (session,run) 有界聚合，flush 时每条 run 至多物化一条
   * `evidence.gap`（dropped = 合并计数）。键表有界：超限逐出最旧。
   */
  const pendingGaps = new Map<string, { sessionKey: string; runId: string; reason: string; dropped: number }>();
  const PENDING_GAP_RUN_LIMIT = 64;

  function sessionDirOf(sessionKey: string): string {
    return join(workspaceDir, identityComponent(sessionKey));
  }

  function runFileOf(sessionKey: string, runId: string): string {
    return join(sessionDirOf(sessionKey), `${identityComponent(runId)}${RUN_FILE_SUFFIX}`);
  }

  /**
   * 第二轮 V · **读写共用的身份判据**：包络必须属于本 workspace + 本 sessionKey
   * （`envelopeOwnedBy`），且（对单 run 读写）runId 一致（`envelopeMatches`）。
   * 核心不变量：**路径只是定位，身份以包络为准** —— 不凭目录名或正文 runId 推定 session。
   */
  function envelopeOwnedBy(envelope: RunFileEnvelope | null, sessionKey: string): envelope is RunFileEnvelope {
    return envelope !== null && envelope.workspaceKey === options.workspaceKey && envelope.sessionKey === sessionKey;
  }

  function envelopeMatches(envelope: RunFileEnvelope | null, sessionKey: string, runId: string): boolean {
    return envelopeOwnedBy(envelope, sessionKey) && envelope.runId === runId;
  }

  /**
   * V-final · **写入前的包络预算判据**（与 `listRuns`/`readRun` 的有界读头同一预算）。
   *
   * 按**实际序列化包络字节**计算（含 JSON 转义：每个 `"` → `\"`，中文 → UTF-8 多字节），
   * createdAt 用上界余量。超预算 ⇒ 该 (sessionKey, runId) 绝不落盘 —— 写出去的文件
   * `readHeadLine` 会截断，`listRuns` 看不见、重启后的 writer 也核验不了它。
   */
  function envelopeBudgetExceeded(sessionKey: string, runId: string): boolean {
    return !headLineFitsBudget(
      JSON.stringify(buildEnvelope(options.workspaceKey, sessionKey, runId, ENVELOPE_CREATED_AT_MARGIN)),
    );
  }

  /**
   * 落盘前的身份包络保证（与事件**同一管道**：在 writeOne 内、串行 pendingWrites 上）：
   * - 文件不存在/为空 ⇒ 先写包络行（**永远第 1 行**），再写事件；
   * - 已有文件 ⇒ 只读文件头核验包络（**有界**，不读正文）；不匹配 ⇒ 拒写本条 +
   *   诊断 `identity-mismatch`（他人文件/旧格式文件不得被继续写入，也不得冒充本 run）。
   * 核验结果按 run 缓存，避免每次 append 都读头（与本模块其它 runKey 表同类，按 run 有界）。
   */
  async function ensureRunFileIdentity(entry: PendingEntry, filePath: string): Promise<boolean> {
    const runKey = `${entry.sessionKey}|${entry.runId}`;
    const cached = runFileIdentity.get(runKey);
    if (cached) return cached === 'ok';
    const head = await readHeadLine(filePath);
    if (head === null) {
      const envelope = buildEnvelope(options.workspaceKey, entry.sessionKey, entry.runId, now());
      await appendFile(filePath, `${JSON.stringify(envelope)}\n`, 'utf8');
      runFileIdentity.set(runKey, 'ok');
      return true;
    }
    if (!envelopeMatches(parseEnvelope(head), entry.sessionKey, entry.runId)) {
      runFileIdentity.set(runKey, 'mismatch');
      diagnostic({
        source: 'execution-history',
        reason: 'identity-mismatch',
        runId: entry.runId,
        message: 'run file identity envelope mismatch',
      });
      return false;
    }
    runFileIdentity.set(runKey, 'ok');
    return true;
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
    // 第二轮 V：先核验/写入身份包络，再落事件（同一管道）。包络不匹配 ⇒ 拒写本条，
    // 不污染不可信文件、也不把错误内容写成"本 run 的证据"。
    if (!(await ensureRunFileIdentity(entry, filePath))) return;
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
      // V-final：身份合法 ≠ 包络落盘后可核验 —— 身份上限（4096 字节）允许双引号，而
      // JSON 转义把每个 `"` 变成 `\"`，病态身份足以把首行包络撑过 16 KiB 读头预算。
      // 这种文件写出去就再也读不回来（`listRuns` 截断跳过、重启后 writer 也核验不了），
      // 因此**按实际序列化包络字节**在写入前拒收该条：专属诊断、不闩锁 writer（不是
      // I/O 错误）、不影响后续条目与其它身份。
      if (envelopeBudgetExceeded(sessionKey, record.runId)) {
        diagnostic({
          source: 'execution-history',
          reason: 'identity-envelope-budget',
          runId: record.runId,
          message: `envelope line >= ${ENVELOPE_HEAD_BYTES} bytes`,
        });
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
    // 第二轮 V：**先验身份包络，再解析事件** —— 路径与正文 runId 都不足以定身份。
    // 包络缺失（旧格式/外来文件）或不属于本 workspace/session/run ⇒ 整体拒收（不返回
    // 半份"疑似"证据）并显式记诊断；`evidence.gap` 等正记录只可能存在于已核验文件内。
    //
    // V-final：读侧与写侧**同一预算** —— 首行包络超出有界读头（本不该落盘，例如修复前
    // 构建写出的文件）时 `listRuns` 会截断跳过；`readRun` 也必须在同一判据上拒收，否则
    // 同一文件"列不出来、却能读出整份证词"（第二轮 V 残留的 list/read 分裂）。
    if (!headLineFitsBudget(lines[0])) {
      diagnostic({
        source: 'execution-history',
        reason: 'identity-mismatch',
        runId,
        message: 'run file envelope exceeds head budget',
      });
      return emptyRead(sessionKey, runId);
    }
    if (!envelopeMatches(parseEnvelope(lines[0]), sessionKey, runId)) {
      diagnostic({
        source: 'execution-history',
        reason: 'identity-mismatch',
        runId,
        message: 'run file identity envelope missing or mismatched',
      });
      return emptyRead(sessionKey, runId);
    }
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as ExecutionEvent;
        // 混入的包络行（同文件重复写头）不是事件：跳过，不让它冒充证据。
        if ((parsed as unknown as Record<string, unknown>)[ENVELOPE_FIELD] !== undefined) continue;
        // 判别联合：内联字面量比较才能收窄（helper 只收窄 type 本身，收不了对象）。
        if (parsed.type === 'evidence.gap') {
          gaps.push({
            reason: parsed.payload.reason,
            dropped: parsed.payload.dropped ?? 0,
            at: parsed.receivedAt,
          });
          continue;
        }
        // R1：记录内校验**原始身份** —— 文件里混进的其它 run 记录不得冒充本 run 证据
        //（文件级身份已由首行包络核验；这里再按记录 runId 逐条核对，两层纵深）。
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
   * R4 + 第二轮 V：**在应用限额之前**按可信元数据（文件 mtime）确定最新候选 —— readdir
   * 顺序与 UUID 字典序都不代表时间顺序，调用方 `slice(0,8)` 必须拿到最新 8 个 run。
   *
   * 原始 runId 只能来自**身份包络**（物理文件名是哈希，不可逆）：这里对每个候选文件做
   * **有界读头**（只读第 1 行，不做全目录正文扫描）并核验本 workspace + 本 sessionKey；
   * 核验不过的文件**如实跳过**并留 `identity-mismatch` 诊断。同 mtime 用 runId 升序做
   * **确定性**平局判据。
   */
  async function listRuns(sessionKey: string): Promise<string[]> {
    if (!isValidIdentity(sessionKey)) return [];
    try {
      const dir = sessionDirOf(sessionKey);
      const entries = await readdir(dir, { withFileTypes: true });
      const runs: Array<{ runId: string; mtimeMs: number }> = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(RUN_FILE_SUFFIX)) continue;
        const full = join(dir, entry.name);
        try {
          const info = await stat(full);
          const envelope = parseEnvelope(await readHeadLine(full));
          if (!envelopeOwnedBy(envelope, sessionKey) || !isValidIdentity(envelope.runId)) {
            diagnostic({ source: 'execution-history', reason: 'identity-mismatch', message: entry.name });
            continue;
          }
          runs.push({ runId: envelope.runId, mtimeMs: info.mtimeMs });
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
