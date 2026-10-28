import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BUG-082（C-B §2/§3）：余额刷新的**通道**与**单飞**语义。
 *
 * 两条硬约束：
 *   ① 刷新走**轻量只读额度通道**（`commercialQuotaSnapshot`），不再为了拿两个数字
 *      去跑整份账户概览（那份带 profile/设备/组织，且历史上还带一次写 RPC）；
 *   ② **不堆叠请求**：进行中的刷新只合并，不同时并发第二条；迟到的回包按
 *      store 代次作废（登出/切号后不许写回）。
 */

const quotaMock = vi.fn();
const overviewMock = vi.fn();

async function loadStore() {
  vi.resetModules();
  const module = await import('../src/renderer/stores/commercialStore');
  return module.useCommercialStore;
}

function quotaResult(usedMicros: number, fetchedAt = '2026-10-15T10:00:00.000Z') {
  return {
    ok: true as const,
    result: {
      license: {
        activated: true,
        licenseId: 'l1',
        orgId: 'o1',
        licenseKey: 'RY-1',
        sku: 's',
        status: 'active',
        expiresAt: null,
        tokenQuotaMicros: 1_000_000_000,
        tokenUsedMicros: usedMicros,
      },
      org: { id: 'o1', name: 'org', plan: 'pro', role: 'owner' },
      fetchedAt,
    },
  };
}

function seededOverview() {
  return {
    account: { userId: 'u1', phone: null, email: null, nickname: null, avatar: null },
    org: { id: 'o1', name: 'org', plan: 'pro', role: 'owner' },
    license: {
      activated: true,
      licenseId: 'l1',
      orgId: 'o1',
      licenseKey: 'RY-1',
      sku: 's',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: 1_000_000_000,
      tokenUsedMicros: 100_000_000,
    },
    device: { fingerprint: 'fp', shortFingerprint: 'fp' },
    fetchedAt: '2026-10-15T09:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const disk = new Map<string, string>();
  const stub = {
    getItem: (key: string) => disk.get(key) ?? null,
    setItem: (key: string, value: string) => void disk.set(key, value),
    removeItem: (key: string) => void disk.delete(key),
    clear: () => disk.clear(),
    key: (index: number) => [...disk.keys()][index] ?? null,
    get length() {
      return disk.size;
    },
  } as Storage;
  (globalThis as unknown as { localStorage: Storage }).localStorage = stub;
  const target = (globalThis.window ??= {} as typeof globalThis.window) as unknown as Window & {
    clawwork: Record<string, unknown>;
    localStorage: Storage;
  };
  target.clawwork = {
    commercialQuotaSnapshot: quotaMock,
    commercialAccountOverview: overviewMock,
  } as unknown as typeof target.clawwork;
  target.localStorage = stub;
});

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
});

describe('余额刷新走轻量只读通道（BUG-082）', () => {
  it('⭐ refresh 只打轻量额度通道，不再跑整份账户概览', async () => {
    quotaMock.mockResolvedValue(quotaResult(120_000_000));
    const useCommercialStore = await loadStore();
    useCommercialStore.setState({ status: 'ready', overview: seededOverview() as never });

    await useCommercialStore.getState().refresh();

    expect(quotaMock).toHaveBeenCalledTimes(1);
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it('刷新把新额度并进既有快照：account/device 保留，license/fetchedAt 更新', async () => {
    quotaMock.mockResolvedValue(quotaResult(120_000_000, '2026-10-15T10:00:05.000Z'));
    const useCommercialStore = await loadStore();
    useCommercialStore.setState({ status: 'ready', overview: seededOverview() as never });

    await useCommercialStore.getState().refresh();

    const state = useCommercialStore.getState();
    expect(state.status).toBe('ready');
    expect(state.overview?.license?.tokenUsedMicros).toBe(120_000_000);
    expect(state.overview?.fetchedAt).toBe('2026-10-15T10:00:05.000Z');
    // 身份与设备指纹来自上一次全量读取，不被轻量刷新抹掉
    expect(state.overview?.account?.userId).toBe('u1');
    expect(state.overview?.device?.fingerprint).toBe('fp');
    // 磁盘缓存也要跟着走，否则重开又回到旧数字
    expect(JSON.parse(window.localStorage.getItem('cw:commercial-overview') ?? '{}')?.license?.tokenUsedMicros).toBe(
      120_000_000,
    );
  });

  it('⭐ 单飞：并发的多次触发只合并，绝不并发第二条请求', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const resolvers: Array<(value: unknown) => void> = [];
    quotaMock.mockImplementation(() => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        resolvers.push((value) => {
          inFlight -= 1;
          resolve(value);
        });
      });
    });
    const useCommercialStore = await loadStore();
    useCommercialStore.setState({ status: 'ready', overview: seededOverview() as never });

    const first = useCommercialStore.getState().refresh();
    const second = useCommercialStore.getState().refresh();
    const third = useCommercialStore.getState().refresh();

    expect(calls).toBe(1);
    resolvers[0](quotaResult(120_000_000));
    await Promise.all([first, second, third]);

    // 合并成最多一次补跑：3 次触发 → 2 条请求（1 条在飞 + 1 条合并），全程无并发
    expect(calls).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(1);
  });

  it('刷新失败：保留最近成功值，只把状态标成 offline（不归零、不清 fetchedAt）', async () => {
    quotaMock.mockResolvedValue({ ok: false, error: 'network down' });
    const useCommercialStore = await loadStore();
    useCommercialStore.setState({ status: 'ready', overview: seededOverview() as never });

    await useCommercialStore.getState().refresh();

    const state = useCommercialStore.getState();
    expect(state.status).toBe('offline');
    expect(state.overview?.license?.tokenUsedMicros).toBe(100_000_000);
    expect(state.overview?.fetchedAt).toBe('2026-10-15T09:00:00.000Z');
  });

  it('没有账号时不空跑（未登录/登出后不产生请求）', async () => {
    const useCommercialStore = await loadStore();
    useCommercialStore.setState({ status: 'idle', overview: null });

    await useCommercialStore.getState().refresh();

    expect(quotaMock).not.toHaveBeenCalled();
  });

  it('⭐ 登出（clearCache）后迟到的额度回包不写内存、不落缓存', async () => {
    let finish!: (value: unknown) => void;
    quotaMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const useCommercialStore = await loadStore();
    useCommercialStore.setState({ status: 'ready', overview: seededOverview() as never });

    const work = useCommercialStore.getState().refresh();
    useCommercialStore.getState().clearCache();
    finish(quotaResult(999_000_000));
    await work;

    const state = useCommercialStore.getState();
    expect(state.overview).toBeNull();
    expect(state.status).toBe('idle');
    expect(window.localStorage.getItem('cw:commercial-overview')).toBeNull();
  });

  it('轻量通道报错（抛异常）同样只降级为 offline，不炸 store', async () => {
    quotaMock.mockRejectedValue(new Error('ipc gone'));
    const useCommercialStore = await loadStore();
    useCommercialStore.setState({ status: 'ready', overview: seededOverview() as never });

    await useCommercialStore.getState().refresh();

    expect(useCommercialStore.getState().status).toBe('offline');
    expect(useCommercialStore.getState().overview?.license?.tokenUsedMicros).toBe(100_000_000);
  });
});
