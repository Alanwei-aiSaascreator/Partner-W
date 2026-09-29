import { describe, expect, it, vi } from 'vitest';
import { RELAY_BASE_URL } from '../src/main/commercial/relay-config.js';
import {
  bootstrapRelayWithRetry,
  type GatewayAccessPrep,
  createRelayBootstrapScheduler,
  ensureRelayConfigured,
} from '../src/main/commercial/relay-bootstrap.js';
import type {
  AuthCheck,
  RelayBootstrapDeps,
  RelayBootstrapRunOptions,
  RelayBootstrapStatus,
  RelayGatewayHandle,
  RelayKeyFetchResult,
} from '../src/main/commercial/relay-bootstrap.js';
import { advancingClock } from './helpers/advancing-clock.js';

/**
 * 启动时的商业配置落地。
 *
 * 这一层修的是三个实测出来的洞：
 *   ① `applyRelayConfig` 原先**只在激活那一刻**被调用 —— 重启/换 profile 之后
 *      没有任何代码把中转配置写回网关 ⇒ `models.list` 空 ⇒ 界面只有 Default
 *   ② `configureRelay` 要求"此刻有网关连着"，首次启动时网关还没连上，
 *      它只记一条 warn 就返回，**没有重试**
 *   ③ 中转 key 没有第二个来源（只在 RPC 返回里出现过）
 *
 * ⚠️ 这里钉的两条语义最容易混：
 *   - `runtime ready`（网关活着）**不等于** `commercial ready`（模型可用）
 *   - 「没网关」是**可重试**的，**不能**当成「没激活」
 */

const RELAY_KEY = 'rly_test_key_should_never_be_logged';
const LICENSE = 'RY-TEST-0001';

/** 一个假网关：patch 之后回读能看见 provider（applyRelayConfig 要回读校验）。 */
function makeGateway(initial: unknown = { config: {} }): {
  gateway: RelayGatewayHandle;
  patchConfig: ReturnType<typeof vi.fn>;
  getConfig: ReturnType<typeof vi.fn>;
  runConfigMutationCall: ReturnType<typeof vi.fn>;
} {
  let snapshot = initial as { config?: Record<string, unknown>; hash?: string };
  const patchConfig = vi.fn(async ({ raw }: { baseHash: string; raw: string }) => {
    const patch = JSON.parse(raw) as { models?: { providers?: Record<string, unknown> } };
    const providers = patch.models?.providers ?? {};
    snapshot = {
      ...snapshot,
      hash: 'h2',
      config: {
        ...(snapshot.config ?? {}),
        models: { providers: { ...providers } },
        agents: patch && 'agents' in patch ? (patch as Record<string, unknown>).agents : undefined,
      },
    };
    return { ok: true };
  });
  const getConfig = vi.fn(async () => ({ ...snapshot, hash: snapshot.hash ?? 'h1' }));
  const runConfigMutationCall = vi.fn();
  const runConfigMutation: RelayGatewayHandle['runConfigMutation'] = async (work) => {
    runConfigMutationCall();
    return work({ getConfig, patchConfig });
  };
  return { gateway: { getConfig, patchConfig, runConfigMutation }, patchConfig, getConfig, runConfigMutationCall };
}

function makeDeps(over: Partial<RelayBootstrapDeps> = {}, initialSnapshot: unknown = { config: {} }) {
  const { gateway, patchConfig, getConfig, runConfigMutationCall } = makeGateway(initialSnapshot);
  const deps: RelayBootstrapDeps = {
    hasCommercialClient: () => true,
    checkAuth: async () => 'authenticated',
    readLicenseKey: async () => LICENSE,
    fetchRelayKey: vi.fn(async (): Promise<RelayKeyFetchResult> => ({ ok: true, relayKey: RELAY_KEY })),
    getGateway: () => gateway,
    deviceFingerprint: () => 'fp-1',
    ...over,
  };
  return { deps, gateway, patchConfig, getConfig, runConfigMutationCall };
}

/** 网关里已经有一份**指向中转**的 provider（幂等命中用）。 */
const alreadyRelay = {
  hash: 'h1',
  config: { models: { providers: { clawrouter: { baseUrl: RELAY_BASE_URL, apiKey: 'whatever' } } } },
};

