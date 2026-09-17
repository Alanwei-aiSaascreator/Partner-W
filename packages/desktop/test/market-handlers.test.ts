import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 助手市场 / 创作者中心的 IPC。
 *
 * 与 `community-handlers` 同一套路：这一层只做三件事 ——
 *   ① 没有登录态给 `not_authenticated`（不让异常穿透 IPC）；
 *   ② RPC 异常收敛成错误码（英文长句压成 `unknown`，网络异常给 `network`）；
 *   ③ 参数名翻译：renderer 传驼峰，RPC 只认 `p_*`。
 *
 * 权限/可见性**不在这里测** —— 那是迁移 40 的 definer RPC 的职责，在
 * `scripts/tests/agent_templates.sql` 里逐条钉过了。
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

import { registerMarketHandlers } from '../src/main/ipc/market-handlers.js';

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(fn({}, ...args));
}

describe('market IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.client = { rpc: mocks.rpc };
    registerMarketHandlers();
  });

  it('未登录（拿不到商业客户端）⇒ not_authenticated', async () => {
    mocks.client = null;
    const res = (await call('market:templates')) as { ok: boolean; errorCode?: string };
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('not_authenticated');
  });

  it('列表：参数翻成 p_category / p_query，原样带回行', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ id: 't1' }], error: null });
    const res = (await call('market:templates', { category: 'content', query: '教练' })) as {
      ok: boolean;
      result?: unknown;
    };
    expect(res.result).toEqual([{ id: 't1' }]);
    expect(mocks.rpc).toHaveBeenCalledWith('market_templates', { p_category: 'content', p_query: '教练' });
  });

  it('列表：不传参数时给 null（不是 undefined）', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    await call('market:templates');
    expect(mocks.rpc).toHaveBeenCalledWith('market_templates', { p_category: null, p_query: null });
  });

  it('详情 / 安装 / 删除都走 p_id，且安装结果翻成驼峰 installCount', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ id: 't1', instructions: 'p' }], error: null });
    await call('market:detail', { id: 't1' });
    expect(mocks.rpc).toHaveBeenLastCalledWith('market_template_detail', { p_id: 't1' });

    mocks.rpc.mockResolvedValueOnce({ data: [{ install_count: 3 }], error: null });
    const res = (await call('market:installed', { id: 't1' })) as { result?: { installCount: number } };
    expect(mocks.rpc).toHaveBeenLastCalledWith('market_template_installed', { p_id: 't1' });
    expect(res.result).toEqual({ installCount: 3 });

    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    await call('market:delete', { id: 't1' });
    expect(mocks.rpc).toHaveBeenLastCalledWith('creator_template_delete', { p_id: 't1' });
  });

  it('建模板：五个字段全翻成 p_*', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ id: 'new' }], error: null });
    await call('market:create', {
      name: '名字',
      description: '描述',
      category: 'office',
      emoji: '📊',
      instructions: '提示词',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('creator_template_create', {
      p_name: '名字',
      p_description: '描述',
      p_category: 'office',
      p_emoji: '📊',
      p_instructions: '提示词',
    });
  });

  it('改模板 / 改状态：id 翻成 p_id、status 翻成 p_status', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    await call('market:update', {
      id: 't1',
      name: 'n',
      description: '',
      category: 'other',
      emoji: '🧩',
      instructions: 'i',
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith('creator_template_update', {
      p_id: 't1',
      p_name: 'n',
      p_description: '',
      p_category: 'other',
      p_emoji: '🧩',
      p_instructions: 'i',
    });

    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    await call('market:set-status', { id: 't1', status: 'published' });
    expect(mocks.rpc).toHaveBeenLastCalledWith('creator_template_set_status', { p_id: 't1', p_status: 'published' });
  });

  it('RPC 报机器码 ⇒ 原样进 errorCode', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'template_not_found' } });
    const res = (await call('market:detail', { id: 't1' })) as { ok: boolean; errorCode?: string };
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('template_not_found');
  });

  it('RPC 报英文长句 ⇒ 压成 unknown，不摆到界面上', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'duplicate key value violates unique constraint "agent_templates_pkey"' },
    });
    const res = (await call('market:mine')) as { ok: boolean; errorCode?: string };
    expect(res.errorCode).toBe('unknown');
  });

  it('RPC 抛异常 ⇒ network', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    const res = (await call('market:templates')) as { ok: boolean; errorCode?: string };
    expect(res.errorCode).toBe('network');
  });

  it('八个频道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'market:create',
      'market:delete',
      'market:detail',
      'market:installed',
      'market:mine',
      'market:set-status',
      'market:templates',
      'market:update',
    ]);
  });
});
