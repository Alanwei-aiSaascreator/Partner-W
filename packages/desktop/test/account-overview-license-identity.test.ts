import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  membershipFilters: [] as Array<[string, unknown]>,
  queriedTables: [] as string[],
  rpc: vi.fn(),
  readLicenseStatus: vi.fn(),
}));

const memberships = [
  {
    user_id: 'somebody-else',
    role: 'owner',
    joined_at: '2025-01-01T00:00:00Z',
    organizations: { id: 'org-shared', name: 'Shared', slug: 'shared', plan: 'pro' },
  },
  {
    user_id: 'user-current',
    role: 'owner',
    joined_at: '2026-01-01T00:00:00Z',
    organizations: { id: 'org-exact', name: 'Exact', slug: 'exact', plan: 'pro' },
  },
];

function membershipQuery() {
  const filters = new Map<string, unknown>();
  const node = {
    select: vi.fn(() => node),
    eq: vi.fn((column: string, value: unknown) => {
      state.membershipFilters.push([column, value]);
      filters.set(column, value);
      return node;
    }),
    order: vi.fn(() => node),
    then: (onFulfilled: (value: unknown) => unknown) => {
      const data = memberships.filter((row) => {
        for (const [column, value] of filters) {
          if ((row as unknown as Record<string, unknown>)[column] !== value) return false;
        }
        return true;
      });
      return Promise.resolve({ data, error: null }).then(onFulfilled);
    },
  };
  return node;
}

function staleOverviewQuery() {
  const node = {
    select: vi.fn(() => node),
    eq: vi.fn(() => node),
    maybeSingle: vi.fn(async () => ({
      data: {
        id: 'license-wrong',
        license_key: 'RY-WRONG-0001',
        sku: 'wrong-card',
        status: 'active',
        expires_at: null,
        token_quota_micros: 99,
        token_used_micros: 1,
      },
      error: null,
    })),
  };
  return node;
}

const client = {
  auth: {
    getUser: vi.fn(async () => ({
      data: {
        user: {
          id: 'user-current',
          email: 'owner@example.test',
          phone: null,
          user_metadata: {},
        },
      },
      error: null,
    })),
  },
  from: vi.fn((table: string) => {
    state.queriedTables.push(table);
    if (table === 'org_members') return membershipQuery();
    if (table === 'org_active_license') return staleOverviewQuery();
    throw new Error(`unexpected table: ${table}`);
  }),
  rpc: state.rpc,
};

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => client,
  resetCommercialClient: vi.fn(),
}));

vi.mock('../src/main/commercial/license.js', () => ({
  deviceFingerprint: () => '0123456789abcdef0123456789abcdef',
  readLicenseStatus: state.readLicenseStatus,
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() }),
}));

describe('account overview uses the relay entitlement identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.membershipFilters = [];
    state.queriedTables = [];
    state.readLicenseStatus.mockResolvedValue({
      ok: true,
      result: {
        configured: true,
        licenseId: 'license-exact',
        orgId: 'org-exact',
        licenseKey: 'RY-EXACT-0001',
        sku: 'exact-card',
        status: 'active',
        expiresAt: null,
        maxActivations: 3,
        tokenQuotaMicros: 5_000_000_000,
        tokenUsedMicros: 125_000_000,
        activated: true,
        deviceFingerprint: 'fingerprint',
      },
    });
    state.rpc.mockResolvedValue({ data: {}, error: null });
  });

  it('filters memberships to the signed-in user and displays the exact license used by relay bootstrap', async () => {
    const { readAccountOverview } = await import('../src/main/commercial/auth.js');
    const result = await readAccountOverview();

    expect(result.ok).toBe(true);
    expect(state.membershipFilters).toContainEqual(['user_id', 'user-current']);
    expect(result.result).toMatchObject({
      org: { id: 'org-exact', role: 'owner' },
      license: {
        activated: true,
        licenseId: 'license-exact',
        orgId: 'org-exact',
        licenseKey: 'RY-EXACT-0001',
        tokenQuotaMicros: 5_000_000_000,
        tokenUsedMicros: 125_000_000,
      },
    });
    expect(state.queriedTables).not.toContain('org_active_license');
  });
});
