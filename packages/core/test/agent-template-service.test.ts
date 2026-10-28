import { describe, expect, it } from 'vitest';
import {
  normalizeMyTemplates,
  normalizeTemplateDetail,
  normalizeTemplateList,
  templateSlug,
  templateToInstallDefinition,
} from '../src/services/agent-template-service.js';
import { describeTemplateError, describeTemplateErrorKey } from '../src/services/agent-template-error-message.js';

describe('templateSlug —— 确定性 slug（幂等安装的前提）', () => {
  it('同一个模板 id 永远得到同一个 slug（整 id 哈希前 12 位）', () => {
    const id = '3f2a1b4c-5d6e-7f80-9a0b-1c2d3e4f5a6b';
    expect(templateSlug(id)).toBe('partner-w-tpl-88a1c42c9d74');
    expect(templateSlug(id)).toBe(templateSlug(id));
    expect(templateSlug(` ${id} `)).toBe(templateSlug(id)); // 首尾空白不影响
  });

  it('不同模板得到不同 slug', () => {
    expect(templateSlug('aaaaaaaa-1111-2222-3333-444444444444')).not.toBe(
      templateSlug('bbbbbbbb-1111-2222-3333-444444444444'),
    );
  });

  /**
   * ⭐ 2026-10-07（质检 P2-1 的回归）：老写法"去符号 + 取前 8 位"把**前 8 位相同**的
   *    两个模板截成同一个 id —— 对 B 点"使用"会静默复用到 A 的助手（界面还报成功）。
   */
  it('⭐ 前 8 个可读字符相同的两个模板**不再**共用 slug', () => {
    const first = templateSlug('t-official-content-coach');
    const second = templateSlug('t-official-writer');
    expect(first).not.toBe(second);
    expect(first).toBe('partner-w-tpl-2a06fbf43e3a');
    expect(second).toBe('partner-w-tpl-52baed5d12f3');
  });

  it('拿不到可用的 id 时给一个稳定兜底（不返回空串）', () => {
    expect(templateSlug('')).toMatch(/^partner-w-tpl-[0-9a-f]{12}$/);
    expect(templateSlug('short')).toMatch(/^partner-w-tpl-[0-9a-f]{12}$/);
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
    expect(def.id).toBe('partner-w-tpl-88a1c42c9d74');
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

describe('describeTemplateErrorKey —— 机器码 → i18n 键（9 语言文案的唯一入口）', () => {
  it('认得的码给 market.error.* 键；认不出的落 unknown；原型链上的名字不算', () => {
    expect(describeTemplateErrorKey('network')).toBe('market.error.network');
    expect(describeTemplateErrorKey('not_authenticated')).toBe('market.error.notAuthenticated');
    expect(describeTemplateErrorKey('SOMETHING_NEW')).toBe('market.error.unknown');
    expect(describeTemplateErrorKey(undefined)).toBe('market.error.unknown');
    expect(describeTemplateErrorKey('constructor')).toBe('market.error.unknown');
    expect(describeTemplateErrorKey('__proto__')).toBe('market.error.unknown');
  });
});
