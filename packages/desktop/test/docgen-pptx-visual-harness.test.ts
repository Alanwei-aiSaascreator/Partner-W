import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_BODY_PT, MIN_BODY_PT, bodyFontSizePt, findPptxLayoutProblem } from '../src/main/docgen/pptx-layout';
import { paginatePptxRequest } from '../src/main/docgen/pptx-pagination';
import { documentFileNameFor } from '../src/main/docgen/generate';
import { parseDocgenRequest } from '../src/main/docgen/request';
import { renderPptx } from '../src/main/docgen/render-pptx';

/**
 * **人工视觉验收的材料准备**（不是视觉验收本身）。
 *
 * 它把三份样本渲染成真 .pptx 落在一个固定目录里，好让人用 WPS / PowerPoint 打开看。
 * ⚠️ 这个文件**证明不了**"版面没重叠、没裁切" —— 那件事只有真渲染器回看能证明，
 *    见本仓的 WPS 渲染流程。它只保证"要看的这三份确实出得来、而且是我想验的那三种体量"。
 *
 * 落点在**系统临时目录**（不是仓库、不是桌面）—— 本仓对"写到工作区外"有明确规矩。
 */

const OUT_DIR = join(tmpdir(), 'partner-w-ppt-visual');

const NORMAL_FIVE_PAGES = {
  kind: 'pptx',
  title: '九月经营简报',
  subtitle: '2026-09-26 · 产品组',
  slides: [
    { title: '本月完成情况', bullets: ['文档生成能力已落地', '文件导入提示已修复', 'U 盘更新通道已恢复'] },
    { title: '关键指标', bullets: ['周活 1,240', '留存 38%', '平均时长 21 分钟'] },
    { title: '问题与风险', bullets: ['更新链上偶发启动器卡死', '已加日志留档'] },
    { title: '下一步计划', bullets: ['PPT 主题与配色', '真盘验收', '发布到稳定通道'] },
    { title: '需要支持', bullets: ['一台干净的测试机', '一张测试用激活卡'] },
  ],
};

const BORDERLINE_MIXED = {
  kind: 'pptx',
  title: 'Q3 Review & 1.0.1 Plan',
  subtitle: '2026-09-26 · Product / Engineering',
  slides: [
    {
      title: 'What shipped（本轮交付）',
      bullets: Array.from(
        { length: 12 },
        (_, i) => `第 ${i + 1} 项：docgen 版面保护已落地，relay 侧文生图已就绪，等待一次真实 smoke test 后启用。`,
      ),
    },
  ],
};

const AT_THE_FLOOR = {
  kind: 'pptx',
  title: '满版压力样本',
  subtitle: 'Dense source pagination',
  slides: [
    {
      title: '这一页正好压在下限',
      bullets: [
        ...Array.from({ length: 11 }, (_, i) => `第 ${i + 1} 项：这是一条长度正常、只占一行的要点内容。`),
        'Item 12: retain the full explanation through automatic pagination rather than shrinking the body text to fit a crowded source slide.',
      ],
    },
  ],
};

describe('人工视觉验收：把三份样本落到临时目录', () => {
  it('⭐ 三份都出得来，且"临界"那份确实是临界的', async () => {
    mkdirSync(OUT_DIR, { recursive: true });

    const written: Array<{ name: string; size: number }> = [];
    for (const [stem, raw] of [
      ['1-normal-5page-cn', NORMAL_FIVE_PAGES],
      ['2-borderline-mixed-cn-en', BORDERLINE_MIXED],
      ['3-at-the-floor-18pt', AT_THE_FLOOR],
    ] as const) {
      const parsed = parseDocgenRequest(raw);
      if (!parsed.ok) throw new Error(`样本不合法：${parsed.error}`);
      if (parsed.request.kind !== 'pptx') throw new Error('样本 kind 不对');
      expect(findPptxLayoutProblem(paginatePptxRequest(parsed.request)), `${stem} 本该通过`).toBeNull();

      const buffer = await renderPptx(parsed.request);
      // ⚠️ 落盘名用**纯 ASCII**，不用 `documentFileNameFor` 那套（标题里的 `&` 会把
      //    WPS 的 COM `SaveAs(目录, 18)` 输出路径切坏，导出的 PNG 连扩展名都不对）。
      //    这里验的是版面，不是文件命名 —— 产品侧的文件名规则另有一组测试钉着。
      expect(documentFileNameFor(parsed.request.title, 'pptx')).toMatch(/\.pptx$/);
      const path = join(OUT_DIR, `${stem}.pptx`);
      writeFileSync(path, buffer);
      written.push({ name: path, size: buffer.length });
    }

    for (const file of written) {
      expect(existsSync(file.name), file.name).toBe(true);
      expect(file.size, `${file.name} 太小，多半是空文件`).toBeGreaterThan(10_000);
    }

    for (const raw of [NORMAL_FIVE_PAGES, BORDERLINE_MIXED, AT_THE_FLOOR]) {
      const result = parseDocgenRequest(raw);
      if (!result.ok || result.request.kind !== 'pptx') throw new Error('Invalid visual fixture');
      for (const slide of paginatePptxRequest(result.request).slides) {
        const size = bodyFontSizePt(slide.bullets);
        expect(size).toBeGreaterThanOrEqual(MIN_BODY_PT);
        expect(size).toBeLessThanOrEqual(MAX_BODY_PT);
      }
    }
  });

  it('reports raw body overflow before pagination without rejecting valid content', () => {
    const raw = {
      kind: 'pptx',
      title: '此前超量样本',
      slides: [{ title: '爆页', bullets: Array.from({ length: 12 }, () => '内'.repeat(300)) }],
    };
    const parsed = parseDocgenRequest(raw);
    if (!parsed.ok) throw new Error(`样本不合法：${parsed.error}`);
    if (parsed.request.kind !== 'pptx') throw new Error('样本 kind 不对');

    expect(findPptxLayoutProblem(parsed.request)).toEqual({ code: 'slide-body-overflow', page: 1 });
    expect(findPptxLayoutProblem(paginatePptxRequest(parsed.request))).toBeNull();
  });
});
