import { COMMERCIAL_DEFAULT_MODEL_ID } from '@clawwork/shared';
import type { RelayMediaReadiness } from '@clawwork/shared';
import { setActiveRelayKey } from './relay-key.js';
import { RELAY_SEARCH_PLUGIN_ID } from '../runtime/relay-search-plugin.js';

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
 * 中转服务的地址（**生产默认值**）。
 *
 * ⚠️ 必须带 `/relay` 前缀：nginx 会把该前缀剥掉再转给中转服务
 * （`services/relay/deploy/nginx-relay.conf` 的 `proxy_pass`），而 clawrouter 插件
 * 是在这个地址后面接 `/v1/catalog`、`/v1/chat/completions` 的。
 * 少了前缀，请求会打到站点根上，表现为「模型列表是空的」而且不报错。
 *
 * ⚠️ 2026-10-03 起本模块**不再直接用它**写配置/认配置 —— 一律走
 *    `activeRelayBaseUrl()`（受控配置出口，见 `relay-endpoint.ts`）。
 *    这个常量只剩两个身份：① 默认值；② 白名单/回退的锚点。
 */
export const RELAY_BASE_URL = 'https://api.rongyinghudong.com/relay';

/** 去掉尾斜杠，只用于比较。 */
export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * 受控配置出口的**唯一落地形态**：一个进程级覆盖值。
 *
 * - `null`（默认）= 生产基址，行为与历史逐字相同；
 * - 非 null = 测试模式解析出的本机基址（`relay-startup` 在每轮 bootstrap
 *   写入前解析一次，见 `ensureControlledRelayEndpointResolved`）。
 *
 * ⚠️ 只该由受控解析处调用（测试可以用它固定夹具）。别在别处随手 set ——
 *    这个值决定"写进网关的 provider 打到哪"与"哪些用量算中转"两件事。
 */
let activeRelayBaseUrlOverride: string | null = null;

/** 设置活动基址；`null` 恢复生产默认。（受控配置出口，2026-10-03） */
export function setActiveRelayBaseUrl(baseUrl: string | null): void {
  activeRelayBaseUrlOverride = baseUrl ? normalizeBaseUrl(baseUrl) : null;
}

/** 当前**实际**使用的中转基址：写配置、认配置、探针三处共用这一个出口。 */
export function activeRelayBaseUrl(): string {
  return activeRelayBaseUrlOverride ?? RELAY_BASE_URL;
}

