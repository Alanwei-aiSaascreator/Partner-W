import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 渲染层唯一能主动送的埋点通道（`analytics:track`）。
 *
 * 这一层只做两件事，各有必须钉住的理由：
 *   ① **只收白名单事件名** —— 渲染层若能把任意名字送进来，看板会被前端随手加的名字
 *      污染，而白名单在服务端是**要改迁移**的；
 *   ② `props` **不可信** —— 服务端卡 `pg_column_size(props) <= 1024`，超了抛
 *      `invalid_payload`，而上报器把 `invalid_payload` 判为**永久拒绝 ⇒ 整批一起丢**；
 *      循环引用 / BigInt 更会在上报器里变成卡死队首的毒条目。
 *
 * ⚠️ 与 `context-handlers.test.ts` 同款：走**真的** reporter 单例（不 mock `trackEvent`），
 *    被钉住的行为是「入队了哪个事件、props 变成什么」，只有真实队列看得见。
 */
const handleMap = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handleMap.set(channel, handler)),
  },
}));

import {
  createAnalyticsReporter,
  initAnalyticsReporterForTest,
  stopAnalyticsReporter,
  type AnalyticsReporter,
} from '../src/main/analytics/reporter.js';
import { registerAnalyticsHandlers } from '../src/main/ipc/analytics-handlers.js';

let analytics: AnalyticsReporter;

function call(payload: unknown): Promise<unknown> {
  const fn = handleMap.get('analytics:track');
  if (!fn) throw new Error('no handler registered for analytics:track');
  return Promise.resolve(fn({}, payload));
}

describe('analytics IPC handlers', () => {
  beforeEach(() => {
    handleMap.clear();
    analytics = createAnalyticsReporter({
      storage: { read: () => null, write: () => {} },
      send: vi.fn(async () => ({ ok: true, inserted: 0 })),
    });
    initAnalyticsReporterForTest(analytics);
    registerAnalyticsHandlers();
  });

  afterEach(() => {
    stopAnalyticsReporter();
  });

  it('白名单内的事件入队一次，标量 props 原样保留', async () => {
    await expect(call({ event: 'module_opened', props: { module: 'growth' } })).resolves.toEqual({
      ok: true,
      result: null,
    });

    expect(analytics.peek()).toHaveLength(1);
    expect(analytics.peek()[0]).toMatchObject({ event: 'module_opened', props: { module: 'growth' } });
  });

  it('白名单外的事件名被拒，且一条都不入队', async () => {
    await expect(call({ event: 'whatever_i_want' })).resolves.toEqual({ ok: false, errorCode: 'invalid_event' });

    expect(analytics.peek()).toEqual([]);
  });

  it('★ 嵌套 / 数组 / 循环引用 / BigInt 的 props 值被剔除，事件照记（毒批次入口）', async () => {
    const circular: Record<string, unknown> = { module: 'growth' };
    circular.self = circular;

    await call({ event: 'module_opened', props: circular });
    await call({ event: 'module_opened', props: { module: 'growth', nested: { a: 1 }, list: [1], big: BigInt(1) } });

    expect(analytics.peek().map((e) => e.props)).toEqual([{ module: 'growth' }, { module: 'growth' }]);
  });

  it('★ 超限 props（>512B）丢 props、保事件 —— 不能让一个坏 props 带走整批 49 条', async () => {
    await call({ event: 'module_opened', props: { module: 'x'.repeat(600) } });

    expect(analytics.peek()).toHaveLength(1);
    expect(analytics.peek()[0].props).toBeUndefined();
  });

  it('通道名单与 preload 约定一致', () => {
    expect([...handleMap.keys()].sort()).toEqual(['analytics:track']);
  });
});
