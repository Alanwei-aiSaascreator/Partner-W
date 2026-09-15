import type { CommercialConfig } from '../workspace/config.js';
import type { RelayGatewayHandle } from './relay-bootstrap.js';
import { removeRelayConfig } from './relay-config.js';
import { readConfig, updateConfig } from '../workspace/config.js';
import { getAllGatewayClients } from '../ws/index.js';
import { LOCAL_GATEWAY_ID } from '../runtime/state-config.js';
import { getDebugLogger } from '../debug/index.js';

export interface CommercialAccessCleanupDeps {
  readCommercialConfig: () => CommercialConfig | undefined;
  writeCommercialConfig: (config: CommercialConfig) => void;
  getGateway: () => RelayGatewayHandle | null;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface CommercialAccessCleanupResult {
  cleaned: boolean;
  pending: boolean;
}

export function buildCommercialAccessCleanupDeps(): CommercialAccessCleanupDeps {
  return {
    readCommercialConfig: () => readConfig()?.commercial,
    writeCommercialConfig: (commercial) => {
      updateConfig({ commercial });
    },
    getGateway: () => {
      const clients = getAllGatewayClients();
      const preferred = clients.get(LOCAL_GATEWAY_ID);
      const picked = preferred?.isConnected ? preferred : Array.from(clients.values()).find((gw) => gw.isConnected);
      if (!picked) return null;
      return {
        getConfig: () => picked.getConfig(),
        patchConfig: (params) => picked.patchConfig(params),
      };
    },
    log: (event, data = {}) => getDebugLogger().info({ domain: 'commercial', event, data }),
  };
}

export async function requestCommercialAccessCleanup(
  deps: CommercialAccessCleanupDeps,
): Promise<CommercialAccessCleanupResult> {
  const current = deps.readCommercialConfig() ?? { supabaseUrl: '', supabaseAnonKey: '' };
  deps.writeCommercialConfig({ ...current, licenseKey: undefined, relayCleanupPending: true });
  return performPendingCleanup(deps);
}

export async function drainPendingCommercialAccessCleanup(
  deps: CommercialAccessCleanupDeps,
): Promise<CommercialAccessCleanupResult> {
  if (!deps.readCommercialConfig()?.relayCleanupPending) return { cleaned: false, pending: false };
  return performPendingCleanup(deps);
}

async function performPendingCleanup(deps: CommercialAccessCleanupDeps): Promise<CommercialAccessCleanupResult> {
  const gateway = deps.getGateway();
  if (!gateway) return { cleaned: false, pending: true };

  const result = await removeRelayConfig({
    getConfig: gateway.getConfig,
    patchConfig: gateway.patchConfig,
    log: (event, data) => deps.log?.(event, data),
  });
  if (!result.cleaned) {
    deps.log?.('relay.cleanup-pending', { errorCode: result.errorCode, error: result.error });
    return { cleaned: false, pending: true };
  }

  const current = deps.readCommercialConfig() ?? { supabaseUrl: '', supabaseAnonKey: '' };
  deps.writeCommercialConfig({ ...current, relayCleanupPending: false });
  deps.log?.('relay.cleanup-complete');
  return { cleaned: true, pending: false };
}
