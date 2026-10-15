import { modelIdMatches, type ModelCatalogEntry } from '@clawwork/shared';
import { RELAY_PROVIDER_ID } from '@/components/ChatInput/model-families';
import type { ImageInputSupport } from './attachment-actions';

/**
 * 所有发送模式共用的视觉门禁。只信目录input，不按模型名猜能力。
 * 自动模式可切换一次视觉候选；custom和专用制作链保留显式模型。
 * 不可确认图片支持、无候选或切换失败时，调用方保留草稿并阻止发送。
 */

/**
 * 偏好顺序（官方页核证过声明了视觉能力的两个模型，2026-10-07 relay 侧点亮）：
 *   · `qwen3.7-flash`：百炼官方页「多模态基础能力、万物识别」「视觉语言系列 Flash 模型」；
 *   · `qwen3.5-27b`：百炼官方页「视觉语言 Dense 模型」。
 *
 * 顺序即优先级：Flash 在前（快且便宜，看图这种"过一次就够"的活不需要重模型）。
 * 目录里两个都没有时，退而取**任意**声明了 image 的中转模型（目录顺序即厂商顺序）。
 */
export const VISION_FALLBACK_PREFERRED_ORDER: readonly string[] = ['qwen3.7-flash', 'qwen3.5-27b'];

/** 目录条目是否自述支持图片输入（`input` 含 `'image'`；形状不对 = 没有声明）。 */
function declaresImageInput(entry: ModelCatalogEntry): boolean {
  const input = entry.input;
  if (!Array.isArray(input)) return false;
  return input.some((value) => typeof value === 'string' && value === 'image');
}

/** 发送前以config.get静态覆盖校正models.list；旧缺input按runtime缺省text处理。 */
export function visionCatalogWithConfiguredInputs(
  catalog: readonly ModelCatalogEntry[],
  snapshot: unknown,
): ModelCatalogEntry[] | null {
  const provider = (snapshot as { config?: { models?: { providers?: Record<string, { models?: unknown }> } } } | null)
    ?.config?.models?.providers?.[RELAY_PROVIDER_ID];
  if (!provider) return null;
  const configured = provider.models;
  if (configured !== undefined && !Array.isArray(configured)) return null;
  return catalog.map((entry) => {
    if (entry.provider !== RELAY_PROVIDER_ID) return entry;
    const row = Array.isArray(configured)
      ? (configured.find((value: unknown) => {
          const id = value && typeof value === 'object' ? (value as { id?: unknown }).id : undefined;
          return typeof id === 'string' && modelIdMatches(id, entry.id);
        }) as { input?: unknown } | undefined)
      : undefined;
    if (!row) return entry;
    const input = Array.isArray(row.input)
      ? row.input.filter((value): value is string => typeof value === 'string')
      : ['text'];
    return { ...entry, input };
  });
}

/**
 * 在目录里挑一个"能看图的备选模型"；找不到返回 `null`（调用方阻止带图发送）。
 *
 * 规则（顺序即优先级）：
 *   1. 只认 `provider === 'clawrouter'` 的条目（网关全量目录里其它 provider 我们服务不了，
 *      选了就是"请求根本发不出去"—— 与 `relayModelsFrom` 同一把尺）；
 *   2. `input` 必须含 `'image'`（自述声明，见文件头）；
 *   3. 先按 `preferredOrder` 找；都没命中再取**第一个**声明了 image 的条目；
 *   4. 一个都没有 ⇒ `null`。
 *
 * 纯函数（无 React、无 IPC）：判据错了用户就会白发一轮，所以要能单独钉住。
 */
export function selectVisionFallbackModel(
  catalog: readonly ModelCatalogEntry[],
  preferredOrder: readonly string[] = VISION_FALLBACK_PREFERRED_ORDER,
): ModelCatalogEntry | null {
  const visionCapable = catalog.filter((entry) => entry.provider === RELAY_PROVIDER_ID && declaresImageInput(entry));
  if (visionCapable.length === 0) return null;

  for (const id of preferredOrder) {
    const preferred = visionCapable.find((entry) => entry.id === id);
    if (preferred) return preferred;
  }
  return visionCapable[0] ?? null;
}

