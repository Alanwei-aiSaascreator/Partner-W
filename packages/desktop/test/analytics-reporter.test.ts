import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAnalyticsReporter,
  initAnalyticsReporterForTest,
  trackOnSuccess,
  type AnalyticsReporter,
} from '../src/main/analytics/reporter.js';

// 与仓库既有做法一致（`../debug/index.js` 会 import `electron`）：不依赖它的内部行为，
// 顺便去掉未初始化时往 stderr 打的那层噪声。本文件不断言日志。
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

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

  it('★ 只移除这一批：flush 期间新入队的事件不会被一起清掉', async () => {
    const storage = memoryStorage();
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      // 第一次发送的过程中来了新事件（用户正在用）；第二次发它，故意失败让它留在队列里
      if (calls === 1) reporter.track('chat_sent');
      return calls === 1 ? { ok: true, inserted: 1 } : { ok: false };
    });
    // `send` 里引用了下面这个 const：闭包只在 flush 时才跑，那时它已经初始化了
    const reporter: AnalyticsReporter = createAnalyticsReporter({ storage, send });
    reporter.track('app_launch');
    await reporter.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(reporter.peek().map((e) => e.event)).toEqual(['chat_sent']);
  });

  it('★ 永久拒绝丢该批后继续发下一批（不是丢一批就收工）', async () => {
    const storage = memoryStorage();
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? { ok: false, permanent: true, errorCode: 'invalid_payload' } : { ok: true, inserted: 1 };
    });
    const reporter = createAnalyticsReporter({ storage, send, max: 200 });
    for (let i = 0; i < 60; i += 1) reporter.track('chat_sent'); // 跨过 BATCH(50) ⇒ 两个批次

    await reporter.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(reporter.peek()).toHaveLength(0);
  });

  it('★ 落盘回读要过白名单：坏条目进不了队列（否则毒条目会跨重启复活）', () => {
    const storage = memoryStorage();
    storage.write(
      JSON.stringify({
        events: [
          { clientEventId: 'ok-1', event: 'app_launch', occurredAt: '2026-01-01T00:00:00.000Z' },
          { clientEventId: 123, event: 'app_launch', occurredAt: '2026-01-01T00:00:00.000Z' }, // 数字 id
          { clientEventId: 'bad-1', event: 'not_a_real_event', occurredAt: '2026-01-01T00:00:00.000Z' }, // 非白名单
          { clientEventId: 'bad-2', event: 'app_launch' }, // 缺 occurredAt
          null,
          42,
          'nope',
        ],
        chatSentCount: 2,
      }),
    );

    const reporter = createAnalyticsReporter({ storage, send: vi.fn() });

    expect(reporter.peek().map((e) => e.clientEventId)).toEqual(['ok-1']);

    // 整段读不出来也不能炸：退化成空队列
    const broken = memoryStorage();
    broken.write('not json{');
    expect(createAnalyticsReporter({ storage: broken, send: vi.fn() }).peek()).toEqual([]);
  });

  it('★ 失败之后单飞标志要复位（否则一次失败就再也不发了）', async () => {
    const storage = memoryStorage();
    const send = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true, inserted: 1 });
    const reporter = createAnalyticsReporter({ storage, send });
    reporter.track('app_launch');

    await reporter.flush(); // 第一次：临时性失败，条目留在队列里
    await reporter.flush(); // 第二次：必须**真的**再发一次

    expect(send).toHaveBeenCalledTimes(2);
    expect(reporter.peek()).toHaveLength(0);
  });

  it('★ chatSentCount 跨重启只补一次 first_chat_sent', () => {
    const storage = memoryStorage();
    storage.write(JSON.stringify({ events: [], chatSentCount: 3 }));
    const reporter = createAnalyticsReporter({ storage, send: vi.fn() });

    reporter.trackChatSent();

    // 已经聊过 3 次了，重启后不该再补一条 first_chat_sent（会影响看板口径）
    expect(reporter.peek().map((e) => e.event)).toEqual(['chat_sent']);
  });
});

describe('trackOnSuccess', () => {
  it('ok:false 时一条都不记（失败不能被记成"用户干了这件事"）', () => {
    const reporter = createAnalyticsReporter({ storage: memoryStorage(), send: vi.fn() });
    initAnalyticsReporterForTest(reporter);

    const result = trackOnSuccess({ ok: false, errorCode: 'network' }, 'post_published');

    expect(reporter.peek()).toHaveLength(0);
    // 收口写法要**原样把结果还回去**：handler 的返回值不能被埋点改掉
    expect(result).toEqual({ ok: false, errorCode: 'network' });
  });

  it('ok:true 时记一次，并把结果原样返回', () => {
    const reporter = createAnalyticsReporter({ storage: memoryStorage(), send: vi.fn() });
    initAnalyticsReporterForTest(reporter);

    const result = trackOnSuccess({ ok: true, result: null }, 'post_published');

    expect(reporter.peek().map((e) => e.event)).toEqual(['post_published']);
    expect(result).toEqual({ ok: true, result: null });
  });
});
