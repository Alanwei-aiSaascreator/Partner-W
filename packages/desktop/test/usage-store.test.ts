import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-a23 + T-a25：`usageStore` 曾经每 60 秒发两条**注定失败 / 无人消费**的请求 ——
 * `usage.cost`（多 agent 配置下恒为 INVALID_REQUEST「session key "main" has no explicit owner」，
 * 语言依据在随包运行时 `dist/usage-lCaKvodi.mjs`：不带 `agentScope`/`agentId` 时它拿 `"main"` 解析归属）
 * 与 `sessions.usage`（`{ key }` 里带的是 **task 级会话键**，而 `chat.send` 是**用 key 惰性建会话**的，
 * 所以"还没发过消息 / 会话被删 / agent 前缀变过"的 key 在网关上不是会话 ⇒
 * `Invalid session reference`，全档 36 次）。两条取回的数据在渲染层都**只有写没有读** ⇒ 死轮询，都已删。
 *
 * ⚠️ 这个文件最容易假绿的地方是**桩的形状**：原来的 store 用
 * `typeof window.clawwork.getUsageCost !== 'function'` 之类的守卫，
 * 桩里若干脆没有这个方法，"没被调用"会在**代码还没改**时就成立。
 * 所以桩**必须提供**这两个方法，再断言它们一次都没被调用。
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

/**
 * ⚠️ **必须按老签名（带 sessionKey）调用**，否则断言是**空成立**的 —— 我自己踩过一次：
 * 第一版测试写成 `fetchUsage('gw-1')`（因为新签名已经没收这个参数了），
 * 而旧 store 里 `if (sessionKey)` 才发 `sessions.usage` ⇒ "一次都没被调用"**在代码还没改时就是绿的**。
 * 那测出来的是"**我没传**"，不是"**它不发**"（同款陷阱：[[verify-your-own-verifier]] 的"绿得没意义"）。
 * 所以这里走一次类型断言，**喂它一个 sessionKey** 再断言它不发 —— 这样红灯才真的在盯代码。
 */
type FetchUsageAnyArity = (gatewayId: string, sessionKey?: string) => Promise<void>;
const fetchUsageWithKey = (store: { getState: () => { fetchUsage: unknown } }, gatewayId: string, key?: string) =>
  (store.getState().fetchUsage as FetchUsageAnyArity)(gatewayId, key);

describe('usageStore：不再轮询无人消费的会话级用量', () => {
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

  it('喂了 sessionKey 时 getSessionUsage 仍一次都没被调用（桩提供了它 ⇒ 这是真断言）', async () => {
    const store = await loadStore();
    // 喂一个 sessionKey：旧代码在这条路上会发 sessions.usage，所以这一版**必须红**
    await fetchUsageWithKey(store, 'gw-1', 's-1');

    expect(sessionUsageMock).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledTimes(1);
  });

  it('store 状态里不再有 cost / sessionUsage 字段（死状态一起删掉）', async () => {
    const store = await loadStore();
    const state = store.getState();

    expect(Object.prototype.hasOwnProperty.call(state, 'cost')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(state, 'sessionUsage')).toBe(false);
  });

  it('usage.status 仍被写入（防"顺手删多了"）', async () => {
    const store = await loadStore();
    statusMock.mockResolvedValue({ ok: true, result: { providers: [{ provider: 'p1' }] } });

    await store.getState().fetchUsage('gw-1');

    expect(store.getState().status).toEqual({ providers: [{ provider: 'p1' }] });
    expect(store.getState().loading).toBe(false);
  });

  it('30 秒窗口内第二次调用跳过实例级查询，且跳过时不再发任何请求', async () => {
    const store = await loadStore();
    await fetchUsageWithKey(store, 'gw-1', 's-1');
    // 第二次：instanceFetchedAt 在 30 秒窗口内 ⇒ 实例级查询被跳过；现在**也没有**别的请求可发
    await fetchUsageWithKey(store, 'gw-1', 's-1');

    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(costMock).not.toHaveBeenCalled();
    expect(sessionUsageMock).not.toHaveBeenCalled();
    expect(store.getState().loading).toBe(false);
  });

  it('usage.status 失败时把 error 暴露出来（不再被别的请求的成功掩盖）', async () => {
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
