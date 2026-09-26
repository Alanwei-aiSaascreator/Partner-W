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

/* ────────────────────────── 写进助手记忆（2026-09-26 身份中心 v2） ────────────────────────── */

/**
 * 身份块的标记。**必须是注释**：`USER.md` 是运行时**每轮全文注入**的提示词，
 * 标记要在模型看到的正文里不可见（与 `stampPresetPrompt` 同一个理由）。
 */
export const IDENTITY_BLOCK_START = '<!-- 身份中心：自动写入，请勿手改 -->';
export const IDENTITY_BLOCK_END = '<!-- /身份中心 -->';

/**
 * `USER.md` 的字符上限 —— **运行时的硬限制**，不是我们定的（记忆页同一口径）。
 * 超了要么被截断、要么整份写不进去，两种都比"如实报错、一个字不写"坏。
 */
export const USER_MD_MAX_CHARS = 4000;

/** 身份块的正文（含标记）。`tagLabels` 为空时也要说清"未选"，不留一个空冒号。 */
export function buildIdentityBlock(input: { groupLabel: string; tagLabels: readonly string[] }): string {
  const tags = input.tagLabels.length > 0 ? input.tagLabels.join('、') : '（未选）';
  return [
    IDENTITY_BLOCK_START,
    '## 我的身份',
    `- 客群：${input.groupLabel}`,
    `- 标签：${tags}`,
    IDENTITY_BLOCK_END,
  ].join('\n');
}

export type IdentityMergeResult = { ok: true; content: string } | { ok: false; reason: 'over-limit'; limit: number };

/** 把已有的身份块整段摘掉（含它前后的空行），只留用户自己写的内容。 */
function stripIdentityBlock(existing: string): string {
  const start = existing.indexOf(IDENTITY_BLOCK_START);
  if (start < 0) return existing.trim();
  const endMark = existing.indexOf(IDENTITY_BLOCK_END, start);
  const end = endMark < 0 ? existing.length : endMark + IDENTITY_BLOCK_END.length;
  return `${existing.slice(0, start)}${existing.slice(end)}`.trim();
}

/**
 * **合并**身份块进 `USER.md`：用户自己写的一个字节都不许丢，重复保存是**替换**不是追加。
 *
 * ⚠️ 为什么不是整份覆盖写（记忆页那种）：那边是用户自己在编辑那个文件，覆盖是用户的意思；
 *    这里是**页面顺手写的**，把用户手写的记忆冲掉是不可逆的损坏。
 */
export function mergeIdentityIntoUserMd(existing: string, block: string): IdentityMergeResult {
  const base = stripIdentityBlock(existing);
  const content = base.length > 0 ? `${base}\n\n${block}` : block;
  if (content.length > USER_MD_MAX_CHARS) {
    return { ok: false, reason: 'over-limit', limit: USER_MD_MAX_CHARS };
  }
  return { ok: true, content };
}
