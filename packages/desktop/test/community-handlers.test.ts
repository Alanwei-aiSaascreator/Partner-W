import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 广场 / 团队的 IPC 层。
 *
 * 这一层只做三件事，各自都有必须钉住的理由：
 *   ① **没有登录态时必须给 `not_authenticated`**，而不是让异常穿透 IPC
 *      （穿透的表现是 renderer 里一句 "Error invoking remote method"）；
 *   ② **RPC 的异常要收敛成错误码**（网络挂了给 `network`，别把英文原文带出去）；
 *   ③ 参数名要翻：renderer 传驼峰，RPC 只认 `p_*`。
 *
 * ⚠️ 权限/可见性**不在这里测** —— 那是数据库 definer RPC 的职责，
 *    在 `scripts/tests/community_team.sql` 里逐条钉过了。这里再实现一遍
 *    只会造出第二套真相。
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

import { registerCommunityHandlers } from '../src/main/ipc/community-handlers.js';
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

describe('community IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.client = { rpc: mocks.rpc };
    // 埋点走真的 reporter 单例：断言的是「handler 到底记了哪个事件」，
    // 而不是「handler 里出现过某个字符串」（见 context-handlers.test.ts 的同款写法）。
    analytics = createAnalyticsReporter({
      storage: { read: () => null, write: () => {} },
      send: vi.fn(async () => ({ ok: true, inserted: 0 })),
    });
    initAnalyticsReporterForTest(analytics);
    registerCommunityHandlers();
  });

  afterEach(() => {
    stopAnalyticsReporter();
  });

  it('未登录（拿不到商业客户端）⇒ not_authenticated，且不抛异常', async () => {
    mocks.client = null;
    const res = (await call('community:feed')) as { ok: boolean; errorCode?: string };
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('not_authenticated');
  });

  it('RPC 成功 ⇒ 原样带回 result', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ post_id: 'p1' }], error: null });
    const res = (await call('community:feed', { limit: 20 })) as { ok: boolean; result?: unknown };
    expect(res.ok).toBe(true);
    expect(res.result).toEqual([{ post_id: 'p1' }]);
    expect(mocks.rpc).toHaveBeenCalledWith('community_feed', { p_limit: 20, p_before: null });
  });

  it('RPC 报错 ⇒ 把机器码放进 errorCode', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'post_not_found' } });
    const res = (await call('community:comments', { postId: 'p1' })) as { ok: boolean; errorCode?: string };
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('post_not_found');
  });

  it('RPC 报的是英文长句 ⇒ 不原样透出，收敛成 unknown', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'duplicate key value violates unique constraint "org_invite_codes_code_key"' },
    });
    const res = (await call('community:invite-list')) as { ok: boolean; errorCode?: string };
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('unknown');
  });

  it('RPC 抛异常（网络挂了）⇒ 归一成 network，不炸 IPC', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    const res = (await call('community:feed')) as { ok: boolean; errorCode?: string };
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('network');
  });

  it('发帖把 UI 的驼峰参数翻成 RPC 的 p_ 参数', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 'new-id', error: null });
    const res = (await call('community:post-create', { body: '你好', visibility: 'private' })) as {
      ok: boolean;
      result?: unknown;
    };
    expect(res.result).toBe('new-id');
    expect(mocks.rpc).toHaveBeenCalledWith('community_post_create', { p_body: '你好', p_visibility: 'private' });
  });

  it('邀请码参数同样翻译，且只传后端认识的字段', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ code: 'ABC' }], error: null });
    await call('community:invite-create', { role: 'member', maxUses: 3, expiresInHours: 24 });
    expect(mocks.rpc).toHaveBeenCalledWith('team_invite_create', {
      p_role: 'member',
      p_max_uses: 3,
      p_expires_in_hours: 24,
    });
  });

  it('点赞结果在这一层就翻成驼峰（后端返回的是 like_count）', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ liked: true, like_count: 3 }], error: null });
    const res = (await call('community:like-toggle', { postId: 'p1' })) as {
      result?: { liked: boolean; likeCount: number };
    };
    expect(res.result).toEqual({ liked: true, likeCount: 3 });
  });

  it('加入团队的结果同样翻成驼峰', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ org_id: 'o1', org_name: '甲', role: 'member' }], error: null });
    const res = (await call('community:join', { code: 'X' })) as {
      result?: { orgId: string; orgName: string; role: string };
    };
    expect(res.result).toEqual({ orgId: 'o1', orgName: '甲', role: 'member' });
  });

  it('建码结果翻成驼峰（code + expiresAt）', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ code: 'ABCDEF1234', expires_at: '2026-09-20T00:00:00Z' }],
      error: null,
    });
    const res = (await call('community:invite-create', {})) as {
      result?: { code: string; expiresAt: string };
    };
    expect(res.result).toEqual({ code: 'ABCDEF1234', expiresAt: '2026-09-20T00:00:00Z' });
  });

  it('★ 发帖成功记一次 post_published；失败一条都不记', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 'new-id', error: null });
    await call('community:post-create', { body: '你好', visibility: 'private' });
    expect(analytics.peek().map((e) => e.event)).toEqual(['post_published']);

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'not_org_member' } });
    await call('community:post-create', { body: '你好', visibility: 'private' });
    expect(analytics.peek().map((e) => e.event)).toEqual(['post_published']);
  });

  it('★ 加入团队成功记一次 team_joined；重复加入（already_member）不记', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ org_id: 'o1', org_name: '甲', role: 'member' }], error: null });
    await call('community:join', { code: 'X' });
    expect(analytics.peek().map((e) => e.event)).toEqual(['team_joined']);

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'already_member' } });
    await call('community:join', { code: 'X' });
    expect(analytics.peek().map((e) => e.event)).toEqual(['team_joined']);
  });

  it('每个 RPC 都注册了 handler，且频道名与 preload 约定一致', () => {
    const channels = [...mocks.handlers.keys()].sort();
    expect(channels).toEqual([
      'community:comment-add',
      'community:comments',
      'community:feed',
      'community:info',
      'community:invite-create',
      'community:invite-list',
      'community:invite-revoke',
      'community:join',
      'community:leave',
      'community:like-toggle',
      'community:member-remove',
      'community:member-set-role',
      'community:members',
      'community:post-create',
      'community:post-delete',
      'community:switch-team',
    ]);
  });
});
