import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const overviewMock = vi.fn();
/** 轻量只读额度通道（BUG-082）：静默刷新走它，不再跑整份概览。 */
const quotaMock = vi.fn();
const licenseStatusMock = vi.fn();

async function loadStore() {
  vi.resetModules();
  const module = await import('../src/renderer/stores/commercialStore');
  return module.useCommercialStore;
}

describe('commercial store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const target = (globalThis.window ??= {} as typeof globalThis.window) as unknown as Window & {
      clawwork: Record<string, unknown>;
      localStorage: Storage;
    };
    target.clawwork = {
      commercialAccountOverview: overviewMock,
      commercialQuotaSnapshot: quotaMock,
      commercialLicenseStatus: licenseStatusMock,
    } as unknown as typeof target.clawwork;
    // 这个文件跑在 node 环境（没有 jsdom ⇒ 没有 localStorage）。
    // 用 Map 兜一个：store 会把快照缓存到 localStorage，"登出清缓存"这条
    // 必须连**磁盘那份**一起验证 —— 只清内存的话，reload 之后又会读回来。
    const store = new Map<string, string>();
    target.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    } as Storage;
  });

  it('stores the quota numbers from the account overview', async () => {
    overviewMock.mockResolvedValue({
      ok: true,
      result: {
        account: { userId: 'u1', phone: null, email: null, nickname: null, avatar: null },
        org: { id: 'o1', name: '我的空间', plan: 'free', role: 'owner' },
        license: {
          licenseKey: 'RY-1',
          sku: 'USB-标准版',
          status: 'active',
          expiresAt: null,
          maxActivations: 1,
          tokenQuotaMicros: 5000,
          tokenUsedMicros: 1000,
          activated: true,
        },
        device: { fingerprint: 'f', shortFingerprint: 'f' },
        fetchedAt: '2026-09-10T00:00:00.000Z',
      },
    });

    const useCommercialStore = await loadStore();
    await useCommercialStore.getState().load();

    const state = useCommercialStore.getState();
    expect(state.status).toBe('ready');
    expect(state.overview?.license?.tokenQuotaMicros).toBe(5000);
    expect(state.overview?.license?.tokenUsedMicros).toBe(1000);
  });

  it('marks itself offline but keeps the last good snapshot on failure', async () => {
    overviewMock.mockResolvedValue({ ok: false, error: 'network down' });

    const useCommercialStore = await loadStore();
    useCommercialStore.setState({
      status: 'ready',
      overview: { license: { tokenQuotaMicros: 100, tokenUsedMicros: 1 } } as never,
    });
    await useCommercialStore.getState().load();

    const state = useCommercialStore.getState();
    expect(state.status).toBe('offline');
    expect(state.overview?.license?.tokenUsedMicros).toBe(1);
  });

  /**
   * ⭐ 2026-09-17：闸门改成"读失败时可用缓存放行"之后，**登出必须清缓存**。
   *
   * 否则：A 登出 → B 登录 → B 的额度读取失败 ⇒ 闸门会拿 **A 的快照**给 B 授权，
   * 而那张许可证根本不是他的。这正是 store 里那句旧注释担心的事，
   * 只是以前"缓存不授权"把它挡住了；现在得靠登出清缓存来挡。
   */
  it('⭐ 登出清缓存：切换账号后不会拿上一个人的快照授权', async () => {
    const useCommercialStore = await loadStore();
    useCommercialStore.setState({
      status: 'ready',
      overview: {
        account: { userId: 'u-old' },
        license: { tokenQuotaMicros: 100, tokenUsedMicros: 1 },
      } as never,
    });
    expect(useCommercialStore.getState().overview).not.toBeNull();

    useCommercialStore.getState().clearCache();

    const state = useCommercialStore.getState();
    expect(state.overview).toBeNull();
    expect(state.status).toBe('idle');
    // localStorage 里那份也要清掉，否则下次启动又会从磁盘读回来
    expect(window.localStorage.getItem('cw:commercial-overview')).toBeNull();
  });

  it('stores a null licence without treating it as an error', async () => {
    overviewMock.mockResolvedValue({
      ok: true,
      result: {
        account: { userId: 'u1', phone: null, email: null, nickname: null, avatar: null },
        org: null,
        license: null,
        device: { fingerprint: 'f', shortFingerprint: 'f' },
        fetchedAt: '2026-09-10T00:00:00.000Z',
      },
    });

    const useCommercialStore = await loadStore();
    await useCommercialStore.getState().load();

    const state = useCommercialStore.getState();
    expect(state.status).toBe('ready');
    expect(state.overview?.license).toBeNull();
  });

  it('marks authorization offline when a silent refresh fails', async () => {
    quotaMock.mockResolvedValue({ ok: false, error: 'network down' });

    const useCommercialStore = await loadStore();
    const cachedOverview = {
      account: { userId: 'u-old' },
      license: { tokenQuotaMicros: 100, tokenUsedMicros: 1 },
    } as never;
    useCommercialStore.setState({ status: 'ready', overview: cachedOverview });

    await useCommercialStore.getState().refresh();

    const state = useCommercialStore.getState();
    expect(state.status).toBe('offline');
    // 保留最近一次成功的值（不清、不归零）——界面据此显示"更新于 …"
    expect(state.overview).toBe(cachedOverview);
    expect(quotaMock, '静默刷新只打轻量额度通道').toHaveBeenCalledTimes(1);
    expect(overviewMock, '不再为了刷新跑整份账户概览').not.toHaveBeenCalled();
  });
});

