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
    };
    target.clawwork = {
      commercialAccountOverview: overviewMock,
      commercialLicenseStatus: licenseStatusMock,
    } as unknown as typeof target.clawwork;
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
