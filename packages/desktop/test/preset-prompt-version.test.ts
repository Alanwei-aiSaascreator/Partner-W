import { describe, expect, it } from 'vitest';
import {
  COMMON_OPERATING_CONTRACT,
  PRESET_AGENT_DEFINITIONS,
  PRESET_PROMPT_VERSION,
  readPresetPromptVersion,
  stampPresetPrompt,
} from '../src/renderer/lib/preset-agents';

/**
 * 预置助手提示词的**版本标记**与**交付边界**。
 *
 * 两件事都在 2026-09-24 落地，起因是同事的真机反馈：
 * 助手会许诺"我给你出个 PPT"，而运行时**没有任何文档生成能力**
 * （35047 个文件里搜 pptx/pptxgenjs/officegen/exceljs/python-pptx/libreoffice 全 0）。
 *
 * 边界写进六个预置助手共用的契约里（对**新装**立刻生效）；
 * 标记是**将来能把改动推到已有盘**的前提 —— 安装器只在文件缺失时才写，
 * 没有标记就永远分不清"我们写的旧版本"和"用户自己改过的"。
 */
describe('交付边界（COMMON_OPERATING_CONTRACT）', () => {
  it('⭐ 四种文档（pptx / docx / xlsx / pdf）都是**有条件**的可能：技能可见才承诺', () => {
    for (const ext of ['.pptx', '.docx', '.xlsx', '.pdf']) {
      expect(COMMON_OPERATING_CONTRACT, ext).toContain(ext);
    }
    expect(COMMON_OPERATING_CONTRACT).toMatch(/docgen/i);
    expect(COMMON_OPERATING_CONTRACT, '技能不可见时的口径').toMatch(/skill is \*\*not\*\* available/i);
  });

  it('uses actual image tool availability instead of refusing every image request', () => {
    expect(COMMON_OPERATING_CONTRACT).not.toMatch(/cannot\*{0,2} produce images/i);
    expect(COMMON_OPERATING_CONTRACT).toMatch(/image_generate` is available, use that tool/);
    expect(COMMON_OPERATING_CONTRACT).toMatch(/tool is unavailable, state the specific missing capability/);
    expect(COMMON_OPERATING_CONTRACT).toMatch(/verify its actual output before claiming completion/);
  });

  it('does not invent image job progress or image links', () => {
    expect(COMMON_OPERATING_CONTRACT).toMatch(/Do not claim an image job is\s+running before the tool accepts it/);
    expect(COMMON_OPERATING_CONTRACT).toContain('fictitious image links');
  });

  it('includes the capability-driven image contract in every preset soul', () => {
    for (const definition of PRESET_AGENT_DEFINITIONS) {
      expect(definition.soulMd, definition.id).toContain('image_generate');
      expect(definition.soulMd, definition.id).not.toMatch(/cannot\*{0,2} produce images/i);
    }
  });

  it('⭐ 别把三种文档写成"已经能了"——边界句必须挂着技能这个前提', () => {
    // 反面判据：老的"docx / xlsx 做不到"那句必须已经删掉（否则模型会照旧拒绝 Word）
    expect(COMMON_OPERATING_CONTRACT).not.toMatch(/cannot[\s\S]{0,40}produce[\s\S]{0,20}\.docx/i);
  });

  it('distinguishes submitted source from verified output files', () => {
    expect(COMMON_OPERATING_CONTRACT).toContain('submitted for generation');
    expect(COMMON_OPERATING_CONTRACT).toContain('already exists or is guaranteed to appear');
    expect(COMMON_OPERATING_CONTRACT).toMatch(/verify the actual output file\s+before claiming success/);
    expect(COMMON_OPERATING_CONTRACT).toContain('a plan, source file, or script alone is not the requested PPT');
  });

  it('工作区之外（例如桌面）不许声称能直接拿到', () => {
    expect(COMMON_OPERATING_CONTRACT).toMatch(/desktop/i);
    expect(COMMON_OPERATING_CONTRACT).toMatch(/do not claim you can reach other locations/i);
  });

  it('六个预置助手的 SOUL 都带着这份契约（漏一个就等于那个助手还在许诺）', () => {
    expect(PRESET_AGENT_DEFINITIONS.length).toBe(6);
    for (const definition of PRESET_AGENT_DEFINITIONS) {
      expect(definition.soulMd, `${definition.id} 的 SOUL 缺交付边界`).toContain('## Delivery boundary');
    }
  });
});

describe('stampPresetPrompt', () => {
  it('盖出的标记是 HTML 注释（markdown 渲染不可见，不干扰模型看正文）', () => {
    const stamped = stampPresetPrompt('正文');
    expect(stamped).toContain(`<!-- mofang-prompt:${PRESET_PROMPT_VERSION} -->`);
    expect(stamped.startsWith('正文')).toBe(true);
  });

  it('幂等：盖两次不会叠出两个标记', () => {
    const once = stampPresetPrompt('正文');
    const twice = stampPresetPrompt(once);
    expect(twice).toBe(once);
    expect(twice.match(/mofang-prompt:/g)?.length, '只能有一个标记').toBe(1);
  });

  it('换版本号再盖 ⇒ 标记被替换成新的，不会两个并存', () => {
    const older = stampPresetPrompt('正文', '2020-01-01.1');
    const newer = stampPresetPrompt(older, '2030-01-01.1');
    expect(newer.match(/mofang-prompt:/g)?.length).toBe(1);
    expect(readPresetPromptVersion(newer)).toBe('2030-01-01.1');
  });

  it('标记在**末尾**（正文一个字都不动）', () => {
    const stamped = stampPresetPrompt('# 标题\n\n- 一条要求');
    const lines = stamped.split('\n').filter(Boolean);
    expect(lines.slice(0, 2), '正文原样在前').toEqual(['# 标题', '- 一条要求']);
    expect(lines.at(-1), '标记只能在最后一行').toContain('<!-- mofang-prompt:');
  });
});

describe('readPresetPromptVersion —— 认得出"是不是我们写的"', () => {
  it('我们盖过的 ⇒ 读得出版本', () => {
    expect(readPresetPromptVersion(stampPresetPrompt('正文'))).toBe(PRESET_PROMPT_VERSION);
  });

  it('⭐ 没有标记 ⇒ null（旧版写的或**用户自己改过的**，两种都必须当成"不是我们的"）', () => {
    expect(readPresetPromptVersion('# 我自己写的身份\n\n- 随便写点')).toBeNull();
  });

  it('负对照：随便一段带注释的文字不会被误认', () => {
    expect(readPresetPromptVersion('<!-- 这是普通注释 -->\n正文')).toBeNull();
    expect(readPresetPromptVersion('<!-- mofang-prompt -->')).toBeNull();
  });

  it('六个预置助手的原文**都不带**标记（标记由写入方盖，定义保持纯净）', () => {
    for (const definition of PRESET_AGENT_DEFINITIONS) {
      expect(readPresetPromptVersion(definition.identityMd), `${definition.id}.identityMd`).toBeNull();
      expect(readPresetPromptVersion(definition.soulMd), `${definition.id}.soulMd`).toBeNull();
    }
  });
});
