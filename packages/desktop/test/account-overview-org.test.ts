import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `readAccountOverview` 选的**是哪个组织**。
 *
 * ## 为什么单独钉这一条
 *
 * 2026-09-24 的真实客诉（号 18581821250）：
 * 「显示这激活卡属于另一个组织，当前账号无法使用，去激活显示之前绑定的也改不了」。
 *
 * 根因之一就在这个函数：它以前写的是 `session.orgs[0]`，而 `readSessionState`
 * 查 `org_members` 时**既没有 order 也没有 role 过滤** ⇒
 *   · 「第一个」由数据库随意决定，两次读数可以不同；
 *   · 可能是用户**只是 member** 的组织 —— 而按 P1 明文口径，
 *     计费 RPC 全部要求 `role='owner'`，member 连中转 key 都读不到。
 * 于是界面把别人组织的卡显示成「当前账户已绑定 {sku}」，
 * 用户既用不了、又因为激活页那时不渲染输入框而换不掉。
 *
 * 纯选择器（`owner-org.test.ts`）只证明**规则**对；这个文件证明**接线**对 ——
 * 把 `auth.ts` 那行改回 `session.orgs[0]`，这里必须变红。
 */

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  readLicenseStatus: vi.fn(),
}));

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => ({ auth: { getUser: hoisted.getUser }, from: hoisted.from, rpc: hoisted.rpc }),
  resetCommercialClient: vi.fn(),
}));

vi.mock('../src/main/workspace/config.js', () => ({
  ensureDeviceId: () => 'stable-device-id',
  readConfig: () => ({ commercial: { licenseKey: null } }),
  updateConfig: vi.fn(),
}));

vi.mock('../src/main/debug/index.js', () => ({
  initDebugLogger: vi.fn(),
  getDebugLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() }),
}));

vi.mock('../src/main/commercial/license.js', () => ({
  deviceFingerprint: () => '0123456789abcdef0123456789abcdef',
  readLicenseStatus: hoisted.readLicenseStatus,
}));

interface OrgRow {
  role: string;
  joined_at: string;
  organizations: { id: string; name: string; slug: string; plan: string };
}

function chain(result: unknown, onEq?: (column: string, value: unknown) => void) {
  const node: Record<string, unknown> = {};
  for (const method of ['select', 'order', 'limit', 'not', 'in', 'is', 'filter']) {
    node[method] = vi.fn(() => node);
  }
  node.eq = vi.fn((column: string, value: unknown) => {
    onEq?.(column, value);
    return node;
  });
  node.maybeSingle = vi.fn(async () => result);
  node.single = vi.fn(async () => result);
  node.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
  return node;
}

function orgRow(id: string, role: string, joinedAt: string): OrgRow {
  return { role, joined_at: joinedAt, organizations: { id, name: id, slug: id, plan: 'pro' } };
}

/**
 * `activeCardOrgId` 决定**哪个组织有生效的卡** —— 其余组织返回空。
 * 这样「选错组织」不是断言上的差别，而是行为上的差别：拿不到卡。
 */
function wireSupabase(rows: OrgRow[], activeCardOrgId: string | null) {
  hoisted.from.mockImplementation((table: string) => {
    if (table === 'org_members') return chain({ data: rows, error: null });
    throw new Error(`unexpected table: ${table}`);
  });
  hoisted.readLicenseStatus.mockResolvedValue({
    ok: true,
    result: activeCardOrgId
      ? {
          configured: true,
          licenseId: 'lic-1',
          orgId: activeCardOrgId,
          licenseKey: 'RY-TEST-0001',
          sku: 'USB-内测版',
          status: 'active',
          expiresAt: null,
          maxActivations: 3,
          tokenQuotaMicros: 5_000_000_000,
          tokenUsedMicros: 1_000_000,
          activated: true,
          deviceFingerprint: 'fingerprint',
        }
      : {
          configured: false,
          licenseId: null,
          orgId: null,
          licenseKey: null,
          sku: null,
          status: null,
          expiresAt: null,
          maxActivations: 0,
          tokenQuotaMicros: 0,
          tokenUsedMicros: 0,
          activated: false,
          deviceFingerprint: 'fingerprint',
        },
  });
}

async function readOverview() {
  const { readAccountOverview } = await import('../src/main/commercial/auth.js');
  return readAccountOverview();
}

describe('readAccountOverview 的组织选择', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    hoisted.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: null, phone: '18581821250' } },
      error: null,
    });
  });

  it('更早加入的 **member** 组织排在前面 ⇒ 仍然选 owner 组织，卡也取它那张', async () => {
    wireSupabase(
      [orgRow('org-member', 'member', '2026-01-01T00:00:00Z'), orgRow('org-owner', 'owner', '2026-06-01T00:00:00Z')],
      'org-owner',
    );

    const res = await readOverview();

    expect(res.ok).toBe(true);
    const result = res.ok ? res.result : null;
    expect(result?.org?.id, '选中的组织').toBe('org-owner');
    expect(result?.license?.sku, '取到的是 owner 组织那张卡').toBe('USB-内测版');
    expect(hoisted.readLicenseStatus).toHaveBeenCalledTimes(1);
    expect(hoisted.from).not.toHaveBeenCalledWith('org_active_license');
  });

  it('两个 owner ⇒ 取先加入的那个（数组顺序颠倒也成立）', async () => {
    wireSupabase(
      [orgRow('org-late', 'owner', '2026-06-01T00:00:00Z'), orgRow('org-early', 'owner', '2026-01-01T00:00:00Z')],
      'org-early',
    );

    const res = await readOverview();

    const result = res.ok ? res.result : null;
    expect(result?.org?.id).toBe('org-early');
    expect(result?.license?.sku).toBe('USB-内测版');
    expect(hoisted.readLicenseStatus).toHaveBeenCalledTimes(1);
  });

  it('一个 owner 组织都没有 ⇒ 不显示任何卡（**不**挑一个 member 组织顶上）', async () => {
    wireSupabase([orgRow('org-member', 'member', '2026-01-01T00:00:00Z')], null);

    const res = await readOverview();

    const result = res.ok ? res.result : null;
    expect(result?.org, '没有 owner 组织 ⇒ org 为 null').toBeNull();
    expect(result?.license, '因此也不该显示卡').toBeNull();
    expect(hoisted.readLicenseStatus).toHaveBeenCalledTimes(1);
  });
});