/**
 * R2（2026-10-10 集中终审 §4.7）：账号代次 + 读序号守卫 ——
 * "A 的激活/overview 迟到于 B"不许再写回缓存/内存。
 *
 * ⚠️ 磁盘桩挂两处：store 里的 `localStorage` 是裸标识符（Node 环境解析到
 * `globalThis.localStorage`，Node 24 默认没有这个全局）——只挂 `window.localStorage`
 * 的话"磁盘那份"的断言是空转。这里把同一份 Map 桩同时挂到 globalThis 与 window。
 */
describe('commercial store — 账号代次守卫（R2）', () => {
  let disk: Map<string, string>;
  beforeEach(() => {
    vi.clearAllMocks();
    disk = new Map<string, string>();
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
      commercialAccountOverview: overviewMock,
      commercialQuotaSnapshot: quotaMock,
    } as unknown as typeof target.clawwork;
    target.localStorage = stub;
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
  });

  const resultFor = (userId: string) => ({
    ok: true as const,
    result: {
      account: { userId, phone: null, email: null, nickname: null, avatar: null },
      org: null,
      license: null,
      device: { fingerprint: 'f', shortFingerprint: 'f' },
      fetchedAt: '2026-10-10T00:00:00.000Z',
    },
  });

  it('⭐ clearCache 后旧账号的迟到回包：内存与磁盘缓存都不许写', async () => {
    let finish!: (value: unknown) => void;
    overviewMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const useCommercialStore = await loadStore();
    const work = useCommercialStore.getState().load();
    useCommercialStore.getState().clearCache();

    finish(resultFor('A'));
    await work;

    const state = useCommercialStore.getState();
    expect(state.overview).toBeNull();
    expect(state.status).toBe('idle');
    expect(disk.get('cw:commercial-overview')).toBeUndefined();
  });

  it('旧代次的迟到失败不把新代次的 status 打成 offline', async () => {
    let reject!: (error: Error) => void;
    overviewMock.mockImplementationOnce(() => new Promise((_resolve, no) => (reject = no)));
    const useCommercialStore = await loadStore();
    const work = useCommercialStore.getState().load();
    useCommercialStore.getState().clearCache();

    reject(new Error('late failure'));
    await work;

    expect(useCommercialStore.getState().status).toBe('idle');
  });

  it('⭐ 组件级判据在写回前合取：load(isCurrent=false) ⇒ 不写缓存、不落内存', async () => {
    overviewMock.mockResolvedValue(resultFor('A'));
    const useCommercialStore = await loadStore();

    await useCommercialStore.getState().load(() => false);

    expect(useCommercialStore.getState().overview).toBeNull();
    expect(disk.get('cw:commercial-overview')).toBeUndefined();
  });

  it('refresh 的迟到回包同样被代次作废', async () => {
    let finish!: (value: unknown) => void;
    quotaMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const useCommercialStore = await loadStore();
    useCommercialStore.setState({ status: 'ready', overview: { account: { userId: 'A' } } as never });

    const work = useCommercialStore.getState().refresh();
    useCommercialStore.getState().clearCache();
    finish({
      ok: true,
      result: {
        license: { tokenQuotaMicros: 100, tokenUsedMicros: 1 },
        org: null,
        fetchedAt: '2026-10-10T00:00:00.000Z',
      },
    });
    await work;

    expect(useCommercialStore.getState().overview).toBeNull();
    expect(disk.get('cw:commercial-overview')).toBeUndefined();
  });

  it('两个 load 竞速：后发者赢，先发的迟到回包被序号作废', async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    overviewMock.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const useCommercialStore = await loadStore();

    const first = useCommercialStore.getState().load();
    const second = useCommercialStore.getState().load();
    resolvers[1](resultFor('NEW'));
    resolvers[0](resultFor('OLD'));
    await Promise.all([first, second]);

    expect(useCommercialStore.getState().overview?.account?.userId).toBe('NEW');
    expect(JSON.parse(disk.get('cw:commercial-overview') ?? '{}').account.userId).toBe('NEW');
  });
});
