import { describe, expect, it } from 'vitest';
import {
  normalizeMyTemplates,
  normalizeTemplateDetail,
  normalizeTemplateList,
  templateSlug,
  templateToInstallDefinition,
} from '../src/services/agent-template-service.js';
import { describeTemplateError } from '../src/services/agent-template-error-message.js';

describe('templateSlug —— 确定性 slug（幂等安装的前提）', () => {
  it('同一个模板 id 永远得到同一个 slug', () => {
    const id = '3f2a1b4c-5d6e-7f80-9a0b-1c2d3e4f5a6b';
    expect(templateSlug(id)).toBe('rongying-tpl-3f2a1b4c');
    expect(templateSlug(id)).toBe(templateSlug(id));
  });

  it('不同模板得到不同 slug', () => {
    expect(templateSlug('aaaaaaaa-1111-2222-3333-444444444444')).not.toBe(
      templateSlug('bbbbbbbb-1111-2222-3333-444444444444'),
    );
  });

  it('拿不到可用的 id 时给一个稳定兜底（不返回空串）', () => {
    expect(templateSlug('')).toMatch(/^rongying-tpl-/);
    expect(templateSlug('short')).toMatch(/^rongying-tpl-/);
    expect(templateSlug('')).toBe(templateSlug(''));
  });
});

describe('templateToInstallDefinition —— 模板 → 安装定义', () => {
  const detail = {
    id: '3f2a1b4c-5d6e-7f80-9a0b-1c2d3e4f5a6b',
    name: '爆款内容教练',
    description: '从选题到成稿的内容工作流',
    category: 'content' as const,
    emoji: '📣',
    instructions: '你是内容创作教练。',
  };

  it('id/creationName 用 slug，提示词进 IDENTITY.md 的 body', () => {
    const def = templateToInstallDefinition(detail, '公共契约文本');
    expect(def.id).toBe('rongying-tpl-3f2a1b4c');
    expect(def.creationName).toBe(def.id);
    expect(def.identityMd).toContain('你是内容创作教练。');
    expect(def.identityMd).toContain('从选题到成稿的内容工作流'); // 描述进 frontmatter
    expect(def.emoji).toBe('📣');
  });

  it('SOUL.md 用公共契约（模板助手与预置助手同一份）', () => {
    expect(templateToInstallDefinition(detail, '公共契约文本').soulMd).toBe('公共契约文本');
  });

  it('没有 emoji 时给兜底，不塞空串', () => {
    expect(templateToInstallDefinition({ ...detail, emoji: '' }, 'c').emoji.trim().length).toBeGreaterThan(0);
  });
});

describe('normalizeTemplateList / Detail —— 坏行不许炸', () => {
  it('列表：snake→驼峰 + 数字兜底', () => {
    const rows = normalizeTemplateList([
      {
        id: 't1',
        name: '甲',
        description: 'd',
        category: 'content',
        emoji: '📣',
        is_official: true,
        author_name: '官方',
        install_count: '3',
        view_count: 7,
        installed_by_me: true,
      },
    ]);
    expect(rows[0]).toEqual({
      id: 't1',
      name: '甲',
      description: 'd',
      category: 'content',
      emoji: '📣',
      isOfficial: true,
      authorName: '官方',
      installCount: 3,
      viewCount: 7,
      installedByMe: true,
    });
  });

  it('列表：非数组/坏行丢掉', () => {
    expect(normalizeTemplateList(undefined)).toEqual([]);
    expect(normalizeTemplateList([null, {}, { name: '没有 id' }])).toEqual([]);
  });

  it('分类越界降级为 other', () => {
    expect(normalizeTemplateList([{ id: 't', category: 'weird' }])[0]?.category).toBe('other');
  });

  it('详情：缺 id 给 null', () => {
    expect(normalizeTemplateDetail(null)).toBeNull();
    expect(normalizeTemplateDetail({ name: 'x' })).toBeNull();
    expect(normalizeTemplateDetail({ id: 't1', instructions: 'p' })?.instructions).toBe('p');
  });

  it('详情：RPC 返回单行数组也认（PostgREST 的 returns table 是数组）', () => {
    expect(normalizeTemplateDetail([{ id: 't1', instructions: 'p' }])?.id).toBe('t1');
  });

  it('我的模板：带 created_at + 状态降级', () => {
    const rows = normalizeMyTemplates([{ id: 't1', status: 'weird', created_at: '2026-09-17T00:00:00Z' }]);
    expect(rows[0]?.status).toBe('draft');
    expect(rows[0]?.createdAt).toBe('2026-09-17T00:00:00Z');
  });
});

describe('describeTemplateError', () => {
  it('每条错误码都有中文且不回显机器码', () => {
    for (const code of [
      'not_authenticated',
      'no_organization',
      'template_not_found',
      'forbidden',
      'invalid_name',
      'invalid_description',
      'invalid_category',
      'invalid_emoji',
      'invalid_instructions',
      'invalid_status',
      'template_installed_cannot_delete',
      'network',
    ]) {
      const text = describeTemplateError(code);
      expect(text).toMatch(/[一-龥]/);
      expect(text).not.toContain(code);
    }
  });

  it('认不出的码给中文兜底', () => {
    expect(describeTemplateError('SOMETHING_NEW')).toMatch(/[一-龥]/);
    expect(describeTemplateError(undefined)).toMatch(/[一-龥]/);
  });
});
