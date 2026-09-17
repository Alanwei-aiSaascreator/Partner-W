/**
 * 中转服务（relay）在客户端这一侧的常量与识别逻辑。
 *
 * 本文件承担两件事，分两次提交落地：
 *   ① **认出**哪些 provider 是走中转的（用量上报要用它去重）—— 见 `relayProviderIds`
 *   ② **写入**中转配置（激活时）—— 见 `buildRelayPatch` / `applyRelayConfig`
 *
 * 之所以①②放一起：它们必须共用同一个「中转地址」常量。分散两处早晚会漂。
 */

/**
 * 中转服务的地址。
 *
 * ⚠️ 必须带 `/relay` 前缀：nginx 会把该前缀剥掉再转给中转服务
 * （`services/relay/deploy/nginx-relay.conf` 的 `proxy_pass`），而 clawrouter 插件
 * 是在这个地址后面接 `/v1/catalog`、`/v1/chat/completions` 的。
 * 少了前缀，请求会打到站点根上，表现为「模型列表是空的」而且不报错。
 */
export const RELAY_BASE_URL = 'https://api.rongyinghudong.com/relay';

/** 去掉尾斜杠，只用于比较。 */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * 从网关配置快照里，找出**实际打到中转服务**的 provider 名。
 *
 * 入参是 `gateway-client.getConfig()` 的返回（`ConfigSnapshot`），
 * 真正的配置在它的 `.config` 下 —— 不是顶层。
 *
 * ## 为什么按 baseUrl 而不是按名字
 *
 * provider 的名字是**用户可改的**（网关的 Models 设置里就能改）。按名字过滤的话，
 * 用户一改名过滤就**静默失效** —— 而失效的后果是把已经由中转服务计量过的用量
 * 再上报一次，**用户被扣两次钱**。判据必须落在「这个 provider 实际打到哪」。
 *
 * 前缀比较那半句是为了容错：`.../relay/v1` 这种带路径的写法也算。
 * 同时它不会误伤 `.../relay-other` —— 因为要求的是 `target + '/'`。
 */
export function relayProviderIds(configSnapshot: unknown): Set<string> {
  const ids = new Set<string>();

  const providers = (configSnapshot as { config?: { models?: { providers?: unknown } } } | null)?.config?.models
    ?.providers;
  if (!providers || typeof providers !== 'object') return ids;

  const target = normalizeBaseUrl(RELAY_BASE_URL);
  for (const [id, entry] of Object.entries(providers as Record<string, unknown>)) {
    const baseUrl = (entry as { baseUrl?: unknown } | null)?.baseUrl;
    if (typeof baseUrl !== 'string') continue;

    const normalized = normalizeBaseUrl(baseUrl);
    if (normalized === target || normalized.startsWith(`${target}/`)) ids.add(id);
  }
  return ids;
}

/** 中转服务在网关配置里的 provider 名。插件声明的 `providers` 也是这个名字。 */
export const RELAY_PROVIDER_ID = 'clawrouter';

export interface RelayPatchInput {
  relayKey: string | null | undefined;
  deviceFingerprint: string;
  /** 现有网关配置快照（`getConfig()` 的返回，真正的配置在 `.config`）。 */
  existingConfig?: unknown;
  /** 解析出来的默认模型 ref；仅当 `agents.defaults.model.primary` 未设置时才用。 */
  defaultModel?: string | null;
}

export type RelayConfigPatch = Record<string, unknown>;

function configOf(snapshot: unknown): Record<string, unknown> | undefined {
  return (snapshot as { config?: Record<string, unknown> } | null)?.config;
}

/**
 * 构造写进网关的配置补丁（深合并语义，见 `config.patch`）。
 *
 * ⚠️ 规范形状里**没有 `api` 字段** —— 传输协议由 catalog 里每个模型的 capability
 * 逐条决定（官方文档 `docs/providers/clawrouter.md`）。写死会把「按模型选传输」
 * 压成「整个 provider 一个传输」。测试里有反向断言盯着这条，别加。
 */