describe('ensureRelayConfigured —— 纯净/未配置', () => {
  it('⭐ 没配商业层（无 Supabase）⇒ not-configured，且**不碰网关**', async () => {
    const { deps, patchConfig, getConfig } = makeDeps({ hasCommercialClient: () => false });
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('not-configured');
    expect(res.relayReady).toBe(false);
    expect(patchConfig).not.toHaveBeenCalled();
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('⭐ 没登录 ⇒ unauthenticated（不是 unlicensed —— 两者界面要说的话不同）', async () => {
    const { deps, patchConfig } = makeDeps({ checkAuth: async () => 'unauthenticated' });
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('unauthenticated');
    expect(res.relayReady).toBe(false);
    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('⭐ 登录了但名下没有卡 ⇒ unlicensed，**不写配置、不伪造模型**', async () => {
    const { deps, patchConfig } = makeDeps({ readLicenseKey: async () => null });
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('unlicensed');
    expect(res.relayReady).toBe(false);
    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('⭐⭐ 有卡但服务端**确定性**拒绝（没下发 key / 旧卡）⇒ entitlement-rejected，**不是**泛化的 unlicensed', async () => {
    // ⚠️ 这一条在 2026-09-21 改过：原先断言的是 `unlicensed` —— 那正是本轮修的塌缩。
    //    「名下没有卡」和「有卡但服务端拒绝给中转凭证」要用户做的事完全不同。
    const { deps, patchConfig } = makeDeps({
      fetchRelayKey: async (): Promise<RelayKeyFetchResult> => ({
        ok: false,
        errorCode: 'activation_failed',
        retryable: false,
      }),
    });
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('entitlement-rejected');
    expect(res.relayReady).toBe(false);
    expect(res.errorCode).toBe('activation_failed');
    expect(res.retryable).toBe(false);
    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('⭐⭐ P0001「卡已绑到别的组织」⇒ 安全码一路保留到结果，日志里也看得见', async () => {
    const log = vi.fn();
    const { deps, patchConfig } = makeDeps({
      fetchRelayKey: async (): Promise<RelayKeyFetchResult> => ({
        ok: false,
        errorCode: 'license_bound_elsewhere',
        retryable: false,
      }),
      log,
    });
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('entitlement-rejected');
    expect(res.errorCode, '压成 unlicensed 就把"卡绑在别的账号名下"这条信息丢了').toBe('license_bound_elsewhere');
    expect(res.retryable).toBe(false);
    expect(res.relayReady).toBe(false);
    expect(patchConfig).not.toHaveBeenCalled();

    const printed = JSON.stringify(log.mock.calls);
    expect(printed, '排查要知道是哪一个安全码').toContain('license_bound_elsewhere');
    expect(printed).not.toContain(LICENSE);
    expect(printed).not.toContain(RELAY_KEY);
  });
});

/**
 * ⭐⭐ 确定性拒绝 vs 暂时失败：**重试策略必须分得开**。
 *
 * 那个 4 分钟窗口是为「等一等真的会好」的一类准备的（网关没连上 / 会话暂时问不出来）。
 * 把确定性拒绝放进循环里的代价是具体的：每次都要再发一次 `activate_license`，
 * 而卡的归属**不是时间能改的** —— 纯打服务端，结论一个字节都不变。
 */
describe('bootstrapRelayWithRetry —— 确定性拒绝一次都不重试', () => {
  it('⭐⭐ 卡被判定绑在别的组织 ⇒ 4 分钟窗口里只问一次，一次 sleep 都没有', async () => {
    const fetchRelayKey = vi.fn(
      async (): Promise<RelayKeyFetchResult> => ({
        ok: false,
        errorCode: 'license_bound_elsewhere',
        retryable: false,
      }),
    );
    // ⚠️ 时钟**随 sleep 前进**（`test/helpers/advancing-clock.ts`）：冻结时钟 + 空 sleep
    //    会让 deadline 永远够不到 —— 那既是死循环的形状，也让"4 分钟窗口"根本没被跑到。
    const clock = advancingClock();
    const { deps } = makeDeps({ fetchRelayKey });

    const res = await bootstrapRelayWithRetry(deps, { ...clock, waitForGatewayMs: 240_000 });

    expect(res.status).toBe('entitlement-rejected');
    expect(res.errorCode).toBe('license_bound_elsewhere');
    expect(res.retryable).toBe(false);
    expect(fetchRelayKey, '确定性拒绝 ⇒ 整个重试窗口里只该问服务端一次').toHaveBeenCalledTimes(1);
    expect(clock.sleep, '既不该退避，也不该轮询').not.toHaveBeenCalled();
  });

  it('⭐⭐ 抛出的网络/超时 ⇒ transport **可重试**：走既有退避，第二次成功就 applied', async () => {
    let calls = 0;
    const fetchRelayKey = vi.fn(async (): Promise<RelayKeyFetchResult> => {
      calls += 1;
      return calls === 1 ? { ok: false, errorCode: 'transport', retryable: true } : { ok: true, relayKey: RELAY_KEY };
    });
    const clock = advancingClock();
    const { deps, patchConfig } = makeDeps({ fetchRelayKey });

    const res = await bootstrapRelayWithRetry(deps, { ...clock, waitForGatewayMs: 240_000 });

    expect(res.status).toBe('applied');
    expect(res.relayReady).toBe(true);
    expect(fetchRelayKey).toHaveBeenCalledTimes(2);
    expect(clock.sleep, '走的是**既有**的有界退避表（第一档 2s），不是新加一条重试路径').toHaveBeenCalledWith(2_000);
    expect(patchConfig).toHaveBeenCalledTimes(1);
  });
});

/**
 * ⭐⭐ I1：`retryable` 必须是**全量**且**可信任**的字段。
 *
 * 只在"被分类"的那两条分支上设置它，会留下两种坏形状：
 *   - `auth-transient` 有时带、有时不带（取决于哪条路进来的）；
 *   - `runtime-not-ready` 压根没有这个字段 —— 而它恰恰是**循环真的会重试**的那个。
 * 调用方拿到 `undefined` 就只能靠猜，而猜错的代价是"把确定性拒绝扔进 4 分钟循环"
 * （反过来就是"把可恢复的失败当成终局"）。
 *
 * 这张表逐状态对拍**三件事**：返回的 `status`、它的 `retryable`、以及循环**实际**
 * 有没有再试一次（`sleep` 被调用过 = 真的重试了）。
 *
 * ⚠️ 每一条用例都刻意做成**形状单一**（每次迭代结论相同）：混形状的场景（先传输失败
 *    再成功）里"重试过"与"最终可重试"本来就不该一致，那些由上面的循环用例覆盖。
 */
describe('retryable 是可信任的全量字段（逐状态对拍循环行为）', () => {
  const table: Array<{
    name: string;
    over?: Partial<RelayBootstrapDeps>;
    snapshot?: unknown;
    expected: RelayBootstrapStatus;
    expectedRetryable: boolean;
  }> = [
    {
      name: 'not-configured（本机没接商业层）',
      over: { hasCommercialClient: () => false },
      expected: 'not-configured',
      expectedRetryable: false,
    },
    {
      name: 'unauthenticated（明确没登录）',
      over: { checkAuth: async () => 'unauthenticated' },
      expected: 'unauthenticated',
      expectedRetryable: false,
    },
    {
      name: 'auth-transient（会话暂时问不出来）',
      over: { checkAuth: async () => 'transient' },
      expected: 'auth-transient',
      expectedRetryable: true,
    },
    {
      name: 'unlicensed（名下没有卡）',
      over: { readLicenseKey: async () => null },
      expected: 'unlicensed',
      expectedRetryable: false,
    },
    {
      name: 'entitlement-rejected（卡被服务端确定性拒绝）',
      over: {
        fetchRelayKey: async (): Promise<RelayKeyFetchResult> => ({
          ok: false,
          errorCode: 'license_bound_elsewhere',
          retryable: false,
        }),
      },
      expected: 'entitlement-rejected',
      expectedRetryable: false,
    },
    {
      name: 'auth-transient（取 key 传输失败）',
      over: {
        fetchRelayKey: async (): Promise<RelayKeyFetchResult> => ({
          ok: false,
          errorCode: 'transport',
          retryable: true,
        }),
      },
      expected: 'auth-transient',
      expectedRetryable: true,
    },
    {
      name: 'runtime-not-ready（网关还没连上）',
      over: { getGateway: () => null },
      expected: 'runtime-not-ready',
      expectedRetryable: true,
    },
    {
      name: 'failed（清理被网关拒 ⇒ 确定性）',
      over: { prepareGatewayAccess: async (): Promise<GatewayAccessPrep> => ({ ok: false, errorCode: 'rejected' }) },
      snapshot: alreadyRelay,
      expected: 'failed',
      expectedRetryable: false,
    },
    { name: 'applied（这次真的写进去了）', expected: 'applied', expectedRetryable: false },
    {
      name: 'already-applied（幂等命中）',
      snapshot: alreadyRelay,
      expected: 'already-applied',
      expectedRetryable: false,
    },
  ];

  for (const row of table) {
    it(`⭐ ${row.name} ⇒ retryable=${row.expectedRetryable}，且与循环是否重试一致`, async () => {
      const clock = advancingClock();
      const { deps } = makeDeps(row.over ?? {}, row.snapshot ?? { config: {} });

      const res = await bootstrapRelayWithRetry(deps, { ...clock, waitForGatewayMs: 240_000 });

      expect(res.status).toBe(row.expected);
      expect(res.retryable, 'retryable 必须**总是**被显式设置（undefined 不可接受）').toBe(row.expectedRetryable);
      const loopRetried = clock.sleep.mock.calls.length > 0;
      expect(
        loopRetried,
        `retryable=${row.expectedRetryable} 与循环的真实行为不一致（sleep 调了 ${clock.sleep.mock.calls.length} 次）`,
      ).toBe(row.expectedRetryable);
    });
  }
});

describe('ensureRelayConfigured —— runtime ready ≠ commercial ready', () => {
  it('⭐ 旧账号 relay 尚未清理时，不得把它当作当前账号已配置', async () => {
    const prepareGatewayAccess = vi.fn(async () => ({ ok: false }) as const);
    const { deps, patchConfig } = makeDeps({ prepareGatewayAccess }, alreadyRelay);

    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('runtime-not-ready');
    expect(res.relayReady).toBe(false);
    expect(prepareGatewayAccess).toHaveBeenCalledTimes(1);
    expect(patchConfig).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ 2026-09-17 实机：清理用的 `config.patch` 本身不合法（少报 `replacePaths`），
   *   网关**每次**都拒。而这一支被归进"runtime-not-ready"⇒ 每秒重试一次、
   *   每次两个网关 RPC，连跑 4 分钟（`DEFAULT_WAIT_MS`），把网关打到限流：
   *   `rate limit exceeded for config.patch; retry after 7s`。
   *
   * 拒绝是**确定性**的：配置不改，重试一万次还是拒。所以一次都不该重试。
   */
  it('⭐ 清理被网关拒绝 ⇒ 不再轮询（确定性失败，重试只会打爆网关）', async () => {
    const prepareGatewayAccess = vi.fn(async (): Promise<GatewayAccessPrep> => ({ ok: false, errorCode: 'rejected' }));
    const sleep = vi.fn(async () => {});
    const { deps, patchConfig } = makeDeps({ prepareGatewayAccess }, alreadyRelay);

    const res = await bootstrapRelayWithRetry(deps, { sleep, waitForGatewayMs: 240_000 });

    expect(res.status).toBe('failed');
    expect(res.relayReady).toBe(false);
    expect(prepareGatewayAccess).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('网关只是还没连上 ⇒ 仍然轮询（这一类等一等真的会好）', async () => {
    let calls = 0;
    const prepareGatewayAccess = vi.fn(async () => {
      calls += 1;
      return calls >= 3 ? { ok: true } : { ok: false };
    });
    const sleep = vi.fn(async () => {});
    const { deps } = makeDeps({ prepareGatewayAccess }, alreadyRelay);

    const res = await bootstrapRelayWithRetry(deps, { sleep, waitForGatewayMs: 240_000 });

    expect(prepareGatewayAccess).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(res.status).toBe('already-applied');
  });

  it('⭐ 网关还没连上 ⇒ runtime-not-ready（可重试），**不是** unlicensed', async () => {
    const { deps, patchConfig } = makeDeps({ getGateway: () => null });
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('runtime-not-ready');
    expect(res.relayReady).toBe(false);
    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('⭐ 读配置就抛（连不上）⇒ 也归 runtime-not-ready，别把网络问题说成没授权', async () => {
    const getConfig = async () => Promise.reject(new Error('not connected'));
    const patchConfig = async () => ({});
    const { deps } = makeDeps({
      getGateway: () => ({
        getConfig,
        patchConfig,
        runConfigMutation: (work) => work({ getConfig, patchConfig }),
      }),
    });
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('runtime-not-ready');
    expect(res.relayReady).toBe(false);
  });
});

describe('ensureRelayConfigured —— 应用配置', () => {
  it('⭐ 已登录 + 有卡 + 网关空 ⇒ 取 key 并写进网关（clawrouter → relay）', async () => {
    const { deps, patchConfig, runConfigMutationCall } = makeDeps();
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('applied');
    expect(res.relayReady).toBe(true);
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(runConfigMutationCall, 'relay 的 get→patch→verify 必须是一笔不可穿透的事务').toHaveBeenCalledOnce();

    const patch = JSON.parse(patchConfig.mock.calls[0][0].raw) as {
      models: { providers: Record<string, { baseUrl: string; apiKey: string }> };
    };
    expect(patch.models.providers.clawrouter.baseUrl).toBe(RELAY_BASE_URL);
    expect(patch.models.providers.clawrouter.apiKey).toBe(RELAY_KEY);
  });

  it('⭐ 取 key 用的是**账号里那张卡**的 key（幂等：同设备重复取返回同一把）', async () => {
    const fetchRelayKey = vi.fn(async (): Promise<RelayKeyFetchResult> => ({ ok: true, relayKey: RELAY_KEY }));
    const { deps } = makeDeps({ fetchRelayKey });
    await ensureRelayConfigured(deps);

    expect(fetchRelayKey).toHaveBeenCalledWith(LICENSE);
  });
});

describe('ensureRelayConfigured —— 幂等 & 配置变化', () => {
  it('⭐ 网关已经有指向中转的 provider ⇒ already-applied：**不调服务端、不写配置**', async () => {
    const fetchRelayKey = vi.fn(async (): Promise<RelayKeyFetchResult> => ({ ok: true, relayKey: RELAY_KEY }));
    const { deps, patchConfig } = makeDeps({ fetchRelayKey }, alreadyRelay);

    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('already-applied');
    expect(res.relayReady).toBe(true);
    expect(patchConfig).not.toHaveBeenCalled();
    // 关键：每次启动都打一次激活 RPC 是没必要的
    expect(fetchRelayKey).not.toHaveBeenCalled();
  });

  it('有媒体能力探针时，即使聊天 provider 已存在也重新取 key 并对齐媒体配置', async () => {
    const fetchRelayKey = vi.fn(async (): Promise<RelayKeyFetchResult> => ({ ok: true, relayKey: RELAY_KEY }));
    const resolveMediaCapabilities = vi.fn(async () => ({ image: false, video: true }));
    const { deps, patchConfig } = makeDeps({ fetchRelayKey, resolveMediaCapabilities }, alreadyRelay);

    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('applied');
    expect(fetchRelayKey).toHaveBeenCalledWith(LICENSE);
    expect(resolveMediaCapabilities).toHaveBeenCalledWith(RELAY_KEY);
    const raw = JSON.parse(patchConfig.mock.calls[0]?.[0].raw as string) as {
      models: { providers: Record<string, { baseUrl?: string }> };
      agents: { defaults: { mediaModels: { video: { primary: string } } } };
    };
    expect(raw.models.providers.xai?.baseUrl).toBe(`${RELAY_BASE_URL}/v1`);
    expect(raw.agents.defaults.mediaModels.video.primary).toBe('xai/grok-imagine-video');
  });

  it('⭐ 重复调用结果稳定（第二次幂等命中，不再写）', async () => {
    const { gateway, patchConfig, getConfig } = makeGateway();
    const deps = makeDeps({ getGateway: () => gateway });

    const first = await ensureRelayConfigured(deps.deps);
    const second = await ensureRelayConfigured(deps.deps);

    expect(first.status).toBe('applied');
    expect(second.status).toBe('already-applied');
    expect(patchConfig).toHaveBeenCalledTimes(1);
    void getConfig;
  });

  it('⭐ 网关里的 provider 指向**别处**（不是中转）⇒ 照样要应用，不能算已就绪', async () => {
    const other = {
      hash: 'h1',
      config: { models: { providers: { clawrouter: { baseUrl: 'https://example.com/v1', apiKey: 'x' } } } },
    };
    const { deps, patchConfig } = makeDeps({}, other);

    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('applied');
    expect(patchConfig).toHaveBeenCalledTimes(1);
  });

  it('⭐ 用户自己配的**别的** provider 不算命中（只看打到中转的那些）', async () => {
    const own = {
      hash: 'h1',
      config: { models: { providers: { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' } } } },
    };
    const { deps, patchConfig } = makeDeps({}, own);

    const res = await ensureRelayConfigured(deps);
    expect(res.status).toBe('applied');
    expect(patchConfig).toHaveBeenCalledTimes(1);
  });
});

describe('ensureRelayConfigured —— 写失败 & 韧性', () => {
  it('⭐ 网关拒绝写入 ⇒ failed（relayReady=false），**不抛**', async () => {
    const getConfig = async () => ({ hash: 'h1', config: {} });
    const patchConfig = async () => Promise.reject(new Error('schema rejected'));
    const gateway: RelayGatewayHandle = {
      getConfig,
      patchConfig,
      runConfigMutation: (work) => work({ getConfig, patchConfig }),
    };
    const { deps } = makeDeps({ getGateway: () => gateway });

    const res = await ensureRelayConfigured(deps);
    expect(res.status).toBe('failed');
    expect(res.relayReady).toBe(false);
    expect(res.detail).toContain('rejected');
  });

  it('⭐ 会话检查自己抛 ⇒ auth-transient（**不是**没登录），不让启动挂掉', async () => {
    // ⚠️ 这条断言在 2B 里**改过**：原先写的是 `unauthenticated` —— 那正是 bug 本身。
    //    「问不出来」和「服务端说你没登录」是两件事；前者必须可重试，否则一次网络
    //    抖动就把用户踢成未登录，且整个会话无法自愈。
    const { deps } = makeDeps({
      checkAuth: async () => {
        throw new Error('supabase down');
      },
    });
    const res = await ensureRelayConfigured(deps);
    expect(res.status).toBe('auth-transient');
    expect(res.relayReady).toBe(false);
  });

  it('⭐⭐ 取 key 自己抛（边界违约）⇒ 当成 transport + 可重试，**不是** unlicensed', async () => {
    // ⚠️ 这条在 2026-09-21 改过：边界函数（`fetchRelayKeyForLicense`）现在**不抛** ——
    //    网络/超时都被它收成 `transport` 结果。真抛了说明注入了一个违约的实现，
    //    那时按"暂时问不出来"处理（等一等会好），而不是把一次异常说成"你没卡"。
    const { deps } = makeDeps({
      fetchRelayKey: async () => {
        throw new Error('rpc exploded');
      },
    });
    const res = await ensureRelayConfigured(deps);
    expect(res.status).toBe('auth-transient');
    expect(res.errorCode).toBe('transport');
    expect(res.retryable).toBe(true);
    expect(res.relayReady).toBe(false);
  });

  it('⭐⭐ ok:true 但 relayKey 是空串（边界违约）⇒ 确定性失败，**绝不** ready', async () => {
    // 没有 key 就是列不出模型。类型上 `ok:true` 必带非空 key，这一支只是兜底 ——
    // 但它兜的正是本轮要修的塌缩：**没有 key 绝不等于已就绪**。
    const { deps, patchConfig } = makeDeps({ fetchRelayKey: async () => ({ ok: true, relayKey: '' }) });
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('entitlement-rejected');
    expect(res.errorCode).toBe('activation_failed');
    expect(res.retryable).toBe(false);
    expect(res.relayReady).toBe(false);
    expect(patchConfig).not.toHaveBeenCalled();
  });
});

describe('日志卫生', () => {
  it('⭐ 任何分支都不把 relay key / license key 写进日志', async () => {
    const log = vi.fn();
    const { deps } = makeDeps({ log });

    await ensureRelayConfigured(deps);

    const printed = JSON.stringify(log.mock.calls);
    expect(printed).not.toContain(RELAY_KEY);
    expect(printed).not.toContain(LICENSE);
  });
});

/**
 * ⭐ 2B 回归：`auth-transient`（会话**暂时**问不出来）**绝不能**被固化成「未登录」。
 *
 * 实测过的真实事故：同一个有效会话，一次启动报 `unauthenticated`、下一次直接
 * `applied` —— 因为 `auth.getUser()` 有一次超了 8 秒，而那条路径**既不重试、
 * 也没有第二次机会**（启动只 bootstrap 一次）。用户表现为：模型列表空的，
 * 必须重启客户端。
 *
 * 这里用**注入的 sleep / now** 把时间钉死，所以断言的是真实的退避行为，不是"等一会儿"。
 */
describe('bootstrapRelayWithRetry —— 暂时问不出来 ≠ 没登录', () => {
  /** 按剧本依次返回 auth 结果；用完后一直返回最后一个。 */
  function makeRetryHarness(script: AuthCheck[]) {
    let i = 0;
    const sleeps: number[] = [];
    const clock = advancingClock();
    const made = makeDeps({
      checkAuth: async () => script[Math.min(i++, script.length - 1)] ?? 'authenticated',
    });
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      // ⚠️ 时间**真的往前走**：deadline 因此被真实评估（既不会真等 172 秒，也不会出现
      //    冻结时钟那种"永远够不到 deadline"的死循环形状 —— 见 helper 的注释）。
      await clock.sleep(ms);
    };
    return {
      ...made,
      sleeps,
      /** 断言"退避了几次/各多少"看 `sleeps`；超时预算由真实的 `now` 决定。 */
      run: (over: Partial<RelayBootstrapRunOptions> = {}) =>
        bootstrapRelayWithRetry(made.deps, { ...clock, sleep, ...over }),
    };
  }

  it('⭐ 登录有效 ⇒ 直接 applied，一次都不重试', async () => {
    const h = makeRetryHarness(['authenticated']);
    const res = await h.run();
    expect(res.status).toBe('applied');
    expect(res.relayReady).toBe(true);
    expect(h.sleeps).toEqual([]);
  });

  it('⭐⭐ 第一次超时、第二次成功 ⇒ 最终 applied（**不用重启客户端**）', async () => {
    const h = makeRetryHarness(['transient', 'authenticated']);
    const res = await h.run();
    expect(res.status).toBe('applied');
    expect(res.relayReady).toBe(true);
    // 恰好退避一次就该恢复 —— 不许把"先超时后成功"变成永久未登录
    expect(h.sleeps).toEqual([2_000]);
  });

  it('⭐⭐ 连续 transient ⇒ auth-transient（暂不可用），**不是** unauthenticated；且重试有界', async () => {
    const h = makeRetryHarness(['transient']);
    const res = await h.run();
    expect(res.status).toBe('auth-transient');
    expect(res.status, '一次网络问题就把用户说成"已退出登录"是本轮要修的 bug').not.toBe('unauthenticated');
    expect(res.relayReady).toBe(false);
    // ⚠️ 退避**必须越过 supabase-js 的刷新失败冷却期（60s）**，否则冷却期内
    //    每次重试都只拿到缓存的失败，等于没重试。合计 112s。
    expect(h.sleeps).toEqual([2_000, 5_000, 15_000, 30_000, 60_000, 60_000]);
    // 冷却期一过还得多给一次机会，别赌"恰好掐准边界"
    expect(h.sleeps.filter((ms) => ms >= 60_000).length, '至少两次机会越过冷却期').toBeGreaterThanOrEqual(2);
  });

  it('⭐⭐ 明确未登录（401/403）⇒ unauthenticated，且**一次都不重试**', async () => {
    const h = makeRetryHarness(['unauthenticated']);
    const res = await h.run();
    expect(res.status).toBe('unauthenticated');
    expect(res.relayReady).toBe(false);
    // 对**真正无效**的凭证不该反复打服务端
    expect(h.sleeps).toEqual([]);
  });

  it('⭐ 重试后成功走的是正常幂等路径，不重复写配置', async () => {
    const h = makeRetryHarness(['transient', 'authenticated']);
    expect((await h.run()).status).toBe('applied');
    expect(h.patchConfig).toHaveBeenCalledTimes(1);
    // 第二次：网关里已经有指向中转的 provider ⇒ 幂等命中，一个字节都不再写
    expect((await h.run()).status).toBe('already-applied');
    expect(h.patchConfig).toHaveBeenCalledTimes(1);
  });

  it('⭐ 退避再久也不会越过总 deadline（否则等于无限重试）', async () => {
    let t = 0;
    const h = makeRetryHarness(['transient']);
    const res = await bootstrapRelayWithRetry(h.deps, {
      sleep: async (ms) => {
        h.sleeps.push(ms);
        t += ms;
      },
      now: () => t,
      waitForGatewayMs: 10_000,
    });
    expect(res.status).toBe('auth-transient');
    expect(t, '总等待时间超过了 deadline').toBeLessThanOrEqual(10_000);
  });

  it('⭐ runtime-not-ready 仍然照旧轮询（别把既有行为弄丢）', async () => {
    let calls = 0;
    const clock = advancingClock();
    const { gateway, patchConfig } = makeGateway();
    const made = makeDeps({ getGateway: () => (calls++ < 2 ? null : gateway) });
    // ⚠️ 别写 `now: () => 0` + 空 sleep：那样循环**只能**靠桩里的 `calls++ < 2` 终止，
    //    桩一改就是死循环（这正是把 worker 跑到 OOM 的形状）。
    const res = await bootstrapRelayWithRetry(made.deps, { ...clock, waitForGatewayMs: 240_000 });
    expect(res.status).toBe('applied');
    expect(clock.sleep, '轮了两次才等到网关（不是靠 deadline 兜底的）').toHaveBeenCalledTimes(2);
    expect(patchConfig).toHaveBeenCalledTimes(1);
  });
});

/**
 * ⭐ 2C：**登录发生在启动之后**时，自动重新触发一次 bootstrap。
 *
 * ## 要补的洞
 *
 * 启动路径只在 `app.whenReady()` 里 `bootstrapCommercialRelay()` **一次**
 * （`main/index.ts:300`，全仓唯一调用点）。启动时没登录 ⇒ 结论是 `unauthenticated`
 * ⇒ `bootstrapRelayWithRetry` **刻意不重试**（明确没登录等多久都一样）。
 * 而用户接下来在登录页完成 OTP 时，主进程侧只有 `verifyLoginOtp()` 返回 `{ok:true}`，
 * **没有任何东西再去调度一次 bootstrap** ⇒ 界面模型列表一直是空的，
 * 用户必须重启客户端才看得到模型。
 *
 * ## 这一层的语义边界（刻意划死）
 *
 * 触发条件是**「用户刚刚完成一次交互式登录」**这个**转变**，不是"收到某个 auth 事件"：
 *
 *   - **收 `SIGNED_IN` 事件是不够的**：auth-js 在 `_recoverAndRefresh`（`:4150/:4165`）、
 *     `setSession`（`:3069`）等一堆地方都会发 `SIGNED_IN`，启动恢复会话时也会发。
 *   - **收 `TOKEN_REFRESHED` 是错的**：auto-refresh 每 ~30s 就可能刷一次
 *     （`GoTrueClient.js:4282`），拿它当触发条件会变成"每半分钟重写一次网关配置"。
 *   ⇒ 直接挂在**两个登录入口的成功返回**上，`TOKEN_REFRESHED` 连门都进不来。
 *
 * ## 必须不并发
 *
 * OTP 成功的那一刻，可能同时存在：正在跑的 2B 退避重试（`auth-transient`，
 * 最长 172s）、`runtime-not-ready` 轮询……如果这里再起一条独立的 bootstrap，
 * 就会有两条链同时 `patchConfig`（`applyRelayConfig` 的 baseHash 回读校验会打架）。
 * ⇒ 调度器是**单飞**的：跑着的时候再触发只记一个"待补跑"，绝不开第二条。
 */
describe('createRelayBootstrapScheduler —— 2C：登录后自动补跑', () => {
  /**
   * 每个用例一份**随 sleep 前进**的时钟（工厂：共享一份会让时间在用例之间累积）。
   * ⚠️ 别回到固定时钟 + 空 sleep —— 那是「永远够不到 deadline」的死循环形状。
   */
  const fast = () => advancingClock();

  it('⭐⭐ 启动时没登录 ⇒ unauthenticated 且不写配置；用户登录后**同一个调度器再跑一次** ⇒ applied', async () => {
    let authed = false;
    const made = makeDeps({ checkAuth: async () => (authed ? 'authenticated' : 'unauthenticated') });
    const sched = createRelayBootstrapScheduler(made.deps, fast());

    const first = await sched.trigger('startup');
    expect(first.status, '启动时没登录就该如实报没登录').toBe('unauthenticated');
    expect(made.patchConfig, '没登录时不该碰网关').not.toHaveBeenCalled();

    // ---- 用户完成 OTP（主进程侧就是 verifyLoginOtp 返回 ok）
    authed = true;
    const second = await sched.trigger('signed-in');

    expect(second.status, '登录之后**不重启客户端**也该把中转配置落下去').toBe('applied');
    expect(second.relayReady).toBe(true);
    expect(made.patchConfig).toHaveBeenCalledTimes(1);
  });

  it('⭐⭐ 正在跑的时候登录 ⇒ **不并发**；但这次登录不许被丢掉（跑完补一次）', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let live = 0;
    let maxLive = 0;
    const made = makeDeps({
      checkAuth: async () => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        await gate;
        live -= 1;
        return 'authenticated';
      },
    });
    const sched = createRelayBootstrapScheduler(made.deps, fast());

    const first = sched.trigger('startup');
    await Promise.resolve(); // 让它真的进到 checkAuth 里挂住
    const second = sched.trigger('signed-in');
    release();

    const [r1, r2] = await Promise.all([first, second]);
    expect(maxLive, '同时跑了**两条** bootstrap ⇒ 会两条链抢着 patchConfig').toBe(1);
    // 登录这一下不能被吞掉：补跑的那次会走幂等快路径
    expect(r2.status).toBe('already-applied');
    expect(r1.relayReady).toBe(true);
    expect(made.patchConfig, '补跑不该重复写配置').toHaveBeenCalledTimes(1);
  });

  it('⭐ 负对照：启动时**明确**未登录 ⇒ 只问一次，不会在后台反复 bootstrap', async () => {
    const checkAuth = vi.fn(async () => 'unauthenticated' as AuthCheck);
    const made = makeDeps({ checkAuth });
    const sched = createRelayBootstrapScheduler(made.deps, fast());

    const res = await sched.trigger('startup');
    expect(res.status).toBe('unauthenticated');
    // 「明确没登录」等多久都一样 ⇒ 既不该重试，也不该留着后台循环
    expect(checkAuth).toHaveBeenCalledTimes(1);
    expect(sched.inFlight()).toBe(false);
  });

  it('⭐ 负对照：已经 applied 之后再触发（等价于普通 TOKEN_REFRESHED 场景）⇒ 幂等命中，**不重写配置**', async () => {
    const made = makeDeps();
    const sched = createRelayBootstrapScheduler(made.deps, fast());

    expect((await sched.trigger('startup')).status).toBe('applied');
    expect(made.patchConfig).toHaveBeenCalledTimes(1);

    expect((await sched.trigger('signed-in')).status).toBe('already-applied');
    expect(made.patchConfig, '刷新一次 token 就重写一次网关配置，是不可接受的回归').toHaveBeenCalledTimes(1);
  });
});
