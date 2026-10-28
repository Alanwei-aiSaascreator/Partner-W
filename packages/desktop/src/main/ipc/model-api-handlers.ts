import { ipcMain } from 'electron';
import { readConfig, updateConfig, type ByokEndpointConfig } from '../workspace/config.js';
import { applyByokConfig, removeByokConfig, BYOK_REASONING_LEVELS, endpointProviderId } from '../models/byok.js';
import { getGatewayClient } from '../ws/index.js';
import { LOCAL_GATEWAY_ID } from '../runtime/state-config.js';

/**
 * BYOK 模型服务配置的 IPC 面（私有化 / 开源版）。
 *
 * 2026-10-28 升级为**多端点**：一个配置 = 一组端点，每个端点一个 provider。
 *
 * - `model-api:get`    只读脱敏：不回传明文 apiKey，每端点只给 `hasApiKey`。
 * - `model-api:apply`  写配置（apiKey 走 safeStorage 加密）+ 应用到网关。
 * - `model-api:list`   调端点 `GET /models`（OpenAI 兼容）拉可用模型 id 列表。
 * - `model-api:remove` 清配置 + 从网关移除所有 byok provider。
 */

/** OpenAI 兼容端点拉模型列表的超时（毫秒）。 */
const LIST_MODELS_TIMEOUT_MS = 10_000;

function normalizeBaseUrlForList(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** 端点脱敏只读态（renderer 侧不回传明文 key）。 */
function toPublicEndpoint(endpoint: ByokEndpointConfig) {
  return {
    id: endpoint.id,
    name: endpoint.name,
    baseUrl: endpoint.baseUrl,
    modelIds: endpoint.modelIds,
    modelLevels: endpoint.modelLevels ?? {},
    hasApiKey: Boolean(endpoint.apiKey),
  };
}

/** 只收合法档位（low/medium/high/max），其余静默丢弃。 */
function sanitizeLevels(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, level] of Object.entries(raw as Record<string, unknown>)) {
      const value = String(level).trim();
      if (BYOK_REASONING_LEVELS.includes(value as (typeof BYOK_REASONING_LEVELS)[number])) out[id] = value;
    }
  }
  return out;
}

export function registerModelApiHandlers(): void {
  ipcMain.handle('model-api:get', () => {
    const config = readConfig()?.modelApi;
    if (!config) return { ok: true, result: null };
    return {
      ok: true,
      result: { endpoints: config.endpoints.map(toPublicEndpoint) },
    };
  });

  ipcMain.handle('model-api:apply', async (_event, payload: { endpoints?: unknown }) => {
    const current = readConfig()?.modelApi;
    const rawEndpoints = Array.isArray(payload?.endpoints) ? (payload.endpoints as unknown[]) : [];
    if (rawEndpoints.length === 0) {
      return { ok: false, errorCode: 'rejected', error: 'invalid config' };
    }

    const endpoints: ByokEndpointConfig[] = rawEndpoints.map((raw) => {
      const entry = (raw ?? {}) as {
        id?: unknown;
        name?: unknown;
        baseUrl?: unknown;
        apiKey?: unknown;
        modelIds?: unknown;
        modelLevels?: unknown;
      };
      const id = endpointProviderId(String(entry.id ?? '').trim());
      const modelIds = Array.isArray(entry.modelIds)
        ? (entry.modelIds as unknown[]).map((m) => String(m).trim()).filter(Boolean)
        : [];
      // 空 apiKey = 保留同端点（按 id）已存的那把（renderer 不回显明文，用户不重填就不换）。
      const incomingKey = String(entry.apiKey ?? '').trim();
      const existingKey = current?.endpoints.find((e) => e.id === id)?.apiKey ?? '';
      const apiKey = incomingKey || existingKey || '';
      return {
        id,
        name: String(entry.name ?? '').trim() || id,
        baseUrl: String(entry.baseUrl ?? '').trim(),
        apiKey,
        modelIds,
        modelLevels: sanitizeLevels(entry.modelLevels),
      };
    });

    const valid = endpoints.filter((e) => e.baseUrl && e.apiKey && e.modelIds.length > 0);
    if (valid.length === 0) {
      return { ok: false, errorCode: 'rejected', error: 'invalid config' };
    }

    updateConfig({ modelApi: { endpoints } });

    const gateway = getGatewayClient(LOCAL_GATEWAY_ID);
    if (!gateway?.isConnected) {
      return { ok: false, errorCode: 'transport', error: 'gateway not connected' };
    }
    return gateway.runConfigMutation((tx) =>
      applyByokConfig({ getConfig: tx.getConfig, patchConfig: tx.patchConfig }, { endpoints }),
    );
  });

  ipcMain.handle('model-api:list', async (_event, payload: { baseUrl?: unknown; apiKey?: unknown }) => {
    const baseUrl = String(payload?.baseUrl ?? '').trim();
    let apiKey = String(payload?.apiKey ?? '').trim();
    // 端点已配置但 renderer 拿不到明文 key ⇒ 按 baseUrl 回退到已存的 key，不必让用户重填。
    if (!apiKey) {
      const matched = readConfig()?.modelApi?.endpoints.find((e) => e.baseUrl.trim() === baseUrl);
      apiKey = matched?.apiKey ?? '';
    }
    if (!baseUrl || !apiKey) {
      return { ok: false, errorCode: 'rejected', error: 'baseUrl and apiKey are required' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIST_MODELS_TIMEOUT_MS);
    try {
      const res = await fetch(`${normalizeBaseUrlForList(baseUrl)}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, errorCode: 'rejected', error: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      const modelIds = (Array.isArray(body?.data) ? body.data : [])
        .map((entry) => String(entry?.id ?? '').trim())
        .filter(Boolean);
      return { ok: true, result: { modelIds } };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        errorCode: aborted ? 'transport' : 'rejected',
        error: aborted ? 'list models timed out' : error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  });

  ipcMain.handle('model-api:remove', async () => {
    const current = readConfig();
    if (current?.modelApi) {
      updateConfig({ modelApi: undefined });
    }

    const gateway = getGatewayClient(LOCAL_GATEWAY_ID);
    if (!gateway?.isConnected) {
      return { ok: false, errorCode: 'transport', error: 'gateway not connected' };
    }
    return gateway.runConfigMutation((tx) =>
      removeByokConfig({ getConfig: tx.getConfig, patchConfig: tx.patchConfig }),
    );
  });
}
