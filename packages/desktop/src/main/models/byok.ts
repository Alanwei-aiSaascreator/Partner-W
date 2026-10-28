import { normalizeBaseUrl } from '../commercial/relay-config.js';
import type { ByokEndpointConfig, ModelApiConfig } from '../workspace/config.js';

/**
 * BYOK（Bring Your Own Key）模型服务接入 —— 私有化 / 开源版的核心模型路径。
 *
 * 用户自配若干 OpenAI 兼容端点（`baseUrl` + `apiKey` + 模型 id 列表），这里把
 * **每个端点**写进网关 `models.providers.<endpointId>`，让模型目录按端点列出。
 *
 * 2026-10-28 用户需求升级：从「单端点」变成「多端点池」——一个 key 一个 url 里
 * 常有多个模型，且要支持多个 url / 多个 key 供客户选定。
 *
 * 写入模式与 relay 同构（`relay-config.ts` 的 `applyRelayConfig`）：
 * `getConfig` → `buildByokPatch` → `patchConfig` → 回读验证，同一份乐观锁重试。
 *
 * ⚠️ 日志纪律：`apiKey` 绝不进日志（日志会进排查记录、用户可能外发）。
 */

/** 迁移保留的首个端点 / provider id（旧单端点配置的 provider 就叫这个）。 */
export const BYOK_PROVIDER_ID = 'byok';

/** BYOK 模型可选的四档推理功率（内核 level 词，low/medium/high/max 与 effort 词同名）。 */
export const BYOK_REASONING_LEVELS = ['low', 'medium', 'high', 'max'] as const;
export const BYOK_DEFAULT_LEVEL: string = 'high';

/** 内核 `buildThinkingLevelMap` 同构：把**全词表**写满，不支持的写 `null`。 */
const ALL_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function byokThinkingLevelMap(level: string): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const l of ALL_REASONING_LEVELS) map[l] = l === level ? level : null;
  return map;
}

/** 单个模型 id 的功率档；未声明 / 非法值回落到默认 `high`。 */
export function byokLevelFor(id: string, levels?: Record<string, string>): string {
  const level = levels?.[id];
  return level && (BYOK_REASONING_LEVELS as readonly string[]).includes(level) ? level : BYOK_DEFAULT_LEVEL;
}

/** 端点 id → 网关 provider id（只留字母数字连字符，非法字符转 `-`）。 */
export function endpointProviderId(endpointId: string): string {
  const safe = endpointId
    .trim()
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || BYOK_PROVIDER_ID;
}

/** 某个 provider id 是不是 BYOK 系的（`byok` 或 `byok-xxx`）。 */
export function isByokProviderId(providerId: string): boolean {
  return providerId === BYOK_PROVIDER_ID || providerId.startsWith(`${BYOK_PROVIDER_ID}-`);
}

/** OpenAI 兼容端点的模型 ref（两段：`<providerId>/<modelId>`）。 */
export function byokModelRef(providerId: string, id: string): string {
  return `${providerId}/${id}`;
}

export interface ByokApplyDeps {
  /** 读网关配置快照（`gateway-client.getConfig()`）。**会抛**。 */
  getConfig: () => Promise<unknown>;
  /** 写网关配置（`gateway-client.patchConfig()`）。**会抛**。 */
  patchConfig: (params: { baseHash: string; raw: string; replacePaths?: string[] }) => Promise<unknown>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface ByokApplyResult {
  ok: boolean;
  error?: string;
  errorCode?: 'transport' | 'rejected' | 'hash-conflict' | 'verify-failed';
}

const MAX_HASH_RETRIES = 3;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 快照里的 `.config`（外层是 `{ hash, config }`）。 */
function configOf(snapshot: unknown): Record<string, unknown> | undefined {
  return (snapshot as { config?: Record<string, unknown> } | null)?.config;
}

/** 与 `relay-config.ts` 同款：区分乐观锁冲突（可重试）/ 传输错误 / 其余拒绝。 */
function classifyWriteError(error: unknown): 'hash-conflict' | 'transport' | 'rejected' {
  const text = messageOf(error);
  if (/hash|config changed since last load|re-run config\.get and retry/i.test(text)) return 'hash-conflict';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|not connected|timeout/i.test(text)) {
    return 'transport';
  }
  return 'rejected';
}

/**
 * 单个端点的模型 id → 静态模型条目。
 *
 * 每个模型按用户选的档位声明**单一**推理档：`compat.supportedReasoningEfforts: [level]`
 * + 全词表 `thinkingLevelMap`（只留该档非 null），字段形状对齐 `relay-config.ts` 的
 * `buildRoutedModel` —— 内核据此给该模型开对应功率。
 */
function modelEntries(endpoint: ByokEndpointConfig): Array<Record<string, unknown>> {
  return endpoint.modelIds.map((id) => {
    const level = byokLevelFor(id, endpoint.modelLevels);
    return {
      id,
      name: id,
      reasoning: true,
      input: ['text'],
      compat: { supportsReasoningEffort: true, supportedReasoningEfforts: [level] },
      thinkingLevelMap: byokThinkingLevelMap(level),
    };
  });
}

/** 过滤出「能写进网关」的有效端点（baseUrl + apiKey + 至少一个模型）。 */
function validEndpoints(config: ModelApiConfig): ByokEndpointConfig[] {
  return config.endpoints.filter((e) => normalizeBaseUrl(e.baseUrl.trim()) && e.apiKey && e.modelIds.length > 0);
}

/**
 * 构建 BYOK 配置补丁。无效输入（没有有效端点）返回 null。
 *
 * - 每个端点写一个 provider：`models.providers.<endpointId>`（baseUrl + apiKey + models）
 * - 若默认模型未设置，指向第一个端点的第一个模型
 */
