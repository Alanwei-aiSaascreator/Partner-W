import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BUG-082（C-B §1）：**先拆读副作用**。
 *
 * 事实（2026-10-15 核查）：`readAccountOverview` 每次调用都会 fire-and-forget
 * 打一发 `activate_license`（设备登记）—— 那是一条**写** RPC。而余额要能每几秒
 * 刷一次（消费中），这条读路径就绝不能再带写。
 *
 * 这两组断言锁的是拆分的两条腿：
 *   ① 读路径（概览 + 新的轻量额度快照）**一次都不许**打 `activate_license`；
 *   ② 轻量通道与概览必须给出**同一张卡**的额度（同一套 user/org/license 校验），
 *      否则"顶栏一个数、账户页另一个数"会以更隐蔽的形式回来。
 *
 * ⚠️ 设备登记本身没有被删除 —— 它仍在**激活 / 中转 bootstrap** 边界上
 *    （`relay-startup.ts` 的 `fetchRelayKeyForLicense` → `activate_license`）。
 */

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string | null; phone: string | null; user_metadata: unknown },
  rpc: vi.fn(),
  readLicenseStatus: vi.fn(),
}));

const memberships = [
  {
    user_id: 'user-current',
    role: 'owner',
    joined_at: '2026-01-01T00:00:00Z',
    organizations: { id: 'org-exact', name: 'Exact', slug: 'exact', plan: 'pro' },
  },
];

function membershipQuery() {
  const node = {
    select: vi.fn(() => node),
    eq: vi.fn(() => node),
    order: vi.fn(() => node),
    then: (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve({ data: memberships, error: null }).then(onFulfilled),
  };
  return node;
}

const client = {
  auth: {
    getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })),
  },
  from: vi.fn((table: string) => {
    if (table === 'org_members') return membershipQuery();
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

const activeLicense = {
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
};

describe('额度读取通道不带写副作用（BUG-082）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: 'user-current', email: 'owner@example.test', phone: null, user_metadata: {} };
    state.readLicenseStatus.mockResolvedValue({ ok: true, result: activeLicense });
    state.rpc.mockResolvedValue({ data: { relayKey: 'rly_test' }, error: null });
  });

  it('轻量额度快照给出与概览同一张卡的额度，且**不打设备登记 RPC**', async () => {
    const { readQuotaSnapshot } = await import('../src/main/commercial/auth.js');
    const result = await readQuotaSnapshot();

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      org: { id: 'org-exact', role: 'owner' },
      license: {
        activated: true,
        licenseId: 'license-exact',
        orgId: 'org-exact',
        tokenQuotaMicros: 5_000_000_000,
        tokenUsedMicros: 125_000_000,
      },
    });
    expect(typeof result.result?.fetchedAt).toBe('string');

    // ⭐ 这条是本次修复的核心：读余额一步都不许碰 activate_license。
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('账户概览（全量快照）同样不再触发设备登记', async () => {
    const { readAccountOverview } = await import('../src/main/commercial/auth.js');
    const result = await readAccountOverview();

    expect(result.ok).toBe(true);
    expect(result.result?.license?.licenseId).toBe('license-exact');
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('两条通道在同一时刻给出同一张卡的同一个余额（不会各读各的）', async () => {
    const { readAccountOverview, readQuotaSnapshot } = await import('../src/main/commercial/auth.js');

    const overview = await readAccountOverview();
    const snapshot = await readQuotaSnapshot();

    expect(snapshot.result?.license?.tokenUsedMicros).toBe(overview.result?.license?.tokenUsedMicros);
    expect(snapshot.result?.license?.licenseId).toBe(overview.result?.license?.licenseId);
    expect(snapshot.result?.org?.id).toBe(overview.result?.org?.id);
  });

  it('未登录时轻量通道如实报 not_signed_in，而不是给出空额度', async () => {
    state.user = null;
    const { readQuotaSnapshot } = await import('../src/main/commercial/auth.js');
    const result = await readQuotaSnapshot();

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('not_signed_in');
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('卡不属于当前账号（校验失败）时轻量通道给 null，不给出别人的余额', async () => {
    state.readLicenseStatus.mockResolvedValue({
      ok: true,
      result: { ...activeLicense, configured: false, activated: false, licenseId: null, orgId: null },
    });
    const { readQuotaSnapshot } = await import('../src/main/commercial/auth.js');
    const result = await readQuotaSnapshot();

    expect(result.ok).toBe(true);
    expect(result.result?.license).toBeNull();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('license 读取失败时轻量通道如实失败（不塌缩成"余额 0"）', async () => {
    state.readLicenseStatus.mockResolvedValue({ ok: false, error: 'boom', errorCode: 'license_read_failed' });
    const { readQuotaSnapshot } = await import('../src/main/commercial/auth.js');
    const result = await readQuotaSnapshot();

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('license_read_failed');
  });
});
