import { COMMERCIAL_DEFAULT_MODEL_ID } from '@clawwork/shared';

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
 * 图片那条的 baseUrl：**要带 `/v1`**。
 *
 * OpenAI 形状的客户端会自己在后面接 `/images/generations`，所以给到 `/relay/v1`
 * 才拼得出 `/relay/v1/images/generations`（nginx 再把 `/relay` 剥掉转给 relay）。
 * 少一段的表现是请求打到 `/relay/images/generations` —— 404，而且不解释。
 */
export const RELAY_IMAGE_BASE_URL = `${RELAY_BASE_URL}/v1`;

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
  return typeof baseUrl === 'string' && normalizeBaseUrl(baseUrl) === normalizeBaseUrl(RELAY_IMAGE_BASE_URL);
}

export interface RelayPatchInput {
  relayKey: string | null | undefined;
  deviceFingerprint: string;
  /** 现有网关配置快照（`getConfig()` 的返回，真正的配置在 `.config`）。 */
  existingConfig?: unknown;
  /** 解析出来的默认模型 ref；仅当 `agents.defaults.model.primary` 未设置时才用。 */
  defaultModel?: string | null;
  /**
   * 联网搜索开关（用户在设置里能改）。
   *
   * ⚠️ 缺省 = **开**（见 `webSearchEnabled`）：这个功能本来就存在，
   *    默认改关等于升级一次就静默拿走一个能力。
   */
  webSearch?: boolean;
  /**
   * 图片能力是否接线。**缺省 = 关**（见 `IMAGE_GENERATION_WIRED`）。
   *
   * 做成显式入参而不是直接用常量，是为了让测试能真的把两条路都走一遍 ——
   * 而"默认关"这条行为本身由常量兜底。
   */
  imageGenerationWired?: boolean;
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
 */
const ENABLE_SEARCH_MODEL_IDS = ['qwen-turbo', 'qwen-plus'] as const;

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
): Record<string, { params: { extra_body: { enable_search: true } } }> {
  // ⭐ 关掉时返回**空表**（而不是"写一个 false"）：百炼那边认的是"有没有这个参数"，
  //    写 `enable_search: false` 是另一回事（它会照 false 处理，但少写更干净、也少一个出错面）。
  if (!enabled) return {};
  return Object.fromEntries(
    ENABLE_SEARCH_MODEL_IDS.map((id) => [
      `${RELAY_PROVIDER_ID}/${id}`,
      { params: { extra_body: { enable_search: true } } },
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
    return ownsOpenAIImageConfig(input.existingConfig);
  })();
  const wired = (input.imageGenerationWired ?? IMAGE_GENERATION_WIRED) && acceptsOurImageConfig;

  const providers: Record<string, unknown> = {
    [RELAY_PROVIDER_ID]: {
      baseUrl: RELAY_BASE_URL,
      apiKey: input.relayKey,
      headers,
    },
  };

  // 图片：**默认不写**（见 `IMAGE_GENERATION_WIRED`）。只在允许时补这一条 ——
  // 同一个 relay key、同一个设备头，只是形状是 OpenAI 那条。
  if (wired) {
    providers[OPENAI_IMAGE_PROVIDER_ID] = {
      baseUrl: RELAY_IMAGE_BASE_URL,
      apiKey: input.relayKey,
      headers,
    };
  }

  const patch: RelayConfigPatch = { models: { providers } };

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
  if (wired && (imagePrimary === undefined || ownsOpenAIImageConfig(input.existingConfig))) {
    agentsDefaults.mediaModels = { image: { primary: OPENAI_IMAGE_MODEL_REF } };
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
  if (ownsOpenAIImageConfig(configSnapshot)) {
    agentsRemoval.mediaModels = { image: { primary: null } };
  }

  if (agentsRemoval.mediaModels) {
    // 与 `models.providers.<id>` 同款：把被删子树里的数组路径全部报备，
    // 否则网关会以"破坏性补丁"为由**拒掉整条 patch**（不是拒这一段）。
    const image = (agentDefaultsForRemoval?.mediaModels as { image?: unknown } | undefined)?.image;
    replacePaths.push(...collectBaseArrayPaths(image, 'agents.defaults.mediaModels.image'));
  }

  if (Object.keys(agentsRemoval).length > 0) {
    patch.agents = { defaults: agentsRemoval };
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
  // OpenClaw 2026.9.3 的真网关不一定带 `hash` 这个词：冷启时预置
  // 助手与中转配置并发写，它返回的是后半句。把它当 schema 拒绝会让
  // 模型永久留在“正在准备”，而提示本身已明确要求重读 `config.get`。
  if (/hash|config changed since last load|re-run config\.get and retry/i.test(text)) return 'hash-conflict';
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
  input: { relayKey: string | null | undefined; deviceFingerprint: string; webSearch?: boolean },
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

    // ⭐ 联网开关由**调用方**传（不在这个函数里读全局配置）：读全局会让它没法单测，
    //    而它的测试恰恰是"写没写进去"这件事的主要防线。
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
