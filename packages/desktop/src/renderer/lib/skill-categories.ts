/**
 * 技能库的分类映射（2026-10-17 晚，用户给的设计稿：四个渐变分类卡 + 分类筛选）。
 *
 * 我们的随包技能没有 category 元数据（`OurSkillEntry` 只有 slug/name/description/emoji），
 * 所以这里按 **slug** 做唯一映射 —— 纯函数、可单测。未命中的落 `other`（界面上归到「其他」，
 * 不隐藏、不猜）。
 *
 * ⚠️ 分类只影响展示与筛选，**不改任何安装/执行语义**。
 */
export type SkillCategory = 'content' | 'commerce' | 'research' | 'office' | 'other';

export const SKILL_CATEGORY_ORDER: SkillCategory[] = ['content', 'commerce', 'research', 'office', 'other'];

const EXACT: Record<string, SkillCategory> = {
  'copy-variants': 'content',
  'formal-writing': 'content',
  'presentation-deck-v2': 'content',
  'deck-layout': 'content',
  'video-generation': 'content',
  'image-generation': 'content',
  'product-compare': 'content',
  'rongying-post-analysis': 'commerce',
  'rongying-post-creation': 'commerce',
  'rongying-post-inspection': 'commerce',
  'rongying-post-production': 'commerce',
  'rongying-post-research': 'commerce',
  'study-cards': 'research',
  'octop-news-brief': 'research',
  'octop-knowledge-wiki': 'research',
  'octop-design-research-synthesis': 'research',
  'octop-design-user-research': 'research',
  'meeting-minutes': 'office',
  'weekly-report': 'office',
  'table-clean': 'office',
  'document-deck': 'office',
  'html-deliverable': 'office',
};

/** slug → 分类。`octop-design-*`/`octop-engineering-*` 按前缀再兜一层。 */
export function skillCategoryOf(slug: string): SkillCategory {
  const exact = EXACT[slug];
  if (exact) return exact;
  if (slug.startsWith('octop-design-')) return 'content';
  if (slug.startsWith('octop-engineering-')) return 'office';
  return 'other';
}

export interface CategorizedSkill<T> {
  category: SkillCategory;
  items: T[];
}

/** 按固定顺序分组；空组不产出（与任务列表同一口径）。 */
export function groupSkillsByCategory<T extends { slug: string }>(
  skills: readonly T[],
): CategorizedSkill<{ slug: string } & T>[] {
  const buckets = new Map<SkillCategory, Array<{ slug: string } & T>>();
  for (const skill of skills) {
    const category = skillCategoryOf(skill.slug);
    const list = buckets.get(category) ?? [];
    list.push(skill);
    buckets.set(category, list);
  }
  const groups: CategorizedSkill<{ slug: string } & T>[] = [];
  for (const category of SKILL_CATEGORY_ORDER) {
    const items = buckets.get(category);
    if (items && items.length > 0) groups.push({ category, items });
  }
  return groups;
}
