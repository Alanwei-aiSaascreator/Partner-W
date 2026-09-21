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
  /**
   * 上一次清理**为什么没成**。
   *
   * - 没有这个字段（`pending` 但无 errorCode）⇒ 网关还没连上，**等一等会好**；
   * - `rejected` / `verify-failed` ⇒ 确定性失败（补丁本身不合法 / 网关说写了却没生效），
   *   重试一万次也一样 —— 调用方**不该**继续轮询，那只会把网关打到限流。
   */
  errorCode?: 'transport' | 'rejected' | 'hash-conflict' | 'verify-failed';
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
        runConfigMutation: (work) =>
          picked.runConfigMutation((tx) =>
            work({
              getConfig: tx.getConfig,
              patchConfig: tx.patchConfig,
            }),
          ),
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

  const remove = (tx: Pick<RelayGatewayHandle, 'getConfig' | 'patchConfig'>) =>
    removeRelayConfig({
      getConfig: tx.getConfig,
      patchConfig: tx.patchConfig,
      log: (event, data) => deps.log?.(event, data),
    });
  const result = await gateway.runConfigMutation(remove);
  if (!result.cleaned) {
    deps.log?.('relay.cleanup-pending', { errorCode: result.errorCode, error: result.error });
    // 把失败原因**透给调用方**：它决定"要不要接着重试"，而这两类必须分开
    //（见 CommercialAccessCleanupResult.errorCode 的注释）。
    return { cleaned: false, pending: true, ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
  }

  const current = deps.readCommercialConfig() ?? { supabaseUrl: '', supabaseAnonKey: '' };
  deps.writeCommercialConfig({ ...current, relayCleanupPending: false });
  deps.log?.('relay.cleanup-complete');
  return { cleaned: true, pending: false };
}
