import { createWriteStream, existsSync, mkdirSync, openSync, unlinkSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { DebugDomain, DebugEvent, DebugLevel } from '@clawwork/shared';
import { sanitizeForLog } from '@clawwork/shared';

interface CreateDebugLoggerOptions {
  debugDir: string;
  maxEvents?: number;
  console?: boolean;
  onEvent?: (event: DebugEvent) => void;
  maxFileSize?: number;
  maxFiles?: number;
  retentionDays?: number;
}

export interface DebugLogFilter {
  level?: DebugLevel[];
  domain?: DebugDomain[];
  gatewayId?: string;
  sessionKey?: string;
  taskId?: string;
  traceId?: string;
  feature?: string;
  limit?: number;
}

export interface LogEventOptions {
  /** Skip console output (used when replaying pre-init buffered events). */
  silent?: boolean;
}

export interface DebugLogger {
  debug: (input: LogEventInput) => DebugEvent;
  info: (input: LogEventInput) => DebugEvent;
  warn: (input: LogEventInput) => DebugEvent;
  error: (input: LogEventInput) => DebugEvent;
  log: (input: LogEventInput & { level: DebugLevel }, options?: LogEventOptions) => DebugEvent;
  getRecentEvents: (filter?: DebugLogFilter) => DebugEvent[];
  currentFilePath: () => string;
  flush: () => Promise<void>;
  /** Flush every pending write and release all file handles. */
  close: () => Promise<void>;
}

export interface LogEventInput {
  domain: DebugDomain;
  event: string;
  traceId?: string;
  feature?: string;
  message?: string;
  gatewayId?: string;
  sessionKey?: string;
  taskId?: string;
  runId?: string;
  requestId?: string;
  wsFrameId?: string;
  seq?: number;
  attempt?: number;
  durationMs?: number;
  ok?: boolean;
  error?: DebugEvent['error'];
  data?: Record<string, unknown>;
}

export function createDebugLogger(options: CreateDebugLoggerOptions): DebugLogger {
  const maxEvents = options.maxEvents ?? 1000;
  const writeConsole = options.console ?? true;
  const maxFileSize = options.maxFileSize ?? 50 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 5;
  const retentionDays = options.retentionDays ?? 14;
  const recentEvents: DebugEvent[] = [];
  const debugDir = options.debugDir;

  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new RangeError('maxFiles must be a positive integer');

  let writeStream: WriteStream | null = null;
  let currentLogDate = '';
  let activeFilePath = '';
  let currentFileSize = 0;
  let pendingWrites = Promise.resolve();
  let diskError: Error | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const ownedFiles: Array<{ path: string; day: string }> = [];
  const nextSlots = new Map<string, number>();

  ensureDir(debugDir);

  function recordDiskError(error: unknown): void {
    if (diskError) return;
    diskError = error instanceof Error ? error : new Error(String(error));
    console.error('[debug] logger disk error:', diskError);
  }

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const next = pendingWrites.then(operation);
    pendingWrites = next.catch(recordDiskError);
    return next;
  }

  function slotPath(day: string, slot: number): string {
    return join(debugDir, `debug-${day}${slot === 0 ? '' : `.${slot}`}.ndjson`);
  }

  function currentFilePath(): string {
    if (activeFilePath) return activeFilePath;
    const day = new Date().toISOString().slice(0, 10);
    let slot = nextSlots.get(day) ?? 0;
    while (existsSync(slotPath(day, slot))) slot++;
    return slotPath(day, slot);
  }

  function pruneOwnedFiles(): void {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    while (
      ownedFiles.length > 0 &&
      (ownedFiles.length >= maxFiles || (retentionDays > 0 && Date.parse(ownedFiles[0].day) < cutoff))
    ) {
      unlinkSync(ownedFiles[0].path);
      ownedFiles.shift();
    }
  }

  function openStream(day: string): void {
    ensureDir(debugDir);
    pruneOwnedFiles();
    let slot = nextSlots.get(day) ?? 0;
    let filePath: string;
    let fd: number;
    for (;;) {
      filePath = slotPath(day, slot++);
      try {
        fd = openSync(filePath, 'wx');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    nextSlots.set(day, slot);
    activeFilePath = filePath;
    currentLogDate = day;
    currentFileSize = 0;
    ownedFiles.push({ path: filePath, day });
    writeStream = createWriteStream(filePath, { fd, autoClose: true }).on('error', recordDiskError);
  }

  async function closeStream(): Promise<void> {
    const stream = writeStream;
    writeStream = null;
    if (!stream || stream.closed) return;
    const closed = new Promise<void>((resolve) => stream.once('close', resolve));
    if (!stream.destroyed && !stream.writableEnded) stream.end();
    await closed;
  }

  async function ensureStream(day: string, nextLineSize: number): Promise<void> {
    if (
      writeStream &&
      currentLogDate === day &&
      (currentFileSize === 0 || currentFileSize + nextLineSize <= maxFileSize)
    )
      return;
    await closeStream();
    if (diskError) throw diskError;
    openStream(day);
  }

  function log(input: LogEventInput & { level: DebugLevel }, logOptions?: LogEventOptions): DebugEvent {
    if (closing) {
      // ⚠️ 2026-10-08 真机（用户点退出弹「A JavaScript error occurred in the main process」，
      //    Uncaught Exception: Debug logger is closing or closed，栈落在网关子进程的
      //    ChildProcess close 回调 → runtime.gateway.output 处理器）：
      //    关闭之后仍有**在途回调**要写日志 —— teardown 已把网关进程杀掉，但它的
      //    stdout/stderr 'data'/'close' 事件还躺在事件循环里，回调进来时 `closing` 已置位。
      //    旧行为在这里 `throw` ⇒ 事件处理器里的同步异常冒到 Electron 主进程 ⇒ 退出时弹
      //    模态错误框（恰在用户以为"用完了"的一刻，观感等于"崩了"）。
      //    **日志器永远不该有能力弄崩应用** ⇒ 关闭后的写入**降级为丢弃**：
      //      · 仍然进 `recentEvents`（排障现场不丢，调试导出照常可读）；
      //      · **绝不重新开流**（原契约的关切保持不变：不复用/不复活未受管的 writer，
      //        本分支不碰 writeStream / enqueue）。
      const dropped: DebugEvent = sanitizeForLog({ ts: new Date().toISOString(), ...input });
      recentEvents.push(dropped);
      if (recentEvents.length > maxEvents) {
        recentEvents.splice(0, recentEvents.length - maxEvents);
      }
      return dropped;
    }
    const now = new Date();
    const event: DebugEvent = sanitizeForLog({
      ts: now.toISOString(),
      ...input,
    });

    recentEvents.push(event);
    if (recentEvents.length > maxEvents) {
      recentEvents.splice(0, recentEvents.length - maxEvents);
    }

    const jsonLine = `${JSON.stringify(event)}\n`;
    const lineSize = Buffer.byteLength(jsonLine, 'utf8');
    const day = now.toISOString().slice(0, 10);
    if (!diskError) {
      void enqueue(async () => {
        if (diskError) throw diskError;
        await ensureStream(day, lineSize);
        currentFileSize += lineSize;
        writeStream!.write(jsonLine, 'utf8');
      });
    }

    if (lineSize > maxFileSize && writeConsole && !logOptions?.silent) {
      console.warn('[debug] Event exceeds file budget; complete sanitized evidence retained:', {
        event: event.event,
        bytes: lineSize,
        maxFileSize,
      });
    }

    if (writeConsole && !logOptions?.silent) {
      const line = `[${event.level}] [${event.domain}] ${event.event}`;
      if (event.level === 'error') console.error(line, event);
      else if (event.level === 'warn') console.warn(line, event);
      else console.log(line, event);
    }

    options.onEvent?.(event);
    return event;
  }

  function flush(): Promise<void> {
    if (closePromise) return closePromise;
    return enqueue(async () => {
      if (diskError) throw diskError;
      if (!writeStream) return;
      await new Promise<void>((resolve, reject) => {
        writeStream!.write(Buffer.alloc(0), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      if (diskError) throw diskError;
    });
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = enqueue(async () => {
      await closeStream();
      if (diskError) throw diskError;
    });
    return closePromise;
  }

  return {
    debug: (input) => log({ ...input, level: 'debug' }),
    info: (input) => log({ ...input, level: 'info' }),
    warn: (input) => log({ ...input, level: 'warn' }),
    error: (input) => log({ ...input, level: 'error' }),
    log,
    getRecentEvents: (filter) => filterEvents(recentEvents, filter),
    currentFilePath,
    flush,
    close,
  };
}

function filterEvents(events: DebugEvent[], filter?: DebugLogFilter): DebugEvent[] {
  let result = [...events];
  if (!filter) return result;
  if (filter.level?.length) result = result.filter((event) => filter.level!.includes(event.level));
  if (filter.domain?.length) result = result.filter((event) => filter.domain!.includes(event.domain));
  if (filter.gatewayId) result = result.filter((event) => event.gatewayId === filter.gatewayId);
  if (filter.sessionKey) result = result.filter((event) => event.sessionKey === filter.sessionKey);
  if (filter.taskId) result = result.filter((event) => event.taskId === filter.taskId);
  if (filter.traceId) result = result.filter((event) => event.traceId === filter.traceId);
  if (filter.feature) result = result.filter((event) => event.feature === filter.feature);
  if (filter.limit && filter.limit > 0) result = result.slice(-filter.limit);
  return result;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
