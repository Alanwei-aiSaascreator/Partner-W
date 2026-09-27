import { describe, expect, it } from 'vitest';
import {
  COMMON_OPERATING_CONTRACT,
  PRESET_AGENT_DEFINITIONS,
  PRESET_PROMPT_VERSION,
} from '../src/renderer/lib/preset-agents';

/**
 * 交付合同（`COMMON_OPERATING_CONTRACT`）会**每一轮全文注入**给每个预置助手，
 * 而它的"交付边界"是一张**封闭清单**。
 *
 * ⭐ 为什么必须钉死：2026-09-27 真机反馈里「生成 html 出不来、让我自己复制」的**头号原因**
 *    就是这张清单**只列了 pptx/docx/xlsx/pdf、没有 html** ——
 *    而 `htmlgen` 通道的用法只写在一份 `SKILL.md` 里，**技能正文不进系统提示词**
 *    （运行时只注入一份"名字 + 一行描述"的技能目录，模型得**自己决定**去读那个文件）。
 *    一边是每轮全额的封闭清单，一边是要主动去翻的文档 ⇒ **模型按清单走完全合理**，
 *    错的是清单没把通道列进去。
 *
 * ⇒ **加任何新的交付通道，都必须同时改这里。** 漏了 = 那条通道在用户侧等于不存在，
 *    而且表现成"产品做不到"，不是"没接线"。
 */
describe('预置助手的交付合同：每条通道都要在清单里', () => {
  it('⭐ 网页（html）必须在清单里，并点名 htmlgen 与那个技能', () => {
    expect(COMMON_OPERATING_CONTRACT, '没写网页交付这一条').toMatch(/Web pages \(\.html\)/);
    expect(COMMON_OPERATING_CONTRACT, '没点名 htmlgen 这条 fence 通道').toContain('htmlgen');
    expect(COMMON_OPERATING_CONTRACT, '没点名技能 slug，模型不知道去翻哪一份').toContain('html-deliverable');
  });

  it('⭐ 必须明说"别自己写 HTML、别让用户手动存" —— 那正是上一轮的失败形态', () => {
    expect(COMMON_OPERATING_CONTRACT).toMatch(/never hand the user markup to save/);
    // ⚠️ 合同正文里有 Markdown 斜体（`is *not* a 产物`）⇒ 正则要把星号带上，
    //    否则查的是"没有星号的版本"，永远匹配不到（就是这次踩的）。
    expect(COMMON_OPERATING_CONTRACT, '要说清自己写的页面不算「产物」').toMatch(/not\*?\s*a 产物/);
  });

  it('四件文档那条**还在**（加新的别把旧的挤掉）', () => {
    expect(COMMON_OPERATING_CONTRACT).toMatch(/\.pptx \/ \.docx \/ \.xlsx \/ \.pdf/);
    expect(COMMON_OPERATING_CONTRACT).toContain('docgen');
  });

  it('"不许声称文件已经存在"那条还在（网页也一样适用）', () => {
    expect(COMMON_OPERATING_CONTRACT).toMatch(/Never claim a file already exists/);
  });

  it('⭐ 合同真的被拼进了每个助手的 SOUL（否则改了也不生效）', () => {
    const needle = 'Web pages (.html)';
    for (const agent of PRESET_AGENT_DEFINITIONS) {
      expect(agent.soulMd, `${agent.id} 的 SOUL 里没有交付合同片段`).toContain(needle);
    }
  });

  it('提示词版本号是当前那一版（改了合同就该动它）', () => {
    // 这一版加了网页交付那条。版本号是"将来能不能安全升级已发出去的盘"的唯一依据
    // （见 preset-agents.ts 里 PRESET_PROMPT_VERSION 的注释）。
    expect(PRESET_PROMPT_VERSION).toBe('2026-09-27.1');
  });
});
