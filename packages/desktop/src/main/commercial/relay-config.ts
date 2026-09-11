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

  const providers = (configSnapshot as { config?: { models?: { providers?: unknown } } } | null)?.config
    ?.models?.providers;
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
