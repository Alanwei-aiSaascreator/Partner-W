import { beforeEach, describe, expect, it, vi } from 'vitest';

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

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(fn({}, ...args));
}

describe('growth / bounty IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.rpc.mockReset();
    mocks.client = { rpc: mocks.rpc };
    registerGrowthHandlers();
  });

  it('注册了 11 个通道', () => {
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
});