function activeRelayMediaBaseUrl(): string {
  return `${activeRelayBaseUrl()}/v1`;
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

  const target = normalizeBaseUrl(activeRelayBaseUrl());
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

/**
 * ⚠️ 历史教训（2026-10-12，一小时的现场排障）：**不要试图从 `gateway.getConfig()`
 * 的快照里读 relay key**。网关对 apiKey 做**脱敏**（回读值恒为 `__OPENCLAW_REDACTED__`），
 * 拿它出站的效果是每个请求 401 `invalid relay key`，而 chat 一切正常 —— 极具迷惑性。
 * 活体 key 只在 `applyRelayConfig` 这一个漏斗里以明文出现，持有者见 `relay-key.ts`。
 */

/**
 * 图片那条路走**内置的 `openai` 图像 provider**（而不是自造插件）。
 *
 * 为什么复用而不是写插件：随包运行时自带的 `openai` provider 就是说 OpenAI 形状的，
 * 而我们 relay 已经有了一条同形状的严格适配端点（`/v1/images/generations`）。
 * 于是这里只需要**把它的 baseUrl 指到我们**，一个字的新插件都不用写。
 *
 * ⚠️ 代价：`models.providers.openai` 一旦配置，"openai 这个 provider 被配置了"对
 *    运行时就是全局事实 —— 也就是**聊天**若有人选 `openai/...` 的模型也会打到我们 relay。
 *    我们的 catalog 只发 `clawrouter/*`，所以正常路径不会走到；这里记一笔是为了
 *    下次有人改 catalog 时能想起这件事。
 */
export const OPENAI_IMAGE_PROVIDER_ID = 'openai';

/** 我们这个内测能力**只**提供这一个图像模型（服务端 allowlist 也是它）。 */
export const OPENAI_IMAGE_MODEL_ID = 'qwen-image-1';

/** 模型 ref = `<provider>/<model id>`（两段，与 `clawrouter/<id>` 同一规则）。 */
export const OPENAI_IMAGE_MODEL_REF = `${OPENAI_IMAGE_PROVIDER_ID}/${OPENAI_IMAGE_MODEL_ID}`;

/**
 * 视频复用随包 OpenClaw 的内置 `xai` provider。客户端只说 xAI 形状，relay
 * 在服务端把它转换成豆包 Seedance/Ark 的任务协议；供应商 Key 不下发到客户端。
 */
export const XAI_VIDEO_PROVIDER_ID = 'xai';
export const XAI_VIDEO_MODEL_ID = 'grok-imagine-video';
export const XAI_VIDEO_MODEL_REF = `${XAI_VIDEO_PROVIDER_ID}/${XAI_VIDEO_MODEL_ID}`;

/**
 * 图片接线**总闸**。默认 **false** —— 不写 `models.providers.openai`、不写 `mediaModels.image`。
 *
 * ⚠️ 为什么默认必须是关的，而不是"先写好、服务端以后再说"：
 *    写进去之后，运行时就会认为 `openai` 这个 provider **已配置**，于是真的会去打我们的 relay。
 *    而 relay 侧 `MEDIA_IMAGE_ENABLED` 还没开 ⇒ 拿到 503 ⇒
 *    用户看到的是一个**存在但总是失败**的能力 —— 那比"没有这个能力"难查得多，
 *    而且它出现在"不该有图片入口"的内测包上。
 *
 * ⚠️ 翻成 true 之前必须**同时**满足：
 *    ① 服务端 `MEDIA_IMAGE_ENABLED=1` 且该卡在 `MEDIA_IMAGE_ENTITLED_LICENSES` 里；
 *    ② 已经跑过一次**真实供应商**的单图 smoke 并且拿到了图。
 *    两条缺一不可 —— 只做①就翻，等于让用户去撞一个没人验过的上游接口。
 */
export const IMAGE_GENERATION_WIRED = false;

/** 缺少 relay 的逐卡能力证据时，视频同样必须保持关闭。 */
export const VIDEO_GENERATION_WIRED = false;

/**
 * 这份 openai 图片配置**是不是我们的**。
 *
 * ⚠️ 判据必须是**两条同时成立**，缺一不可：
 *    ① `mediaModels.image.primary` **精确等于**我们的模型 ref；
 *    ② `models.providers.openai.baseUrl` **精确等于**我们 relay 的 `/v1` 地址。
 *
 * ⚠️ 只按 `openai/` **前缀**判断是不够的（这是一版修掉的真缺陷）：
 *    用户自己配的 `openai/gpt-image-1` 同样带这个前缀，会被我们**覆盖**成 qwen-image-1 ——
 *    那是把用户手上本来能用的能力换成一个内测能力，而且他没同意。
 *
 * ⚠️ 刻意**不引入新的所有权标记键**：往 provider 子树里塞一个运行时 schema 不认的键，
 *    会让**整份配置被判非法**（本仓栽过一次同类事故，见 `docs/agent-rules`）。
 *    上面这两条值本身就是等价证据 —— 只有我们写过，才会同时是这两个值。
 */
export function ownsOpenAIImageConfig(configSnapshot: unknown): boolean {
  const config = configOf(configSnapshot);
  if (!config) return false;

  const defaults = (config.agents as { defaults?: Record<string, unknown> } | undefined)?.defaults;
  const primary = (defaults?.mediaModels as { image?: { primary?: unknown } } | undefined)?.image?.primary;
  if (primary !== OPENAI_IMAGE_MODEL_REF) return false;

  const providers = (config.models as { providers?: Record<string, unknown> } | undefined)?.providers;
  const baseUrl = (providers?.openai as { baseUrl?: unknown } | undefined)?.baseUrl;
  return typeof baseUrl === 'string' && normalizeBaseUrl(baseUrl) === normalizeBaseUrl(activeRelayMediaBaseUrl());
}

/** 与图片同一条所有权纪律：模型 ref 与 relay baseUrl 两条必须同时命中。 */
export function ownsXaiVideoConfig(configSnapshot: unknown): boolean {
  const config = configOf(configSnapshot);
  if (!config) return false;

  const defaults = (config.agents as { defaults?: Record<string, unknown> } | undefined)?.defaults;
  const primary = (defaults?.mediaModels as { video?: { primary?: unknown } } | undefined)?.video?.primary;
  if (primary !== XAI_VIDEO_MODEL_REF) return false;

  const providers = (config.models as { providers?: Record<string, unknown> } | undefined)?.providers;
  const baseUrl = (providers?.[XAI_VIDEO_PROVIDER_ID] as { baseUrl?: unknown } | undefined)?.baseUrl;
  return typeof baseUrl === 'string' && normalizeBaseUrl(baseUrl) === normalizeBaseUrl(activeRelayMediaBaseUrl());
}

export interface RelayPatchInput {
  relayKey: string | null | undefined;
  deviceFingerprint: string;
  /** 现有网关配置快照（`getConfig()` 的返回，真正的配置在 `.config`）。 */
  existingConfig?: unknown;
  /** 解析出来的默认模型 ref；仅当 `agents.defaults.model.primary` 未设置时才用。 */
  defaultModel?: string | null;
  /**
   * relay 目录的静态模型条目（思考档位/上下文窗口的接线，见
   * `relayCatalogModelEntries` 的说明）。缺省 / 拉取失败 = 保留旧快照；
   * 可信目录的空数组 = 清除已下架或换账号前的静态能力。
   */
  catalogModels?: readonly RelayCatalogModelEntry[] | null;
  /**
   * 联网搜索开关（用户在设置里能改）。
   *
   * ⚠️ 缺省 = **开**（见 `webSearchEnabled`）：这个功能本来就存在，
   *    默认改关等于升级一次就静默拿走一个能力。
   */
  webSearch?: boolean;
  bundledWebSearchAvailable?: boolean;
  /**
   * 图片能力是否接线。**缺省 = 关**（见 `IMAGE_GENERATION_WIRED`）。
   *
   * 做成显式入参而不是直接用常量，是为了让测试能真的把两条路都走一遍 ——
   * 而"默认关"这条行为本身由常量兜底。
   */
  imageGenerationWired?: boolean;
  /** 视频能力是否接线；生产值只能来自 relay `/v1/capabilities`。 */
  videoGenerationWired?: boolean;
}

export type RelayConfigPatch = Record<string, unknown>;

function configOf(snapshot: unknown): Record<string, unknown> | undefined {
  return (snapshot as { config?: Record<string, unknown> } | null)?.config;
}

function isPluginExplicitlyDisabled(config: Record<string, unknown> | undefined, pluginId: string): boolean {
  const plugins = config?.plugins as
    | { enabled?: unknown; deny?: unknown; entries?: Record<string, { enabled?: unknown }> }
    | undefined;
  if (plugins?.enabled === false) return true;
  const matches = (id: unknown): boolean => typeof id === 'string' && id.trim().toLowerCase() === pluginId;
  if (Array.isArray(plugins?.deny) && plugins.deny.some(matches)) return true;
  return Object.entries(plugins?.entries ?? {}).some(([id, entry]) => matches(id) && entry?.enabled === false);
}

/**
 * 构造写进网关的配置补丁（深合并语义，见 `config.patch`）。
 *
 * ⚠️ 规范形状里**没有 `api` 字段** —— 传输协议由 catalog 里每个模型的 capability
 * 逐条决定（官方文档 `docs/providers/clawrouter.md`）。写死会把「按模型选传输」
 * 压成「整个 provider 一个传输」。测试里有反向断言盯着这条，别加。
 */
/**
 * 百炼内置联网搜索（`enable_search`）—— **只有这几个模型能开**。
 *
 * 为什么必须是一张**白名单**而不是"全开"：对不支持的模型传这个参数，百炼是
 * **直接报错** `This model does not support enable_search.`（不是忽略），
 * 全开等于把 deepseek / glm / kimi / doubao 那些模型一起打挂。
 * 依据：官方能力表 + 我们自己的目录逐条核过（能支持的是 qwen-max/plus/turbo 一系）。
 *
 * ⚠️ 三个**真代价**（2026-09-19 查实，别忘）：
 *   1. 成本 ≈ **200 倍输入 token**（网页内容会拼进 prompt，按模型标准价计费）；
 *   2. **15 RPS 限流按阿里云主账号维度**，超限**静默不搜** —— 我们所有用户共用
 *      一个账号 ⇒ 有人会悄悄搜不到，而日志里一切正常；
 *   3. 兼容模式**拿不到来源/角标**，也**无法判断是否真的搜了** ⇒ 界面不能显示"已联网"。
 *
 * ⭐ 2026-10-08（任务模式 · 固定综合模型 `qwen3.7-flash`）：
 *   生产 relay 探针实测 —— `qwen3.7-flash` 带 `enable_search` **兼容且真实触发**
 *   （同一问句输入 15 → 5974 token，网页内容确实拼进了 prompt；一次搜索型问答 ≈ 0.5 元，
 *   与上面第 1 条"≈200 倍输入"的量级吻合）⇒ 加入白名单（搜索开）。
 *   **快速档走别名 `qwen3.7-flash-fast`（relay 目录里的条目，upstream 指向 qwen3.7-flash）
 *   —— 刻意不列在这里**：这个开关只认模型级配置，不进白名单 = 上游搜索硬关，
 *   不需要任何"关搜索"的参数（会话补丁也没有这种通道）。
 */
const ENABLE_SEARCH_MODEL_IDS = ['qwen-turbo', 'qwen-plus', 'qwen3.7-flash'] as const;

/**
 * 按模型注入联网开关。
 *
 * 挂点与形状都是**读随包运行时定的**（`dist/extra-params-*.mjs`）：
 *   · 只有 `params.extra_body` 会被 `Object.assign(payloadObj, extraBody)` 合并进
 *     真正发出去的 payload；**裸写 `params.enable_search` 会被静默丢弃**
 *     （它不在通用 `params` 的转发范围内，而且丢了没有任何报错）；
 *   · 表按 `clawrouter/<模型 id>` 键控（ref 是**两段**，见本文件顶部那段说明）。
 */
function enableSearchModelEntries(
  enabled: boolean,
): Record<string, { params: { extra_body: { enable_search: true | null } } }> {
  return Object.fromEntries(
    ENABLE_SEARCH_MODEL_IDS.map((id) => [
      `${RELAY_PROVIDER_ID}/${id}`,
      { params: { extra_body: { enable_search: enabled ? true : null } } },
    ]),
  );
}

/**
 * 联网开关**默认是开的**。
 *
 * ⚠️ 为什么默认开而不是关：这个功能已经存在，默认关等于**把它从用户手里拿走** ——
 *    而这一轮要修的恰恰是"功能有、够不着"。现在的做法是**让它开着但看得见**：
 *    设置里有一行明说它在联网、只有哪两款模型能用、以及成本大约高多少，随手能关。
 * ⚠️ 缺省（老盘上没有这个字段）**按开**处理：否则升级一次就静默改了所有人的行为。
 */
export function webSearchEnabled(config?: { webSearch?: boolean } | null): boolean {
  return config?.webSearch !== false;
}

export function buildRelayPatch(input: RelayPatchInput): RelayConfigPatch | null {
  // 没有 key 就不写：写一个空 apiKey 会让网关去调一个必然 401 的地址，
  // 用户看到的是一堆失败的模型调用，比「没配置」更难排查。
  if (!input.relayKey) return null;

  const headers: Record<string, string> = {};
  if (input.deviceFingerprint) {
    // 只记录不拦截（设计文档 6.2）。缺了也不影响放行，所以允许缺省。
    headers['X-ClawRouter-Project-Id'] = input.deviceFingerprint;
  }

  const config = configOf(input.existingConfig);
  const ownedImageConfig = ownsOpenAIImageConfig(input.existingConfig);
  const ownedVideoConfig = ownsXaiVideoConfig(input.existingConfig);

  /**
   * 图片那一整块能不能动。**两条同时成立**才动：
   *   ① 总闸打开（`IMAGE_GENERATION_WIRED` / 显式入参）；
   *   ② 用户手上**没有**一份"不是我们的" openai provider。
   *
   * ⚠️ ② 不能省：只判总闸的话，一个配了 `openai.baseUrl = https://api.openai.com/v1`
   *    的用户，其 baseUrl 会被我们**改写成 relay 的地址** ——
   *    他的 `openai/gpt-image-1` 从此打到我们这边，而且他不会知道发生过什么。
   */
  const acceptsOurImageConfig = ((): boolean => {
    const hasOpenAiProvider =
      (config?.models as { providers?: Record<string, unknown> } | undefined)?.providers?.openai !== undefined;
    if (!hasOpenAiProvider) return true;
    return ownedImageConfig;
  })();
  const imageWired =
    (input.imageGenerationWired ?? IMAGE_GENERATION_WIRED) &&
    acceptsOurImageConfig &&
    !isPluginExplicitlyDisabled(config, OPENAI_IMAGE_PROVIDER_ID);

  const acceptsOurVideoConfig = ((): boolean => {
    const providers = (config?.models as { providers?: Record<string, unknown> } | undefined)?.providers;
    const hasXaiProvider = providers?.[XAI_VIDEO_PROVIDER_ID] !== undefined;
    const videoPrimary = (
      config?.agents as { defaults?: { mediaModels?: { video?: { primary?: unknown } } } } | undefined
    )?.defaults?.mediaModels?.video?.primary;
    if (!hasXaiProvider && videoPrimary === undefined) return true;
    return ownedVideoConfig;
  })();
  const videoWired =
    (input.videoGenerationWired ?? VIDEO_GENERATION_WIRED) &&
    acceptsOurVideoConfig &&
    !isPluginExplicitlyDisabled(config, XAI_VIDEO_PROVIDER_ID);

  const previousModels = (config?.models as { providers?: Record<string, { models?: unknown }> } | undefined)
    ?.providers?.[RELAY_PROVIDER_ID]?.models;
  // 目录暂不可用时，仅把旧版省略input条目变为明确text；保留已有视觉和思考声明。
  const legacyModels =
    input.catalogModels == null &&
    Array.isArray(previousModels) &&
    previousModels.some((row: unknown) => row !== null && typeof row === 'object' && !('input' in row))
      ? previousModels.map((row: unknown) =>
          row !== null && typeof row === 'object' && !('input' in row) ? { ...row, input: ['text'] } : row,
        )
      : undefined;
  const catalogModels = input.catalogModels ?? legacyModels;
  const providers: Record<string, unknown> = {
    [RELAY_PROVIDER_ID]: {
      baseUrl: activeRelayBaseUrl(),
      apiKey: input.relayKey,
      headers,
      // ⭐ 2026-10-12：目录模型静态条目（思考档位接线，见 `relayCatalogModelEntries`）。
      //    数组在 merge patch 里 = 全量替换：每次写入即目录快照；拉不到目录就不写这个键
      //    （旧快照保留 / 无旧值时内核动态发现兜底）；可信空目录则撤销旧条目。
      ...(catalogModels != null ? { models: catalogModels } : {}),
    },
  };

  // 图片：**默认不写**（见 `IMAGE_GENERATION_WIRED`）。只在允许时补这一条 ——
  // 同一个 relay key、同一个设备头，只是形状是 OpenAI 那条。
  if (imageWired) {
    providers[OPENAI_IMAGE_PROVIDER_ID] = {
      baseUrl: activeRelayMediaBaseUrl(),
      apiKey: input.relayKey,
      headers,
    };
  } else if (ownedImageConfig) {
    // JSON merge patch：省略键表示“保持原值”，只有 null 才会真的删除。
    // 因此卡片降权或能力探针失败时，必须显式清掉我们自己留下的入口；
    // 所有权判据同时核对 provider URL + model ref，不会碰用户自己的 openai。
    providers[OPENAI_IMAGE_PROVIDER_ID] = null;
  }

  if (videoWired) {
    providers[XAI_VIDEO_PROVIDER_ID] = {
      baseUrl: activeRelayMediaBaseUrl(),
      apiKey: input.relayKey,
      headers,
    };
  } else if (ownedVideoConfig) {
    providers[XAI_VIDEO_PROVIDER_ID] = null;
  }

  const patch: RelayConfigPatch = { models: { providers } };
  const search = (config?.tools as { web?: { search?: Record<string, unknown> } } | undefined)?.web?.search;
  // 我们写过的 provider：'rongying-search'（2026-10-12 起）或 'duckduckgo'（旧版遗留，
  // 视同自己的、允许被这次改写接管到新 provider）。
  const searchOwned = search?.provider === RELAY_SEARCH_PLUGIN_ID || search?.provider === 'duckduckgo';
  const userSearchConfigured =
    !searchOwned &&
    search !== undefined &&
    (search.enabled === false ||
      Object.keys(search).some((key) => !['enabled', 'maxResults', 'timeoutSeconds', 'cacheTtlMinutes'].includes(key)));
  const searchWired =
    input.bundledWebSearchAvailable === true &&
    !userSearchConfigured &&
    !isPluginExplicitlyDisabled(config, RELAY_SEARCH_PLUGIN_ID);
  const enableBundledSearch = searchWired && input.webSearch !== false;
  if (enableBundledSearch) {
    // provider 选择 + 插件条目（enabled + 连接配置一并写：插件目录由 state-config 落盘，
    // 这里只补"怎么连 relay"——baseUrl 用**激活期活体**的 relay 地址，apiKey 用活体 relay key。
    // ⚠️ 绝不从 gateway config 快照读 key（getConfig 对 apiKey 脱敏，见 relay-config 顶部红字教训）；
    //    这里写的就是 input.relayKey 本身，与服务端其余通道同一把。
    patch.tools = { web: { search: { enabled: true, provider: RELAY_SEARCH_PLUGIN_ID } } };
    patch.plugins = {
      entries: {
        [RELAY_SEARCH_PLUGIN_ID]: {
          enabled: true,
          config: { webSearch: { baseUrl: activeRelayBaseUrl(), apiKey: input.relayKey } },
        },
      },
    };
  } else if (searchWired && searchOwned && input.webSearch === false) {
    patch.tools = { web: { search: { enabled: false } } };
  }

  // `plugins.allow`：官方文档说「若配置里设了它，必须把 clawrouter 加进名单」。
  // ⚠️ **只在它本来就存在时补名** —— 凭空创建一份 allow 名单会把其他插件
  // 全挡在外面，那是灾难不是配置。
  const allow = (config?.plugins as { allow?: unknown } | undefined)?.allow;
  if (Array.isArray(allow)) {
    const names = allow.filter((x): x is string => typeof x === 'string');
    const required = [
      RELAY_PROVIDER_ID,
      ...(imageWired ? [OPENAI_IMAGE_PROVIDER_ID] : []),
      ...(videoWired ? [XAI_VIDEO_PROVIDER_ID] : []),
      ...(enableBundledSearch ? [RELAY_SEARCH_PLUGIN_ID] : []),
    ];
    patch.plugins = {
      ...(patch.plugins as Record<string, unknown> | undefined),
      allow: [...new Set([...names, ...required])],
    };
  }

  // 默认模型：**只在该字段未设置时写**。
  // 激活是「新增能力」，不该是「重设用户偏好」——用户已经选过的模型不动。
  const primary = (config?.agents as { defaults?: { model?: { primary?: unknown } } } | undefined)?.defaults?.model
    ?.primary;

  const agentsDefaults: Record<string, unknown> = { models: enableSearchModelEntries(input.webSearch !== false) };
  if (!primary && input.defaultModel) {
    agentsDefaults.model = { primary: input.defaultModel };
  }

  // ⭐ 图片模型：**只在"没有"或"本来就是我们的"时写**。
  //
  // ⚠️ 为什么不无条件写：网上那台运行时自带一次 doctor 迁移，会把旧的 nano-banana 技能
  //    搬到 `agents.defaults.mediaModels.image.primary = google/gemini-3-pro-image-preview`。
  //    无条件覆盖 = 把用户手上**本来能用**的图像能力换成我们的内测能力，
  //    而且是在他没同意的情况下。这与"不重设用户的模型偏好"是同一条规矩。
  const imagePrimary = (
    config?.agents as { defaults?: { mediaModels?: { image?: { primary?: unknown } } } } | undefined
  )?.defaults?.mediaModels?.image?.primary;
  const mediaModels: Record<string, { primary: string | null }> = {};
  if (imageWired && (imagePrimary === undefined || ownedImageConfig)) {
    mediaModels.image = { primary: OPENAI_IMAGE_MODEL_REF };
  } else if (!imageWired && ownedImageConfig) {
    mediaModels.image = { primary: null };
  }
  if (videoWired) {
    mediaModels.video = { primary: XAI_VIDEO_MODEL_REF };
  } else if (ownedVideoConfig) {
    mediaModels.video = { primary: null };
  }
  if (Object.keys(mediaModels).length > 0) {
    agentsDefaults.mediaModels = mediaModels;
  }

  patch.agents = { defaults: agentsDefaults };

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
/** 这个模型 ref 是不是指向我们这个 relay（provider 段落在 `providerIds` 里，或就叫 clawrouter）。 */
function pointsAtRelay(modelRef: string, providerIds: Set<string>): boolean {
  const providerName = modelRef.split('/', 1)[0];
  return providerIds.has(providerName) || providerName === RELAY_PROVIDER_ID;
}

/**
 * 「可以删」的 relay provider 名集合 —— 本文件删除判据的**唯一源**。
 *
 * `openai` / `xai` 是运行时的公共 provider 名，不能只凭 baseUrl 删除；必须同时
 * 命中我们写入的 media model ref，避免清掉用户自己配置的同名 provider。
 */
function removableRelayProviderIds(configSnapshot: unknown): Set<string> {
  const providerIds = relayProviderIds(configSnapshot);
  if (providerIds.has(OPENAI_IMAGE_PROVIDER_ID) && !ownsOpenAIImageConfig(configSnapshot)) {
    providerIds.delete(OPENAI_IMAGE_PROVIDER_ID);
  }
  if (providerIds.has(XAI_VIDEO_PROVIDER_ID) && !ownsXaiVideoConfig(configSnapshot)) {
    providerIds.delete(XAI_VIDEO_PROVIDER_ID);
  }
  return providerIds;
}

export function buildRelayRemovalPatch(configSnapshot: unknown): RelayRemovalPatch | null {
  const config = configOf(configSnapshot);
  if (!config) return null;

  const providerIds = removableRelayProviderIds(configSnapshot);
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

  /**
   * `agents.defaults` 底下**所有**指向我们这个 relay 的模型 ref 都要清掉。
   *
   * ⚠️ 少了图片那一条的后果很具体：注销（或换卡）之后 `models.providers.openai`
   *    被清掉了，而 `mediaModels.image.primary` 还指着 `openai/qwen-image-1` ——
   *    网关会去找一个**已经不存在**的 provider。轻则图片能力报一个看不懂的错，
   *    重则整份配置被判非法（本仓栽过一次：写进一个 schema 不认的值会让配置整体失效）。
   */
  const agentDefaultsForRemoval = (config.agents as { defaults?: Record<string, unknown> } | undefined)?.defaults;
  const agentsRemoval: Record<string, unknown> = {};

  const primary = (agentDefaultsForRemoval?.model as { primary?: unknown } | undefined)?.primary;
  if (typeof primary === 'string' && pointsAtRelay(primary, providerIds)) {
    agentsRemoval.model = { primary: null };
  }

  // ⚠️ 判据与写入侧**同一个函数**（`ownsOpenAIImageConfig`）：两条都成立才清。
  //    用"前缀是 `openai/`"或"指向 relay"这类放宽的判据，会把**用户自己**的图片模型一起清掉。
  const removedMediaModels: Record<string, { primary: null }> = {};
  if (ownsOpenAIImageConfig(configSnapshot)) {
    removedMediaModels.image = { primary: null };
  }
  if (ownsXaiVideoConfig(configSnapshot)) {
    removedMediaModels.video = { primary: null };
  }
  if (Object.keys(removedMediaModels).length > 0) {
    agentsRemoval.mediaModels = removedMediaModels;
  }

  if (agentsRemoval.mediaModels) {
    // 与 `models.providers.<id>` 同款：把被删子树里的数组路径全部报备，
    // 否则网关会以"破坏性补丁"为由**拒掉整条 patch**（不是拒这一段）。
    const image = (agentDefaultsForRemoval?.mediaModels as { image?: unknown } | undefined)?.image;
    replacePaths.push(...collectBaseArrayPaths(image, 'agents.defaults.mediaModels.image'));
    const video = (agentDefaultsForRemoval?.mediaModels as { video?: unknown } | undefined)?.video;
    replacePaths.push(...collectBaseArrayPaths(video, 'agents.defaults.mediaModels.video'));
  }

  if (Object.keys(agentsRemoval).length > 0) {
    patch.agents = { defaults: agentsRemoval };
  }

  return Object.keys(patch).length > 0 ? { patch, replacePaths } : null;
}

/**
 * 构造**分段收缩**补丁：把 relay provider 里的大数组按**条数减半**。
 *
 * ⚠️ 为什么需要它（2026-10-14 实机，BUG-080）：
 *    网关（openclaw 2026.9.3 `dist/config-path-mutation-*.mjs`）有一个 `size-drop`
 *    写守卫 —— 新配置字节数 < 旧配置的一半（且旧配置 ≥512B）就**整条拒写**并留档
 *    `.rejected`。而我们的清账补丁要删的 `models.providers.clawrouter`（内含
 *    **模型目录静态快照**）在我们的配置里恰好体积过半：实测 20901B → 8542B（40.9%），
 *    于是"正确的清理"被守卫当成"疑似误删整份配置"拦下，且拒绝是**确定性**的
 *    （重试一万次也一样）—— 用户表现为登录后永远卡在"服务准备"。
 *
 * 解法：删之前先把大数组**减半**（16 条 → 8 条），让每一次写入的缩减都远小于 50%；
 * 循环几轮后整棵 provider 的删除自然落进守卫阈值内（实测 1 轮减半 + 1 轮删除即过）。
 * 数组用前缀保留 + 在 `replacePaths` 声明该路径（replace 语义，而不是按 id 合并），
 * 与 `buildRelayRemovalPatch` 的数组路径纪律逐字同源。
 *
 * 返回 null = 没有可收缩的大数组（调用方应就此放弃，保持 fail-closed）。
 */
export function buildRelayRemovalShrinkPatch(configSnapshot: unknown): RelayRemovalPatch | null {
  const config = configOf(configSnapshot);
  if (!config) return null;

  const providerIds = removableRelayProviderIds(configSnapshot);
  if (providerIds.size === 0) return null;
  const providers = (config.models as { providers?: unknown } | undefined)?.providers;
  if (!providers || typeof providers !== 'object') return null;

  const shrunkProviders: Record<string, unknown> = {};
  const replacePaths: string[] = [];
  for (const id of providerIds) {
    const models = ((providers as Record<string, unknown>)[id] as { models?: unknown } | null)?.models;
    if (!Array.isArray(models) || models.length === 0) continue;
    const kept = models.slice(0, Math.floor(models.length / 2));
    shrunkProviders[id] = { models: kept.length > 0 ? kept : null };
    // 声明 replacePaths：数组按整段替换（否则 id 键数组会按 id 合并、收缩无效），
    // 同时也满足网关对"会丢 base 条目的数组补丁"的报备要求。
    replacePaths.push(`models.providers.${id}.models`);
  }
  if (Object.keys(shrunkProviders).length === 0) return null;

  return { patch: { models: { providers: shrunkProviders } }, replacePaths };
}

/** 取 catalog 的超时。catalog 是纯内存查询，正常在百毫秒级。 */
const CATALOG_TIMEOUT_MS = 8_000;

/**
 * 内核思考档位词表：relay 目录的 effort 词 → 内核 level 词。
 *
 * **逐字对齐内核的 `CLAWROUTER_REASONING_EFFORT_LEVELS`**
 * （`dist/provider-catalog-Cdx84e9y.mjs`，随包运行时同文件）——relay 用 `none`、
 * 内核用 `off`，其余同名。改这里之前先对内核源；有专项测试钉住映射。
 */
const RELAY_EFFORT_TO_THINKING_LEVEL: ReadonlyArray<readonly [effort: string, level: string]> = [
  ['none', 'off'],
  ['minimal', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['max', 'max'],
];

/** 写进 `models.providers.clawrouter.models[]` 的静态模型条目（JSON 形状）。 */
export interface RelayCatalogModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input?: Array<'text' | 'image'>;
  compat?: { supportsReasoningEffort: true; supportedReasoningEfforts: string[] };
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
  maxTokens?: number;
}

function readEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const advertised = new Set(value.filter((entry): entry is string => typeof entry === 'string'));
  // 按内核词表顺序输出（内核 `normalizeClawRouterReasoningEfforts` 同规则），
  // 未知词不传（内核也会自行过滤，这里双保险）。
  return RELAY_EFFORT_TO_THINKING_LEVEL.filter(([effort]) => advertised.has(effort)).map(([effort]) => effort);
}

function buildThinkingLevelMap(efforts: readonly string[]): Record<string, string | null> {
  const supported = new Set(efforts);
  const map: Record<string, string | null> = {};
  // 与内核 `buildThinkingLevelMap` 逐字同构：**每个** level 都写键，不支持 = null。
  for (const [effort, level] of RELAY_EFFORT_TO_THINKING_LEVEL) map[level] = supported.has(effort) ? effort : null;
  return map;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * relay 目录（`/v1/catalog` 的响应体）→ **内核静态模型条目**。
 *
 * ## 为什么要有这批静态条目（2026-10-12 修复：思考档位接线）
 *
 * 内核对 clawrouter 模型的**思考档位**只认模型条目的 `compat.supportedReasoningEfforts`
 * （内核 `dist/extensions/clawrouter/index.js` 的 `resolveClawRouterThinkingProfile`），
 * 缺失 ⇒ 回落基础五档 `off|minimal|low|medium|high`。真机后果（2026-10-11）：
 * deep 档 = `thinkingLevel:"max"` 被 `sessions.patch` 每发必拒
 * （「不支持「最高」档思考」上屏、任务实际停在 high）——目录里 glm-5.3-flash 明明
 * 声明了 `["low","high","max"]`，只是**没有任何路径把它传导进内核**。
 *
 * 把目录声明**静态写进网关配置**是内核官方支持的通道（`openai` 扩展的模型条目
 * 同形；`capability model inspect` 实测静态条目带全 compat 进 catalog）。
 * 字段形状与内核动态发现产物（`buildRoutedModel`）对齐：efforts 非空才写
 * compat + thinkingLevelMap + reasoning=true。
 *
 * ⚠️ 写的是**目录原样快照**：JSON merge patch 里数组 = 全量替换，每次写入
 * 即刷新（目录下架模型 ⇒ 列表随之移除）。
 */
export function relayCatalogModelEntries(catalog: unknown): RelayCatalogModelEntry[] {
  const providers = (catalog as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(providers)) return [];

  const entries: RelayCatalogModelEntry[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    const models = (provider as { models?: unknown } | null)?.models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const row = model as {
        id?: unknown;
        displayName?: unknown;
        capabilities?: unknown;
        supportedReasoningEfforts?: unknown;
        pricing?: { maxInputTokens?: unknown; defaultMaxOutputTokens?: unknown } | null;
      } | null;
      const id = typeof row?.id === 'string' ? row.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const displayName = typeof row?.displayName === 'string' && row.displayName.trim() ? row.displayName.trim() : id;
      const efforts = readEfforts(row?.supportedReasoningEfforts);
      const contextWindow = asPositiveInt(row?.pricing?.maxInputTokens);
      const maxTokens = asPositiveInt(row?.pricing?.defaultMaxOutputTokens);
      entries.push({
        id,
        name: displayName,
        reasoning: efforts.length > 0,
        // 显式覆盖静态缺省text；只信目录声明，不按模型名字猜视觉能力。
        input:
          Array.isArray(row?.capabilities) && row.capabilities.includes('llm.vision') ? ['text', 'image'] : ['text'],
        ...(efforts.length > 0
          ? {
              compat: { supportsReasoningEffort: true as const, supportedReasoningEfforts: efforts },
              thinkingLevelMap: buildThinkingLevelMap(efforts),
            }
          : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
      });
    }
  }
  return entries;
}

/**
 * 拉取可信目录；网络/结构失败返回null保留旧快照，成功空目录返回[]撤销旧声明。
 */
export async function fetchRelayCatalogModelEntries(relayKey: string): Promise<RelayCatalogModelEntry[] | null> {
  const res = await fetch(`${normalizeBaseUrl(activeRelayBaseUrl())}/v1/catalog`, {
    headers: { Authorization: `Bearer ${relayKey}` },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const catalog: unknown = await res.json();
  if (!Array.isArray((catalog as { providers?: unknown } | null)?.providers)) return null;
  return relayCatalogModelEntries(catalog);
}

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
  const res = await fetch(`${normalizeBaseUrl(activeRelayBaseUrl())}/v1/catalog`, {
    headers: { Authorization: `Bearer ${relayKey}` },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as {
    providers?: Array<{ models?: Array<{ id?: unknown }> }>;
  };
  const models = (body.providers ?? []).flatMap((provider) =>
    (provider.models ?? []).filter((m): m is { id: string } => typeof m.id === 'string' && m.id.length > 0),
  );

  // ⚠️ **优先**取商业默认模型，而不是目录第一条：这个值会写进网关的
  //    `agents.defaults.model.primary`，而 composer 显示的也是商业默认 ——
  //    两处取不同的模型，用户看到的和实际生成消息的就会对不上（2026-09-17 实机）。
  //    目录里没有它时才退回第一条，免得整个默认都不写。
  const model = models.find((m) => m.id.split('/').at(-1) === COMMERCIAL_DEFAULT_MODEL_ID) ?? models[0];
  if (!model) return null;

  return `${RELAY_PROVIDER_ID}/${String(model.id)}`;
}

export interface RelayMediaCapabilities {
  image: boolean;
  video: boolean;
}

/**
 * 逐卡查询 relay 当前**真实可用**的媒体能力。网络、HTTP 或结构异常全部抛给
 * `applyRelayConfig` 收成 fail-closed 告警；绝不因为探针失败而猜成可用。
 */
export async function fetchRelayMediaCapabilities(relayKey: string): Promise<RelayMediaCapabilities> {
  const res = await fetch(`${normalizeBaseUrl(activeRelayBaseUrl())}/v1/capabilities`, {
    headers: { Authorization: `Bearer ${relayKey}` },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`relay media capabilities returned ${res.status}`);

  const body = (await res.json()) as {
    image?: { enabled?: unknown };
    video?: { enabled?: unknown };
  };
  if (typeof body?.image?.enabled !== 'boolean' || typeof body?.video?.enabled !== 'boolean') {
    throw new Error('invalid media capabilities response');
  }
  return { image: body.image.enabled, video: body.video.enabled };
}

export interface ApplyRelayConfigDeps {
  /** 读网关配置快照（`gateway-client.getConfig()`）。**会抛**，不返回 IpcResult。 */
  getConfig: () => Promise<unknown>;
  /** 写网关配置（`gateway-client.patchConfig()`）。**会抛**，不返回 IpcResult。 */
  patchConfig: (params: { baseHash: string; raw: string; replacePaths?: string[] }) => Promise<unknown>;
  /** 解析一个可用的中转模型 ref；拿不到返回 null（不阻塞主流程）。 */
  resolveDefaultModel?: (relayKey: string) => Promise<string | null>;
  /** 拉 relay 目录映射成静态模型条目；拿不到返回 null（不阻塞主流程）。 */
  resolveCatalogModels?: (relayKey: string) => Promise<RelayCatalogModelEntry[] | null>;
  /** relay 的逐卡媒体能力探针；缺省或失败一律按两项关闭。 */
  resolveMediaCapabilities?: (relayKey: string) => Promise<RelayMediaCapabilities>;
  /** 日志。**不要传含 relay key 的数据进来**。 */
  log?: (event: string, data: Record<string, unknown>) => void;
}

export type ApplyRelayErrorCode = 'no-key' | 'transport' | 'rejected' | 'hash-conflict' | 'verify-failed';

export interface ApplyRelayResult {
  ok: boolean;
  /** 配置是否**真的写进去了**（回读校验通过）。只看 patchConfig 的返回不够。 */
  configured: boolean;
  media?: RelayMediaReadiness;
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
  // OpenClaw 2026.9.3 的真网关不一定带 `hash` 这个词：冷启时预置
  // 助手与中转配置并发写，它返回的是后半句。把它当 schema 拒绝会让
  // 模型永久留在“正在准备”，而提示本身已明确要求重读 `config.get`。
  if (/hash|config changed since last load|re-run config\.get and retry/i.test(text)) return 'hash-conflict';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|not connected|timeout/i.test(text)) {
    return 'transport';
  }
  return 'rejected';
}

/**
 * 是不是网关的 `size-drop` 写守卫拒绝（2026-10-14，BUG-080）。
 *
 * 消息形状由网关固定：`Config write rejected: <path> (size-drop:<old>-><new>). …`
 * （`code=CONFIG_WRITE_REJECTED`）。它**不是普通的 rejected** —— 补丁本身合法、
 * 只是"一次删太多"，分段收缩后可以过。普通 rejected 仍在上面直接返回。
 */
function isConfigSizeDropRejection(error: unknown): boolean {
  return /\(size-drop:\d+->\d+\)/.test(messageOf(error));
}

/** 分段收缩的轮数上限：按条数减半，8 轮足够把任何现实规模的数组收进守卫阈值。 */
const MAX_SIZE_DROP_SHRINKS = 8;

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

/**
 * 从网关移除商业中转凭证（清账）。
 *
 * 常规路径：读快照 → 构造最窄删除补丁 → 写 → 回读校验。两类可恢复失败会重试：
 *   · 乐观锁冲突（`hash-conflict`）→ 重读快照再来（原逻辑，预算 `MAX_HASH_RETRIES`）；
 *   · `size-drop` 守卫拒绝（2026-10-14，BUG-080）→ 先把 relay provider 的大数组
 *     **按条数减半**再重试（`buildRelayRemovalShrinkPatch`），几轮后整棵删除即过。
 * 其余失败（含"收缩也救不了"的 size-drop）保持 fail-closed，返回 `rejected`。
 */
export async function removeRelayConfig(deps: RemoveRelayConfigDeps): Promise<RemoveRelayResult> {
  const log = deps.log ?? ((): void => {});
  let hashConflictsUsed = 0;
  let shrinksUsed = 0;

  // 轮数上限 = 乐观锁重试预算 + 收缩预算；两个分支都各自设限（见下），这里只是防呆。
  for (let attempt = 1; attempt <= MAX_HASH_RETRIES + MAX_SIZE_DROP_SHRINKS; attempt += 1) {
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

      if (kind === 'hash-conflict') {
        hashConflictsUsed += 1;
        if (hashConflictsUsed < MAX_HASH_RETRIES) continue;
        return { ok: false, cleaned: false, errorCode: 'hash-conflict', error: messageOf(error) };
      }

      // ⭐ 2026-10-14（BUG-080）：`size-drop` 守卫拒绝（一次删太多）不是死路 ——
      //    先把 relay provider 里的大数组减半再重试；被拒的写没落盘，快照 hash 仍然有效。
      if (isConfigSizeDropRejection(error) && shrinksUsed < MAX_SIZE_DROP_SHRINKS) {
        const shrink = buildRelayRemovalShrinkPatch(snapshot);
        if (shrink) {
          try {
            await deps.patchConfig({
              baseHash,
              raw: JSON.stringify(shrink.patch),
              replacePaths: shrink.replacePaths,
            });
          } catch (shrinkError) {
            const shrinkKind = classifyWriteError(shrinkError);
            log('relay.config-remove-shrink-failed', {
              attempt,
              kind: shrinkKind,
              message: messageOf(shrinkError),
            });
            if (shrinkKind === 'hash-conflict') {
              hashConflictsUsed += 1;
              if (hashConflictsUsed < MAX_HASH_RETRIES) continue;
            }
            return { ok: false, cleaned: false, errorCode: shrinkKind, error: messageOf(shrinkError) };
          }
          shrinksUsed += 1;
          log('relay.config-remove-shrunk', { attempt, round: shrinksUsed });
          continue;
        }
      }

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
  if (normalizeBaseUrl(String(baseUrl ?? '')) !== normalizeBaseUrl(activeRelayBaseUrl())) return false;
  // 脱敏后仍然是**非空字符串**（真 key 或 `__OPENCLAW_REDACTED__` 都算有 key）；
  // 空串/缺失才说明这个 provider 没带上凭证。
  return typeof apiKey === 'string' && apiKey.length > 0;
}

function catalogPatchApplied(snapshot: unknown, patch: RelayConfigPatch): boolean {
  const expected = (patch.models as { providers?: Record<string, { models?: RelayCatalogModelEntry[] }> } | undefined)
    ?.providers?.[RELAY_PROVIDER_ID]?.models;
  if (!expected) return true;
  const actual = (configOf(snapshot)?.models as { providers?: Record<string, { models?: unknown }> } | undefined)
    ?.providers?.[RELAY_PROVIDER_ID]?.models;
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((entry) => {
    const current = actual.find(
      (value: unknown) => value && typeof value === 'object' && (value as { id?: unknown }).id === entry.id,
    ) as Partial<RelayCatalogModelEntry> | undefined;
    if (!current) return false;
    // 回读配置是最终模型覆盖的真源；models.list动态声明不能替代input。
    // 只核本次声明字段，允许runtime补缺省字段和重排对象/集合。
    const sameValues = (value: unknown, expectedValues: readonly string[]): boolean =>
      Array.isArray(value) &&
      value.length === expectedValues.length &&
      expectedValues.every((item) => value.includes(item));
    if (entry.input && !sameValues(current.input, entry.input)) return false;
    if (current.reasoning !== entry.reasoning) return false;
    if (
      entry.compat &&
      (current.compat?.supportsReasoningEffort !== true ||
        !sameValues(current.compat.supportedReasoningEfforts, entry.compat.supportedReasoningEfforts))
    )
      return false;
    if (
      entry.thinkingLevelMap &&
      !Object.entries(entry.thinkingLevelMap).every(([level, effort]) => current.thinkingLevelMap?.[level] === effort)
    )
      return false;
    return (
      (entry.contextWindow === undefined || current.contextWindow === entry.contextWindow) &&
      (entry.maxTokens === undefined || current.maxTokens === entry.maxTokens)
    );
  });
}

/**
 * 回读校验本次媒体补丁真的生效。
 *
 * 只检查本次明确写过的路径：没碰的第三方 provider / 用户模型不参与判断；
 * 写 null 的路径必须在回读里消失，避免“聊天中转成功”掩盖幽灵媒体入口。
 */
function mediaPatchApplied(snapshot: unknown, patch: RelayConfigPatch): boolean {
  const config = configOf(snapshot);
  if (!config) return false;

  const patchedProviders = (patch.models as { providers?: Record<string, unknown> } | undefined)?.providers;
  const currentProviders = (config.models as { providers?: Record<string, unknown> } | undefined)?.providers;
  const patchedMedia =
    (patch.agents as { defaults?: { mediaModels?: Record<string, { primary?: unknown }> } } | undefined)?.defaults
      ?.mediaModels ?? {};
  const currentMedia =
    (config.agents as { defaults?: { mediaModels?: Record<string, { primary?: unknown }> } } | undefined)?.defaults
      ?.mediaModels ?? {};

  const check = (input: { providerId: string; expectedBaseUrl: string; mediaKind: 'image' | 'video' }): boolean => {
    const providerTouched = Object.prototype.hasOwnProperty.call(patchedProviders ?? {}, input.providerId);
    if (providerTouched) {
      const expectedProvider = patchedProviders?.[input.providerId];
      const currentProvider = currentProviders?.[input.providerId];
      if (expectedProvider === null) {
        if (currentProvider !== undefined && currentProvider !== null) return false;
      } else {
        const baseUrl = (currentProvider as { baseUrl?: unknown } | null)?.baseUrl;
        if (typeof baseUrl !== 'string' || normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(input.expectedBaseUrl)) {
          return false;
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(patchedMedia, input.mediaKind)) {
      const expectedPrimary = patchedMedia[input.mediaKind]?.primary;
      const currentPrimary = currentMedia[input.mediaKind]?.primary;
      if (expectedPrimary === null) {
        if (currentPrimary !== undefined && currentPrimary !== null) return false;
      } else if (currentPrimary !== expectedPrimary) {
        return false;
      }
    }
    return true;
  };

  return (
    check({ providerId: OPENAI_IMAGE_PROVIDER_ID, expectedBaseUrl: activeRelayMediaBaseUrl(), mediaKind: 'image' }) &&
    check({ providerId: XAI_VIDEO_PROVIDER_ID, expectedBaseUrl: activeRelayMediaBaseUrl(), mediaKind: 'video' })
  );
}

function searchPatchApplied(snapshot: unknown, patch: RelayConfigPatch): boolean {
  const expected = (patch.tools as { web?: { search?: Record<string, unknown> } } | undefined)?.web?.search;
  if (!expected) return true;
  const config = configOf(snapshot);
  const actual = (config?.tools as { web?: { search?: Record<string, unknown> } } | undefined)?.web?.search;
  if (!Object.entries(expected).every(([key, value]) => actual?.[key] === value)) return false;
  if (expected.enabled !== true) return true;
  const plugins = config?.plugins as { entries?: Record<string, { enabled?: unknown }>; allow?: string[] } | undefined;
  return (
    plugins?.entries?.[RELAY_SEARCH_PLUGIN_ID]?.enabled === true &&
    (!Array.isArray(plugins.allow) || plugins.allow.includes(RELAY_SEARCH_PLUGIN_ID))
  );
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
  input: {
    relayKey: string | null | undefined;
    deviceFingerprint: string;
    webSearch?: boolean;
    bundledWebSearchAvailable?: boolean;
  },
): Promise<ApplyRelayResult> {
  const warnings: string[] = [];
  const log = deps.log ?? ((): void => {});

  // 活体 key 的内存持有者（2026-10-12 视频接入）：这里是**唯一**拿到明文 key 的漏斗
  // （激活与每轮启动 bootstrap 都走它）——网关的 `config.get` 对 apiKey 脱敏，
  // 消息期的直呼 relay（视频）只能从这里取。null 即清除（见 relay-key.ts）。
  setActiveRelayKey(input.relayKey);

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

  let catalogModels: RelayCatalogModelEntry[] | null = null;
  if (deps.resolveCatalogModels) {
    try {
      catalogModels = await deps.resolveCatalogModels(input.relayKey);
    } catch (error) {
      // 目录拉不到只是「静态模型条目不写」（旧快照保留 / 动态发现兜底），不该拖垮写入。
      warnings.push('resolve-catalog-models-failed');
      log('relay.catalog-models-resolve-failed', { message: messageOf(error) });
    }
  }

  let mediaCapabilities: RelayMediaCapabilities = { image: false, video: false };
  let mediaProbeStatus: 'unknown' | 'resolved' | 'probe-failed' = 'unknown';
  if (deps.resolveMediaCapabilities) {
    try {
      const capabilities = await deps.resolveMediaCapabilities(input.relayKey);
      if (typeof capabilities?.image !== 'boolean' || typeof capabilities?.video !== 'boolean') {
        throw new Error('invalid media capabilities response');
      }
      mediaCapabilities = capabilities;
      mediaProbeStatus = 'resolved';
    } catch (error) {
      mediaProbeStatus = 'probe-failed';
      warnings.push('resolve-media-capabilities-failed');
      log('relay.media-capabilities-resolve-failed', { message: messageOf(error) });
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

    // ⭐ 联网开关由**调用方**传（不在这个函数里读全局配置）：读全局会让它没法单测，
    //    而它的测试恰恰是"写没写进去"这件事的主要防线。
    const patch = buildRelayPatch({
      ...input,
      existingConfig: snapshot,
      defaultModel,
      catalogModels,
      imageGenerationWired: mediaCapabilities.image,
      videoGenerationWired: mediaCapabilities.video,
    });
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
    let appliedSnapshot: unknown;
    try {
      appliedSnapshot = await deps.getConfig();
      verified =
        providerApplied(appliedSnapshot) &&
        catalogPatchApplied(appliedSnapshot, patch) &&
        mediaPatchApplied(appliedSnapshot, patch) &&
        searchPatchApplied(appliedSnapshot, patch);
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
    const patchedMedia = (
      patch.agents as { defaults?: { mediaModels?: Record<string, { primary?: unknown }> } } | undefined
    )?.defaults?.mediaModels;
    const appliedConfig = configOf(appliedSnapshot);
    const appliedProviders = (appliedConfig?.models as { providers?: Record<string, { apiKey?: unknown }> } | undefined)
      ?.providers;
    const allow = (appliedConfig?.plugins as { allow?: unknown } | undefined)?.allow;
    const mediaState = (
      kind: 'image' | 'video',
      providerId: string,
      modelRef: string,
    ): RelayMediaReadiness['image'] => {
      if (mediaProbeStatus !== 'resolved') return mediaProbeStatus;
      const apiKey = appliedProviders?.[providerId]?.apiKey;
      return mediaCapabilities[kind] &&
        patchedMedia?.[kind]?.primary === modelRef &&
        typeof apiKey === 'string' &&
        apiKey.trim().length > 0 &&
        !isPluginExplicitlyDisabled(appliedConfig, providerId) &&
        (!Array.isArray(allow) || allow.includes(providerId))
        ? 'ready'
        : 'unavailable';
    };
    const media: RelayMediaReadiness = {
      image: mediaState('image', OPENAI_IMAGE_PROVIDER_ID, OPENAI_IMAGE_MODEL_REF),
      video: mediaState('video', XAI_VIDEO_PROVIDER_ID, XAI_VIDEO_MODEL_REF),
    };
    return { ok: true, configured: true, media, warnings };
  }

  return {
    ok: false,
    configured: false,
    errorCode: 'hash-conflict',
    error: 'config patch kept conflicting',
    warnings,
  };
}
