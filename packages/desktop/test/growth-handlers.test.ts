import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 成长值 / 悬赏的 IPC。
 *
 * 与 `market-handlers` 同一套路：这一层只做三件事 ——
 *   ① 没有登录态给 `not_authenticated`（不让异常穿透 IPC）；
 *   ② RPC 异常收敛成错误码（英文长句压成 `unknown`，网络异常给 `network`）；
 *   ③ 参数名翻译：renderer 传驼峰，RPC 只认 `p_*`。
 *
 * 权限/状态机/可见性**不在这里测** —— 那是迁移 45/46/47 的 definer RPC 的职责，
 * 在 `scripts/tests/bounty_growth.sql` 里逐条钉过了（75 条断言）。
 */
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  rpc: vi.fn(),
  client: null as null | { rpc: (...args: unknown[]) => unknown },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => mocks.client,
}));

import { registerGrowthHandlers } from '../src/main/ipc/growth-handlers.js';
import {
  createAnalyticsReporter,
  initAnalyticsReporterForTest,
  stopAnalyticsReporter,
  type AnalyticsReporter,
} from '../src/main/analytics/reporter.js';

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(fn({}, ...args));
}

let analytics: AnalyticsReporter;

describe('growth / bounty IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.rpc.mockReset();
    mocks.client = { rpc: mocks.rpc };
    // 埋点走真的 reporter 单例（同 context-handlers.test.ts 的写法）
    analytics = createAnalyticsReporter({
      storage: { read: () => null, write: () => {} },
      send: vi.fn(async () => ({ ok: true, inserted: 0 })),
    });
    initAnalyticsReporterForTest(analytics);
    registerGrowthHandlers();
  });

  afterEach(() => {
    stopAnalyticsReporter();
  });

  it('注册了 13 个通道', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'bounty:accept',
      'bounty:cancel',
      'bounty:claim',
      'bounty:create',
      'bounty:list',
      'bounty:reject',
      'bounty:release',
      'bounty:submit',
      'growth:check-in',
      'growth:history',
      'growth:summary',
      'growth:task-claim',
      'growth:task-list',
    ]);
  });

  it('成长值：成功取首行；机器码原样传；英文长句压成 unknown', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ balance: 20, total_earned: 20, level: 1, to_next_level: 180, checked_in_today: true, badges: [] }],
      error: null,
    });
    await expect(call('growth:summary')).resolves.toMatchObject({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith('growth_summary', {});

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'insufficient_growth' } });
    await expect(call('growth:check-in')).resolves.toEqual({ ok: false, errorCode: 'insufficient_growth' });

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied for table bounties' } });
    await expect(call('growth:check-in')).resolves.toEqual({ ok: false, errorCode: 'unknown' });
  });

  it('成长值：history 传分页参数、返回数组', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ id: 'e1' }], error: null });
    await expect(call('growth:history', { limit: 10, before: '2026-09-17T00:00:00Z' })).resolves.toMatchObject({
      ok: true,
      result: [{ id: 'e1' }],
    });
    expect(mocks.rpc).toHaveBeenCalledWith('growth_history', {
      p_limit: 10,
      p_before: '2026-09-17T00:00:00Z',
    });

    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(call('growth:history')).resolves.toEqual({ ok: true, result: [] });
  });

  it('悬赏：create 参数改名、list 过滤、动作类无返回', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 'b-1', error: null });
    await expect(call('bounty:create', { title: '写周报', description: 'd', reward: 120 })).resolves.toEqual({
      ok: true,
      result: 'b-1',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('bounty_create', {
      p_title: '写周报',
      p_description: 'd',
      p_reward: 120,
    });

    mocks.rpc.mockResolvedValueOnce({ data: [{ id: 'b1' }], error: null });
    await expect(call('bounty:list', { status: 'open' })).resolves.toMatchObject({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith('bounty_list', { p_status: 'open' });

    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(call('bounty:claim', { id: 'b1' })).resolves.toEqual({ ok: true, result: null });
    expect(mocks.rpc).toHaveBeenCalledWith('bounty_claim', { p_id: 'b1' });

    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(call('bounty:submit', { id: 'b1', note: '做完了' })).resolves.toEqual({ ok: true, result: null });
    expect(mocks.rpc).toHaveBeenCalledWith('bounty_submit', { p_id: 'b1', p_note: '做完了' });
  });

  it('未登录 ⇒ not_authenticated，且不触碰网络', async () => {
    mocks.client = null;
    await expect(call('growth:summary')).resolves.toEqual({ ok: false, errorCode: 'not_authenticated' });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('rpc 抛异常 ⇒ network，异常不穿透 IPC', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(call('bounty:list')).resolves.toEqual({ ok: false, errorCode: 'network' });
  });

  it('★ 签到：只有真的新签（awarded > 0）记一次 daily_check_in', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ balance: 20, total_earned: 20, level: 1, checked_in_today: true, awarded: 20 }],
      error: null,
    });
    await call('growth:check-in');
    expect(analytics.peek().map((e) => e.event)).toEqual(['daily_check_in']);
  });

  it('★ 签到幂等：同一天重复调用（awarded = 0）不记；RPC 失败也不记', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ balance: 20, total_earned: 20, level: 1, checked_in_today: true, awarded: 0 }],
      error: null,
    });
    await call('growth:check-in');

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'not_authenticated' } });
    await call('growth:check-in');

    expect(analytics.peek()).toEqual([]);
  });

  it('每日任务（迁移 065）：list 传空参、claim 参数改名', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ task: 'publish', reward: 10, done: true, claimed: false }],
      error: null,
    });
    await expect(call('growth:task-list')).resolves.toMatchObject({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith('daily_task_list', {});

    mocks.rpc.mockResolvedValueOnce({
      data: [{ balance: 30, total_earned: 30, level: 1, checked_in_today: false, awarded: 10 }],
      error: null,
    });
    await expect(call('growth:task-claim', { task: 'publish' })).resolves.toMatchObject({
      ok: true,
      result: { awarded: 10 },
    });
    expect(mocks.rpc).toHaveBeenCalledWith('daily_task_claim', { p_task: 'publish' });
  });

  it('每日任务：两个码原样传出去（中文由 core 的 describeGrowthError 翻）', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'task_not_done' } });
    await expect(call('growth:task-claim', { task: 'publish' })).resolves.toEqual({
      ok: false,
      errorCode: 'task_not_done',
    });

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'invalid_task' } });
    await expect(call('growth:task-claim', { task: 'nope' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_task',
    });
  });

  /**
   * ⭐ 没传 task ⇒ 传空串，由**服务端**判 `invalid_task`。
   *
   * 客户端不自己猜哪些键合法 —— 目录的唯一一份在服务端（`daily_task_catalog()`），
   * 在客户端再抄一遍就是第二份真相，迟早和那边漂开。
   */
  it('每日任务：没传 task ⇒ 空串，判定交给服务端', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'invalid_task' } });
    await expect(call('growth:task-claim')).resolves.toEqual({ ok: false, errorCode: 'invalid_task' });
    expect(mocks.rpc).toHaveBeenCalledWith('daily_task_claim', { p_task: '' });
  });

  /**
   * ⭐ **每日任务刻意不上报埋点** —— 这条钉住的是**决定**，不是实现细节。
   *
   * 事件名是**服务端 CHECK 的闭集**（迁移 48），加一个名字要：改那条 CHECK（= 再推一条迁移）
   * + 改 `ANALYTICS_EVENTS` + 加调用，三处缺一不可。而领奖本身已经在服务端落了
   * `growth_entries (reason='daily_task')` —— 那才是权威、可查、带 user_id 的记录。
   *
   * ⇒ 谁要改这条测试，先想清楚是不是也准备推那条迁移。
   */
  it('⭐ 每日任务：领奖**不上报埋点**（事件名是服务端闭集，理由见代码注释）', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ balance: 30, total_earned: 30, level: 1, checked_in_today: false, awarded: 10 }],
      error: null,
    });
    await call('growth:task-claim', { task: 'publish' });
    expect(analytics.peek()).toEqual([]);
  });

  it('★ 悬赏发布成功记一次 bounty_published；失败不记', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 'b-1', error: null });
    await call('bounty:create', { title: '写周报', description: 'd', reward: 120 });
    expect(analytics.peek().map((e) => e.event)).toEqual(['bounty_published']);

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'insufficient_balance' } });
    await call('bounty:create', { title: '写周报', description: 'd', reward: 120 });
    expect(analytics.peek().map((e) => e.event)).toEqual(['bounty_published']);
  });
});