export function buildRelayPatch(input: RelayPatchInput): RelayConfigPatch | null {
  // 没有 key 就不写：写一个空 apiKey 会让网关去调一个必然 401 的地址，
  // 用户看到的是一堆失败的模型调用，比「没配置」更难排查。
  if (!input.relayKey) return null;

  const headers: Record<string, string> = {};
  if (input.deviceFingerprint) {
    // 只记录不拦截（设计文档 6.2）。缺了也不影响放行，所以允许缺省。
    headers['X-ClawRouter-Project-Id'] = input.deviceFingerprint;
  }

  const patch: RelayConfigPatch = {
    models: {
      providers: {
        [RELAY_PROVIDER_ID]: {
          baseUrl: RELAY_BASE_URL,
          apiKey: input.relayKey,
          headers,
        },
      },
    },
  };

  const config = configOf(input.existingConfig);

  // `plugins.allow`：官方文档说「若配置里设了它，必须把 clawrouter 加进名单」。
  // ⚠️ **只在它本来就存在时补名** —— 凭空创建一份 allow 名单会把其他插件
  // 全挡在外面，那是灾难不是配置。
  const allow = (config?.plugins as { allow?: unknown } | undefined)?.allow;
  if (Array.isArray(allow)) {
    const names = allow.filter((x): x is string => typeof x === 'string');
    patch.plugins = { allow: [...new Set([...names, RELAY_PROVIDER_ID])] };
  }

  // 默认模型：**只在该字段未设置时写**。
  // 激活是「新增能力」，不该是「重设用户偏好」——用户已经选过的模型不动。
  const primary = (config?.agents as { defaults?: { model?: { primary?: unknown } } } | undefined)?.defaults?.model
    ?.primary;
  if (!primary && input.defaultModel) {
    patch.agents = { defaults: { model: { primary: input.defaultModel } } };
  }

  return patch;
}

export interface RelayRemovalPatch {
  patch: RelayConfigPatch;
  replacePaths: string[];
}

/**
 * 与网关 `dist/patch-replace-paths-*.mjs` 的 `collectBaseArrayPaths` **同构**：
 * 删除一个对象子树时，把该子树下**每一个数组路径**收集出来（点号分隔，
 * 遇到数组即停、不往元素里递归）。
 *
 * 为什么必须一模一样：网关在 `config.patch` 里对"把对象整个置 null"的补丁做
 * 破坏性校验 —— 少报一个数组路径就**整条 patch 被拒**（`INVALID_REQUEST`）。
 * 2026-09-17 实机就是这个：provider 的 `models` 数组没报备，清理永远失败，
 * 然后被每秒重试一次（见 relay-bootstrap 的 runtime-not-ready 轮询）。
 */
function collectBaseArrayPaths(base: unknown, path: string): string[] {
  if (Array.isArray(base)) return [path];
  if (typeof base !== 'object' || base === null) return [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(base as Record<string, unknown>)) {
    // 与网关的 isMergePatchObjectKeyAllowed 对齐：原型污染键不参与
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    paths.push(...collectBaseArrayPaths(value, path ? `${path}.${key}` : key));
  }
  return paths;
}

/**
 * 构造一份最窄的 JSON merge patch 来移除商业中转凭证。
 *
 * `config.get` 会脱敏所有密钥，所以这里绝不能把完整快照通过 `config.set`
 * 写回；只对确认指向荣盈中转地址的 provider 发 `null` 删除。
 */
export function buildRelayRemovalPatch(configSnapshot: unknown): RelayRemovalPatch | null {
  const config = configOf(configSnapshot);
  if (!config) return null;

  const providerIds = relayProviderIds(configSnapshot);
  const patch: RelayConfigPatch = {};
  const replacePaths: string[] = [];

  if (providerIds.size > 0) {
    patch.models = {
      providers: Object.fromEntries(Array.from(providerIds, (id) => [id, null])),
    };
    // ⚠️ 整棵 provider 子树被删 ⇒ 它下面的数组路径全部要报备，否则网关直接拒整条补丁。
    const providers = (config.models as { providers?: unknown } | undefined)?.providers;
    if (providers && typeof providers === 'object') {
      for (const id of providerIds) {
        replacePaths.push(
          ...collectBaseArrayPaths((providers as Record<string, unknown>)[id], `models.providers.${id}`),
        );
      }
    }
  }

  const allow = (config.plugins as { allow?: unknown } | undefined)?.allow;
  if (Array.isArray(allow)) {
    const blockedNames = new Set([...providerIds, RELAY_PROVIDER_ID]);
    const filtered = allow.filter((name) => typeof name !== 'string' || !blockedNames.has(name));
    if (filtered.length !== allow.length) {
      patch.plugins = { allow: filtered };
      replacePaths.push('plugins.allow');
    }
  }

  const primary = (config.agents as { defaults?: { model?: { primary?: unknown } } } | undefined)?.defaults?.model
    ?.primary;
  if (typeof primary === 'string') {
    const providerName = primary.split('/', 1)[0];
    if (providerIds.has(providerName) || providerName === RELAY_PROVIDER_ID) {
      patch.agents = { defaults: { model: { primary: null } } };
    }
  }

  return Object.keys(patch).length > 0 ? { patch, replacePaths } : null;
}

