import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MembershipRow {
  user_id: string;
  org_id: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
}

interface LicenseRow {
  id: string;
  org_id: string;
  license_key: string;
  sku: string;
  status: string;
  expires_at: string | null;
  issued_at: string;
  max_activations: number;
  token_quota_micros: number;
  token_used_micros: number;
}

interface ActivationRow {
  id: string;
  license_id: string;
  device_fingerprint: string;
  revoked_at: string | null;
}

const state = vi.hoisted(() => ({
  currentUserId: 'user-current',
  config: {} as Record<string, unknown>,
  memberships: [] as MembershipRow[],
  licenses: [] as LicenseRow[],
  activeLicenses: [] as LicenseRow[],
  activations: [] as ActivationRow[],
  queriedTables: [] as string[],
  rpc: vi.fn(),
  beforeLicenseLookup: vi.fn<(licenseKey: string) => Promise<void>>(async () => {}),
}));

function filteredRows(
  table: string,
  equals: Map<string, unknown>,
  inValues: Map<string, readonly unknown[]>,
): unknown[] {
  const source =
    table === 'org_members'
      ? state.memberships
      : table === 'licenses'
        ? state.licenses
        : table === 'license_activations'
          ? state.activations
          : state.activeLicenses;

  return source.filter((row) => {
    const record = row as unknown as Record<string, unknown>;
    for (const [column, value] of equals) {
      if (record[column] !== value) return false;
    }
    for (const [column, values] of inValues) {
      if (!values.includes(record[column])) return false;
    }
    return true;
  });
}

function query(table: string) {
  const equals = new Map<string, unknown>();
  const inValues = new Map<string, readonly unknown[]>();
  const orders: Array<{ column: string; ascending: boolean }> = [];
  let limit: number | null = null;

  const execute = () => {
    const rows = filteredRows(table, equals, inValues).slice();
    rows.sort((left, right) => {
      const a = left as Record<string, unknown>;
      const b = right as Record<string, unknown>;
      for (const order of orders) {
        const av = String(a[order.column] ?? '');
        const bv = String(b[order.column] ?? '');
        const compared = av.localeCompare(bv);
        if (compared !== 0) return order.ascending ? compared : -compared;
      }
      return 0;
    });
    return { data: limit === null ? rows : rows.slice(0, limit), error: null };
  };

  const node = {
    select: vi.fn(() => node),
    eq: vi.fn((column: string, value: unknown) => {
      equals.set(column, value);
      return node;
    }),
    is: vi.fn((column: string, value: unknown) => {
      equals.set(column, value);
      return node;
    }),
    in: vi.fn((column: string, values: readonly unknown[]) => {
      inValues.set(column, values);
      return node;
    }),
    order: vi.fn((column: string, options?: { ascending?: boolean }) => {
      orders.push({ column, ascending: options?.ascending !== false });
      return node;
    }),
    limit: vi.fn((value: number) => {
      limit = value;
      return node;
    }),
    maybeSingle: vi.fn(async () => {
      if (table === 'licenses') {
        await state.beforeLicenseLookup(String(equals.get('license_key') ?? ''));
      }
      const result = execute();
      return { data: result.data[0] ?? null, error: null };
    }),
    then: (onFulfilled: (value: ReturnType<typeof execute>) => unknown) => Promise.resolve(execute()).then(onFulfilled),
  };
  return node;
}

const client = {
  auth: {
    getUser: vi.fn(async () => ({ data: { user: { id: state.currentUserId } }, error: null })),
  },
  from: vi.fn((table: string) => {
    state.queriedTables.push(table);
    return query(table);
  }),
  rpc: state.rpc,
};

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => client,
}));

vi.mock('../src/main/workspace/config.js', () => ({
  ensureDeviceId: () => 'stable-device-id',
  readConfig: () => state.config,
  updateConfig: (partial: Record<string, unknown>) => {
    state.config = { ...state.config, ...partial };
    return state.config;
  },
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() }),
}));

vi.mock('../src/main/ws/index.js', () => ({ getAllGatewayClients: () => new Map() }));

