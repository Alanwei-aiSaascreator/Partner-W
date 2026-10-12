import type { ModelCatalogEntry } from '@clawwork/shared';

/**
 * 消息级模型的展示名：优先用网关目录里的 `name`，目录里没有就退回 id 本身（剥掉 provider 前缀）。
 *
 * ⚠️ **只做展示增强，绝不兜底**：入参没有 `modelId` 就返回 `undefined`，
 * 调用方据此不渲染徽章 —— 不要从会话级 `task.model` / picker 补一个值上去。
 * 那个字段是"当前选中的模型"，与本条消息"实际由谁生成"是两回事
 * （2026-09-13 实测：同一会话里三条回复可以分别由 glm-4.7 / qwen-turbo / kimi-k2-thinking 生成）。
 *
 * ⚠️ **刻意不过 `relayModelsFrom`**：那个过滤器回答的是"这个模型现在还能不能选来发消息"，
 * 而历史消息记的模型可能已经下架或换了 provider —— 拿它过滤，会把本来能解析出来的名字
 * 降级成裸 id，甚至整条徽章消失。展示不承担"可发送性"判断。
 */
export function resolveModelLabel(
  modelId: string | undefined | null,
  catalog?: readonly ModelCatalogEntry[],
): string | undefined {
  if (!modelId) return undefined;

  const entry = catalog?.find((model) => model.id === modelId);
  if (entry?.name) return entry.name;

  // 与 `ChatInput/utils.ts` 的 `getModelLabel` 同规则：剥掉 `provider/` 前缀。
  return modelId.split('/').pop() || modelId;
}

/**
 * 2026-10-11（用户拍板）：三档任务模式（快速 / 智能 / 深度）背后跑哪个模型是**内部实现**，
 * 不上屏 —— 仅 `custom`（高级：用户显式选过模型）才渲染消息级模型徽章/名称。
 * 与 composer chip 的两级口径同规则（`ChatInput` 的 `modeDriven = mode !== 'custom'`）。
 */
export function shouldShowModelBadge(taskMode: string | null | undefined): boolean {
  return taskMode === 'custom';
}
