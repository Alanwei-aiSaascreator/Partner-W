import { describe, expect, it, vi } from 'vitest';
import type { CommercialConfig } from '../src/main/workspace/config.js';
import {
  drainPendingCommercialAccessCleanup,
  requestCommercialAccessCleanup,
  type CommercialAccessCleanupDeps,
} from '../src/main/commercial/relay-cleanup.js';
import { RELAY_BASE_URL } from '../src/main/commercial/relay-config.js';

function fixture(connected: boolean) {
  let commercial: CommercialConfig = {
    supabaseUrl: 'https://commercial.test',
    supabaseAnonKey: 'anon',
    licenseKey: 'RY-OLD',
  };
  let gatewayConfig: Record<string, unknown> = {
    models: {
      providers: {
        clawrouter: { baseUrl: RELAY_BASE_URL, apiKey: '__OPENCLAW_REDACTED__' },
      },
    },
  };
  const patchConfig = vi.fn(async (params: { raw: string }) => {
    const patch = JSON.parse(params.raw) as { models?: { providers?: Record<string, unknown> } };
    if (patch.models?.providers?.clawrouter === null) {
      gatewayConfig = { models: { providers: {} } };
    }
    return { ok: true };
  });
  const gateway = {
    getConfig: vi.fn(async () => ({ hash: 'h1', config: gatewayConfig })),
    patchConfig,
  };
  const deps: CommercialAccessCleanupDeps = {
    readCommercialConfig: () => commercial,
    writeCommercialConfig: (next) => {
      commercial = next;
    },
    getGateway: () => (connected ? gateway : null),
  };
  return { deps, gateway, read: () => commercial };
}

/**
 * 按**真网关的规则**校验破坏性数组补丁（`dist/patch-replace-paths-*.mjs` 的
 * `collectBaseArrayPaths`）：把某个对象整个置 null 时，该子树下**每一个数组路径**
 * 都必须出现在 `replacePaths` 里，否则整条 patch 被拒。
 *
 * 2026-09-17 实机正是栽在这条上：真实的 clawrouter provider 带一个 `models` 数组，
 * 客户端没报备 ⇒ 补丁**永远**被拒 ⇒ 清理永远 pending ⇒ 每秒重试一次，
 * 连网关自己的限流都触发了（`rate limit exceeded for config.patch`）。
 * 原来的假网关不校验这个，所以测试一直是绿的。
 */
function collectArrayPaths(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return [path];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectArrayPaths(child, path ? `${path}.${key}` : key),
  );
}

function fixtureWithRealisticGateway(rejectEverything = false) {
  let commercial: CommercialConfig = {
    supabaseUrl: 'https://commercial.test',
    supabaseAnonKey: 'anon',
    licenseKey: 'RY-OLD',
  };
  const gatewayConfig: Record<string, unknown> = {
    models: {
      providers: {
        clawrouter: {
          baseUrl: RELAY_BASE_URL,
          apiKey: '__OPENCLAW_REDACTED__',
          models: [{ id: 'deepseek-v4-flash' }, { id: 'qwen3.5-27b' }],
        },
      },
    },
  };
  const patchConfig = vi.fn(async (params: { raw: string; replacePaths?: string[] }) => {
    if (rejectEverything) {
      throw new Error('config.patch would remove entries from array path(s): models.providers.clawrouter.models');
    }
    const patch = JSON.parse(params.raw) as { models?: { providers?: Record<string, unknown> } };
    const declared = new Set(params.replacePaths ?? []);
    const providers = (gatewayConfig.models as { providers: Record<string, unknown> }).providers;
    for (const [id, value] of Object.entries(patch.models?.providers ?? {})) {
      if (value !== null) continue;
      const required = collectArrayPaths(providers[id], `models.providers.${id}`);
      const missing = required.filter((path) => !declared.has(path));
      if (missing.length > 0) {
        throw new Error(`config.patch would remove entries from array path(s): ${missing.join(', ')}`);
      }
      delete providers[id];
    }
    return { ok: true };
  });
  const gateway = {
    getConfig: vi.fn(async () => ({ hash: 'h1', config: gatewayConfig })),
    patchConfig,
  };
  const deps: CommercialAccessCleanupDeps = {
    readCommercialConfig: () => commercial,
    writeCommercialConfig: (next) => {
      commercial = next;
    },
    getGateway: () => gateway,
  };
  return { deps, gateway, patchConfig, read: () => commercial };
}

describe('commercial relay cleanup coordinator', () => {
  it('⭐ 清掉一个带 models 数组的真实 provider（少报数组路径就会被网关拒）', async () => {
    const f = fixtureWithRealisticGateway();

    const result = await requestCommercialAccessCleanup(f.deps);

    expect(result).toEqual({ cleaned: true, pending: false });
    expect(f.read().relayCleanupPending).toBe(false);
    expect(f.patchConfig).toHaveBeenCalledWith(
      expect.objectContaining({ replacePaths: ['models.providers.clawrouter.models'] }),
    );
  });

  it('⭐ 被网关拒绝时把原因透出来（调用方据此决定**不再**轮询）', async () => {
    const f = fixtureWithRealisticGateway(true);

    const result = await requestCommercialAccessCleanup(f.deps);

    expect(result).toEqual({ cleaned: false, pending: true, errorCode: 'rejected' });
    expect(f.read().relayCleanupPending).toBe(true);
  });

  it('clears the local licence immediately and records pending cleanup without a gateway', async () => {
    const f = fixture(false);

    const result = await requestCommercialAccessCleanup(f.deps);

    expect(result).toEqual({ cleaned: false, pending: true });
    expect(f.read().licenseKey).toBeUndefined();
    expect(f.read().relayCleanupPending).toBe(true);
  });

  it('removes the relay and clears the pending marker when a gateway is connected', async () => {
    const f = fixture(true);

    const result = await requestCommercialAccessCleanup(f.deps);

    expect(result).toEqual({ cleaned: true, pending: false });
    expect(f.read().licenseKey).toBeUndefined();
    expect(f.read().relayCleanupPending).toBe(false);
    expect(f.gateway.patchConfig).toHaveBeenCalledTimes(1);
  });

  it('drains a persisted pending cleanup before account bootstrap', async () => {
    const f = fixture(true);
    f.deps.writeCommercialConfig({ ...f.read(), licenseKey: undefined, relayCleanupPending: true });

    const result = await drainPendingCommercialAccessCleanup(f.deps);

    expect(result).toEqual({ cleaned: true, pending: false });
    expect(f.read().relayCleanupPending).toBe(false);
  });

  it('is a no-op when no cleanup is pending', async () => {
    const f = fixture(true);

    expect(await drainPendingCommercialAccessCleanup(f.deps)).toEqual({ cleaned: false, pending: false });
    expect(f.gateway.patchConfig).not.toHaveBeenCalled();
  });
});
