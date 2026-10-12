/**
 * 任务模式（快速 / 智能 / 深度）—— **用户选模式、不选模型**的统一映射。
 *
 * ## 为什么必须是单一真源
 *
 * 同一条映射被两处消费：渲染层（输入框的模式 chip 显示什么、发送时给 composer 什么
 * `presetModel`/`presetThinking`）与任何将来要看"这个任务按哪档跑"的面。
 * 分头写两份的下场是旧账重演 —— 用户看到的模型和实际生成消息的模型对不上
 *（2026-09-17 实机：composer 显示 deepseek-v4-flash、消息徽章是 qwen3.5-27b）。
 *
 * ## 三档 + 高级（custom）
 *
 * （2026-10-10 Cephalon 批：三档统一 `glm-5.3-flash`，只差思考强度。）
 *
 * | 模式 | 模型 | 思考档 |
 * |---|---|---|
 * | `fast` 快速 | `glm-5.3-flash` | `low` |
 * | `smart` 智能（默认） | `glm-5.3-flash` | `high` |
 * | `deep` 深度 | `glm-5.3-flash` | `max` |
 * | `custom` 高级：指定模型 | **用户自己选的模型**（保留既有行为） | 用户自己的档位 |
 *
 * ## 存量保护（硬要求）
 *
 * 旧行 migration 后 `mode` 为空 ⇒ 一律按 `custom` 处理：其既有 `task.model` 是用户
 * 当年**显式选过**的模型，不许被"默认智能"劫持。新任务在 `createTask` 时写入默认档
 *（`DEFAULT_TASK_MODE`），所以"新任务默认智能"与"旧行不被动"两件事互不干扰。
 *
 * ⚠️ 模型 id 写**本体**（不带 `clawrouter/` 前缀）—— 目录里的 id 就是本体，网关侧的
 *    ref 才是 `<provider>/<id>` 两段（与 `COMMERCIAL_DEFAULT_MODEL_ID` 同一把尺）。
 */

export const TASK_MODES = ['fast', 'smart', 'deep'] as const;
export type TaskMode = (typeof TASK_MODES)[number];

/**
 * 持久化进 `tasks.mode` 的取值：三档之一，或 `custom`（高级：指定模型）。
 * 老数据里是 NULL —— 读出来按 `custom` 处理（见 `resolveEffectiveTaskMode`）。
 */
export type TaskModeSetting = TaskMode | 'custom';

export const DEFAULT_TASK_MODE: TaskMode = 'smart';

/**
 * 旧快速档的 relay 模型别名（`qwen3.7-flash-fast`，relay 保留在售、下拉隐藏）。
 * 2026-10-10 Cephalon 批后**三档已不再使用它** —— 常量保留只为：①隐藏名单
 * `MODE_ALIAS_MODEL_IDS` 继续把存量目录里的旧别名挡在高级列表外；②测试与未来
 * 迁移引用同一真源。不要顺手删。
 */
export const FAST_MODEL_ALIAS_ID = 'qwen3.7-flash-fast';

/** 三档共用的基础模型（id 本体，不带 `clawrouter/` 前缀）。 */
export const MODE_BASE_MODEL_ID = 'glm-5.3-flash';

export const MODE_POLICY: Record<TaskMode, { modelId: string; thinkingLevel: string }> = {
  fast: { modelId: MODE_BASE_MODEL_ID, thinkingLevel: 'low' },
  smart: { modelId: MODE_BASE_MODEL_ID, thinkingLevel: 'high' },
  deep: { modelId: MODE_BASE_MODEL_ID, thinkingLevel: 'max' },
};

/** 模式专用别名（不是"某个可选模型"）—— 高级模型列表里要隐藏它们。 */
export const MODE_ALIAS_MODEL_IDS: readonly string[] = [FAST_MODEL_ALIAS_ID];

export function isTaskMode(value: unknown): value is TaskMode {
  return typeof value === 'string' && (TASK_MODES as readonly string[]).includes(value);
}

/** 持久化值 → 三档；不是三档一律 `undefined`（`custom` 走 `normalizeTaskModeSetting`）。 */
export function normalizeTaskMode(value: unknown): TaskMode | undefined {
  return isTaskMode(value) ? value : undefined;
}

/** 持久化值 → 四选一；脏值一律 `undefined`（调用方按"没有偏好"处理，不猜）。 */
export function normalizeTaskModeSetting(value: unknown): TaskModeSetting | undefined {
  if (value === 'custom') return 'custom';
  return normalizeTaskMode(value);
}

/**
 * 一个任务实际按哪档跑。**发送路径与界面显示共用这一把尺**。
 *
 * - 显式 mode ⇒ 原样；
 * - mode 为空（旧行 / 网关发现并回填的旧会话）⇒ `custom` —— 不劫持既有 `task.model`。
 *   注意：**这不是默认档**。新任务在 `createTask` 里就已经写入 `DEFAULT_TASK_MODE`，
 *   所以"新任务智能、旧任务不被动"两件事同时成立（见文件头"存量保护"）。
 */
export function resolveEffectiveTaskMode(task: { mode?: unknown; model?: unknown }): TaskModeSetting {
  return normalizeTaskModeSetting(task.mode) ?? 'custom';
}

/** 模型 id 的比对口径：按最后一段比（`clawrouter/x` 与 `x` 视为同一个模型）。 */
export function modelIdMatches(modelId: string, target: string): boolean {
  return modelId.split('/').at(-1) === target.split('/').at(-1);
}

/** 这条目录 id 是不是模式专用别名（高级模型列表里要隐藏）。 */
export function isModeAliasModelId(modelId: string): boolean {
  return MODE_ALIAS_MODEL_IDS.some((alias) => modelIdMatches(modelId, alias));
}

/**
 * 对着**目录**解析某一档该用哪个模型 id；解析不出来返回 `undefined`。
 *
 * 返回的是**目录里真实存在的那个 id**（可能是 `clawrouter/qwen3.7-flash` 这种带命名
 * 空间的写法）—— 调用方拿它直接当 `presetModel`，与目录逐字一致才不会在发送前被
 *「这个模型不在目录里」的闸门拦下。
 *
 * 规则：
 *   1. 按 `MODE_POLICY` 找（三档同为 `glm-5.3-flash`，命中即返回目录里那个 id）；
 *   2. 找不到 ⇒ `undefined`（调用方**保持现状、不拦截**：目录没拉到时照发，
 *      由上游与目录自己说话；拿它当"不支持"去拦住用户是更坏的失败）。
 *      2026-10-10 Cephalon 批起**不再回退旧 Qwen 别名**——旧别名只隐藏、不使用。
 */
export function resolveModeModelId(mode: TaskMode, catalogModelIds: readonly string[]): string | undefined {
  const policy = MODE_POLICY[mode];
  return catalogModelIds.find((id) => modelIdMatches(id, policy.modelId));
}
