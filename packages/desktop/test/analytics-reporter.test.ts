import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnalyticsReporter } from '../src/main/analytics/reporter.js';

function memoryStorage() {
  let raw: string | null = null;
  return {
    read: () => raw,
    write: (value: string) => {
      raw = value;
    },
  };
}

describe('analytics reporter', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('队列超过上限时丢最旧的', () => {
    const storage = memoryStorage();
    const reporter = createAnalyticsReporter({ storage, send: vi.fn(), max: 3 });
    for (const name of ['app_launch', 'chat_sent', 'chat_sent', 'chat_sent'] as const) {
      reporter.track(name);
    }
    expect(reporter.peek().map((e) => e.event)).toEqual(['chat_sent', 'chat_sent', 'chat_sent']);
  });

  it('flush 只发送成功的内容：失败的批次留在队列里，不丢', async () => {
    const storage = memoryStorage();
    const send = vi.fn().mockResolvedValue({ ok: false });
    const reporter = createAnalyticsReporter({ storage, send });
    reporter.track('app_launch');
    await reporter.flush();
    expect(reporter.peek()).toHaveLength(1);
  });

  it('flush 成功后清空已发送的条目，并落盘', async () => {
    const storage = memoryStorage();
    const send = vi.fn().mockResolvedValue({ ok: true, inserted: 1 });
    const reporter = createAnalyticsReporter({ storage, send });
    reporter.track('app_launch');
    await reporter.flush();
    expect(reporter.peek()).toHaveLength(0);
    expect(storage.read()).toContain('"events":[]');
  });

  it('单飞：并发 flush 只发一次', async () => {
    const storage = memoryStorage();
    const send = vi.fn().mockResolvedValue({ ok: true, inserted: 1 });
    const reporter = createAnalyticsReporter({ storage, send });
    reporter.track('app_launch');
    await Promise.all([reporter.flush(), reporter.flush()]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('发送抛异常不上抛（埋点绝不打断用户操作）', async () => {
    const storage = memoryStorage();
    const send = vi.fn().mockRejectedValue(new Error('boom'));
    const reporter = createAnalyticsReporter({ storage, send });
    reporter.track('app_launch');
    await expect(reporter.flush()).resolves.toBeUndefined();
  });

  it('first_chat_sent 只在首条会话时记一次', () => {
    const storage = memoryStorage();
    const reporter = createAnalyticsReporter({ storage, send: vi.fn() });
    reporter.trackChatSent();
    reporter.trackChatSent();
    expect(reporter.peek().map((e) => e.event)).toEqual(['first_chat_sent', 'chat_sent', 'chat_sent']);
  });

  it('★ 超过 30 天的条目直接丢掉（否则队首永久卡死）', async () => {
    const storage = memoryStorage();
    const send = vi.fn().mockResolvedValue({ ok: true, inserted: 1 });
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const reporter = createAnalyticsReporter({
      storage,
      send,
      now: () => new Date(clock).toISOString(),
    });
    reporter.track('app_launch');
    // 到了 3 月，那条已经是 59 天前：服务端的时间窗口永远收不下它
    clock = Date.parse('2026-03-01T00:00:00Z');
    await reporter.flush();
    expect(reporter.peek()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('★ 永久性拒绝丢掉这批（不无限重试）；临时性失败仍然留着', async () => {
    const permanentSend = vi.fn().mockResolvedValue({ ok: false, permanent: true, errorCode: 'invalid_event' });
    const a = createAnalyticsReporter({ storage: memoryStorage(), send: permanentSend });
    a.track('app_launch');
    await a.flush();
    expect(a.peek()).toHaveLength(0);

    const temporarySend = vi.fn().mockResolvedValue({ ok: false, permanent: false, errorCode: 'rate_limited' });
    const b = createAnalyticsReporter({ storage: memoryStorage(), send: temporarySend });
    b.track('app_launch');
    await b.flush();
    expect(b.peek()).toHaveLength(1);
  });
});
