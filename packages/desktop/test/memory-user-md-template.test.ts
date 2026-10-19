/**
 * 内核默认 `USER.md` 模板的识别与本地化骨架。
 *
 * ## 为什么需要它
 *
 * 内核（OpenClaw 2026.9.3）在工作区首次准备时，会把
 * `docs/reference/templates/USER.md` 的正文**落成盘上真实的 `USER.md`**：
 *
 * ```
 * # USER.md - User Model
 * Store stable user preferences and profile facts ...
 * <!-- observed: YYYY-MM-DD | status: active -->
 * ```
 *
 * 因此中文产品里第一次打开「设置 → 记忆 → 关于你」，看到的是一整页英文——
 * 而且这份英文同时是**每轮注入给助手**的提示词。
 *
 * ## 判据的边界（这里是测试真正要钉住的东西）
 *
 * - **只认"一字未改的内核模板"**：只要用户动过一行（追加一条 directive、
 *   把 `- Prefer ...` 换成真话），就必须按"真实内容"处理，**一个字节都不许动**。
 * - 判据必须是**结构性的**（整份行的集合 + 关键标记），不能只匹配一行——
 *   用户手写的记忆里出现一句 `- Prefer ...` 不该被误判成模板。
 */
import { describe, expect, it } from 'vitest';
import {
  buildAboutYouSkeleton,
  isKernelDefaultUserMd,
  KERNEL_USER_MD_TEMPLATE_BODY,
} from '../src/renderer/lib/user-md-template';

/** 真机上落到盘里的那份（1137 B，正文无 YAML frontmatter）。 */
const TEMPLATE = KERNEL_USER_MD_TEMPLATE_BODY;

describe('isKernelDefaultUserMd —— 只认一字未改的内核模板', () => {
  it('真机盘上的那份正文（逐字节）⇒ 判定为内核默认模板', () => {
    expect(isKernelDefaultUserMd(TEMPLATE)).toBe(true);
  });

  it('带 docs 原文的 YAML frontmatter / CRLF / 行尾空格 ⇒ 仍认得出（归一化后同一份）', () => {
    const withFrontmatter = [
      '---',
      'summary: "Durable user preference and profile directives"',
      'title: "USER template"',
      'read_when:',
      '  - Bootstrapping a workspace manually',
      '---',
      '',
      TEMPLATE,
    ].join('\n');
    expect(isKernelDefaultUserMd(withFrontmatter.replace(/\n/g, '\r\n'))).toBe(true);
    expect(isKernelDefaultUserMd(TEMPLATE.replace(/\n/g, ' \n'))).toBe(true);
    expect(isKernelDefaultUserMd(`\uFEFF${TEMPLATE}\n\n`)).toBe(true);
  });

  it('🔴 用户在模板末尾追加了一条自己的 directive ⇒ 不是模板（真实内容，不许动）', () => {
    const edited = `${TEMPLATE}\n\n## 我的补充\n\n- 汇报时先给结论。\n`;
    expect(isKernelDefaultUserMd(edited)).toBe(false);
  });

  it('🔴 用户只改掉占位那一条（`- Prefer ...` → 真话，其余原封不动）⇒ 不是模板', () => {
    const edited = TEMPLATE.replace('- Prefer ...', '- Always 先给结论再给过程。');
    expect(isKernelDefaultUserMd(edited)).toBe(false);
  });

  it('普通用户内容（中文）⇒ 不是模板', () => {
    expect(isKernelDefaultUserMd('我习惯先看结论。\n\n- 用中文汇报。')).toBe(false);
  });

  it('单行 `- Prefer ...` 之类的巧合内容 ⇒ 不是模板（判据不是单行匹配）', () => {
    expect(isKernelDefaultUserMd('- Prefer ...')).toBe(false);
    expect(isKernelDefaultUserMd('# USER.md - User Model\n\n- Prefer ...')).toBe(false);
  });

  it('空内容 / 只有空白 ⇒ 不是模板（缺失文件应按空记忆处理，另走一条路）', () => {
    expect(isKernelDefaultUserMd('')).toBe(false);
    expect(isKernelDefaultUserMd('   \n\n\t\n')).toBe(false);
  });
});

describe('buildAboutYouSkeleton —— 九语言骨架（文案由调用方按 i18n 传入）', () => {
  const texts = {
    title: '关于你',
    observed: (date: string) => `观察日期：${date} ｜ 状态：有效`,
    sampleDirective: '- 用中文简洁地汇报进度',
  };

  it('结构：一级标题 + 观察注释 + 空行 + 一条示例 directive', () => {
    expect(buildAboutYouSkeleton(texts, '2026-10-18')).toBe(
      ['# 关于你', '<!-- 观察日期：2026-10-18 ｜ 状态：有效 -->', '', '- 用中文简洁地汇报进度'].join('\n'),
    );
  });

  it('不含任何内核英文模板片段（否则"本地化"就是假话）', () => {
    const skeleton = buildAboutYouSkeleton(texts, '2026-10-18');
    expect(skeleton).not.toContain('USER.md - User Model');
    expect(skeleton).not.toContain('observed:');
    expect(skeleton).not.toContain('Prefer ...');
  });

  it('语言文案换了，骨架跟着换（没有硬编码中文）', () => {
    const en = buildAboutYouSkeleton(
      {
        title: 'About You',
        observed: (date: string) => `Observed: ${date} | status: active`,
        sampleDirective: '- Prefer concise progress updates.',
      },
      '2026-10-18',
    );
    expect(en.startsWith('# About You\n')).toBe(true);
    expect(en).toContain('- Prefer concise progress updates.');
  });
});