/** 取 catalog 的超时。catalog 是纯内存查询，正常在百毫秒级。 */
const CATALOG_TIMEOUT_MS = 8_000;

/**
 * 从中转服务的 catalog 里取一个模型，拼成 openclaw 的模型 ref。
 *
 * ref 的格式是 **`clawrouter/<catalog 里的 model id>`** —— **两段**。
 * catalog 里的 provider id（我们这边是 `bailian`）**不进 ref**。
 *
 * ⚠️ 这条是 dev 端到端实测出来的，不是从文档读出来的（2026-09-11）：
 * 起真网关、写进配置、列模型，得到的是 `clawrouter/deepseek-v4-flash`，
 * **没有中间那一段**。我原先按官方文档 `docs/providers/clawrouter.md` 的
 * 例子（`clawrouter/openai/gpt-5.5`）拼了三段 —— 但文档那句原话是
 * 「refs **retain the upstream namespace**」：它那边的 catalog 里 model id
 * **本身就带命名空间**（`openai/gpt-5.5`），ref 仍然是 `clawrouter/` + model id。
 * 我们的 relay 返回的 id 是 `deepseek-v4-flash`（不带命名空间），所以是两段。
 *
 * 三段 ref 在网关里**根本不存在** —— 写进 `model.primary` 是个无效值，
 * 而且不会报错。单测发现不了这个（单测验的是「我以为的格式」）。
 *
 * 拿不到就返回 null —— 默认模型不写而已，不该拖垮配置写入。
 */
