import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createDebugLogger } from '../src/main/debug/logger';

const capture = vi.hoisted(() => ({
  streams: new Set<import('node:fs').WriteStream>(),
  streamPaths: new Map<import('node:fs').WriteStream, string>(),
  unsafeRenames: [] as string[],
  unsafeDeletes: [] as string[],
  delayFirst: false,
  failFirst: false,
  release: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      const stream = actual.createWriteStream(...args);
      capture.streams.add(stream);
      capture.streamPaths.set(stream, String(args[0]));
      stream.once('close', () => {
        capture.streams.delete(stream);
        capture.streamPaths.delete(stream);
      });
      if (capture.failFirst) {
        capture.failFirst = false;
        stream._write = (_chunk, _encoding, done) => done(new Error('injected-write-failure'));
        stream._writev = (_chunks, done) => done(new Error('injected-write-failure'));
      }
      if (capture.delayFirst) {
        capture.delayFirst = false;
        const write = stream._write.bind(stream);
        const writev = stream._writev?.bind(stream);
        let delayed = true;
        const delay = (continueWrite: () => void) => {
          if (!delayed) return continueWrite();
          delayed = false;
          capture.release = () => {
            capture.release = undefined;
            continueWrite();
          };
        };
        stream._write = (chunk, encoding, done) => delay(() => write(chunk, encoding, done));
        if (writev) stream._writev = (chunks, done) => delay(() => writev(chunks, done));
      }
      return stream;
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if ([...capture.streams].some((stream) => capture.streamPaths.get(stream) === String(args[0]) && !stream.closed))
        capture.unsafeRenames.push(String(args[0]));
      return actual.renameSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if ([...capture.streams].some((stream) => capture.streamPaths.get(stream) === String(args[0]) && !stream.closed))
        capture.unsafeDeletes.push(String(args[0]));
      return actual.unlinkSync(...args);
    },
  };
});

let dir: string;
let logger: ReturnType<typeof createDebugLogger> | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(join(process.cwd(), '.debug-logger-lifecycle-'));
  logger = undefined;
  capture.unsafeRenames = [];
  capture.unsafeDeletes = [];
  capture.delayFirst = false;
  capture.failFirst = false;
  capture.release = undefined;
});

