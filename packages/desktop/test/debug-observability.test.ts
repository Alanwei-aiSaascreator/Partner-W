import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDebugLogger } from '../src/main/debug/logger';
import { REDACTED_CONTENT, sanitizeForLog, summarizePayload } from '@clawwork/shared';

describe('debug observability foundation', () => {
  it('redacts secrets and truncates long strings', () => {
    const result = sanitizeForLog({
      token: 'secret-token',
      nested: { password: 'pw123' },
      // 截断行为仍在 —— 用**非正文**键来钉（`text` 现在会被整段摘掉，见下一个用例）
      detail: 'x'.repeat(520),
    }) as Record<string, unknown>;

    expect(result.token).toBe('***redacted***');
    expect((result.nested as Record<string, unknown>).password).toBe('***redacted***');
    expect(result.detail).toBe('x'.repeat(500) + '…<truncated len=520>');
  });

  it('summarizes large payloads without leaking full content', () => {
    const result = summarizePayload({
      message: 'hello world',
      attachment: {
        content: 'a'.repeat(900),
        mimeType: 'text/plain',
      },
    }) as Record<string, unknown>;

    // 正文**整段**摘掉（不是截断到 500 —— 那只是"少存一点"）：见外部审计 P3
    expect((result.attachment as Record<string, unknown>).content).toBe(REDACTED_CONTENT);
    expect(JSON.stringify(result)).not.toContain('aaaaaaaaaa');
    // 负对照：没有 idempotencyKey 的 `message` 是日志说明文字，必须留下
    expect(result.message).toBe('hello world');
  });

  describe('createDebugLogger', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'clawwork-debug-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('stores recent events and writes ndjson to disk', async () => {
      const seen: string[] = [];
      const logger = createDebugLogger({
        debugDir: dir,
        maxEvents: 3,
        console: false,
        onEvent: (event) => {
          seen.push(event.event);
        },
      });

      logger.info({ domain: 'gateway', event: 'gateway.connect.start', gatewayId: 'gw-1' });
      logger.error({ domain: 'ipc', event: 'ipc.ws.send-message.failed', error: { message: 'not connected' } });

      await logger.flush();

      const events = logger.getRecentEvents();
      expect(events).toHaveLength(2);
      expect(events[0]?.event).toBe('gateway.connect.start');
      expect(events[1]?.level).toBe('error');

      const file = logger.currentFilePath();
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]!).error.message).toBe('not connected');
      expect(seen).toEqual(['gateway.connect.start', 'ipc.ws.send-message.failed']);
    });

    it('⭐ 端到端：网关帧里的用户原话不落进 logs/*.ndjson', async () => {
      // 与 gateway-client.ts 实际调用形状一致：
      //   logger.debug({ domain:'gateway', event:'gateway.res.received', data:{ payload: summarizePayload(frame.payload) } })
      const userText = '帮我把 D 盘那个 3.2G 的备份删了，里面是我的护照扫描件';
      const logger = createDebugLogger({ debugDir: dir, console: false });

      logger.debug({
        domain: 'gateway',
        event: 'gateway.res.received',
        wsFrameId: 'f-1',
        data: {
          payload: summarizePayload({
            id: 'r-1',
            method: 'chat.history',
            result: {
              messages: [{ idempotencyKey: 'req-1:user', message: { role: 'user', content: userText } }],
            },
          }),
        },
      });
      logger.debug({
        domain: 'gateway',
        event: 'gateway.req.sent',
        wsFrameId: 'f-2',
        data: {
          params: summarizePayload({
            sessionKey: 'sess-1',
            message: userText,
            idempotencyKey: 'req-2',
            deliver: false,
          }),
        },
      });

      await logger.flush();

      const raw = readFileSync(logger.currentFilePath(), 'utf8');
      expect(raw, '用户原话一个字都不许留在盘上').not.toContain('护照扫描件');
      expect(raw).not.toContain(userText);
      // 但"当时走的是哪个方法、哪个会话"必须还在（否则日志就废了）
      expect(raw).toContain('chat.history');
      expect(raw).toContain('sess-1');
      expect(raw).toContain(REDACTED_CONTENT);
    });

    it('keeps only the newest events in memory', () => {
      const logger = createDebugLogger({
        debugDir: dir,
        maxEvents: 2,
        console: false,
      });

      logger.debug({ domain: 'gateway', event: 'one' });
      logger.debug({ domain: 'gateway', event: 'two' });
      logger.debug({ domain: 'gateway', event: 'three' });

      const events = logger.getRecentEvents();
      expect(events.map((event) => event.event)).toEqual(['two', 'three']);
    });
  });
});