const ownLicense = (overrides: Partial<LicenseRow> = {}): LicenseRow => ({
  id: 'license-own',
  org_id: 'org-own',
  license_key: 'RY-OWN-0001',
  sku: 'USB-标准版',
  status: 'active',
  expires_at: null,
  issued_at: '2026-01-01T00:00:00Z',
  max_activations: 3,
  token_quota_micros: 5_000_000_000,
  token_used_micros: 125_000_000,
  ...overrides,
});

describe('commercial entitlement identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentUserId = 'user-current';
    state.config = {};
    state.memberships = [];
    state.licenses = [];
    state.activeLicenses = [];
    state.activations = [];
    state.queriedTables = [];
    state.rpc.mockReset();
    state.beforeLicenseLookup.mockReset();
    state.beforeLicenseLookup.mockResolvedValue(undefined);
  });

  it('releases the license queue after a stalled read so a later activation can complete', async () => {
    vi.useFakeTimers();
    try {
      const previous = ownLicense({ id: 'license-previous', license_key: 'RY-PREVIOUS-0001' });
      const activated = ownLicense({ id: 'license-activated', license_key: 'RY-ACTIVATED-0001' });
      state.config = {
        commercial: {
          licenseKey: previous.license_key,
          licenseBinding: { userId: state.currentUserId, orgId: previous.org_id, licenseId: previous.id },
        },
      };
      state.memberships = [
        {
          user_id: state.currentUserId,
          org_id: previous.org_id,
          role: 'owner',
          joined_at: '2026-01-01T00:00:00Z',
        },
      ];
      state.licenses = [previous, activated];
      state.activeLicenses = [activated];
      state.rpc.mockResolvedValue({ data: { relayKey: null }, error: null });

      let markPreviousLookupStarted!: () => void;
      const previousLookupStarted = new Promise<void>((resolve) => {
        markPreviousLookupStarted = resolve;
      });
      state.beforeLicenseLookup.mockImplementation((licenseKey) => {
        if (licenseKey !== previous.license_key) return Promise.resolve();
        markPreviousLookupStarted();
        return new Promise<void>(() => {});
      });

      const { activateLicense, readLicenseStatus } = await import('../src/main/commercial/license.js');
      const stalledRead = readLicenseStatus();
      await previousLookupStarted;
      const activation = activateLicense(activated.license_key);
      await Promise.resolve();
      expect(state.rpc).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(8_000);

      expect(state.rpc).toHaveBeenCalledTimes(1);
      await expect(stalledRead).resolves.toMatchObject({ ok: false, errorCode: 'license_read_failed' });
      await expect(activation).resolves.toMatchObject({
        ok: true,
        result: {
          licenseId: activated.id,
          orgId: activated.org_id,
          licenseKey: activated.license_key,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes a new activation behind an older license read so the old card cannot be written back last', async () => {
    const previous = ownLicense({ id: 'license-previous', license_key: 'RY-PREVIOUS-0001' });
    const activated = ownLicense({ id: 'license-activated', license_key: 'RY-ACTIVATED-0001' });
    state.config = {
      commercial: {
        licenseKey: previous.license_key,
        licenseBinding: { userId: state.currentUserId, orgId: previous.org_id, licenseId: previous.id },
      },
    };
    state.memberships = [
      {
        user_id: state.currentUserId,
        org_id: previous.org_id,
        role: 'owner',
        joined_at: '2026-01-01T00:00:00Z',
      },
    ];
    state.licenses = [previous, activated];
    state.activeLicenses = [activated];
    state.rpc.mockResolvedValue({ data: { relayKey: null }, error: null });

    let releasePrevious!: () => void;
    let markPreviousLookupStarted!: () => void;
    const previousLookupStarted = new Promise<void>((resolve) => {
      markPreviousLookupStarted = resolve;
    });
    const previousLookupBlocked = new Promise<void>((resolve) => {
      releasePrevious = resolve;
    });
    state.beforeLicenseLookup.mockImplementation(async (licenseKey) => {
      if (licenseKey !== previous.license_key) return;
      markPreviousLookupStarted();
      await previousLookupBlocked;
    });

    const { activateLicense, readLicenseStatus } = await import('../src/main/commercial/license.js');
    const oldRead = readLicenseStatus();
    await previousLookupStarted;
    const newActivation = activateLicense(activated.license_key);
    await Promise.resolve();
    await Promise.resolve();
    const rpcCallsBeforeOldReadSettled = state.rpc.mock.calls.length;

    releasePrevious();
    await Promise.all([oldRead, newActivation]);

    expect(rpcCallsBeforeOldReadSettled).toBe(0);
    expect(state.config).toMatchObject({
      commercial: {
        licenseKey: activated.license_key,
        licenseBinding: {
          userId: state.currentUserId,
          orgId: activated.org_id,
          licenseId: activated.id,
        },
      },
    });
  });

  it('does not let a slow license read restore a binding after the user clears it', async () => {
    const previous = ownLicense({ id: 'license-previous', license_key: 'RY-PREVIOUS-0001' });
    state.config = {
      commercial: {
        licenseKey: previous.license_key,
        licenseBinding: { userId: state.currentUserId, orgId: previous.org_id, licenseId: previous.id },
      },
    };
    state.memberships = [
      {
        user_id: state.currentUserId,
        org_id: previous.org_id,
        role: 'owner',
        joined_at: '2026-01-01T00:00:00Z',
      },
    ];
    state.licenses = [previous];

    let releasePrevious!: () => void;
    let markPreviousLookupStarted!: () => void;
    const previousLookupStarted = new Promise<void>((resolve) => {
      markPreviousLookupStarted = resolve;
    });
    const previousLookupBlocked = new Promise<void>((resolve) => {
      releasePrevious = resolve;
    });
    state.beforeLicenseLookup.mockImplementation(async (licenseKey) => {
      if (licenseKey !== previous.license_key) return;
      markPreviousLookupStarted();
      await previousLookupBlocked;
    });

    const { clearLicense, readLicenseStatus } = await import('../src/main/commercial/license.js');
    const oldRead = readLicenseStatus();
    await previousLookupStarted;

    expect(clearLicense()).toEqual({ ok: true });
    expect(state.config).toMatchObject({
      commercial: { licenseKey: undefined, licenseBinding: undefined },
    });

    releasePrevious();
    await oldRead;

    expect(state.config).toMatchObject({
      commercial: { licenseKey: undefined, licenseBinding: undefined },
    });
  });

  it('serializes concurrent activations so the final binding belongs to the final relay-key operation', async () => {
    const first = ownLicense({ id: 'license-first', license_key: 'RY-FIRST-0001' });
    const second = ownLicense({ id: 'license-second', license_key: 'RY-SECOND-0001' });
    state.memberships = [
      {
        user_id: state.currentUserId,
        org_id: first.org_id,
        role: 'owner',
        joined_at: '2026-01-01T00:00:00Z',
      },
    ];
    state.licenses = [first, second];
    state.activeLicenses = [second];

    let releaseFirst!: () => void;
    const firstRpcBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    state.rpc.mockImplementation(async (_name: string, params: { p_license_key: string }) => {
      if (params.p_license_key === first.license_key) await firstRpcBlocked;
      return { data: { relayKey: `relay-${params.p_license_key}` }, error: null };
    });

    const { activateLicense } = await import('../src/main/commercial/license.js');
    const firstActivation = activateLicense(first.license_key);
    await Promise.resolve();
    const secondActivation = activateLicense(second.license_key);
    await Promise.resolve();
    const rpcCallsBeforeFirstSettled = state.rpc.mock.calls.length;

    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([firstActivation, secondActivation]);

    expect(rpcCallsBeforeFirstSettled).toBe(1);
    expect(firstResult).toMatchObject({ ok: false, errorCode: 'activation_failed' });
    expect(secondResult.ok).toBe(true);
    expect(state.config).toMatchObject({
      commercial: {
        licenseKey: second.license_key,
        licenseBinding: {
          userId: state.currentUserId,
          orgId: second.org_id,
          licenseId: second.id,
        },
      },
    });
  });

  it('⭐ 激活响应永久丢失也会在 16 秒内返回“结果未知”并放行下一次操作', async () => {
    vi.useFakeTimers();
    try {
      const first = ownLicense({ id: 'license-slow', license_key: 'RY-SLOW-0001' });
      const second = ownLicense({ id: 'license-next', license_key: 'RY-NEXT-0001' });
      state.memberships = [
        {
          user_id: state.currentUserId,
          org_id: first.org_id,
          role: 'owner',
          joined_at: '2026-01-01T00:00:00Z',
        },
      ];
      state.licenses = [first, second];
      state.activeLicenses = [second];

      const blocked = new Promise<void>(() => {});
      state.rpc.mockImplementation(async (_name: string, params: { p_license_key: string }) => {
        if (params.p_license_key === first.license_key) await blocked;
        return { data: { relayKey: `relay-${params.p_license_key}` }, error: null };
      });

      const { activateLicense } = await import('../src/main/commercial/license.js');
      const firstActivation = activateLicense(first.license_key);
      await Promise.resolve();
      const secondActivation = activateLicense(second.license_key);
      let firstSettled = false;
      void firstActivation.finally(() => {
        firstSettled = true;
      });

      await vi.advanceTimersByTimeAsync(15_999);
      expect(firstSettled).toBe(false);
      expect(state.rpc).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      const [firstResult, secondResult] = await Promise.all([firstActivation, secondActivation]);
      expect(firstResult).toMatchObject({ ok: false, errorCode: 'activation_outcome_unknown' });
      expect(secondResult.ok).toBe(true);
      expect(state.rpc).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⭐ 激活响应丢失但 exact key + owner + 当前 device 已落库时，只读对账恢复成功', async () => {
    vi.useFakeTimers();
    try {
      const activated = ownLicense({ id: 'license-reconciled', license_key: 'RY-RECONCILED-0001' });
      state.memberships = [
        {
          user_id: state.currentUserId,
          org_id: activated.org_id,
          role: 'owner',
          joined_at: '2026-01-01T00:00:00Z',
        },
      ];
      state.licenses = [activated];
      state.activeLicenses = [activated];
      state.rpc.mockImplementation(async () => new Promise(() => {}));

      const { activateLicense, deviceFingerprint } = await import('../src/main/commercial/license.js');
      const activation = activateLicense(activated.license_key);
      await Promise.resolve();
      state.activations = [
        {
          id: 'activation-current-device',
          license_id: activated.id,
          device_fingerprint: deviceFingerprint(),
          revoked_at: null,
        },
      ];

      await vi.advanceTimersByTimeAsync(16_000);

      await expect(activation).resolves.toMatchObject({
        ok: true,
        result: {
          activated: true,
          licenseId: activated.id,
          licenseKey: activated.license_key,
          relayConfigured: false,
        },
      });
      expect(state.queriedTables).toContain('license_activations');
      expect(state.config).toMatchObject({
        commercial: {
          licenseKey: activated.license_key,
          licenseBinding: {
            userId: state.currentUserId,
            orgId: activated.org_id,
            licenseId: activated.id,
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an RLS-visible member card and recovers an exact owner-authorized license', async () => {
    const staleMemberCard = ownLicense({
      id: 'license-member-org',
      org_id: 'org-member',
      license_key: 'RY-MEMBER-0001',
      token_used_micros: 9,
    });
    const recovered = ownLicense();
    state.config = { commercial: { licenseKey: staleMemberCard.license_key } };
    state.memberships = [
      {
        user_id: state.currentUserId,
        org_id: 'org-member',
        role: 'member',
        joined_at: '2025-01-01T00:00:00Z',
      },
      {
        user_id: 'the-real-owner',
        org_id: 'org-member',
        role: 'owner',
        joined_at: '2024-01-01T00:00:00Z',
      },
      {
        user_id: state.currentUserId,
        org_id: recovered.org_id,
        role: 'owner',
        joined_at: '2026-01-01T00:00:00Z',
      },
    ];
    state.licenses = [staleMemberCard, recovered];
    state.activeLicenses = [recovered];

    const { readLicenseStatus } = await import('../src/main/commercial/license.js');
    const result = await readLicenseStatus();

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      activated: true,
      licenseId: recovered.id,
      orgId: recovered.org_id,
      licenseKey: recovered.license_key,
      tokenQuotaMicros: recovered.token_quota_micros,
      tokenUsedMicros: recovered.token_used_micros,
    });
    expect(state.config).toMatchObject({
      commercial: {
        licenseKey: recovered.license_key,
        licenseBinding: {
          userId: state.currentUserId,
          orgId: recovered.org_id,
          licenseId: recovered.id,
        },
      },
    });
  });

  it('recovers from every owner organization when the first owner organization has no active card', async () => {
    const recovered = ownLicense({ id: 'license-second-owner-org', org_id: 'org-owner-b' });
    state.memberships = [
      {
        user_id: state.currentUserId,
        org_id: 'org-owner-a',
        role: 'owner',
        joined_at: '2025-01-01T00:00:00Z',
      },
      {
        user_id: state.currentUserId,
        org_id: recovered.org_id,
        role: 'owner',
        joined_at: '2026-01-01T00:00:00Z',
      },
    ];
    state.licenses = [recovered];
    state.activeLicenses = [recovered];

    const { readLicenseStatus } = await import('../src/main/commercial/license.js');
    const result = await readLicenseStatus();

    expect(result.result).toMatchObject({
      activated: true,
      licenseId: recovered.id,
      orgId: recovered.org_id,
      licenseKey: recovered.license_key,
    });
  });

  it('keeps an exact cached owner/org/license binding without switching quota identity after restart', async () => {
    const cached = ownLicense();
    const otherCard = ownLicense({
      id: 'license-other',
      license_key: 'RY-OTHER-0001',
      token_quota_micros: 9_000_000_000,
      token_used_micros: 1,
    });
    state.config = {
      commercial: {
        licenseKey: cached.license_key,
        licenseBinding: { userId: state.currentUserId, orgId: cached.org_id, licenseId: cached.id },
      },
    };
    state.memberships = [
      {
        user_id: state.currentUserId,
        org_id: cached.org_id,
        role: 'owner',
        joined_at: '2026-01-01T00:00:00Z',
      },
    ];
    state.licenses = [cached, otherCard];
    state.activeLicenses = [otherCard];

    const { readLicenseStatus } = await import('../src/main/commercial/license.js');
    const result = await readLicenseStatus();

    expect(result.result).toMatchObject({
      activated: true,
      licenseId: cached.id,
      orgId: cached.org_id,
      licenseKey: cached.license_key,
      tokenQuotaMicros: cached.token_quota_micros,
      tokenUsedMicros: cached.token_used_micros,
    });
    expect(state.queriedTables).not.toContain('org_active_license');
  });

  it('rejects a cached key whose persisted owner/org/license triple does not match the live row', async () => {
    const stale = ownLicense();
    const recovered = ownLicense({
      id: 'license-current',
      license_key: 'RY-CURRENT-0001',
      token_quota_micros: 7_000_000_000,
      token_used_micros: 22,
    });
    state.config = {
      commercial: {
        licenseKey: stale.license_key,
        licenseBinding: { userId: state.currentUserId, orgId: stale.org_id, licenseId: 'different-license' },
      },
    };
    state.memberships = [
      {
        user_id: state.currentUserId,
        org_id: stale.org_id,
        role: 'owner',
        joined_at: '2026-01-01T00:00:00Z',
      },
    ];
    state.licenses = [stale, recovered];
    state.activeLicenses = [recovered];

    const { readLicenseStatus } = await import('../src/main/commercial/license.js');
    const result = await readLicenseStatus();

    expect(result.result).toMatchObject({
      licenseId: recovered.id,
      orgId: recovered.org_id,
      licenseKey: recovered.license_key,
      tokenQuotaMicros: recovered.token_quota_micros,
      tokenUsedMicros: recovered.token_used_micros,
    });
    expect(state.config).toMatchObject({
      commercial: {
        licenseKey: recovered.license_key,
        licenseBinding: {
          userId: state.currentUserId,
          orgId: recovered.org_id,
          licenseId: recovered.id,
        },
      },
    });
  });

  it('replaces a previous binding with the exact card just activated instead of another org card', async () => {
    const activated = ownLicense({ id: 'license-activated', license_key: 'RY-ACTIVATED-0001' });
    const otherCard = ownLicense({
      id: 'license-other',
      license_key: 'RY-OTHER-0001',
      token_quota_micros: 9_000_000_000,
      token_used_micros: 1,
    });
    state.config = {
      commercial: {
        licenseKey: 'RY-PREVIOUS-0001',
        licenseBinding: { userId: state.currentUserId, orgId: activated.org_id, licenseId: 'license-previous' },
      },
    };
    state.memberships = [
      {
        user_id: state.currentUserId,
        org_id: activated.org_id,
        role: 'owner',
        joined_at: '2026-01-01T00:00:00Z',
      },
    ];
    state.licenses = [activated, otherCard];
    state.activeLicenses = [otherCard];
    state.rpc.mockResolvedValue({ data: { relayKey: null }, error: null });

    const { activateLicense } = await import('../src/main/commercial/license.js');
    const result = await activateLicense(activated.license_key);

    expect(result.result).toMatchObject({
      licenseId: activated.id,
      orgId: activated.org_id,
      licenseKey: activated.license_key,
      tokenQuotaMicros: activated.token_quota_micros,
      tokenUsedMicros: activated.token_used_micros,
    });
    expect(state.config).toMatchObject({
      commercial: {
        licenseKey: activated.license_key,
        licenseBinding: {
          userId: state.currentUserId,
          orgId: activated.org_id,
          licenseId: activated.id,
        },
      },
    });
  });

  it('clears a cached member-only key when the current owner identity has no authorized license', async () => {
    const staleMemberCard = ownLicense({
      id: 'license-member-org',
      org_id: 'org-member',
      license_key: 'RY-MEMBER-0001',
    });
    state.config = {
      commercial: {
        licenseKey: staleMemberCard.license_key,
        licenseBinding: { userId: 'previous-user', orgId: staleMemberCard.org_id, licenseId: staleMemberCard.id },
      },
    };
    state.memberships = [
      {
        user_id: state.currentUserId,
        org_id: staleMemberCard.org_id,
        role: 'member',
        joined_at: '2025-01-01T00:00:00Z',
      },
    ];
    state.licenses = [staleMemberCard];

    const { readLicenseStatus } = await import('../src/main/commercial/license.js');
    const result = await readLicenseStatus();

    expect(result.result).toMatchObject({ configured: false, activated: false, licenseKey: null });
    expect(state.config).toMatchObject({
      commercial: { licenseKey: undefined, licenseBinding: undefined },
    });
  });
  it.each(['committed', 'missing-device', 'revoked-device', 'other-device', 'member', 'other-key'] as const)(
    'only recovers exact current activation without submitting another RPC: %s',
    async (mode) => {
      const license = ownLicense();
      state.memberships = [
        {
          user_id: state.currentUserId,
          org_id: license.org_id,
          role: mode === 'member' ? 'member' : 'owner',
          joined_at: '2026-01-01T00:00:00Z',
        },
      ];
      state.licenses = [license];
      state.activeLicenses = [license];
      const module = await import('../src/main/commercial/license.js');
      const recovery = module.recoverLicenseActivation;
      expect(typeof recovery).toBe('function');
      if (mode !== 'missing-device')
        state.activations = [
          {
            id: 'activation-exact',
            license_id: license.id,
            device_fingerprint: mode === 'other-device' ? 'another-device' : module.deviceFingerprint(),
            revoked_at: mode === 'revoked-device' ? '2026-01-01T00:00:00Z' : null,
          },
        ];
      const result = await recovery(mode === 'other-key' ? 'RY-ANOTHER-KEY' : license.license_key);
      expect(result).toMatchObject(
        mode === 'committed'
          ? { ok: true, result: { licenseId: license.id, activated: true, relayConfigured: false } }
          : { ok: false, errorCode: 'activation_outcome_unknown' },
      );
      expect(state.rpc).not.toHaveBeenCalled();
      if (mode !== 'committed') expect(state.config).toEqual({});
    },
  );

  it('does not restore a binding after recovery is superseded by clearing the license', async () => {
    const license = ownLicense();
    state.licenses = [license];
    state.activeLicenses = [license];
    state.memberships = [
      { user_id: state.currentUserId, org_id: license.org_id, role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
    ];
    const module = await import('../src/main/commercial/license.js');
    state.activations = [
      {
        id: 'activation-exact',
        license_id: license.id,
        device_fingerprint: module.deviceFingerprint(),
        revoked_at: null,
      },
    ];
    let finishLookup: (() => void) | undefined;
    state.beforeLicenseLookup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLookup = resolve;
        }),
    );
    const recovery = module.recoverLicenseActivation(license.license_key);
    for (let i = 0; i < 20 && !finishLookup; i++) await Promise.resolve();
    expect(finishLookup).toBeTypeOf('function');
    module.clearLicense();
    finishLookup?.();
    await expect(recovery).resolves.toMatchObject({ ok: false, errorCode: 'activation_outcome_unknown' });
    expect(state.config).toEqual({});
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('rejects an empty recovery key before querying or activating', async () => {
    const module = await import('../src/main/commercial/license.js');
    await expect(module.recoverLicenseActivation('   ')).resolves.toMatchObject({ ok: false, errorCode: 'empty_key' });
    expect(state.queriedTables).toEqual([]);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('does not report recovery success when the license is cleared during the final status read', async () => {
    const license = ownLicense();
    state.licenses = [license];
    state.activeLicenses = [license];
    state.memberships = [
      { user_id: state.currentUserId, org_id: license.org_id, role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
    ];
    const module = await import('../src/main/commercial/license.js');
    state.activations = [
      {
        id: 'activation-exact',
        license_id: license.id,
        device_fingerprint: module.deviceFingerprint(),
        revoked_at: null,
      },
    ];
    let finishFinalRead: (() => void) | undefined;
    state.beforeLicenseLookup
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFinalRead = resolve;
          }),
      );
    const recovery = module.recoverLicenseActivation(license.license_key);
    for (let i = 0; i < 50 && !finishFinalRead; i++) await Promise.resolve();
    expect(finishFinalRead).toBeTypeOf('function');
    expect(state.config).toMatchObject({ commercial: { licenseBinding: { licenseId: license.id } } });
    module.clearLicense();
    finishFinalRead?.();
    await expect(recovery).resolves.toMatchObject({ ok: false, errorCode: 'activation_outcome_unknown' });
    expect(state.config).toMatchObject({ commercial: { licenseBinding: undefined, licenseKey: undefined } });
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('never submits a queued activation after its account generation was cleared', async () => {
    const previous = ownLicense();
    state.licenses = [previous];
    state.activeLicenses = [previous];
    state.memberships = [
      { user_id: state.currentUserId, org_id: previous.org_id, role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
    ];
    state.config = { commercial: { licenseKey: previous.license_key } };
    let finishLookup: (() => void) | undefined;
    state.beforeLicenseLookup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLookup = resolve;
        }),
    );
    state.rpc.mockResolvedValue({ data: { relayKey: null }, error: null });
    const module = await import('../src/main/commercial/license.js');
    const olderRead = module.readLicenseStatus();
    for (let i = 0; i < 30 && !finishLookup; i++) await Promise.resolve();
    expect(finishLookup).toBeTypeOf('function');
    const activation = module.activateLicense('RY-NEXT-UNCLAIMED');
    module.clearLicense();
    state.currentUserId = 'another-user';
    finishLookup?.();
    await olderRead;
    await expect(activation).resolves.toMatchObject({ ok: false, errorCode: 'activation_failed' });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.config).toMatchObject({ commercial: { licenseKey: undefined, licenseBinding: undefined } });
  });
});
