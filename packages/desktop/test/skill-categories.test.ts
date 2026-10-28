import { describe, expect, it } from 'vitest';
import { groupSkillsByCategory, skillCategoryOf } from '../src/renderer/lib/skill-categories.js';

/**
 * 技能库分类（2026-10-17 晚用户设计稿：四个渐变分类卡 + 分类筛选）。
 *
 * 我们的技能没有 category 元数据 ⇒ 按 slug 唯一映射（纯函数钉死）。
 * 未命中的落 other（界面上叫「其他」），**不隐藏、不猜**。
 */
describe('skillCategoryOf', () => {
  it('已知 slug 落到对应分类', () => {
    expect(skillCategoryOf('presentation-deck-v2')).toBe('content');
    expect(skillCategoryOf('partner-w-post-research')).toBe('commerce');
    expect(skillCategoryOf('study-cards')).toBe('research');
    expect(skillCategoryOf('meeting-minutes')).toBe('office');
  });

  it('设计族进内容、工程族进办公（前缀兜底）', () => {
    expect(skillCategoryOf('octop-design-ux-copy')).toBe('content');
    expect(skillCategoryOf('octop-engineering-debug')).toBe('office');
  });

  it('不认识的新技能 ⇒ other（不猜类别）', () => {
    expect(skillCategoryOf('brand-new-skill')).toBe('other');
  });
});

describe('groupSkillsByCategory', () => {
  it('固定顺序分组，空组不产出', () => {
    const groups = groupSkillsByCategory([
      { slug: 'study-cards', name: '学习卡片' },
      { slug: 'meeting-minutes', name: '会议纪要' },
      { slug: 'presentation-deck-v2', name: '演示' },
      { slug: 'unknown-x', name: '未知' },
    ]);
    expect(groups.map((group) => group.category)).toEqual(['content', 'research', 'office', 'other']);
    expect(groups.find((group) => group.category === 'research')?.items).toHaveLength(1);
  });

  it('不丢条目（所有输入都出现在某个组里）', () => {
    const input = [{ slug: 'a' }, { slug: 'study-cards' }, { slug: 'octop-design-ux-copy' }];
    const total = groupSkillsByCategory(input).reduce((sum, group) => sum + group.items.length, 0);
    expect(total).toBe(input.length);
  });
});