/** skip=无图或已支持；switch=切换成功后发送；unavailable=提示调整模型/附件并阻止发送。 */
export type VisionRoutingPlan =
  | { kind: 'skip' }
  | { kind: 'switch'; model: ModelCatalogEntry }
  | { kind: 'unavailable' };

export function planVisionRouting(params: {
  hasImageAttachment: boolean;
  imageInputSupport: ImageInputSupport;
  currentModelId?: string;
  catalog: readonly ModelCatalogEntry[];
  preferredOrder?: readonly string[];
  /** custom显式模型和专用制作链不允许被视觉备选劫持。 */
  allowFallback?: boolean;
}): VisionRoutingPlan {
  const { hasImageAttachment, imageInputSupport, currentModelId, catalog, preferredOrder } = params;
  if (!hasImageAttachment || imageInputSupport === 'supported') return { kind: 'skip' };
  if (params.allowFallback === false) return { kind: 'unavailable' };

  const fallback = selectVisionFallbackModel(catalog, preferredOrder ?? VISION_FALLBACK_PREFERRED_ORDER);
  if (!fallback) return { kind: 'unavailable' };
  // 同id声明冲突，不能用空切换绕过视觉门禁。
  if (fallback.id === currentModelId) return { kind: 'unavailable' };
  return { kind: 'switch', model: fallback };
}

/**
 * 搜索 / 打开网址的**路由事实**（注释化常量：供 Registry 与提示词引用，**本身不改行为**）。
 *
 * 两条事实各有唯一真源，这里只是给渲染层一个可引用的落点（测试把它们与真源钉在一起，
 * 写歪或真源变了没跟就会红）：
 *
 * 1. **搜索**（关键词联网搜索）= relay 侧「百炼内置 `enable_search`」，按模型注入
 *    `params.extra_body.enable_search`（形状必须是 `extra_body`，裸写会被静默丢弃）。
 *    白名单只有这三个模型 —— 对不支持的模型传这个参数，百炼是**直接报错**
 *    （`This model does not support enable_search.`），不是忽略。
 *    ⚠️ 快速档别名 `qwen3.7-flash-fast` **刻意不在**白名单里 = 快速档搜索硬关。
 *    真源：`src/main/commercial/relay-config.ts` 的 `ENABLE_SEARCH_MODEL_IDS`（改一处即可）。
 *    ⚠️ 代价：≈200× 输入 token；15 RPS 按阿里云主账号维度限流（超限**静默不搜**）；
 *    兼容模式拿不到来源角标 ⇒ **界面不许显示"已联网"**。
 *
 * 2. **打开网址读内容** = 运行时内置工具 **`browser`**（随包 runtime 工具注册表里存在；
 *    2026-10-07 语料审计：包内存在、0 调用）。它与 `web_search` / `web_fetch` 不是一回事：
 *    后两者是"搜索 / 抓取"（`web_fetch` 仍降级禁用；`web_search` 自 2026-10-12 起经
 *    博查 + relay 接线恢复，见 `main/runtime/relay-search-plugin.ts` 与
 *    `state-config.ts` 的 `WEB_TOOLS_DENIED`），`browser` 是"打开指定网址读内容"。
 */
export const WEB_ROUTING_FACTS = {
  search: {
    /** 白名单（模型 id 本体，不带 `clawrouter/` 前缀）—— 顺序照 relay-config 的真源表。 */
    modelIds: ['qwen-turbo', 'qwen-plus', 'qwen3.7-flash'],
    /** 注入形状：只有 `params.extra_body` 会被合并进真正发出去的 payload。 */
    injection: 'params.extra_body.enable_search',
    /** 主进程唯一真源（客户端**不要**在这里再维护第二份开关逻辑）。 */
    sourceOfTruth: 'packages/desktop/src/main/commercial/relay-config.ts',
  },
  urlRead: {
    /** 打开网址读内容的工具 id（运行时工具注册表里的名字）。 */
    toolId: 'browser',
  },
} as const;
