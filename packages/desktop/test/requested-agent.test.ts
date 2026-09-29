import { describe, expect, it, vi } from 'vitest';
import { resolveRequestedAgent, resolveRequestedAgentForAction } from '../src/renderer/lib/requested-agent';

const loaded = { agents: [{ id: 'main' }] };

describe('resolveRequestedAgent', () => {
  it('目录还没拉回来时判 loading，不许判缺失', () => {
    expect(resolveRequestedAgent('team-agent-x', undefined)).toBe('loading');
  });

  it('目录已加载且请求在里面时判 ok', () => {
    expect(resolveRequestedAgent('main', loaded)).toBe('ok');
  });

  it('没有请求时判 ok（用默认助手）', () => {
    expect(resolveRequestedAgent('', loaded)).toBe('ok');
    expect(resolveRequestedAgent(undefined, loaded)).toBe('ok');
  });

  it('目录已加载、请求非空且不在里面时判 missing', () => {
    expect(resolveRequestedAgent('team-agent-x', loaded)).toBe('missing');
  });

  /**
   * ⚠️ 空目录**是权威的**，不是"没加载"：本产品真实存在"盘上一个助手都没有"这个状态
   * （见 `identity-center.test.tsx` 的"盘上一个助手都没有 ⇒ 不写、如实说"）。
   * 所以此时判 `missing` 是对的 —— 别把它当成"loading"的另一种写法改掉，
   * 那会把"本机确实没有这个助手"变成沉默的兜底。
   */
  it('目录已加载但为空时，非空请求判 missing', () => {
    expect(resolveRequestedAgent('team-agent-x', { agents: [] })).toBe('missing');
  });
});

describe('resolveRequestedAgentForAction', () => {
  it('目录 loading 时强制刷新，刷新后找到才返回 ok', async () => {
    let current: typeof loaded | undefined;
    const refresh = vi.fn(async () => {
      current = { agents: [{ id: 'team-agent-x' }] };
    });

    await expect(
      resolveRequestedAgentForAction({
        requestedAgentId: 'team-agent-x',
        readCatalog: () => current,
        refresh,
      }),
    ).resolves.toBe('ok');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('目录 loading 时强制刷新，刷新后确认没有则返回 missing', async () => {
    let current: typeof loaded | undefined;

    await expect(
      resolveRequestedAgentForAction({
        requestedAgentId: 'team-agent-x',
        readCatalog: () => current,
        refresh: async () => {
          current = loaded;
        },
      }),
    ).resolves.toBe('missing');
  });

  it('刷新抛错或刷新后仍 loading 都返回 unavailable，不许当 ok', async () => {
    await expect(
      resolveRequestedAgentForAction({
        requestedAgentId: 'team-agent-x',
        readCatalog: () => undefined,
        refresh: async () => {
          throw new Error('offline');
        },
      }),
    ).resolves.toBe('unavailable');

    await expect(
      resolveRequestedAgentForAction({
        requestedAgentId: 'team-agent-x',
        readCatalog: () => undefined,
        refresh: async () => undefined,
      }),
    ).resolves.toBe('unavailable');
  });

  it('目录已有权威结论时不发刷新', async () => {
    const refresh = vi.fn(async () => undefined);

    await expect(
      resolveRequestedAgentForAction({
        requestedAgentId: 'main',
        readCatalog: () => loaded,
        refresh,
      }),
    ).resolves.toBe('ok');
    expect(refresh).not.toHaveBeenCalled();
  });
});
