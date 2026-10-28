import type { ToolActivityKind } from './tool-activity';

/**
 * 动作名显示映射（2026-10-08 对话可视化改造 · Task 4）—— **仅展示层，不改任何执行语义**。
 *
 * ## 为什么需要
 *
 * `classifyToolActivity` 是按"名字里有没有某个词"猜的启发式（正则宽匹配），它刻意保守：
 * 认不出的都落 `other` ⇒ 行上显示泛化文案「使用工具」——用户看不出**这一步在干什么**。
 * 真机上最常见的恰恰是内核/网关的**精确工具名**（`read` / `process` / `apply_patch`…），
 * 它们短、无下划线、不含 `file` 等词根，启发式自然抓不到。
 *
 * ## 规则（Codex 复审定稿）
 *
 * **仅当** `fallbackKind === 'other'` 时，按**精确工具名**（小写归一）查这张小表；
 * 命中就返回映射值，否则原样返回 `fallbackKind`。⇒ 已有分类永不被覆盖（`web_fetch`
 * 被启发式判成 `browseWeb` 时保持 `browseWeb`），也绝不改成新的正则猜测。
 */
const DISPLAY_KIND_BY_TOOL_NAME: Readonly<Record<string, ToolActivityKind>> = {
  read: 'readFile',
  ls: 'listDirectory',
  write: 'writeFile',
  edit: 'writeFile',
  apply_patch: 'writeFile',
  exec: 'execute',
  process: 'execute',
  browser: 'browseWeb',
  web_search: 'search',
  web_fetch: 'search',
};

/**
 * 工具名 + 既有分类 → 上屏用的动作名分类。
 *
 * ⚠️ 查表用**精确匹配**（不是前缀/正则）：表外工具一律保持 `other`（不认识就不编，
 *    与 `sanitizeToolTitle` 剥空后退回泛化文案的既有口径一致）。
 */
export function resolveDisplayKind(toolName: string, fallbackKind: ToolActivityKind): ToolActivityKind {
  if (fallbackKind !== 'other') return fallbackKind;
  return DISPLAY_KIND_BY_TOOL_NAME[toolName.trim().toLowerCase()] ?? fallbackKind;
}
