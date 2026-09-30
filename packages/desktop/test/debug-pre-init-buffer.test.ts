import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

const cleanups: Array<() => Promise<void>> = [];

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

async function loadDebugModule() {
  vi.resetModules();
  return await import('../src/main/debug/index.js');
}

describe('debug logger pre-init buffer (#412)', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    consoleWarnSpy.mockRestore();
  });

  it('initializes the production logger with an explicit five-file, five-MiB budget', async () => {
    vi.resetModules();
    const loggerModule = await import('../src/main/debug/logger.js');
    const createLogger = vi.spyOn(loggerModule, 'createDebugLogger');
    const { initDebugLogger } = await import('../src/main/debug/index.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(process.cwd(), '.debug-production-budget-'));
    const realLogger = initDebugLogger(tmp);
    cleanups.push(async () => {
      await realLogger.close();
      rmSync(tmp, { recursive: true, force: true });
    });
    try {
      expect(createLogger).toHaveBeenCalledWith(expect.objectContaining({ maxFiles: 5, maxFileSize: 5 * 1024 * 1024 }));
      realLogger.log({ domain: 'app', event: 'production-budget', level: 'info' }, { silent: true });
      await realLogger.flush();
      expect(JSON.parse(fs.readFileSync(realLogger.currentFilePath(), 'utf8')).event).toBe('production-budget');
    } finally {
      createLogger.mockRestore();
    }
  });

  it('captures events before initDebugLogger and replays them on init', async () => {
    const debugModule = await loadDebugModule();
    const { getDebugLogger, initDebugLogger } = debugModule;

    const logger = getDebugLogger();
    const beforeInit = logger.error({
      domain: 'app',
      event: 'pre-init-error',
      traceId: 'trace-1',
      error: { message: 'boom' },
      data: { token: 'secret-token', ok: true },
    });

    expect(beforeInit.event).toBe('pre-init-error');
    expect(beforeInit.level).toBe('error');
    expect(beforeInit.traceId).toBe('trace-1');
    expect(beforeInit.data).toEqual({ token: '***redacted***', ok: true });

    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-debug-'));

    const realLogger = initDebugLogger(tmp);
    cleanups.push(async () => {
      await realLogger.close();
      rmSync(tmp, { recursive: true, force: true });
    });
    const recent = realLogger.getRecentEvents();
    const replayed = recent.find((e) => e.event === 'pre-init-error');
    expect(replayed).toMatchObject({
      ts: beforeInit.ts,
      level: 'error',
      traceId: 'trace-1',
      data: { token: '***redacted***', ok: true },
      error: { message: 'boom' },
    });

    realLogger.info({ domain: 'app', event: 'post-init-info' });
    expect(realLogger.getRecentEvents().some((e) => e.event === 'post-init-info')).toBe(true);
  });

  it('buffers events before initDebugLogger runs', async () => {
    const { getDebugLogger, isDebugLoggerInitialized } = await loadDebugModule();

    const logger = getDebugLogger();
    const event1 = logger.info({ domain: 'app', event: 'test-event-1' });
    const event2 = logger.error({ domain: 'gateway', event: 'test-event-2' });

    expect(event1.level).toBe('info');
    expect(event1.domain).toBe('app');
    expect(event1.event).toBe('test-event-1');
    expect(event2.level).toBe('error');
    expect(event2.domain).toBe('gateway');

    expect(getDebugLogger().getRecentEvents()).toHaveLength(2);
    expect(isDebugLoggerInitialized()).toBe(false);
  });

  it('drops oldest events when buffer is full (keeps most recent 256)', async () => {
    const { getDebugLogger, initDebugLogger } = await loadDebugModule();
    const logger = getDebugLogger();

    logger.info({ domain: 'app', event: 'oldest-event' });
    for (let i = 1; i <= 256; i++) {
      logger.debug({ domain: 'app', event: `buffer-overflow-test-${i}` });
    }

    const events = getDebugLogger().getRecentEvents();
    expect(events).toHaveLength(256);
    expect(events.some((e) => e.event === 'oldest-event')).toBe(false);
    expect(events[0].event).toBe('buffer-overflow-test-1');
    expect(events[255].event).toBe('buffer-overflow-test-256');

    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-debug-'));
    const realLogger = initDebugLogger(tmp);
    cleanups.push(async () => {
      await realLogger.close();
      rmSync(tmp, { recursive: true, force: true });
    });
    const flushedEvents = realLogger.getRecentEvents();
    expect(flushedEvents.some((e) => e.event === 'oldest-event')).toBe(false);
  });

  it('warns via console when logging before init', async () => {
    const { getDebugLogger } = await loadDebugModule();

    const logger = getDebugLogger();
    logger.error({ domain: 'app', event: 'pre-init-warning-test' });

    expect(consoleWarnSpy).toHaveBeenCalled();
    const warningCall = consoleWarnSpy.mock.calls[0][0] as string;
    expect(warningCall).toContain('[debug] Logger not initialized yet');
  });

  it('redacts sensitive fields in pre-init console warnings', async () => {
    const { getDebugLogger } = await loadDebugModule();

    getDebugLogger().error({
      domain: 'app',
      event: 'pre-init-secret-test',
      data: { token: 'secret-token' },
    });

    const warnPayload = consoleWarnSpy.mock.calls.flat().join(' ');
    expect(warnPayload).not.toContain('secret-token');
    expect(warnPayload).toContain('pre-init-secret-test');
  });

  it('does not re-print buffered events to console when flushing on init', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { getDebugLogger, initDebugLogger } = await loadDebugModule();
      getDebugLogger().error({ domain: 'app', event: 'pre-init-replay-test' });

      const preInitWarnCount = consoleWarnSpy.mock.calls.length;
      const preInitErrorCount = consoleErrorSpy.mock.calls.length;

      const os = await import('node:os');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-debug-'));
      const realLogger = initDebugLogger(tmp);
      cleanups.push(async () => {
        await realLogger.close();
        rmSync(tmp, { recursive: true, force: true });
      });

      expect(consoleWarnSpy.mock.calls.length).toBe(preInitWarnCount);
      expect(consoleErrorSpy.mock.calls.length).toBe(preInitErrorCount);
      expect(consoleLogSpy.mock.calls.some((c) => String(c[0]).includes('pre-init-replay-test'))).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });
});
