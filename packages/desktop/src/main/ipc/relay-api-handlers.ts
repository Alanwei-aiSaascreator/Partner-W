import { ipcMain } from 'electron';
import { readConfig, updateConfig } from '../workspace/config.js';
import { applyOfficialRelay, removeOfficialRelay } from '../models/relay-api.js';
import { getGatewayClient } from '../ws/index.js';
import { LOCAL_GATEWAY_ID } from '../runtime/state-config.js';
import { deviceFingerprint } from '../commercial/license.js';

/**
 * 官方 API（relay 中继）配置的 IPC 面（私有化 / 开源版）。
 *
 * - `relay-api:get`   只读脱敏：不回传明文 key，只给 `hasKey`。
 * - `relay-api:apply` 写配置（key 走 safeStorage 加密）+ 应用到网关。
 * - `relay-api:remove` 清配置 + 从网关移除 relay 痕迹。
 */
export function registerRelayApiHandlers(): void {
  ipcMain.handle('relay-api:get', () => {
    const config = readConfig()?.relayApi;
    if (!config) return { ok: true, result: null };
    return {
      ok: true,
      result: {
        baseUrl: config.baseUrl ?? '',
        hasKey: Boolean(config.key),
      },
    };
  });

  ipcMain.handle('relay-api:apply', async (_event, payload: { baseUrl?: unknown; key?: unknown }) => {
    const current = readConfig()?.relayApi;
    const baseUrl = String(payload?.baseUrl ?? '').trim();
    // 空 key = 保留已存的那把（渲染层不回显明文，用户不重填就不换）。
    const incomingKey = String(payload?.key ?? '').trim();
    const key = incomingKey || current?.key || '';

    if (!key) {
      return { ok: false, configured: false, errorCode: 'no-key', error: 'relay key required', warnings: [] };
    }

    updateConfig({ relayApi: { baseUrl: baseUrl || undefined, key } });

    const gateway = getGatewayClient(LOCAL_GATEWAY_ID);
    if (!gateway?.isConnected) {
      return { ok: false, configured: false, errorCode: 'transport', error: 'gateway not connected', warnings: [] };
    }
    return gateway.runConfigMutation((tx) =>
      applyOfficialRelay(
        { getConfig: tx.getConfig, patchConfig: tx.patchConfig, deviceFingerprint: deviceFingerprint() },
        { baseUrl: baseUrl || undefined, key },
      ),
    );
  });

  ipcMain.handle('relay-api:remove', async () => {
    const current = readConfig();
    if (current?.relayApi) {
      updateConfig({ relayApi: undefined });
    }

    const gateway = getGatewayClient(LOCAL_GATEWAY_ID);
    if (!gateway?.isConnected) {
      return { ok: false, errorCode: 'transport', error: 'gateway not connected' };
    }
    return gateway.runConfigMutation((tx) =>
      removeOfficialRelay({
        getConfig: tx.getConfig,
        patchConfig: tx.patchConfig,
        deviceFingerprint: deviceFingerprint(),
      }),
    );
  });
}
