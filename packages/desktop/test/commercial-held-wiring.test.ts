import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BUG-082 续（2026-10-16，C owner）——**在途预占（held）全链路贯通**。
 *
 * 事实：额度 = `quota − used − **held**`，而 held 只在 relay 算得出来
 * （三张媒体表 `pending/accepted/unknown` 的 `reserved_micros` 之和，
 * `services/relay/src/held.ts` 的 `HOLD_SOURCES`）。后端把它挂到 `/v1/usage`
 * 的**只增**字段上：`heldMicros` / `availableMicros` / `heldComplete`。
 *
 * 本文件锁的就是桌面侧这一段接线，以及三种状态**必须分得清**：
 *   ① 后端报了确定值        ⇒ `tokenHeldMicros` 有值、`heldComplete` 原样透传；
 *   ② 后端说"口径不可判定"  ⇒ `heldComplete: false` **必须原样带出**，
 *      绝不许在本地把未知折成 0（那正是要修的缺陷：未知显示成确定余额）；
 *   ③ 问不到（没 key/网络/超时/坏形状/老后端）⇒ **同样是不可判定**：
 *      `tokenHeldMicros` 不写，`heldComplete` 写 false。授权结果本身不受影响。
 *
 * ⚠️ r14 返工（2026-10-16）：③ 原本写成"两个字段都不写、UI 沿用 `quota − used` 旧口径"，
 *    独审判定那是把"读不到"伪装成"确定没有预占" —— 替身 relay 返 503 时界面照样显示
 *    确定的 1,000.40。**读不到 ≠ 没有**，现在统一落成 `heldComplete: false`。
 *
 * ⚠️ 真实 relay / 真实媒体冻结 = NOT RUN：这些用例走的是替身 HTTP 与假 Supabase，
 *    只证明"接线与语义"，不替代真实账单验收。
 */

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

const state = vi.hoisted(() => ({
  currentUserId: 'user-current',
  memberships: [] as Array<{ user_id: string; org_id: string; role: string; joined_at: string }>,
  activeLicenses: [] as LicenseRow[],
}));

function query(table: string) {
  const inValues = new Map<string, readonly unknown[]>();
  const equals = new Map<string, unknown>();
  const node = {
    select: vi.fn(() => node),
    eq: vi.fn((column: string, value: unknown) => {
      equals.set(column, value);
      return node;
    }),
    in: vi.fn((column: string, values: readonly unknown[]) => {
      inValues.set(column, values);
      return node;
    }),
    order: vi.fn(() => node),
    limit: vi.fn(() => node),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    then: (onFulfilled: (value: { data: unknown[]; error: null }) => unknown) => {
      const source = table === 'org_members' ? state.memberships : state.activeLicenses;
      const rows = source.filter((row) => {
        const record = row as unknown as Record<string, unknown>;
        for (const [column, value] of equals) if (record[column] !== value) return false;
        for (const [column, values] of inValues) if (!values.includes(record[column])) return false;
        return true;
      });
      return Promise.resolve({ data: rows as unknown[], error: null }).then(onFulfilled);
    },
  };
  return node;
}

const client = {
  auth: { getUser: vi.fn(async () => ({ data: { user: { id: state.currentUserId } }, error: null })) },
  from: vi.fn((table: string) => query(table)),
  rpc: vi.fn(),
};

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => client,
  resetCommercialClient: vi.fn(),
}));

vi.mock('../src/main/workspace/config.js', () => ({
  ensureDeviceId: () => 'stable-device-id',
  readConfig: () => ({}),
  updateConfig: () => ({}),
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() }),
}));

vi.mock('../src/main/ws/index.js', () => ({ getAllGatewayClients: () => new Map() }));

const activeLicense: LicenseRow = {
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
};

/** 替身 `/v1/usage`：只回答 held 那三个字段（其余字段本通道不消费）。 */
function usageResponse(body: unknown, init?: { status?: number }) {
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  state.currentUserId = 'user-current';
  state.memberships = [
    { user_id: 'user-current', org_id: 'org-own', role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
  ];
  state.activeLicenses = [activeLicense];
  vi.stubGlobal('fetch', fetchMock);
  const { setActiveRelayKey } = await import('../src/main/commercial/relay-key.js');
  setActiveRelayKey(null);
});

afterEach(async () => {
  const { setActiveRelayKey } = await import('../src/main/commercial/relay-key.js');
  setActiveRelayKey(null);
  vi.unstubAllGlobals();
});

async function readStatus() {
  const { readLicenseStatus } = await import('../src/main/commercial/license.js');
  return readLicenseStatus();
}

async function withRelayKey<T>(work: () => Promise<T>): Promise<T> {
  const { setActiveRelayKey } = await import('../src/main/commercial/relay-key.js');
  setActiveRelayKey('rly_test_key');
  try {
    return await work();
  } finally {
    setActiveRelayKey(null);
  }
}

