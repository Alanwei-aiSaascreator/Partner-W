import { describe, expect, it, vi } from 'vitest';
import { RELAY_BASE_URL } from '../src/main/commercial/relay-config.js';
import { ensureRelayConfigured } from '../src/main/commercial/relay-bootstrap.js';
import type { RelayBootstrapDeps, RelayGatewayHandle } from '../src/main/commercial/relay-bootstrap.js';

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
  return { gateway: { getConfig, patchConfig }, patchConfig, getConfig };
}

function makeDeps(over: Partial<RelayBootstrapDeps> = {}, initialSnapshot: unknown = { config: {} }) {
  const { gateway, patchConfig, getConfig } = makeGateway(initialSnapshot);
  const deps: RelayBootstrapDeps = {
    hasCommercialClient: () => true,
    isSignedIn: async () => true,
    readLicenseKey: async () => LICENSE,
    fetchRelayKey: vi.fn(async () => RELAY_KEY),
    getGateway: () => gateway,
    deviceFingerprint: () => 'fp-1',
    ...over,
  };
  return { deps, gateway, patchConfig, getConfig };
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
    const { deps, patchConfig } = makeDeps({ isSignedIn: async () => false });
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

  it('⭐ 有卡但服务端没下发中转 key（旧卡）⇒ **不算就绪**', async () => {
    const { deps, patchConfig } = makeDeps({ fetchRelayKey: async () => null });
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('unlicensed');
    expect(res.relayReady).toBe(false);
    expect(patchConfig).not.toHaveBeenCalled();
  });
});

describe('ensureRelayConfigured —— runtime ready ≠ commercial ready', () => {
  it('⭐ 网关还没连上 ⇒ runtime-not-ready（可重试），**不是** unlicensed', async () => {
    const { deps, patchConfig } = makeDeps({ getGateway: () => null });
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('runtime-not-ready');
    expect(res.relayReady).toBe(false);
    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('⭐ 读配置就抛（连不上）⇒ 也归 runtime-not-ready，别把网络问题说成没授权', async () => {
    const { deps } = makeDeps({
      getGateway: () => ({
        getConfig: async () => Promise.reject(new Error('not connected')),
        patchConfig: async () => ({}),
      }),
    });
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('runtime-not-ready');
    expect(res.relayReady).toBe(false);
  });
});

describe('ensureRelayConfigured —— 应用配置', () => {
  it('⭐ 已登录 + 有卡 + 网关空 ⇒ 取 key 并写进网关（clawrouter → relay）', async () => {
    const { deps, patchConfig } = makeDeps();
    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('applied');
    expect(res.relayReady).toBe(true);
    expect(patchConfig).toHaveBeenCalledTimes(1);

    const patch = JSON.parse(patchConfig.mock.calls[0][0].raw) as {
      models: { providers: Record<string, { baseUrl: string; apiKey: string }> };
    };
    expect(patch.models.providers.clawrouter.baseUrl).toBe(RELAY_BASE_URL);
    expect(patch.models.providers.clawrouter.apiKey).toBe(RELAY_KEY);
  });

  it('⭐ 取 key 用的是**账号里那张卡**的 key（幂等：同设备重复取返回同一把）', async () => {
    const fetchRelayKey = vi.fn(async () => RELAY_KEY);
    const { deps } = makeDeps({ fetchRelayKey });
    await ensureRelayConfigured(deps);

    expect(fetchRelayKey).toHaveBeenCalledWith(LICENSE);
  });
});

describe('ensureRelayConfigured —— 幂等 & 配置变化', () => {
  it('⭐ 网关已经有指向中转的 provider ⇒ already-applied：**不调服务端、不写配置**', async () => {
    const fetchRelayKey = vi.fn(async () => RELAY_KEY);
    const { deps, patchConfig } = makeDeps({ fetchRelayKey }, alreadyRelay);

    const res = await ensureRelayConfigured(deps);

    expect(res.status).toBe('already-applied');
    expect(res.relayReady).toBe(true);
    expect(patchConfig).not.toHaveBeenCalled();
    // 关键：每次启动都打一次激活 RPC 是没必要的
    expect(fetchRelayKey).not.toHaveBeenCalled();
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
    const gateway: RelayGatewayHandle = {
      getConfig: async () => ({ hash: 'h1', config: {} }),
      patchConfig: async () => Promise.reject(new Error('schema rejected')),
    };
    const { deps } = makeDeps({ getGateway: () => gateway });

    const res = await ensureRelayConfigured(deps);
    expect(res.status).toBe('failed');
    expect(res.relayReady).toBe(false);
    expect(res.detail).toContain('rejected');
  });

  it('⭐ 会话检查自己抛 ⇒ 当成没登录，不让启动挂掉', async () => {
    const { deps } = makeDeps({
      isSignedIn: async () => {
        throw new Error('supabase down');
      },
    });
    const res = await ensureRelayConfigured(deps);
    expect(res.status).toBe('unauthenticated');
  });

  it('⭐ 取 key 自己抛 ⇒ 不当成已就绪', async () => {
    const { deps } = makeDeps({
      fetchRelayKey: async () => {
        throw new Error('rpc exploded');
      },
    });
    const res = await ensureRelayConfigured(deps);
    expect(res.status).toBe('unlicensed');
    expect(res.relayReady).toBe(false);
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