export function buildByokPatch(config: ModelApiConfig, existingConfig?: unknown): Record<string, unknown> | null {
  const endpoints = validEndpoints(config);
  if (endpoints.length === 0) return null;

  const providers: Record<string, unknown> = {};
  for (const endpoint of endpoints) {
    const providerId = endpointProviderId(endpoint.id);
    providers[providerId] = {
      baseUrl: normalizeBaseUrl(endpoint.baseUrl.trim()),
      apiKey: endpoint.apiKey,
      models: modelEntries(endpoint),
    };
  }

  const patch: Record<string, unknown> = { models: { providers } };

  const snapshot = configOf(existingConfig);
  const primary = (snapshot?.agents as { defaults?: { model?: { primary?: unknown } } } | undefined)?.defaults?.model
    ?.primary;
  if (!primary) {
    const first = endpoints[0];
    patch.agents = {
      defaults: { model: { primary: byokModelRef(endpointProviderId(first.id), first.modelIds[0]) } },
    };
  }

  return patch;
}

/** 写 BYOK 配置到网关并回读验证。不抛异常，失败以返回值带出。 */
export async function applyByokConfig(deps: ByokApplyDeps, config: ModelApiConfig): Promise<ByokApplyResult> {
  const log = deps.log ?? ((): void => {});
  const endpoints = validEndpoints(config);
  if (endpoints.length === 0) {
    return { ok: false, errorCode: 'rejected', error: 'invalid config' };
  }

  for (let attempt = 1; attempt <= MAX_HASH_RETRIES; attempt += 1) {
    let snapshot: unknown;
    try {
      snapshot = await deps.getConfig();
    } catch (error) {
      return { ok: false, errorCode: 'transport', error: messageOf(error) };
    }

    const baseHash = (snapshot as { hash?: unknown } | null)?.hash;
    if (typeof baseHash !== 'string' || !baseHash) {
      return { ok: false, errorCode: 'transport', error: 'config snapshot has no hash' };
    }

    const patch = buildByokPatch(config, snapshot) as Record<string, unknown>;
    log('byok.config-write-start', { attempt, endpoints: endpoints.length });
    try {
      await deps.patchConfig({ baseHash, raw: JSON.stringify(patch) });
    } catch (error) {
      const kind = classifyWriteError(error);
      log('byok.config-write-failed', { attempt, kind, message: messageOf(error) });
      if (kind === 'hash-conflict' && attempt < MAX_HASH_RETRIES) continue;
      return { ok: false, errorCode: kind, error: messageOf(error) };
    }

    try {
      const applied = await deps.getConfig();
      const providers = (configOf(applied)?.models as { providers?: Record<string, unknown> } | undefined)?.providers;
      const allApplied = endpoints.every((e) => {
        const provider = providers?.[endpointProviderId(e.id)];
        return provider && typeof provider === 'object';
      });
      if (allApplied) return { ok: true };
      return { ok: false, errorCode: 'verify-failed', error: 'gateway did not apply the byok config' };
    } catch (error) {
      return { ok: false, errorCode: 'transport', error: messageOf(error) };
    }
  }

  return { ok: false, errorCode: 'hash-conflict', error: 'hash conflict retries exhausted' };
}

/** 移除 BYOK 配置（把 `byok*` 前缀的 provider 置 null），并清掉指向它们的默认模型。 */
export async function removeByokConfig(deps: ByokApplyDeps): Promise<ByokApplyResult> {
  const log = deps.log ?? ((): void => {});

  for (let attempt = 1; attempt <= MAX_HASH_RETRIES; attempt += 1) {
    let snapshot: unknown;
    try {
      snapshot = await deps.getConfig();
    } catch (error) {
      return { ok: false, errorCode: 'transport', error: messageOf(error) };
    }

    const baseHash = (snapshot as { hash?: unknown } | null)?.hash;
    if (typeof baseHash !== 'string' || !baseHash) {
      return { ok: false, errorCode: 'transport', error: 'config snapshot has no hash' };
    }

    const cfg = configOf(snapshot);
    const providers = (cfg?.models as { providers?: Record<string, unknown> } | undefined)?.providers ?? {};
    const byokProviders = Object.keys(providers).filter(isByokProviderId);
    if (byokProviders.length === 0) return { ok: true };

    const providersPatch: Record<string, null> = {};
    const replacePaths: string[] = [];
    for (const providerId of byokProviders) {
      providersPatch[providerId] = null;
      const provider = providers[providerId];
      if (provider && typeof provider === 'object' && Array.isArray((provider as { models?: unknown }).models)) {
        replacePaths.push(`models.providers.${providerId}.models`);
      }
    }

    const patch: Record<string, unknown> = { models: { providers: providersPatch } };
    const primary = (cfg?.agents as { defaults?: { model?: { primary?: unknown } } } | undefined)?.defaults?.model
      ?.primary;
    if (typeof primary === 'string' && isByokProviderId(primary.split('/')[0] ?? '')) {
      patch.agents = { defaults: { model: { primary: null } } };
    }

    try {
      await deps.patchConfig({
        baseHash,
        raw: JSON.stringify(patch),
        ...(replacePaths.length > 0 ? { replacePaths } : {}),
      });
    } catch (error) {
      const kind = classifyWriteError(error);
      log('byok.config-remove-failed', { attempt, kind, message: messageOf(error) });
      if (kind === 'hash-conflict' && attempt < MAX_HASH_RETRIES) continue;
      return { ok: false, errorCode: kind, error: messageOf(error) };
    }
    return { ok: true };
  }

  return { ok: false, errorCode: 'hash-conflict', error: 'hash conflict retries exhausted' };
}