export async function fetchFirstRelayModel(relayKey: string): Promise<string | null> {
  const res = await fetch(`${normalizeBaseUrl(RELAY_BASE_URL)}/v1/catalog`, {
    headers: { Authorization: `Bearer ${relayKey}` },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as {
    providers?: Array<{ models?: Array<{ id?: unknown }> }>;
  };
  const model = body.providers?.[0]?.models?.find((m) => typeof m.id === 'string' && m.id.length > 0);
  if (!model) return null;

  return `${RELAY_PROVIDER_ID}/${String(model.id)}`;
}

export interface ApplyRelayConfigDeps {
  /** 读网关配置快照（`gateway-client.getConfig()`）。**会抛**，不返回 IpcResult。 */
  getConfig: () => Promise<unknown>;
  /** 写网关配置（`gateway-client.patchConfig()`）。**会抛**，不返回 IpcResult。 */
  patchConfig: (params: { baseHash: string; raw: string; replacePaths?: string[] }) => Promise<unknown>;
  /** 解析一个可用的中转模型 ref；拿不到返回 null（不阻塞主流程）。 */
  resolveDefaultModel?: (relayKey: string) => Promise<string | null>;
  /** 日志。**不要传含 relay key 的数据进来**。 */
  log?: (event: string, data: Record<string, unknown>) => void;
}

export type ApplyRelayErrorCode = 'no-key' | 'transport' | 'rejected' | 'hash-conflict' | 'verify-failed';

export interface ApplyRelayResult {
  ok: boolean;
  /** 配置是否**真的写进去了**（回读校验通过）。只看 patchConfig 的返回不够。 */
  configured: boolean;
  warnings: string[];
  error?: string;
  errorCode?: ApplyRelayErrorCode;
}

const MAX_HASH_RETRIES = 3;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 给网关的写入错误分类。
 *
 * **区分这两类是有后果的**：都当一种处理时，schema 拒绝（配置本身不合法）
 * 会被当成网络抖动一直重试 —— 白等，而且永远好不了。
 */
function classifyWriteError(error: unknown): 'hash-conflict' | 'transport' | 'rejected' {
  const text = messageOf(error);
  // 乐观锁：并发写导致快照过期。**重读快照再来就有用**，所以值得重试。
  if (/hash/i.test(text)) return 'hash-conflict';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|not connected|timeout/i.test(text)) {
    return 'transport';
  }
  return 'rejected';
}

export interface RemoveRelayConfigDeps {
  getConfig: () => Promise<unknown>;
  patchConfig: (params: { baseHash: string; raw: string; replacePaths?: string[] }) => Promise<unknown>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface RemoveRelayResult {
  ok: boolean;
  cleaned: boolean;
  error?: string;
  errorCode?: 'transport' | 'rejected' | 'hash-conflict' | 'verify-failed';
}

export async function removeRelayConfig(deps: RemoveRelayConfigDeps): Promise<RemoveRelayResult> {
  const log = deps.log ?? ((): void => {});

  for (let attempt = 1; attempt <= MAX_HASH_RETRIES; attempt += 1) {
    let snapshot: unknown;
    try {
      snapshot = await deps.getConfig();
    } catch (error) {
      return { ok: false, cleaned: false, errorCode: 'transport', error: messageOf(error) };
    }

    const removal = buildRelayRemovalPatch(snapshot);
    if (!removal) return { ok: true, cleaned: true };

    const baseHash = (snapshot as { hash?: unknown } | null)?.hash;
    if (typeof baseHash !== 'string' || !baseHash) {
      return { ok: false, cleaned: false, errorCode: 'transport', error: 'config snapshot has no hash' };
    }

    try {
      await deps.patchConfig({
        baseHash,
        raw: JSON.stringify(removal.patch),
        replacePaths: removal.replacePaths,
      });
    } catch (error) {
      const kind = classifyWriteError(error);
      log('relay.config-remove-failed', { attempt, kind, message: messageOf(error) });
      if (kind === 'hash-conflict' && attempt < MAX_HASH_RETRIES) continue;
      return { ok: false, cleaned: false, errorCode: kind, error: messageOf(error) };
    }

    try {
      if (!buildRelayRemovalPatch(await deps.getConfig())) return { ok: true, cleaned: true };
    } catch (error) {
      log('relay.config-remove-verify-failed', { attempt, message: messageOf(error) });
    }
    return {
      ok: false,
      cleaned: false,
      errorCode: 'verify-failed',
      error: 'gateway still contains relay configuration',
    };
  }

  return { ok: false, cleaned: false, errorCode: 'hash-conflict', error: 'config patch kept conflicting' };
}

/**
 * 回读校验：provider 在、**打到中转**、且带一个非空的 apiKey。
 *
 * ⚠️ **绝不能拿 apiKey 去和真 key 比** —— 网关的 `config.get` **会脱敏**。
 * 实测（2026-09-13 打包态 E2E）：回读到的 raw 里 `"token": "__OPENCLAW_REDACTED__"`，
 * 于是 `apiKey === relayKey` **永远不成立**，配置明明写成功了却每次报
 * `verify-failed` —— 而调用方只把它当"没配上"，于是悄悄什么都不做。
 *
 * 秘密读不回来；能读回来的是「这个 provider 指向哪、有没有 key」。
 * 这也**正是** `relayProviderIds` 用的判据（同一个理由：比得着的才可靠）。
 */
function providerApplied(snapshot: unknown): boolean {
  const providers = (configOf(snapshot)?.models as { providers?: Record<string, unknown> } | undefined)?.providers;
  const entry = providers?.[RELAY_PROVIDER_ID];
  if (!entry || typeof entry !== 'object') return false;

  const { apiKey, baseUrl } = entry as { apiKey?: unknown; baseUrl?: unknown };
  if (normalizeBaseUrl(String(baseUrl ?? '')) !== normalizeBaseUrl(RELAY_BASE_URL)) return false;
  // 脱敏后仍然是**非空字符串**（真 key 或 `__OPENCLAW_REDACTED__` 都算有 key）；
  // 空串/缺失才说明这个 provider 没带上凭证。
  return typeof apiKey === 'string' && apiKey.length > 0;
}

/**
 * 把中转配置写进网关，并**回读校验**。
 *
 * 为什么不直接写盘上的 `openclaw.json`：客户端本来就不直接改那个文件，
 * 它走网关的 `config.patch` RPC（深合并语义）。跟着既有模式走才能继承
 * 既有的并发保护。
 *
 * 本函数**不抛异常** —— 配置写失败不该让激活整体失败：授权已经绑定成功了，
 * 重试配置写入比让用户重新激活代价小。失败时返回 `configured: false`，
 * 调用方在返回值里带出去。
 */
export async function applyRelayConfig(
  deps: ApplyRelayConfigDeps,
  input: { relayKey: string | null | undefined; deviceFingerprint: string },
): Promise<ApplyRelayResult> {
  const warnings: string[] = [];
  const log = deps.log ?? ((): void => {});

  if (!input.relayKey) {
    return { ok: false, configured: false, errorCode: 'no-key', error: 'no relay key', warnings };
  }

  let defaultModel: string | null = null;
  if (deps.resolveDefaultModel) {
    try {
      defaultModel = await deps.resolveDefaultModel(input.relayKey);
    } catch (error) {
      // 拿不到模型只是「默认模型不写」，不该拖垮整个配置写入。
      warnings.push('resolve-default-model-failed');
      log('relay.default-model-resolve-failed', { message: messageOf(error) });
    }
  }

  for (let attempt = 1; attempt <= MAX_HASH_RETRIES; attempt += 1) {
    let snapshot: unknown;
    try {
      snapshot = await deps.getConfig();
    } catch (error) {
      log('relay.config-read-failed', { attempt, message: messageOf(error) });
      return { ok: false, configured: false, errorCode: 'transport', error: messageOf(error), warnings };
    }

    const baseHash = (snapshot as { hash?: unknown } | null)?.hash;
    if (typeof baseHash !== 'string' || !baseHash) {
      return { ok: false, configured: false, errorCode: 'transport', error: 'config snapshot has no hash', warnings };
    }

    const patch = buildRelayPatch({ ...input, existingConfig: snapshot, defaultModel });
    if (!patch) {
      return { ok: false, configured: false, errorCode: 'no-key', error: 'no relay key', warnings };
    }

    // 日志只记形状，**绝不记 key 本身** —— 日志会进排查记录、用户可能外发。
    log('relay.config-write-start', {
      attempt,
      provider: RELAY_PROVIDER_ID,
      hasDeviceHeader: Boolean(input.deviceFingerprint),
      setsDefaultModel: 'agents' in patch,
    });

    try {
      await deps.patchConfig({ baseHash, raw: JSON.stringify(patch) });
    } catch (error) {
      const kind = classifyWriteError(error);
      log('relay.config-write-failed', { attempt, kind, message: messageOf(error) });

      // 只有乐观锁冲突值得重试：它会因为「重读快照」而改变输入。
      // 网络异常虽然客观上也「可重试」，但在激活这个同步流程里立刻重试没有意义
      // —— 标成 transport 交给调用方，换个时间再来。
      // schema 拒绝则重试一万次也一样，直接返回。
      if (kind === 'hash-conflict' && attempt < MAX_HASH_RETRIES) continue;
      return { ok: false, configured: false, errorCode: kind, error: messageOf(error), warnings };
    }

    // 只信 patchConfig 的返回是不够的 —— WS 通道的失败模式比本地文件写复杂，
    // 「返回成功但网关没生效」是它独有的。所以回读一次。
    let verified = false;
    try {
      verified = providerApplied(await deps.getConfig());
    } catch (error) {
      log('relay.config-verify-read-failed', { attempt, message: messageOf(error) });
    }

    log('relay.config-write-done', { attempt, verified });

    if (!verified) {
      return {
        ok: true,
        configured: false,
        errorCode: 'verify-failed',
        error: 'gateway did not apply the relay config',
        warnings,
      };
    }
    return { ok: true, configured: true, warnings };
  }

  return {
    ok: false,
    configured: false,
    errorCode: 'hash-conflict',
    error: 'config patch kept conflicting',
    warnings,
  };
}
