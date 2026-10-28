import {
  applyRelayConfig,
  fetchFirstRelayModel,
  fetchRelayCatalogModelEntries,
  fetchRelayMediaCapabilities,
  removeRelayConfig,
  setActiveRelayBaseUrl,
} from '../commercial/relay-config.js';
import type { RelayApiConfig } from '../workspace/config.js';

/**
 * 官方 API（relay 中继）的**用户手动配置**入口 —— 私有化 / 开源版。
 *
 * 商业版里 relay key 走「登录 → 激活 → `activate_license` RPC 下发」；开源版
 * 移除登录/激活后，改成用户直接填 relay key。其余链路（拉 catalog、写
 * `clawrouter` provider、媒体能力探针、移除清理）**原样复用** `applyRelayConfig`
 * / `removeRelayConfig`，计费鉴权能力不变（与官网同价、不盈利）。
 *
 * ⚠️ `key` 绝不进日志（日志会进排查记录、用户可能外发）。
 */

export interface RelayApiDeps {
  getConfig: () => Promise<unknown>;
  patchConfig: (params: { baseHash: string; raw: string; replacePaths?: string[] }) => Promise<unknown>;
  deviceFingerprint: string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** 写入官方 API 配置：设置中转基址后复用 `applyRelayConfig`。不抛异常。 */
export async function applyOfficialRelay(deps: RelayApiDeps, config: RelayApiConfig) {
  const key = config.key.trim();
  if (!key) {
    return { ok: false, configured: false, errorCode: 'no-key' as const, error: 'relay key required', warnings: [] };
  }

  // 用户填了地址就用用户的；否则回落到生产默认（`setActiveRelayBaseUrl(null)`）。
  const baseUrl = config.baseUrl?.trim();
  setActiveRelayBaseUrl(baseUrl || null);

  return applyRelayConfig(
    {
      getConfig: deps.getConfig,
      patchConfig: deps.patchConfig,
      resolveDefaultModel: fetchFirstRelayModel,
      resolveCatalogModels: fetchRelayCatalogModelEntries,
      resolveMediaCapabilities: fetchRelayMediaCapabilities,
      log: deps.log,
    },
    {
      relayKey: key,
      deviceFingerprint: deps.deviceFingerprint,
    },
  );
}

/** 移除官方 API 配置：复用 `removeRelayConfig`（清账 clawrouter + 搜索插件等痕迹）。 */
export async function removeOfficialRelay(deps: RelayApiDeps) {
  return removeRelayConfig({ getConfig: deps.getConfig, patchConfig: deps.patchConfig, log: deps.log });
}
