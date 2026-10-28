import { beforeEach, describe, expect, it, vi } from 'vitest';

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe.each(['dashboard', 'usage'] as const)('%s workspace request ownership', (kind) => {
  let rpc: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    rpc = vi.fn();
    const target = (globalThis.window ??= {} as typeof globalThis.window);
    target.clawwork = { loadDashboardStats: rpc, getUsageStatus: rpc } as unknown as Window['clawwork'];
  });

  async function store() {
    if (kind === 'dashboard') {
      const { useDashboardStore: s } = await import('../src/renderer/stores/dashboardStore');
      return {
        clear: () => s.getState().clear(),
        fetch: () => s.getState().fetch(true),
        state: () => s.getState(),
        value: () => s.getState().data,
      };
    }
    const { useUsageStore: s } = await import('../src/renderer/stores/usageStore');
    return {
      clear: () => s.getState().clear(),
      fetch: () => s.getState().fetchUsage('same-gateway'),
      state: () => s.getState(),
      value: () => s.getState().status,
    };
  }

  it('ignores old success after clear even when the gateway identity is reused', async () => {
    const s = await store(),
      old = deferred(),
      current = deferred();
    rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const before = s.fetch();
    s.clear();
    const after = s.fetch();
    old.resolve({ ok: true, result: { marker: 'old-workspace' } });
    await before;
    expect(s.value()).toBeNull();
    expect(s.state().loading).toBe(true);
    current.resolve({ ok: true, result: { marker: 'current-workspace' } });
    await after;
    expect(s.value()).toEqual({ marker: 'current-workspace' });
  });

  it.each(['reply', 'throw'] as const)(
    'ignores stale %s failure without settling the current request',
    async (failure) => {
      const s = await store(),
        old = deferred(),
        current = deferred();
      rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      const before = s.fetch();
      s.clear();
      const after = s.fetch();
      if (failure === 'reply') old.resolve({ ok: false, error: 'old-error' });
      else old.reject(new Error('old-error'));
      await before;
      expect(s.state().loading).toBe(true);
      expect('error' in s.state() ? s.state().error : null).toBeNull();
      current.resolve({ ok: false, error: 'current-error' });
      await after;
      expect(s.state().loading).toBe(false);
      expect(s.state()).toMatchObject({ error: 'current-error' });
    },
  );

  it('does not overwrite a current failure with a late old success', async () => {
    const s = await store(),
      old = deferred();
    rpc.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: false, error: 'current-error' });
    const before = s.fetch();
    s.clear();
    await s.fetch();
    old.resolve({ ok: true, result: { marker: 'old-workspace' } });
    await before;
    expect(s.value()).toBeNull();
    expect(s.state()).toMatchObject({ loading: false, error: 'current-error' });
  });
});

it('usage cache belongs to its gateway and the newest gateway request wins', async () => {
  vi.resetModules();
  const old = deferred(),
    rpc = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ ok: true, result: { providers: ['new'] } });
  (globalThis.window ??= {} as typeof globalThis.window).clawwork = {
    getUsageStatus: rpc,
  } as unknown as Window['clawwork'];
  const { useUsageStore: s } = await import('../src/renderer/stores/usageStore');
  const before = s.getState().fetchUsage('old-gateway');
  await s.getState().fetchUsage('new-gateway');
  old.resolve({ ok: true, result: { providers: ['old'] } });
  await before;
  expect(s.getState().status).toEqual({ providers: ['new'] });
  await s.getState().fetchUsage('new-gateway');
  expect(rpc).toHaveBeenCalledTimes(2);
  await s.getState().fetchUsage('third-gateway');
  expect(rpc).toHaveBeenCalledTimes(3);
});

it.each(['reply', 'throw'] as const)(
  'usage hides gateway A status while gateway B is pending and after its %s failure',
  async (failure) => {
    vi.resetModules();
    const pending = deferred(),
      rpc = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, result: { providers: ['A'] } })
        .mockReturnValueOnce(pending.promise);
    (globalThis.window ??= {} as typeof globalThis.window).clawwork = {
      getUsageStatus: rpc,
    } as unknown as Window['clawwork'];
    const { useUsageStore: s } = await import('../src/renderer/stores/usageStore');
    await s.getState().fetchUsage('A');
    const request = s.getState().fetchUsage('B');
    expect(s.getState()).toMatchObject({ status: null, loading: true });
    if (failure === 'reply') pending.resolve({ ok: false, error: 'B failed' });
    else pending.reject(new Error('B failed'));
    await request;
    expect(s.getState()).toMatchObject({ status: null, loading: false, error: 'B failed' });
  },
);
