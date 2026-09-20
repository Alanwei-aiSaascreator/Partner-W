import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-a23：`usageStore` 曾每 60 秒发一条**注定失败**的 `usage.cost`
 * （多 agent 配置下恒为 INVALID_REQUEST「session key "main" has no explicit owner」，
 * 语言依据在随包运行时 `dist/usage-lCaKvodi.mjs`：不带 `agentScope`/`agentId` 时它拿 `"main"`
 * 去解析归属）。它取回的 `cost` 在渲染层**只有写没有读** ⇒ 死轮询，本刀删掉。
 *
 * ⚠️ 这个文件最容易假绿的地方是**桩的形状**：原来的 store 用
 * `typeof window.clawwork.getUsageCost !== 'function'` 当守卫，
 * 桩里若干脆没有这个方法，"没被调用"会在**代码还没改**时就成立。
 * 所以桩**必须提供** `getUsageCost`，再断言它一次都没被调用。
 *
 * 跑法（单文件）：`cd packages/desktop && pnpm vitest run test/usage-store.test.ts`
 */
const statusMock = vi.fn();
const costMock = vi.fn();
const sessionUsageMock = vi.fn();

async function loadStore() {
  vi.resetModules();
  const module = await import('../src/renderer/stores/usageStore');
  return module.useUsageStore;
}

function installClawwork() {
  // 这个文件跑在 node 环境（没有 jsdom）⇒ 自己兜一个 window.clawwork
  const target = (globalThis.window ??= {} as typeof globalThis.window) as unknown as Window & {
    clawwork: Record<string, unknown>;
  };
  target.clawwork = {
    getUsageStatus: statusMock,
    getUsageCost: costMock,
    getSessionUsage: sessionUsageMock,
  } as unknown as typeof target.clawwork;
}

describe('usageStore：不再轮询注定失败的 usage.cost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installClawwork();
    statusMock.mockResolvedValue({ ok: true, result: { providers: [] } });
    costMock.mockResolvedValue({ ok: true, result: { totalMicros: 1 } });
    sessionUsageMock.mockResolvedValue({ ok: true, result: { sessions: [] } });
  });

  it('一次 fetchUsage 里 getUsageCost 一次都没被调用（桩提供了它 ⇒ 这是真断言）', async () => {
    const store = await loadStore();
    await store.getState().fetchUsage('gw-1');

    expect(costMock).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(statusMock).toHaveBeenCalledWith('gw-1');
  });

  it('store 状态里不再有 cost 字段（死状态一起删掉）', async () => {
    const store = await loadStore();
    expect(Object.prototype.hasOwnProperty.call(store.getState(), 'cost')).toBe(false);
  });

  it('usage.status 仍被写入（防"顺手删多了"）', async () => {
    const store = await loadStore();
    statusMock.mockResolvedValue({ ok: true, result: { providers: [{ provider: 'p1' }] } });

    await store.getState().fetchUsage('gw-1');

    expect(store.getState().status).toEqual({ providers: [{ provider: 'p1' }] });
    expect(store.getState().loading).toBe(false);
  });

  it('带 sessionKey 时仍请求 sessions.usage 并写入 sessionUsage（防"顺手删多了"）', async () => {
    const store = await loadStore();
    sessionUsageMock.mockResolvedValue({ ok: true, result: { sessions: [{ usage: { totalTokens: 7 } }] } });

    await store.getState().fetchUsage('gw-1', 's-1');

    expect(sessionUsageMock).toHaveBeenCalledWith('gw-1', 's-1');
    expect(store.getState().sessionUsage).toEqual({ totalTokens: 7 });
  });

  it('30 秒内第二次调用跳过实例级查询时，sessionUsage 仍从结果里取对（下标没串）', async () => {
    const store = await loadStore();
    sessionUsageMock.mockResolvedValue({ ok: true, result: { sessions: [{ usage: { totalTokens: 1 } }] } });
    await store.getState().fetchUsage('gw-1', 's-1');

    // 第二次：instanceFetchedAt 在 30 秒窗口内 ⇒ 只发 sessions.usage 一条
    sessionUsageMock.mockResolvedValue({ ok: true, result: { sessions: [{ usage: { totalTokens: 2 } }] } });
    await store.getState().fetchUsage('gw-1', 's-1');

    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(sessionUsageMock).toHaveBeenCalledTimes(2);
    expect(store.getState().sessionUsage).toEqual({ totalTokens: 2 });
  });

  it('usage.status 失败时把 error 暴露出来（不再被 cost 的成功掩盖）', async () => {
    const store = await loadStore();
    statusMock.mockResolvedValue({ ok: false, error: 'boom' });

    await store.getState().fetchUsage('gw-1');

    expect(store.getState().error).toBe('boom');
  });

  it('usage.status 成功时不设 error', async () => {
    const store = await loadStore();

    await store.getState().fetchUsage('gw-1');

    expect(store.getState().error).toBeNull();
  });
});
