/**
 * 模型列表的「只列能用的 + 按家族分组」。
 *
 * ## 为什么必须过滤
 *
 * 网关的 `models.list` 返回的是 **openclaw 的全量模型目录**（实测 44 个 provider、
 * 1018 个模型），里面绝大多数**我们服务不了** —— 没有对应的 provider 配置。
 * 用户在里面随便挑一个（比如 `deepseek-v4-pro` 之外的 `claude-opus-4`），
 * 得到的是一条失败消息，而且**请求根本没发出去**。
 *
 * 2026-09-11 实测：会话选了非中转模型后，网关日志是
 * `agent errorCode=UNAVAILABLE errorMessage=The selected model was not found by the provider`。
 *
 * ⇒ 只列中转服务真正提供的那些（网关侧它们的 provider 是 `clawrouter`）。
 *
 * ⚠️ 这是**按名字**筛。主进程那边的用量去重刻意用了「按 baseUrl 认」而不是按名字
 *（名字用户可改）。这里做不到 —— 渲染层拿不到网关配置。留作已知局限：
 * 将来若允许用户自定义 provider，这个筛法要跟着改。
 */
import { isModeAliasModelId, type ModelCatalogEntry } from '@clawwork/shared';

export const RELAY_PROVIDER_ID = 'clawrouter';

/**
 * ⭐ 「用户能选的模型」= **唯一一把尺**（2026-10-12 统一，用户真机反馈
 * "设置里的模型下拉还有残留"）。三层收敛：
 *
 *   ① `relayModelsFrom`：我们服务得了的（发送不会 404）——顺带挡掉
 *      内核内置示例模型（`GPT-6 Astra (openai)` 这类，我们没有 openai 渠道）；
 *   ② `available !== false`：目录当前标为不可用的不列；
 *   ③ `!isModeAliasModelId`：模式内部别名（`qwen3.7-flash-fast`）不是"某个可选模型"，
 *      出现在用户可点的清单里等于把实现细节摆上台面（与 ChatInput 高级列表同口径）。
 *
 * **任何给用户选模型的列表**（设置-智能体覆盖模型、建队、`/model` 补全、对比列）
 * 都走这里；读侧解析（展示历史消息的模型名、查 provider/档位）仍用 raw 目录，
 * 那是另一个问题（见 `model-display.ts` 顶部注释）。
 */
export function selectableModelsFrom(models: readonly ModelCatalogEntry[] | undefined | null): ModelCatalogEntry[] {
  return relayModelsFrom([...(models ?? [])]).filter(
    (model) => model.available !== false && !isModeAliasModelId(model.id),
  );
}

/**
 * 展示名净化（2026-10-12 用户口径：**供应链渠道名不上用户可见面**——用户看到
 * "Cephalon/端脑"会去找外部平台。平台计费 ID 在 `id` 里原样保留，只洗展示名）。
 *
 * 兜底层：源头（relay 目录）已改中性展示名；这里再防一手旧缓存/未来渠道字样——
 * 目录进 store 前统一净化，所有消费点（下拉/标签/系统消息）自动干净。
 */
const CHANNEL_TRACE_PATTERN = /\s*(?:[·|]\s*)?\(?\bCephalon\b\)?|端脑|\s*[-–—]\s*cephalon\b/gi;

export function sanitizeModelDisplayName(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(CHANNEL_TRACE_PATTERN, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** 目录入 store 前的净化：**只洗 name**（缺省时用净化后的 id 顶展示），id/provider 原样。 */
export function sanitizedCatalogModels(models: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  return models.map((model) => {
    const name = sanitizeModelDisplayName(model.name) ?? sanitizeModelDisplayName(model.id) ?? model.name;
    return name === model.name ? model : { ...model, name };
  });
}

/**
 * 只留下中转服务能提供的模型。
 *
 * **任何**用模型目录的地方都应该先过这一道 —— 下拉、当前模型标签、模型选择器……
 * 只在某一处过滤是个已犯过的错：下拉只列 clawrouter，但「当前模型」的标签
 * 仍从**全量**目录里解析，于是新任务（还没选模型）显示成
 * `Claude Opus 5 (Claude CLI)` —— 网关返回的第一条，一个我们用不了的模型。
 * 用户看到的是「默认模型是 Opus」，实际什么都没选。
 *
 * ⚠️ 过滤后可能变空（目录没拉到 / 网关只配了别的 provider）。
 * 调用方要按「空目录」处理，**不要**退回未过滤的全量目录。
 */
export function relayModelsFrom(models: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return models.filter((m) => m.provider === RELAY_PROVIDER_ID);
}

/**
 * 这个模型现在还能不能选来发消息？
 *
 * ## 为什么必须在**发送前**校验
 *
 * 模型会从目录里消失（下架、改价、上游调整），而**已有的任务还记着老模型名**。
 * 不在发送前拦，用户的体验是：
 *   能选中 → 点发送 → 报错
 * 错误还发生在「会话准备好了、消息发出去了」之后，看起来像网络问题。
 *
 * ⚠️ **不能只靠 `patchSession` 兜底** —— 2026-09-11 实测：选非中转模型时
 * `patchSession` 是**成功**的，失败发生在发送那一刻
 *（`renderer.agent.lifecycle.error: The selected model was not found by the provider`）。
 *
 * ## 三种情形，只有一种该拦
 *
 * | 情形 | 行为 | 为什么 |
 * |---|---|---|
 * | 目录为空 | **放行** | 多半是冷启动还没拉到（网关 models.list 有 750ms 超时），此时拦会把正常用户挡住 |
 * | 目录非空、有它 | 放行 | 正常 |
 * | 目录非空、没它 | **拦** | 目录已经告诉我们它不在了 |
 *
 * 目录已经拉到（非空）却没这个模型 —— 这是**确定**不在，不是「还没加载完」。
 */
export function isModelSelectable(catalog: ModelCatalogEntry[], modelId: string | undefined): boolean {
  // 没选模型（undefined）= 用网关默认模型，不经过本地目录 → 放行
  if (!modelId) return true;
  // 目录为空：无从判断，放行（宁可让上游报错，也不挡住冷启动的正常发送）
  if (catalog.length === 0) return true;
  return catalog.some((m) => m.id === modelId);
}

/** 家族展示名。键是小写前缀。 */
const FAMILY_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  glm: 'GLM',
  kimi: 'Kimi',
  moonshot: 'Kimi',
  minimax: 'MiniMax',
  abab: 'MiniMax',
  llama: 'Llama',
  gpt: 'GPT',
  claude: 'Claude',
  gemini: 'Gemini',
};

/**
 * 从模型 id 取出家族键。`deepseek-v4-flash` → `deepseek`；`qwen3.6-plus` → `qwen`。
 *
 * 取**开头连续字母**作前缀 —— 数字和点属于版本，不是家族名。
 * 认不出来就归到 `other`，**不猜**（猜错会把两个不相干的模型并到一起）。
 */
export function modelFamilyKey(modelId: string): string {
  const m = /^[a-z]+/i.exec(modelId.trim());
  return m ? m[0].toLowerCase() : 'other';
}

/** 家族展示名；认不出时用 `other`。 */
export function modelFamilyLabel(modelId: string): string {
  const key = modelFamilyKey(modelId);
  if (FAMILY_LABELS[key]) return FAMILY_LABELS[key];
  return key === 'other' ? '其他' : key.charAt(0).toUpperCase() + key.slice(1);
}