afterEach(async () => {
  capture.release?.();
  await logger?.close();
  for (const stream of capture.streams) {
    if (!stream.writableEnded) stream.end();
  }
  await Promise.all(
    [...capture.streams].map((stream) => new Promise<void>((resolve) => stream.once('close', resolve))),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

function files(): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => /^debug-.*\.ndjson$/.test(name))
    .sort(
      (left, right) =>
        left.slice(6, 16).localeCompare(right.slice(6, 16)) ||
        Number(left.match(/\.(\d+)\.ndjson$/)?.[1] ?? 0) - Number(right.match(/\.(\d+)\.ndjson$/)?.[1] ?? 0),
    );
}

function rows(): Array<{ event: string; data?: { values: string[] } }> {
  return files().flatMap((name) =>
    fs
      .readFileSync(join(dir, name), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
}

describe('debug logger retention and lifecycle contract', () => {
  it('bounds files created by a hot same-day logger while retaining newest evidence', async () => {
    logger = createDebugLogger({ debugDir: dir, console: false, maxFileSize: 512, retentionDays: 0 });
    for (let index = 0; index < 100; index++)
      logger.info({ domain: 'app', event: `owned-${index}`, message: 'evidence'.repeat(10) });
    await logger.close();
    expect(files().length).toBeLessThanOrEqual(5);
    expect(rows().some((row) => row.event === 'owned-99')).toBe(true);
    expect(files().every((name) => fs.statSync(join(dir, name)).size <= 512)).toBe(true);
    expect(capture.unsafeDeletes).toEqual([]);
  });

  it('does not rename a file before its writer has emitted close', async () => {
    logger = createDebugLogger({ debugDir: dir, console: false, maxFileSize: 128, retentionDays: 0 });
    for (let index = 0; index < 4; index++)
      logger.info({ domain: 'app', event: `rotation-${index}`, message: 'evidence'.repeat(10) });
    await logger.close();
    expect(capture.unsafeRenames).toEqual([]);
    expect(rows()).toHaveLength(4);
  });

  it('flush waits for pending writes in streams that rotated away', async () => {
    capture.delayFirst = true;
    logger = createDebugLogger({ debugDir: dir, console: false, maxFileSize: 128, retentionDays: 0 });
    logger.info({ domain: 'app', event: 'old-stream', message: 'evidence'.repeat(10) });
    logger.info({ domain: 'app', event: 'current-stream' });
    await vi.waitFor(() => expect(capture.release).toBeTypeOf('function'));
    let flushed = false;
    const pending = logger.flush().then(() => {
      flushed = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    try {
      expect(flushed).toBe(false);
    } finally {
      capture.release?.();
      await pending;
    }
    expect(rows().map((row) => row.event)).toContain('old-stream');
  });

  it('rejects new events after close starts instead of reopening an untracked writer', async () => {
    logger = createDebugLogger({ debugDir: dir, console: false, retentionDays: 0 });
    logger.info({ domain: 'app', event: 'accepted-before-close' });
    const closed = logger.close();
    expect(() => logger!.info({ domain: 'app', event: 'after-close' })).toThrow(/clos/i);
    await closed;
    expect(rows().map((row) => row.event)).toEqual(['accepted-before-close']);
    expect(capture.streams.size).toBe(0);
  });

  it('does not automatically remove historical files present before logger creation', async () => {
    const historical = join(dir, 'debug-2001-01-01.4.ndjson');
    fs.writeFileSync(historical, 'historical-evidence\n');
    logger = createDebugLogger({ debugDir: dir, console: false });
    logger.info({ domain: 'app', event: 'new-event' });
    await logger.close();
    expect(fs.existsSync(historical)).toBe(true);
    expect(fs.readFileSync(historical, 'utf8')).toBe('historical-evidence\n');
  });

  it('preserves same-day historical files while respecting an explicit per-process file count', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const historical = [`debug-${day}.ndjson`, `debug-${day}.1.ndjson`];
    for (const name of historical) fs.writeFileSync(join(dir, name), `historical-${name}\n`);
    logger = createDebugLogger({ debugDir: dir, console: false, maxFiles: 2, maxFileSize: 256, retentionDays: 0 });
    for (let index = 0; index < 20; index++)
      logger.info({ domain: 'app', event: `current-${index}`, message: 'evidence'.repeat(10) });
    await logger.close();
    expect(files()).toHaveLength(4);
    for (const name of historical) expect(fs.readFileSync(join(dir, name), 'utf8')).toBe(`historical-${name}\n`);
    const currentRows = files()
      .filter((name) => !historical.includes(name))
      .flatMap((name) =>
        fs
          .readFileSync(join(dir, name), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      );
    expect(currentRows.map((row) => row.event)).toEqual(['current-18', 'current-19']);
    expect(capture.unsafeDeletes).toEqual([]);
  });

  it('close drains every accepted event across queued rotations and is idempotent', async () => {
    capture.delayFirst = true;
    logger = createDebugLogger({ debugDir: dir, console: false, maxFiles: 10, maxFileSize: 256, retentionDays: 0 });
    for (let index = 0; index < 8; index++)
      logger.info({ domain: 'app', event: `pending-${index}`, message: 'evidence'.repeat(10) });
    const firstClose = logger.close();
    const secondClose = logger.close();
    let closed = false;
    void firstClose.then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(capture.release).toBeTypeOf('function'));
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(closed).toBe(false);
    capture.release?.();
    await Promise.all([firstClose, secondClose, logger.flush()]);
    expect(rows().map((row) => row.event)).toEqual(Array.from({ length: 8 }, (_, index) => `pending-${index}`));
    expect(capture.streams.size).toBe(0);
  });

  it('warns about an oversized event while retaining its complete sanitized evidence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logger = createDebugLogger({ debugDir: dir, console: true, maxFileSize: 512, retentionDays: 0 });
      logger.info({
        domain: 'app',
        event: 'oversized-evidence',
        data: { values: Array.from({ length: 100 }, () => 'v'.repeat(100)) },
      });
      await logger.close();
      expect(warn.mock.calls.some((call) => /exceeds.*budget/i.test(String(call[0])))).toBe(true);
      expect(rows()[0].data?.values).toHaveLength(100);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('reports disk failure from flush and close while releasing the actual file descriptor', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    capture.failFirst = true;
    logger = createDebugLogger({ debugDir: dir, console: false, retentionDays: 0 });
    try {
      logger.info({ domain: 'app', event: 'failed-write' });
      await expect(logger.flush()).rejects.toThrow('injected-write-failure');
      await expect(logger.close()).rejects.toThrow('injected-write-failure');
      expect(capture.streams.size).toBe(0);
      expect(error).toHaveBeenCalled();
      expect(fs.existsSync(logger.currentFilePath())).toBe(true);
    } finally {
      await logger.close().catch(() => {});
      logger = undefined;
      error.mockRestore();
    }
  });

  it('keeps diagnostic logging usable after disk failure without pretending subsequent disk writes succeeded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const onEvent = vi.fn();
    capture.failFirst = true;
    logger = createDebugLogger({ debugDir: dir, console: true, onEvent, retentionDays: 0 });
    try {
      logger.info({ domain: 'app', event: 'failed-write' });
      await expect(logger.flush()).rejects.toThrow('injected-write-failure');
      const filesBefore = files();
      expect(() =>
        logger!.info({ domain: 'app', event: 'handshake-success', data: { token: 'secret' } }),
      ).not.toThrow();
      const event = logger.getRecentEvents().at(-1);
      expect(event).toMatchObject({ event: 'handshake-success', data: { token: '***redacted***' } });
      expect(onEvent).toHaveBeenLastCalledWith(event);
      expect(log.mock.calls.some((call) => String(call[0]).includes('handshake-success'))).toBe(true);
      await expect(logger.flush()).rejects.toThrow('injected-write-failure');
      await expect(logger.close()).rejects.toThrow('injected-write-failure');
      expect(files()).toEqual(filesBefore);
      expect(
        files()
          .map((name) => fs.readFileSync(join(dir, name), 'utf8'))
          .join(''),
      ).not.toContain('handshake-success');
      expect(capture.streams.size).toBe(0);
    } finally {
      await logger.close().catch(() => {});
      logger = undefined;
      error.mockRestore();
      log.mockRestore();
    }
  });

  it('applies age retention only to this process owned closed files across day changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
      const historical = join(dir, 'debug-2001-01-01.ndjson');
      fs.writeFileSync(historical, 'historical-evidence\n');
      logger = createDebugLogger({ debugDir: dir, console: false, retentionDays: 1 });
      logger.info({ domain: 'app', event: 'old-owned' });
      await logger.flush();
      const previousFile = logger.currentFilePath();
      vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
      logger.info({ domain: 'app', event: 'new-owned' });
      await logger.close();
      expect(fs.existsSync(previousFile)).toBe(false);
      expect(fs.readFileSync(historical, 'utf8')).toBe('historical-evidence\n');
      expect(fs.readFileSync(logger.currentFilePath(), 'utf8')).toContain('new-owned');
      expect(capture.unsafeDeletes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('documents that a single sanitized event can exceed the proposed file budget without truncating it', async () => {
    logger = createDebugLogger({ debugDir: dir, console: false, maxFileSize: 512, retentionDays: 0 });
    logger.info({
      domain: 'app',
      event: 'large-evidence',
      data: { values: Array.from({ length: 100 }, () => 'v'.repeat(100)) },
    });
    await logger.close();
    expect(rows()[0].data?.values).toHaveLength(100);
    expect(fs.statSync(join(dir, files()[0])).size).toBeGreaterThan(512);
  });
});
