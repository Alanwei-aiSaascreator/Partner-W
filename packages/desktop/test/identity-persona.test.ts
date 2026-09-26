import { describe, expect, it } from 'vitest';

import {
  IDENTITY_BLOCK_END,
  IDENTITY_BLOCK_START,
  IDENTITY_DEFAULT_TAGS,
  IDENTITY_PERSONA_TAGS,
  USER_MD_MAX_CHARS,
  buildIdentityBlock,
  mergeIdentityIntoUserMd,
  nextTagSelection,
} from '../src/renderer/lib/identity-persona';

/**
 * 身份中心 v2 的**纯逻辑**（2026-09-26）。
 *
 * 为什么这一层要有自己的测试：写进助手记忆（`USER.md`）这件事**不可逆**——
 * 覆盖了用户自己写的记忆就找不回来了。所以"合并"必须先是**可单测的纯函数**，
 * 组件只负责取数据与如实报错。
 *
 * ⚠️ 上限 4000 不是我们定的，是运行时对 `USER.md` 的硬上限（记忆页同一口径）：
 *    超了要么被截断、要么整份写不进去 —— 两种都比"如实报错、一个字不写"坏。
 */

describe('nextTagSelection（既有行为，回归）', () => {
  it('空选 ⇒ 回到默认四个；环上整体挪一格', () => {
    expect(nextTagSelection([])).toEqual(IDENTITY_DEFAULT_TAGS);
    expect(nextTagSelection(IDENTITY_DEFAULT_TAGS)).toEqual(['efficiency', 'logical', 'reporting', 'timeManagement']);
  });

  it('标签集合恰好是界面上那五个', () => {
    expect([...IDENTITY_PERSONA_TAGS]).toEqual([
      'goalOriented',
      'efficiency',
      'logical',
      'reporting',
      'timeManagement',
    ]);
  });
});

describe('buildIdentityBlock', () => {
  it('带上标记、客群与标签，且标签用顿号连起来', () => {
    const block = buildIdentityBlock({ groupLabel: '电商运营', tagLabels: ['目标导向', '注重效率'] });

    expect(block.startsWith(IDENTITY_BLOCK_START)).toBe(true);
    expect(block.endsWith(IDENTITY_BLOCK_END)).toBe(true);
    expect(block).toContain('电商运营');
    expect(block).toContain('目标导向、注重效率');
  });

  it('一个标签都没选时也要说清楚是"未选"，而不是留一个空冒号', () => {
    const block = buildIdentityBlock({ groupLabel: '高效办公', tagLabels: [] });

    expect(block).toContain('高效办公');
    expect(block).not.toMatch(/标签：\s*$/m);
  });
});

describe('mergeIdentityIntoUserMd', () => {
  const block = buildIdentityBlock({ groupLabel: '电商运营', tagLabels: ['目标导向'] });

  it('用户记忆是空的 ⇒ 内容就是这一块（不留下前导空行）', () => {
    const r = mergeIdentityIntoUserMd('', block);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe(block);
  });

  it('⭐ 原有记忆一个字节都不许丢', () => {
    const existing = '# 关于我\n- 我叫老王，做电商的。\n';
    const r = mergeIdentityIntoUserMd(existing, block);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain('我叫老王，做电商的。');
    expect(r.content).toContain(block);
  });

  it('⭐ 幂等：连存两次与存一次完全一样（不是追加两份）', () => {
    const once = mergeIdentityIntoUserMd('旧的记忆', block);
    expect(once.ok).toBe(true);
    if (!once.ok) return;

    const twice = mergeIdentityIntoUserMd(once.content, block);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.content).toBe(once.content);
  });

  it('⭐ 改了标签再存 ⇒ 标记块被替换，用户自己的段落仍在（且只有一份身份块）', () => {
    const first = mergeIdentityIntoUserMd('用户自己写的：喜欢短句', block);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = mergeIdentityIntoUserMd(
      first.content,
      buildIdentityBlock({ groupLabel: '高效办公', tagLabels: ['逻辑清晰'] }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.content).toContain('用户自己写的：喜欢短句');
    expect(second.content).toContain('逻辑清晰');
    expect(second.content).not.toContain('目标导向');
    expect(second.content.split(IDENTITY_BLOCK_START)).toHaveLength(2); // 只出现一次
  });

  it('⚠️ 合并后会超过 4000 字符 ⇒ 如实拒绝，一个字都不写', () => {
    const existing = 'x'.repeat(USER_MD_MAX_CHARS - 10);
    const r = mergeIdentityIntoUserMd(existing, block);

    expect(r).toEqual({ ok: false, reason: 'over-limit', limit: USER_MD_MAX_CHARS });
  });

  it('刚好卡在上限上（等于 4000）⇒ 允许写', () => {
    const blockLen = block.length;
    const existing = 'y'.repeat(USER_MD_MAX_CHARS - blockLen - 2);
    const r = mergeIdentityIntoUserMd(existing, block);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content.length).toBeLessThanOrEqual(USER_MD_MAX_CHARS);
  });
});