describe('在途预占（held）从 relay 透传到 LicenseStatus（BUG-082 续）', () => {
  it('后端报了确定值 ⇒ 原样带出 tokenHeldMicros / heldComplete=true', async () => {
    fetchMock.mockResolvedValue(usageResponse({ heldMicros: 50_000_000, availableMicros: 4_825_000_000, heldComplete: true }));
    const result = await withRelayKey(readStatus);

    expect(result.ok).toBe(true);
    expect(result.result?.tokenHeldMicros).toBe(50_000_000);
    expect(result.result?.heldComplete).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url.endsWith('/v1/usage')).toBe(true);
    expect(init.headers.authorization).toBe('Bearer rly_test_key');
  });

  it('后端说"口径不可判定" ⇒ heldComplete=false 原样带出，绝不本地折成 0', async () => {
    fetchMock.mockResolvedValue(usageResponse({ heldMicros: 0, availableMicros: 0, heldComplete: false }));
    const result = await withRelayKey(readStatus);

    expect(result.ok).toBe(true);
    expect(result.result?.heldComplete).toBe(false);
    // ⚠️ heldMicros 是后端报的 0，但 heldComplete=false 让 UI 知道"这个 0 不可信"。
    expect(result.result?.tokenHeldMicros).toBe(0);
  });

  it('没有活体 relay key ⇒ 一个请求都不打，读数不可判定（heldComplete: false）', async () => {
    fetchMock.mockResolvedValue(usageResponse({ heldMicros: 1, heldComplete: true }));
    const result = await readStatus();

    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.result && 'tokenHeldMicros' in result.result).toBe(false);
    // ⚠️ r14 返工：**读不到** ≠ **没有预占**。旧版在这里写"两个字段都不写"，下游于是
    //    沿用 `quota − used` 显示一个确定的余额（relay 返 503 时实测显示 1,000.40）。
    //    现在读不到一律落成 `heldComplete: false`（不可判定），由 UI 显示"暂不可用"。
    expect(result.result?.heldComplete).toBe(false);
  });

  it('relay 回非 2xx / 坏形状 / 抛异常 ⇒ 读数不可判定（heldComplete: false），授权结果照常成功', async () => {
    for (const bad of [
      usageResponse({}, { status: 503 }),
      usageResponse({ heldMicros: 'lots', heldComplete: 'yes' }),
      usageResponse({ heldMicros: -1, heldComplete: true }),
      usageResponse({ heldMicros: 5, heldComplete: undefined }),
    ]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(bad);
      const result = await withRelayKey(readStatus);
      expect(result.ok).toBe(true);
      expect(result.result?.activated).toBe(true);
      // 没有可信读数 ⇒ 不写 tokenHeldMicros，且口径不可判定。
      expect(result.result && 'tokenHeldMicros' in result.result).toBe(false);
      expect(result.result?.heldComplete).toBe(false);
    }

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('network down'));
    const failed = await withRelayKey(readStatus);
    expect(failed.ok).toBe(true);
    expect(failed.result && 'tokenHeldMicros' in failed.result).toBe(false);
    expect(failed.result?.heldComplete).toBe(false);
  });

  it('轻量额度快照与全量概览都把 held 带到底（不各读各的）', async () => {
    fetchMock.mockResolvedValue(usageResponse({ heldMicros: 7_000_000, availableMicros: 1, heldComplete: true }));
    const { readQuotaSnapshot, readAccountOverview } = await import('../src/main/commercial/auth.js');

    const snapshot = await withRelayKey(() => readQuotaSnapshot());
    const overview = await withRelayKey(() => readAccountOverview());

    expect(snapshot.result?.license?.tokenHeldMicros).toBe(7_000_000);
    expect(snapshot.result?.license?.heldComplete).toBe(true);
    expect(overview.result?.license?.tokenHeldMicros).toBe(7_000_000);
    expect(overview.result?.license?.heldComplete).toBe(true);
  });

  it('relay 说不可判定时，摘要也必须带出 false（不许在投影里丢掉）', async () => {
    fetchMock.mockResolvedValue(usageResponse({ heldMicros: 0, availableMicros: 0, heldComplete: false }));
    const { readQuotaSnapshot } = await import('../src/main/commercial/auth.js');
    const result = await withRelayKey(() => readQuotaSnapshot());

    expect(result.result?.license?.heldComplete).toBe(false);
  });

  it('换了展示的卡之后，同一把 relay key 的读数不许并到新卡上（r14 返工：held 绑定卡身份）', async () => {
    const { setActiveRelayKey } = await import('../src/main/commercial/relay-key.js');
    setActiveRelayKey('rly_binding_card_A');
    try {
      fetchMock.mockResolvedValue(usageResponse({ heldMicros: 50_000_000, heldComplete: true }));
      const first = await readStatus();
      expect(first.result?.licenseId).toBe('license-own');
      expect(first.result?.tokenHeldMicros).toBe(50_000_000);

      // 展示的卡换成另一张，而活体 relay key 还是上一张卡那把（切卡的窗口期）。
      state.activeLicenses = [{ ...activeLicense, id: 'license-new', license_key: 'RY-NEW-0001' }];
      const second = await readStatus();

      expect(second.result?.licenseId).toBe('license-new');
      // ⚠️ `/v1/usage` 的回答只属于那把 key 的卡 ⇒ 不许并到新卡上，如实报"不可判定"。
      expect(second.result && 'tokenHeldMicros' in second.result).toBe(false);
      expect(second.result?.heldComplete).toBe(false);
    } finally {
      setActiveRelayKey(null);
    }
  });

  it('读 held 期间授权代次变了 ⇒ 整条授权结论作废（r14 返工：await 后复核 generation）', async () => {
    const { setActiveRelayKey } = await import('../src/main/commercial/relay-key.js');
    const { advanceLicenseGeneration } = await import('../src/main/commercial/license-generation.js');
    setActiveRelayKey('rly_late_generation');
    let release!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    try {
      const pending = readStatus();
      // 等 held 读取真的发出去（否则可能还没走到 await 就先推进了代次）。
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      // 在途期间切卡 / 登出 ⇒ 代次 +1。
      advanceLicenseGeneration();
      release(usageResponse({ heldMicros: 50_000_000, heldComplete: true }));

      const result = await pending;
      // 旧卡的在途冻结不许落进新身份的界面。
      expect(result.result?.activated).not.toBe(true);
    } finally {
      setActiveRelayKey(null);
    }
  });
});
