import { beforeEach, describe, expect, it, vi } from 'vitest';

const overviewMock = vi.fn();
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
    overviewMock.mockResolvedValue({ ok: false, error: 'network down' });

    const useCommercialStore = await loadStore();
    const cachedOverview = {
      account: { userId: 'u-old' },
      license: { tokenQuotaMicros: 100, tokenUsedMicros: 1 },
    } as never;
    useCommercialStore.setState({ status: 'ready', overview: cachedOverview });

    await useCommercialStore.getState().refresh();

    const state = useCommercialStore.getState();
    expect(state.status).toBe('offline');
    expect(state.overview).toBe(cachedOverview);
  });
});
