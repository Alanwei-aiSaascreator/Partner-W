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

describe('commercial relay cleanup coordinator', () => {
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
