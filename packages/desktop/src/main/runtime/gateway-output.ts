export type GatewayOutputStream = 'stdout' | 'stderr';

export interface GatewayOutputLine {
  stream: GatewayOutputStream;
  text: string;
  repeat: number;
  summary: boolean;
  dropped: number;
}

export interface GatewayOutputStats {
  lines: number;
  emitted: number;
  repeats: number;
  dropped: number;
  sinkErrors: number;
}

export interface GatewayOutputDrain {
  push: (stream: GatewayOutputStream, chunk: string) => void;
  flush: () => void;
  tail: () => string[];
  stats: () => GatewayOutputStats;
}

export interface GatewayOutputDrainOptions {
  secrets?: readonly string[];
  maxLineBytes?: number;
  tailBytes?: number;
  maxLinesPerSecond?: number;
  now?: () => number;
  onSinkError?: (error: unknown) => void;
}

export interface GatewayOutputReadable {
  setEncoding: (encoding: 'utf8') => unknown;
  on: (event: 'data', listener: (chunk: string) => void) => unknown;
}

export interface GatewayOutputStreamSource {
  stdout: GatewayOutputReadable | null;
  stderr: GatewayOutputReadable | null;
  /** `close` 保证 stdio 已经排空；`exit` 可能早于最后一段 pipe 数据。 */
  onClose: (listener: () => void) => void;
}

const REDACTED = '***redacted***';
const DEFAULT_MAX_LINE_BYTES = 8 * 1024;
const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_MAX_LINES_PER_SECOND = 20;
const MIN_SECRET_LENGTH = 8;

