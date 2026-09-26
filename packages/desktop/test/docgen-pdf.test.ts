/**
 * `docgen` 的第四种 kind：`pdf`（2026-09-26）。
 *
 * 为什么不是引一个 PDF 库：中文字体要么内嵌（包体 +15~20 MB，商用授权要单独谈），
 * 要么在别人机器上渲染成方块。而 Electron **自带** Chromium 的打印管线
 * （`printToPDF`）—— 和用户自己用浏览器"打印成 PDF"同一条路，中文靠系统字体天然可用，
 * 零新依赖、零字体分发。
 *
 * ⚠️ 这条路唯一的风险面是"把助手写的内容当 HTML 塞进一个隐藏窗口"，所以：
 *      1. 内容**逐字转义**（`<` `>` `&` 全转）—— 助手写的 `<script>` 只是一个尖括号；
 *      2. 打印窗口 `javascript: false` + `sandbox` + 无 preload（见 `render-pdf.ts`）；
 *      3. 我们生成的 HTML **不许有任何外部引用**（下面有专门一条钉住它）。
 */
import { describe, expect, it, vi } from 'vitest';

import { DOCGEN_KINDS, DOCGEN_OUTPUT_BY_KIND, parseDocgenRequest } from '../src/main/docgen/request.js';
import { buildPdfHtml, renderPdf } from '../src/main/docgen/render-pdf.js';

describe('docgen 契约：kind = pdf', () => {
  it('kind 里多了 pdf，且扩展名是 .pdf', () => {
    expect([...DOCGEN_KINDS]).toContain('pdf');
    expect(DOCGEN_OUTPUT_BY_KIND.pdf.extension).toBe('.pdf');
  });

  it('⭐ 与 docx 同构：title + sections（小标题 / 段落 / 要点）', () => {
    const result = parseDocgenRequest({
      kind: 'pdf',
      title: '本周进展',
      sections: [{ heading: '一、结论', paragraphs: ['先看结论'], bullets: ['转化率 12%'] }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.kind).toBe('pdf');
    if (result.request.kind !== 'pdf') return;
    expect(result.request.title).toBe('本周进展');
    expect(result.request.sections[0].heading).toBe('一、结论');
    expect(result.request.sections[0].bullets).toEqual(['转化率 12%']);
  });

  it('sections 空 / 全是空小节 ⇒ 整份拒（不产一份空白 PDF）', () => {
    expect(parseDocgenRequest({ kind: 'pdf', title: 'x', sections: [] }).ok).toBe(false);
    expect(parseDocgenRequest({ kind: 'pdf', title: 'x', sections: [{ heading: '只有标题' }] }).ok).toBe(true);
    expect(parseDocgenRequest({ kind: 'pdf', title: 'x', sections: [{}] }).ok).toBe(false);
  });

  it('⭐ 上限与 docx 同一条线（40 小节 / 2000 字段落）', () => {
    const sections = Array.from({ length: 41 }, (_, i) => ({ heading: `第 ${i} 节`, paragraphs: ['正文'] }));
    const tooMany = parseDocgenRequest({ kind: 'pdf', title: 'x', sections });

    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error).toContain('40');

    const tooLong = parseDocgenRequest({
      kind: 'pdf',
      title: 'x',
      sections: [{ paragraphs: ['字'.repeat(2001)] }],
    });
    expect(tooLong.ok).toBe(false);
  });
});

describe('buildPdfHtml', () => {
  const request = {
    kind: 'pdf' as const,
    title: '内测汇报',
    sections: [
      { heading: '一、进展', paragraphs: ['本周完成 3 项'], bullets: ['预览能看了', '更新能点了'] },
      { paragraphs: ['没有小标题的一段'], bullets: [] },
    ],
  };

  it('标题、小标题、段落、要点都进 HTML', () => {
    const html = buildPdfHtml(request);

    expect(html).toContain('内测汇报');
    expect(html).toContain('一、进展');
    expect(html).toContain('本周完成 3 项');
    expect(html).toContain('预览能看了');
    expect(html).toContain('没有小标题的一段');
    expect(html).toContain('<li>');
  });

  it('⭐ 助手写的内容逐字转义 —— `<script>` 只是一个尖括号', () => {
    const html = buildPdfHtml({
      kind: 'pdf',
      title: '<img src=x onerror=alert(1)>',
      sections: [{ heading: '<b>粗</b>', paragraphs: ['<script>alert(1)</script>'], bullets: ['a & b'] }],
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>粗</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
  });

  it('⭐ 不许有任何外部引用（打印窗口不该联网）', () => {
    const html = buildPdfHtml(request);

    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/\bsrc=/i);
    // 样式必须内联（外链 CSS 在沙箱窗口里也加载不到）
    expect(html).toContain('<style>');
  });

  it('中文用系统字体（不内嵌字体、也不依赖网络字体）', () => {
    const html = buildPdfHtml(request);

    expect(html).toContain('Microsoft YaHei');
    expect(html).not.toContain('@font-face');
    expect(html).not.toContain('fonts.googleapis');
  });

  it('转义同时保留排版：换行在段落里不塌成一坨', () => {
    const html = buildPdfHtml({
      kind: 'pdf',
      title: 't',
      sections: [{ paragraphs: ['第一行\n第二行'], bullets: [] }],
    });

    expect(html).toContain('第一行\n第二行');
  });
});

describe('renderPdf', () => {
  it('⭐ 把 HTML 交给打印器，拿回它的 buffer（打印那一步可注入）', async () => {
    const print = vi.fn(async () => Buffer.from('%PDF-1.4 假的可交付'));

    const buffer = await renderPdf(
      { kind: 'pdf', title: '周报', sections: [{ paragraphs: ['正文'], bullets: [] }] },
      print,
    );

    expect(print).toHaveBeenCalledTimes(1);
    expect(print.mock.calls[0][0]).toContain('正文');
    expect(buffer.toString()).toContain('%PDF-1.4');
  });
});
