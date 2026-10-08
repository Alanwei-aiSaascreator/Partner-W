import type { ModelCatalogEntry } from '@clawwork/shared';
import { RELAY_PROVIDER_ID } from '@/components/ChatInput/model-families';
import type { ImageInputSupport } from './attachment-actions';

/**
 * Auto Capability Routing v1 —— 「带图发送时，自动换一个能看图的模型」。
 *
 * 语义（Lead 已裁决，v1 最小实现）：
 *   带图发送 × 当前会话模型**不自述**支持图片 ⇒ 先切到目录里声明了 `image` 的中转模型，再发送；
 *   找不到候选 ⇒ **维持现状**（照发，模型按附件纪律如实说看不到）。不拦截、不弹窗、无开关。
 *
 * 为什么判据是「目录声明」而不是「按模型名猜」：
 *   `input` 是网关 `models.list` 的自述字段（`['text']` / `['text','image']`），由随包 runtime
 *   补丁 `rongying-provider-capability-v1` 从 relay 目录的 `llm.vision` 声明投影而来 ——
 *   名字正则猜不出国产型号（BUG-027 调查结论），声明是唯一可信来源。
 *
 * ⚠️ **别把"没声明"当成"不支持"**：没声明只意味着"不知道"（`resolveImageInputSupport`
 *    返回 `unknown`）。路由的触发条件是 `!== 'supported'`（unsupported 与 unknown 都路由）——
 *    宁可白切一次，也不让用户的图片被静默丢弃。
 *
 * ⚠️ 已知取舍（v1）：切过去之后**不自动切回** —— 会话停在该模型，模型选择器可见。
 *    "自动切回"需要在每轮之间跟踪用户意图，v1 不做（宁可见，不可猜）。
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

/**
 * 在目录里挑一个"能看图的备选模型"；找不到返回 `null`（调用方维持现状，不许替代品）。
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

/**
 * 发送这一刻的**路由计划**（纯函数，v1.1 加固）——接线只负责照着做，不再自己判。
 *
 * | 计划 | 含义 | 调用方要做的 |
 * |---|---|---|
 * | `skip` | 不用管：没带图，或当前模型已自述能看图 | 原样发，不提示 |
 * | `switch` | 切到 `model` 再发 | `patchSession` + 一条轻提示（**切成功了才提示**） |
 * | `unavailable` | 带图，但目录里**一个能看图的候选都没有** | **给一条诚实文案再发（不许静默）** |
 *
 * 为什么 v1.1 要补 `unavailable`：v1 的"没候选就悄悄照发"在用户侧是**静默**的 ——
 * 图片被丢掉、模型只会困惑地说"我读不到"，而用户根本不知道是"没能力"还是"出错了"。
 * 照发仍然照发（不拦截是 v1 的既定取舍），但**用户有权先知道这一轮图片识别不了**。
 *
 * ⚠️ 判据与 v1 共用同一把尺：`imageInputSupport !== 'supported'`（`unsupported` 与 `unknown`
 *    都要路由）—— 没声明 ≠ 不支持，宁可白切一次，也不让图片被静默丢弃。
 * ⚠️ 会话/任务维度**没有**记忆：每次发送都拿"这个任务此刻的模型"重新判。
 *    新任务（待发态）没选过模型 ⇒ 起点是默认模型，**不继承**上一段会话切过去的那个
 *    （切换态只落在 `task.model` 与 `task.sessionKey` 上，两处都是任务作用域的）。
 */
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
}): VisionRoutingPlan {
  const { hasImageAttachment, imageInputSupport, currentModelId, catalog, preferredOrder } = params;
  if (!hasImageAttachment || imageInputSupport === 'supported') return { kind: 'skip' };

  const fallback = selectVisionFallbackModel(catalog, preferredOrder ?? VISION_FALLBACK_PREFERRED_ORDER);
  if (!fallback) return { kind: 'unavailable' };
  // 防御分支（脏目录里同 id 两条、第一条没报名看图时理论可达）：切到"同一个模型"是空动作，
  // 还会白弹一条"已切换"提示 —— 按 skip 处理。
  if (fallback.id === currentModelId) return { kind: 'skip' };
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
 *    后两者是"搜索 / 抓取"（`web_search` 已因 DuckDuckGo 反爬在用户网络不可用而降级禁用，
 *    见 `state-config.ts` 的 `WEB_TOOLS_DENIED`），`browser` 是"打开指定网址读内容"。
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