function redactGatewayOutput(text: string, secrets: readonly string[]): string {
  let redacted = text
    .replace(/(\bAuthorization\s*:\s*Bearer\s+)[^\s]+/gi, `$1${REDACTED}`)
    .replace(/\b((?:wss?|https?):\/\/)[^/\s@]+@/gi, `$1${REDACTED}@`)
    .replace(
      /([?&](?:access[_-]?token|token|api[_-]?key|apikey|password|secret|authorization)=)[^&\s#]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /(["']?(?:access[_-]?token|token|api[_-]?key|apikey|password|secret)["']?\s*[:=]\s*)(["']?)[^"',}\s&]+/gi,
      `$1$2${REDACTED}`,
    )
    .replace(/(["']?authorization["']?\s*[:=]\s*)(?!Bearer\b)(["']?)[^"',}\s&]+/gi, `$1$2${REDACTED}`);

  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

function truncateUtf8(text: string, maxBytes: number, originalLength = text.length): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;

  const marker = `<truncated len=${originalLength}>`;
  const prefixBytes = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const prefix = bytes
    .subarray(0, prefixBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
  return `${prefix}${marker}`;
}

export function createGatewayOutputDrain(
  options: GatewayOutputDrainOptions,
  sink: (line: GatewayOutputLine) => void,
): GatewayOutputDrain {
  const maxLineBytes = Math.max(1, options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
  const tailBytes = Math.max(1, options.tailBytes ?? DEFAULT_TAIL_BYTES);
  const maxLinesPerSecond = Math.max(1, options.maxLinesPerSecond ?? DEFAULT_MAX_LINES_PER_SECOND);
  const now = options.now ?? Date.now;
  const maxBufferedChars = Math.max(4096, maxLineBytes * 4);

  const partials: Record<GatewayOutputStream, { text: string; length: number; overflow: boolean }> = {
    stdout: { text: '', length: 0, overflow: false },
    stderr: { text: '', length: 0, overflow: false },
  };
  const repeats = new Map<GatewayOutputStream, { text: string; count: number }>();
  const tail: Array<{ text: string; bytes: number }> = [];
  let tailSize = 0;
  let windowStartedAt = now();
  let emittedInWindow = 0;
  let droppedPending = 0;
  const totals: GatewayOutputStats = { lines: 0, emitted: 0, repeats: 0, dropped: 0, sinkErrors: 0 };

  const appendTail = (text: string): void => {
    let value = text;
    let bytes = Buffer.byteLength(value, 'utf8') + 1;
    if (bytes > tailBytes) {
      const raw = Buffer.from(value, 'utf8');
      value = raw.subarray(Math.max(0, raw.byteLength - Math.max(1, tailBytes - 1))).toString('utf8');
      value = value.replace(/^\uFFFD/u, '');
      bytes = Buffer.byteLength(value, 'utf8') + 1;
    }
    tail.push({ text: value, bytes });
    tailSize += bytes;
    while (tailSize > tailBytes && tail.length > 1) {
      const removed = tail.shift();
      if (removed) tailSize -= removed.bytes;
    }
  };

  const emit = (line: Omit<GatewayOutputLine, 'dropped'>): void => {
    const current = now();
    if (current - windowStartedAt >= 1000) {
      windowStartedAt = current;
      emittedInWindow = 0;
    }

    if (emittedInWindow >= maxLinesPerSecond) {
      totals.dropped += 1;
      droppedPending += 1;
      return;
    }
    emittedInWindow += 1;

    const output: GatewayOutputLine = { ...line, dropped: droppedPending };
    droppedPending = 0;
    totals.emitted += 1;
    try {
      sink(output);
    } catch (error) {
      totals.sinkErrors += 1;
      try {
        options.onSinkError?.(error);
      } catch {
        // 排空子进程管道比错误回调本身更重要；这里绝不能反向打断 data listener。
      }
    }
  };

  const flushRepeats = (stream: GatewayOutputStream): void => {
    const group = repeats.get(stream);
    if (!group || group.count <= 1) return;
    emit({ stream, text: group.text, repeat: group.count, summary: true });
    group.count = 1;
  };

  const acceptLine = (stream: GatewayOutputStream, raw: string, originalLength: number, overflow: boolean): void => {
    if (originalLength === 0) return;
    totals.lines += 1;

    const text = overflow
      ? `<truncated len=${originalLength}>`
      : truncateUtf8(redactGatewayOutput(raw, options.secrets ?? []), maxLineBytes, originalLength);
    appendTail(text);

    const previous = repeats.get(stream);
    if (previous?.text === text) {
      previous.count += 1;
      totals.repeats += 1;
      return;
    }
    flushRepeats(stream);
    repeats.set(stream, { text, count: 1 });
    emit({ stream, text, repeat: 1, summary: false });
  };

  const appendPartial = (stream: GatewayOutputStream, value: string): void => {
    const state = partials[stream];
    state.length += value.length;
    const room = Math.max(0, maxBufferedChars - state.text.length);
    if (room > 0) state.text += value.slice(0, room);
    if (value.length > room) state.overflow = true;
  };

  const finishPartial = (stream: GatewayOutputStream, hadCarriageReturn: boolean): void => {
    const state = partials[stream];
    const raw = hadCarriageReturn && state.text.endsWith('\r') ? state.text.slice(0, -1) : state.text;
    const originalLength = Math.max(0, state.length - (hadCarriageReturn ? 1 : 0));
    acceptLine(stream, raw, originalLength, state.overflow);
    partials[stream] = { text: '', length: 0, overflow: false };
  };

  const push = (stream: GatewayOutputStream, chunk: string): void => {
    const parts = chunk.split('\n');
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? '';
      appendPartial(stream, part);
      if (index < parts.length - 1) finishPartial(stream, part.endsWith('\r'));
    }
  };

  const flush = (): void => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const state = partials[stream];
      if (state.length > 0) finishPartial(stream, false);
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      flushRepeats(stream);
      repeats.delete(stream);
    }
  };

  return {
    push,
    flush,
    tail: () => tail.map((entry) => entry.text),
    stats: () => ({ ...totals }),
  };
}

export function attachGatewayOutputStreams(
  source: GatewayOutputStreamSource,
  options: GatewayOutputDrainOptions,
  sink: (line: GatewayOutputLine) => void,
): GatewayOutputDrain {
  const drain = createGatewayOutputDrain(options, sink);
  for (const stream of ['stdout', 'stderr'] as const) {
    const readable = source[stream];
    if (!readable) continue;
    readable.setEncoding('utf8');
    readable.on('data', (chunk) => drain.push(stream, chunk));
  }
  source.onClose(() => drain.flush());
  return drain;
}

/** 生产日志只落不可逆指纹；自由文本仍只在有界、已脱敏的进程内 tail 中。 */
export function gatewayOutputDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
import { createHash } from 'node:crypto';
