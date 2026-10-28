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
  readStoredIdentityTags,
  saveStoredIdentityTags,
  userMdContentFromReadResult,
  type IdentityTagsStorage,
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

  it('带上首跑的「一句话介绍」（2026-10-07 体检问题 11：以前只写不读）', () => {
    const block = buildIdentityBlock({
      groupLabel: '制造业 · 运营',
      tagLabels: ['目标导向'],
      introduction: '  做小家电的  ',
    });

    expect(block).toContain('- 介绍：做小家电的');
  });

  it('没有介绍（或只有空白）时不留一行空的「介绍：」', () => {
    expect(buildIdentityBlock({ groupLabel: '制造业', tagLabels: [], introduction: '   ' })).not.toContain('- 介绍：');
    expect(buildIdentityBlock({ groupLabel: '制造业', tagLabels: [] })).not.toContain('- 介绍：');
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

  it('⭐ 结束标记被手删 ⇒ 只吞掉身份块自己那几行，后面用户写的内容一个字不丢（问题 12c）', () => {
    const userOwned = [
      '# 我的笔记',
      '<!-- 身份中心：自动写入，请勿手改 -->',
      '## 我的身份',
      '- 客群：制造业',
      '- 标签：目标导向',
      '',
      '## 我自己补的段落',
      '这是用户手写的内容，绝不能被吞掉。',
    ].join('\n');

    const r = mergeIdentityIntoUserMd(userOwned, block);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain('# 我的笔记');
    expect(r.content).toContain('这是用户手写的内容，绝不能被吞掉。');
    expect(r.content).not.toContain('- 客群：制造业');
    expect(r.content.split(IDENTITY_BLOCK_START)).toHaveLength(2); // 只有新写的那一份
  });

  it('结束标记被删且它后面直接接着用户的行（含用户自己的列表项）⇒ 也只吞身份块自己的行', () => {
    const userOwned = [
      '<!-- 身份中心：自动写入，请勿手改 -->',
      '## 我的身份',
      '- 标签：目标导向',
      '用户自己接的一句话',
      '- 我自己的列表项',
    ].join('\n');

    const r = mergeIdentityIntoUserMd(userOwned, block);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 用户那两行活下来了，而且在**前面**（旧块被摘掉、新块追加在后面）
    expect(r.content.trim().startsWith('用户自己接的一句话')).toBe(true);
    expect(r.content).toContain('- 我自己的列表项');
    expect(r.content.split(IDENTITY_BLOCK_START)).toHaveLength(2); // 只有新写的那一份
    expect(r.content.split('## 我的身份')).toHaveLength(2); // 旧块整段被摘掉（标题只剩一个）
  });
});

/* ── 读回助手文件：真机载荷形状（2026-10-07 体检问题 1） ── */

describe('userMdContentFromReadResult', () => {
  it('⭐ 真机载荷 { file: { name, content, missing } } ⇒ 取到正文', () => {
    expect(
      userMdContentFromReadResult({
        agentId: 'main',
        workspace: 'w',
        file: { name: 'USER.md', content: '用户自己写的', missing: false },
      }),
    ).toBe('用户自己写的');
  });

  it('文件不存在（missing:true）⇒ 空串（本来就没有要保住的字节）', () => {
    expect(userMdContentFromReadResult({ file: { name: 'USER.md', content: '', missing: true } })).toBe('');
    expect(userMdContentFromReadResult({ file: { name: 'USER.md', missing: true } })).toBe('');
  });

  it('契约里 content 可选 ⇒ 文件在但没 content 就是空文件', () => {
    expect(userMdContentFromReadResult({ file: { name: 'USER.md', missing: false } })).toBe('');
  });

  it('⭐ 错位形状（就是那个"恒读成空串"的 payload）⇒ null = 读失败，绝不当空文件', () => {
    // 老代码读的就是这个：`result.content` —— 它不存在。若有人改回去，恒返回 ''，覆盖用户的记忆。
    expect(userMdContentFromReadResult({ content: '用户自己写的' })).toBeNull();
    expect(userMdContentFromReadResult({ file: { content: 42 } })).toBeNull();
    expect(userMdContentFromReadResult(null)).toBeNull();
    expect(userMdContentFromReadResult('not an object')).toBeNull();
    expect(userMdContentFromReadResult({ file: null })).toBeNull();
  });
});

/* ── 偏好标签的回读缓存（2026-10-07 体检问题 4） ── */

describe('偏好标签回读缓存', () => {
  function memoryStorage(): IdentityTagsStorage & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
    };
  }

  it('⭐ 存进去再读回来是同一组（按账号分键，换账号读不到）', () => {
    const storage = memoryStorage();
    saveStoredIdentityTags('user-1', ['goalOriented', 'timeManagement'], storage);

    expect(readStoredIdentityTags('user-1', storage)).toEqual(['goalOriented', 'timeManagement']);
    expect(readStoredIdentityTags('user-2', storage)).toBeNull();
    expect(readStoredIdentityTags(null, storage)).toBeNull();
    expect(readStoredIdentityTags(undefined, storage)).toBeNull();
  });

  it('没存过 / 坏 JSON / 空数组 / 陌生项 ⇒ null（调用方回默认四标签）', () => {
    const storage = memoryStorage();
    expect(readStoredIdentityTags('user-1', storage)).toBeNull();

    storage.setItem('partner-w:identity-tags:v1:user-1', 'not json');
    expect(readStoredIdentityTags('user-1', storage)).toBeNull();

    storage.setItem('partner-w:identity-tags:v1:user-1', '[]');
    expect(readStoredIdentityTags('user-1', storage)).toBeNull();

    storage.setItem('partner-w:identity-tags:v1:user-1', '["goalOriented","陌生标签"]');
    expect(readStoredIdentityTags('user-1', storage)).toBeNull();
  });

  it('存储本身炸了也不许把保存流程带崩（读 null / 写吞掉）', () => {
    const broken: IdentityTagsStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readStoredIdentityTags('user-1', broken)).toBeNull();
    expect(() => saveStoredIdentityTags('user-1', ['efficiency'], broken)).not.toThrow();
    // 空选择 / 没账号：不写（保存流程本身有"至少选一个"的守卫）
    expect(() => saveStoredIdentityTags(null, ['efficiency'], broken)).not.toThrow();
    expect(() => saveStoredIdentityTags('user-1', [], broken)).not.toThrow();
  });
});
