/**
 * 身份中心的**纯逻辑**（2026-09-19）。
 *
 * 放在这里的都是**不依赖 React、可以直接单测**的东西 —— 与 `lib/assistant-task-presets.ts`
 * 同一种做法（那边也是"id → i18n key"的映射表 + 纯函数）。
 */

/** 「人群画像标签组合」的五个标签。顺序 = 界面上从左到右。 */
export const IDENTITY_PERSONA_TAGS = ['goalOriented', 'efficiency', 'logical', 'reporting', 'timeManagement'] as const;

export type IdentityTagId = (typeof IDENTITY_PERSONA_TAGS)[number];

/** 设计稿上默认选中的四个（最后一个「时间管理」不选）。 */
export const IDENTITY_DEFAULT_TAGS: IdentityTagId[] = ['goalOriented', 'efficiency', 'logical', 'reporting'];

/**
 * 「换一个标签」：在当前选中的基础上**轮换一格**。
 *
 * 定义得很死：所有标签排成一个环，整体往后挪一位。
 * - 空选 ⇒ 返回默认那四个（"换"之前先有个起点）
 * - 全选 ⇒ 也轮换（没必要特判：结果是同一个集合，但顺序变了；我们按集合看，所以看起来没变）
 *
 * ⚠️ 刻意**不做**"随机抽一个"：随机不可测，而且用户连点两次会看到不稳定的结果。
 */
export function nextTagSelection(current: readonly IdentityTagId[]): IdentityTagId[] {
  if (current.length === 0) return [...IDENTITY_DEFAULT_TAGS];
  const ring = IDENTITY_PERSONA_TAGS;
  const offset = ring.indexOf(current[0]) + 1;
  return ring.map((_, i) => ring[(i + offset) % ring.length]).slice(0, current.length);
}
