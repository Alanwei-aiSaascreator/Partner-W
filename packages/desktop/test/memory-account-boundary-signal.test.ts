/**
 * 2026-10-17 统一审核 §T33② / §T33③：账户边界记忆重投影的**信号**与**连接判据**。
 *
 *  · ② 静默失败：`syncMemoryToAgents` 回 `ok:false`（持续 db-unavailable / 名单读不到）时
 *    受管区块**保住的是旧记忆、无信号** ⇒ 必须记 **warn**（不是 info）并带够定位字段
 *    （归属 id + 失败原因）；
 *  · ③ 连接判据：只判 `!gateway` 时，"对象在、通道不在"会让这次 IPC 白等一次
 *    `REQ_TIMEOUT_MS`（15s）—— 加 `isConnected` 判据后未连接即**静默跳过**。
 *
 * 这里把 `getGatewayClient` / `syncMemoryToAgents` / `owner` / 日志出口全部钉成可控 stub，
 * 只验 `account-switch` 这一个模块的**决策与信号**，不碰真网关 / 真 DB。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gateway: { value: null as null | { isConnected: boolean } },
  sync: vi.fn(),
  owner: { id: '' },
  events: [] as Array<{ level: string; event: string; data: unknown }>,
}));

vi.mock('../src/main/ws/index.js', () => ({
  getGatewayClient: () => mocks.gateway.value,
}));
vi.mock('../src/main/runtime/state-config.js', () => ({ LOCAL_GATEWAY_ID: 'local-runtime' }));
vi.mock('../src/main/memory/sync.js', () => ({
  syncMemoryToAgents: (...a: unknown[]) => mocks.sync(...a),
}));
vi.mock('../src/main/memory/owner.js', () => ({
  currentMemoryOwnerId: () => mocks.owner.id,
}));
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({
    info: (e: { event: string; data: unknown }) => mocks.events.push({ level: 'info', ...e }),
    warn: (e: { event: string; data: unknown }) => mocks.events.push({ level: 'warn', ...e }),
    error: (e: { event: string; data: unknown }) => mocks.events.push({ level: 'error', ...e }),
  }),
}));

const { resyncMemoryOnAccountBoundary } = await import('../src/main/memory/account-switch.js');

const okOutcome = {
  ok: true as const,
  agentIds: ['main'],
  entries: [] as unknown[],
  result: { written: ['main'], unchanged: [], failed: [] },
};

beforeEach(() => {
  mocks.gateway.value = null;
  mocks.owner.id = '';
  mocks.events.length = 0;
  mocks.sync.mockReset();
});

describe('§T33③ 连接判据：网关"对象在、通道不在"不白等 15s', () => {
  it('没有网关对象 ⇒ 静默跳过（不调 sync、不打日志）', async () => {
    mocks.gateway.value = null;
    await resyncMemoryOnAccountBoundary();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.events).toEqual([]);
  });

  it('网关对象在但 isConnected=false ⇒ 同样静默跳过（旧实现会走到 sync 白等一次 15s 超时）', async () => {
    mocks.gateway.value = { isConnected: false };
    await resyncMemoryOnAccountBoundary();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.events).toEqual([]);
  });

  it('isConnected=true ⇒ 正常投影并记 info', async () => {
    mocks.gateway.value = { isConnected: true };
    mocks.sync.mockResolvedValue(okOutcome);
    await resyncMemoryOnAccountBoundary();
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    const success = mocks.events.find((e) => e.event === 'memory.account-boundary-sync');
    expect(success?.level).toBe('info');
  });
});

describe('§T33② 失败信号：ok:false 必须让人看得见', () => {
  it('ok:false（db-unavailable）⇒ 记 warn（不是 info）且带 reason + 归属 id', async () => {
    mocks.gateway.value = { isConnected: true };
    mocks.owner.id = 'user-42';
    mocks.sync.mockResolvedValue({ ok: false, reason: 'db-unavailable' });
    await resyncMemoryOnAccountBoundary();

    const failed = mocks.events.find((e) => e.event === 'memory.account-boundary-sync.failed');
    expect(failed?.level).toBe('warn');
    expect(failed?.data).toMatchObject({ reason: 'db-unavailable', ownerUserId: 'user-42' });
    // 不得再走"成功"那条 info（失败不能被伪装成成功）。
    expect(mocks.events.some((e) => e.event === 'memory.account-boundary-sync')).toBe(false);
  });

  it('投影过程抛错 ⇒ 记 warn 且带归属 id（永不抛）', async () => {
    mocks.gateway.value = { isConnected: true };
    mocks.owner.id = 'user-99';
    mocks.sync.mockRejectedValue(new Error('boom'));
    await expect(resyncMemoryOnAccountBoundary()).resolves.toBeUndefined();

    const failed = mocks.events.find((e) => e.event === 'memory.account-boundary-sync.failed');
    expect(failed?.level).toBe('warn');
    expect(failed?.data).toMatchObject({ reason: 'boom', ownerUserId: 'user-99' });
  });
});
