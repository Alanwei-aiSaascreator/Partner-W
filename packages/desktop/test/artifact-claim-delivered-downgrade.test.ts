import { describe, expect, it } from 'vitest';
import { classifyMissingClaims } from '../src/main/artifact/claim-guard.js';

/**
 * 「有真交付时，顺带提到的文件名不算交付失败」（2026-10-17 用户反馈）。
 *
 * 现场：模型生成了 pptx 并成功登记进成果列表，回复正文里却顺带写了一个不存在的名字
 * （如 `edits.PPTX`），于是聊天里多出一条红色便签「回复里提到了 edits.PPTX，工作区里没有这些文件」
 * —— 用户看到的是"我的 PPT 出问题了"，而实际上那一轮的交付是完整的。
 *
 * 判据（不放松守卫本身）：
 *   · 本轮**没有任何**真实产出 ⇒ 声称缺失照旧是失败（P0 守卫的原意就是"说做好了却什么都没有"）；
 *   · 本轮**有**真实产出 ⇒ 那些没找到的名字降级为"提及但没落盘"的信息项，只进日志，不当失败。
 */
describe('classifyMissingClaims', () => {
  it('本轮没产出 ⇒ 声称的缺失全部仍是失败（守卫不放宽）', () => {
    expect(classifyMissingClaims(['a.pptx', 'b.docx'], [])).toEqual({
      blocked: ['a.pptx', 'b.docx'],
      informational: [],
    });
  });

  it('本轮产出了同格式（.pptx）⇒ 找不到的名字降级为信息项，不阻断交付', () => {
    expect(classifyMissingClaims(['edits.PPTX'], ['荣盈魔方介绍.pptx'])).toEqual({
      blocked: [],
      informational: ['edits.PPTX'],
    });
  });

  it('⭐ 负对照：扩展名不同（产出 .html、声称 .docx）⇒ 照旧报失败（少件就是少件）', () => {
    expect(classifyMissingClaims(['report.docx'], ['report.html'])).toEqual({
      blocked: ['report.docx'],
      informational: [],
    });
  });

  it('混合同轮：同格式降级、异格式仍拦', () => {
    expect(classifyMissingClaims(['a.pptx', 'b.docx'], ['c.pptx'])).toEqual({
      blocked: ['b.docx'],
      informational: ['a.pptx'],
    });
  });

  it('没有缺失就没有任何项（空集保持空集）', () => {
    expect(classifyMissingClaims([], ['a.pptx'])).toEqual({ blocked: [], informational: [] });
    expect(classifyMissingClaims([], [])).toEqual({ blocked: [], informational: [] });
  });

  it('不吞掉内容：信息项与失败项的并集等于原缺失集合', () => {
    const missing = ['x.pptx', 'y.docx'];
    const result = classifyMissingClaims(missing, ['z.pptx']);
    expect([...result.blocked, ...result.informational].sort()).toEqual([...missing].sort());
  });
});
