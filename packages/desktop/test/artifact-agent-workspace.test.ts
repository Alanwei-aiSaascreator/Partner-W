import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAgentWorkspaceCache,
  resolveAgentWorkspace,
} from '../src/main/artifact/agent-workspace.js';

/**
 * 「助手的工作区在哪」—— 新增那个受信根的**唯一来源**。
 *
 * 现场（真机，2026-09-27）：助手用 exec 在它自己的工作区里生成 pptx / html，
 * 而产物表**从来没有过任何记录**（`SELECT COUNT(*) FROM artifacts` = 0）。
 * 两个目录（应用工作区 vs 助手工作区）是兄弟，永不重叠。
 *
 * ⚠️ 这一组最要紧的两条**不是**"能读到"，而是：
 *   ① **读不到不许抛** —— 它跑在一轮消息收尾的产物链上，抛出去会把
 *      auto-extract / docgen / 对账链一起掀翻（那条路径上已经踩过一次）；
 *   ② **读不到不许猜** —— 回 `null`，绝不回落成应用工作区。
 */
describe('resolveAgentWorkspace', () => {
  beforeEach(() => {
    clearAgentWorkspaceCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAgentWorkspaceCache();
  });

  const ok = (workspace: unknown) => vi.fn(async () => ({ agentId: 'main', workspace, files: [] }));

  it('读到 workspace 就返回它', async () => {
    const list = ok('C:\\Users\\u\\AppData\\Roaming\\@clawwork\\desktop\\openclaw-state\\workspace');
    const result = await resolveAgentWorkspace({ gatewayId: 'gw-1', agentId: 'main', listAgentFiles: list });

    expect(result).toBe('C:\\Users\\u\\AppData\\Roaming\\@clawwork\\desktop\\openclaw-state\\workspace');
    expect(list).toHaveBeenCalledWith('gw-1', 'main');
  });

  it('两端空白会被去掉（网关配置里带尾随空格是见过的）', async () => {
    const list = ok('  /tmp/ws  ');
    expect(await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a', listAgentFiles: list })).toBe('/tmp/ws');
  });

  it.each([
    ['字段缺失', { agentId: 'main', files: [] }],
    ['空串', { workspace: '' }],
    ['只有空白', { workspace: '   ' }],
    ['不是字符串', { workspace: 42 }],
    ['含 NUL', { workspace: '/tmp/a\u0000b' }],
    ['回包是数组', []],
    ['回包是 null', null],
    ['回包是字符串', 'workspace'],
  ])('认不出的回包一律 null：%s', async (_label, payload) => {
    const list = vi.fn(async () => payload);
    expect(await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a', listAgentFiles: list })).toBeNull();
  });

  it('⭐ RPC 抛异常 ⇒ 回 null，**不把异常放出去**', async () => {
    // 这条路径上抛出去 = 掀翻整个产物收尾链（auto-extract / docgen / 对账）。
    const list = vi.fn(async () => {
      throw new Error('gateway client not available');
    });

    await expect(
      resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a', listAgentFiles: list }),
    ).resolves.toBeNull();
  });

  it('gatewayId / agentId 为空时直接 null，**一次 RPC 都不发**', async () => {
    const list = vi.fn(async () => ({ workspace: '/ws' }));

    expect(await resolveAgentWorkspace({ gatewayId: '', agentId: 'a', listAgentFiles: list })).toBeNull();
    expect(await resolveAgentWorkspace({ gatewayId: 'g', agentId: '', listAgentFiles: list })).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('成功结果会被缓存 —— 第二轮不再发 RPC', async () => {
    const list = ok('/ws');
    await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a', listAgentFiles: list });
    await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a', listAgentFiles: list });

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('⭐ 失败结果**也**缓存 —— 否则网关没连上时每轮都要等一次 RPC 超时', async () => {
    const list = vi.fn(async () => {
      throw new Error('offline');
    });
    await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a', listAgentFiles: list });
    await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a', listAgentFiles: list });

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('⭐ 但失败缓存的时效**短得多** —— 网关后起来时必须能很快自愈', async () => {
    // 现场：冷启动时产物链可能比网关先跑。把"刚启动那一次读不到"钉死 5 分钟，
    // 这台机器就会整整 5 分钟收不到任何产物。
    const list = vi.fn(async () => {
      throw new Error('offline');
    });
    await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a', listAgentFiles: list });
    expect(list).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-27T12:00:25Z')); // 25 秒后（> 20 秒的失败 TTL）
    const list2 = ok('/ws');
    expect(await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a', listAgentFiles: list2 })).toBe('/ws');
    expect(list2).toHaveBeenCalledTimes(1);
  });

  it('不同 agent / 不同网关各算各的（不互相污染）', async () => {
    const a = ok('/ws-a');
    const b = ok('/ws-b');

    expect(await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a', listAgentFiles: a })).toBe('/ws-a');
    expect(await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'b', listAgentFiles: b })).toBe('/ws-b');
    expect(await resolveAgentWorkspace({ gatewayId: 'g2', agentId: 'a', listAgentFiles: a })).toBe('/ws-a');

    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('⭐ 键不许撞：`gatewayId` 里带分隔符也不能和另一个 agent 混淆', async () => {
    // 用空格当分隔符的话，('g a', 'b') 与 ('g', 'a b') 会撞成同一个键。
    const first = ok('/first');
    const second = ok('/second');

    expect(await resolveAgentWorkspace({ gatewayId: 'g a', agentId: 'b', listAgentFiles: first })).toBe('/first');
    expect(await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a b', listAgentFiles: second })).toBe('/second');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clearAgentWorkspaceCache 之后会重新问（用户改了 agent 配置时用）', async () => {
    const list = ok('/ws');
    await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a', listAgentFiles: list });
    clearAgentWorkspaceCache();
    await resolveAgentWorkspace({ gatewayId: 'g', agentId: 'a', listAgentFiles: list });

    expect(list).toHaveBeenCalledTimes(2);
  });
});
