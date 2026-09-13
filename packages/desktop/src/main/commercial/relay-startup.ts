/**
 * `relay-bootstrap` 的**接线层** —— 把真实世界的 Supabase / 网关 / 日志接上去。
 *
 * 分层刻意如此：`relay-bootstrap.ts` 只认接口（可以裸跑单测），
 * 这里才 import electron 那一侧的东西。
 *
 * ⚠️ 本文件里出现的所有 key **都不许进日志**（relay key 是能花钱的凭证）。
 */

import { getCommercialClient } from './client.js';
import { probeAuth } from './auth.js';
import { deviceFingerprint, readLicenseStatus } from './license.js';
import { fetchFirstRelayModel } from './relay-config.js';
import { bootstrapRelayWithRetry } from './relay-bootstrap.js';
import type { RelayBootstrapDeps, RelayBootstrapResult, RelayGatewayHandle } from './relay-bootstrap.js';
import { getAllGatewayClients } from '../ws/index.js';
import { getDebugLogger } from '../debug/index.js';
import { LOCAL_GATEWAY_ID } from '../runtime/state-config.js';

/**
 * 找一个**连上的**网关。
 *
 * 优先本机的 `local-runtime`（阶段 1 起的那个），否则退回"任意一个连上的" ——
 * 与用量上报、以及激活时的 `configureRelay` 口径一致。
 */
export function findConnectedGateway(): RelayGatewayHandle | null {
  const clients = getAllGatewayClients();
  const preferred = clients.get(LOCAL_GATEWAY_ID);
  const picked = preferred?.isConnected ? preferred : Array.from(clients.values()).find((gw) => gw.isConnected);
  if (!picked) return null;
  return {
    getConfig: () => picked.getConfig(),
    patchConfig: (params) => picked.patchConfig(params),
  };
}

/**
 * 取这张卡的中转 key。
 *
 * ⚠️ 用的是 `activate_license` —— 它对**已知设备是幂等的**（迁移 20260912000011）：
 * 同一 device_fingerprint 再来一次只会刷新 `last_seen_at`，**不占激活名额**，
 * 而且「relay key 生成一次后固定不变」⇒ 拿到的永远是同一把。
 *
 * 这是**唯一**的取 key 途径：key 只在 RPC 返回里出现（设计上不落客户端磁盘）。
 */
export async function fetchRelayKeyForLicense(licenseKey: string): Promise<string | null> {
  const supabase = getCommercialClient();
  if (!supabase) return null;

  const { data, error } = await supabase.rpc('activate_license', {
    p_license_key: licenseKey,
    p_device_fingerprint: deviceFingerprint(),
  });
  if (error) {
    // 只记错误码与文案，**不记 key**
    log('relay.bootstrap.activate-rpc-failed', { code: error.code, message: error.message });
    return null;
  }
  return (data as { relayKey?: string | null } | null)?.relayKey ?? null;
}

function log(event: string, data: Record<string, unknown> = {}): void {
  const logger = getDebugLogger();
  if (event.endsWith('failed') || event.includes('no-')) logger.warn({ domain: 'commercial', event, data });
  else logger.info({ domain: 'commercial', event, data });
}

export function buildRelayBootstrapDeps(): RelayBootstrapDeps {
  return {
    hasCommercialClient: () => getCommercialClient() !== null,
    // 三态，不是布尔 —— 「没登录」和「暂时问不出来」必须分开（见 auth-classify.ts）。
    checkAuth: () => probeAuth(),
    readLicenseKey: async () => {
      const res = await readLicenseStatus();
      return res.ok && res.result?.licenseKey ? res.result.licenseKey : null;
    },
    fetchRelayKey: fetchRelayKeyForLicense,
    getGateway: findConnectedGateway,
    resolveDefaultModel: fetchFirstRelayModel,
    deviceFingerprint,
    log,
  };
}

/**
 * 启动时把商业配置落到网关上。**永不抛**。
 *
 * 重试策略在 `relay-bootstrap.ts` 的 `bootstrapRelayWithRetry` 里（那边没有 electron
 * 依赖，可以被单测钉死）；这里只负责**接线**与"启动路径绝不抛"。
 */
export async function bootstrapCommercialRelay(
  opts: { waitForGatewayMs?: number } = {},
): Promise<RelayBootstrapResult> {
  try {
    return await bootstrapRelayWithRetry(buildRelayBootstrapDeps(), opts);
  } catch (error) {
    // 这一层永不抛：启动路径上抛出去就是白屏。
    console.error('[commercial] relay bootstrap 失败（忽略，界面照常）:', error);
    return { status: 'failed', relayReady: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
