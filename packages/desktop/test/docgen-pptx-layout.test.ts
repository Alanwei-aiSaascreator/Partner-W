import { describe, expect, it } from 'vitest';
import {
  BODY_BOX,
  LINE_SPACING,
  MAX_BODY_PT,
  MIN_BODY_PT,
  bodyFontSizePt,
  estimateBodyHeightPt,
} from '../src/main/docgen/pptx-layout';

/**
 * 正文字号是**算出来的**，不是写死的。
 *
 * 写死 18pt 是量出来的 bug（2026-09-26，WPS 渲染成图看的）：
 * 12 条短要点就把第 1 条压在标题上；12 条 × 300 字上下都冲出版面。
 * 而契约允许一页 12 条（`DOCGEN_LIMITS` 是 P1 定死的，不许动）⇒ 只能从排版侧解决。
 *
 * ⚠️ "装得下"这条判据用的是 `estimateBodyHeightPt` —— 也就是**实现自己那个模型**，
 *    所以它只能证明"按这个模型自洽"，**证明不了模型符合真渲染器**。
 *    符合与否是靠渲染成图回看验的，不在这条测试的射程里。
 */

const SHORT = ['文档生成能力：方案已出', '文件导入提示：已修'];

/** 一条刚好顶到上限的要点（300 字）。 */
const maxBullet = (tag: string): string => {
  const head = `${tag}：`;
  return head + '内'.repeat(300 - head.length);
};

describe('bodyFontSizePt —— 现实体量必须装得下', () => {
  it('短要点仍用最大字号（不能无谓地把正常内容缩小）', () => {
    expect(bodyFontSizePt(SHORT)).toBe(MAX_BODY_PT);
  });

  it('12 条短要点（真会踩到的体量）必须缩小，且算出来的字号真装得下', () => {
    const bullets = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 条要点，简短一句`);
    const size = bodyFontSizePt(bullets);
    expect(size).toBeLessThan(MAX_BODY_PT);
    expect(estimateBodyHeightPt(bullets, size)).toBeLessThanOrEqual(BODY_BOX.h * 72);
  });

  it('一份中等的真实汇报（4 页 × 4 条）每页都装得下', () => {
    const pages = [
      [
        '文档生成能力：方案已出并落地',
        '文件导入提示：已修复并复验',
        'U 盘更新通道：已恢复',
        '电脑操控权限：两档已上线',
      ],
      ['本周主要问题：更新链上偶发启动器卡死，已加日志留档以便下次定性'],
      ['下周计划：PPT 排版保真', '多版式与主题', '真盘验收', '发布 1.0.0 到稳定通道'],
      ['需要支持：一台干净的测试机', '一张测试用激活卡'],
    ];
    for (const bullets of pages) {
      const size = bodyFontSizePt(bullets);
      expect(estimateBodyHeightPt(bullets, size)).toBeLessThanOrEqual(BODY_BOX.h * 72);
    }
  });

  it('内容越多，字号只减不增（单调）', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let count = 1; count <= 12; count += 1) {
      const size = bodyFontSizePt(Array.from({ length: count }, (_, i) => `第 ${i + 1} 条，中等长度的要点内容`));
      expect(size).toBeLessThanOrEqual(previous);
      previous = size;
    }
  });

  it('空页不炸（纯标题页是合法的）', () => {
    expect(bodyFontSizePt([])).toBe(MAX_BODY_PT);
  });
});

describe('bodyFontSizePt —— 已知装不下的极限（如实钉住，不假装修好了）', () => {
  // 12 条 × 300 字 = 3600 字压一页。就算缩到 8pt 也要 400pt 高，而框只有 230pt
  // —— 那不是"字号没算对"，是**内容本身就超过一页**。
  // 真正的解法是按内容自动分页（schema 的 slides 与页是 1:1，那是一次契约改动），
  // 不在这一刀里。这条测试的作用是：让这个缺口**显式存在**，而不是悄悄糊过去。
  it('12 条 × 300 字一页装不下，字号停在下限而不是无限缩下去', () => {
    const bullets = Array.from({ length: 12 }, (_, i) => maxBullet(`要点${i + 1}`));
    expect(bodyFontSizePt(bullets)).toBe(MIN_BODY_PT);
    expect(estimateBodyHeightPt(bullets, MIN_BODY_PT)).toBeGreaterThan(BODY_BOX.h * 72);
  });

  it('下限本身是"还看得见"，不是能一直缩', () => {
    expect(MIN_BODY_PT).toBeGreaterThanOrEqual(10);
    expect(MIN_BODY_PT).toBeLessThan(MAX_BODY_PT);
  });
});

describe('estimateBodyHeightPt —— 模型自身的口径', () => {
  it('空内容为 0（不占高度）', () => {
    expect(estimateBodyHeightPt([], 18)).toBe(0);
  });

  it('字号越大，同一份内容越高', () => {
    expect(estimateBodyHeightPt(SHORT, 18)).toBeGreaterThan(estimateBodyHeightPt(SHORT, 12));
  });

  it('行距倍数是被用上的（不是摆设）', () => {
    // 两条同高内容的差 = 1 行 × 字号 × 行距
    const one = estimateBodyHeightPt(['短'], 18);
    const two = estimateBodyHeightPt(['短', '短'], 18);
    expect(two - one).toBeCloseTo(18 * LINE_SPACING + 3, 5);
  });
});
