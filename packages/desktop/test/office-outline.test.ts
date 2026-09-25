/**
 * `docx` / `pptx` 的**文字大纲**预览。
 *
 * 为什么做"大纲"而不是像素级还原：像素级要引渲染库（有打包前科，见 zip-entry 的说明），
 * 而用户真正缺的是**"我刚做出来的那份东西里写了什么"** —— 逐页标题与正文就够。
 * ⚠️ 界面上要**如实说这是文字版**，不许装成完整还原。
 *
 * ⭐ 夹具还是真库产的真文件（`docx` / `pptxgenjs`）。
 */
import { Packer, Document, Paragraph, TextRun } from 'docx';
import PptxGenJS from 'pptxgenjs';
import { describe, expect, it } from 'vitest';
import { readDocxOutline, readPptxOutline } from '../src/main/preview/office-outline.js';

async function docxOf(paragraphs: string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [{ children: paragraphs.map((text) => new Paragraph({ children: [new TextRun(text)] })) }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function pptxOf(slides: string[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  for (const text of slides) {
    const slide = pptx.addSlide();
    slide.addText(text, { x: 0.5, y: 0.5, w: 8, h: 2 });
  }
  return Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as Buffer);
}

describe('readDocxOutline', () => {
  it('每个段落一行，中文原样', async () => {
    const outline = await readDocxOutline(await docxOf(['第一段', '第二段']));

    expect(outline.paragraphs).toEqual(['第一段', '第二段']);
    expect(outline.truncated).toBe(false);
  });

  it('⭐ XML 实体要解回来（`&amp;` 不许原样上屏）', async () => {
    const outline = await readDocxOutline(await docxOf(['A & B', '小于 < 大于']));

    expect(outline.paragraphs[0]).toBe('A & B');
    expect(outline.paragraphs[1]).toContain('<');
    expect(outline.paragraphs.join()).not.toContain('&amp;');
    expect(outline.paragraphs.join()).not.toContain('&lt;');
  });

  it('对照：不是 docx ⇒ 明确报错，不是崩', async () => {
    await expect(readDocxOutline(Buffer.from('不是 docx'))).rejects.toThrow();
  });
});

describe('readPptxOutline', () => {
  it('逐页给文字，**按页序**', async () => {
    const outline = await readPptxOutline(await pptxOf(['第一页', '第二页', '第三页']));

    expect(outline.slides.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(outline.slides[0].lines.join()).toContain('第一页');
    expect(outline.slides[2].lines.join()).toContain('第三页');
  });

  it('⭐⭐ 十一页以上要**按数字排**（`slide10` 字典序排在 `slide2` 前面 —— 那是错的）', async () => {
    const texts = Array.from({ length: 11 }, (_, i) => `第 ${i + 1} 页`);
    const outline = await readPptxOutline(await pptxOf(texts));

    expect(outline.slides.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(outline.slides[9].lines.join(), '第 10 页要在第 9 页后面').toContain('第 10 页');
    expect(outline.slides[10].lines.join()).toContain('第 11 页');
  });

  it('对照：不是 pptx ⇒ 明确报错，不是崩', async () => {
    await expect(readPptxOutline(Buffer.from('不是 pptx'))).rejects.toThrow();
  });

  it('⭐ 空白页也要占一个位（少一页会让后面所有页码错位）', async () => {
    const pptx = new PptxGenJS();
    pptx.addSlide();
    pptx.addSlide().addText('有字的一页', { x: 0.5, y: 0.5, w: 6, h: 1 });
    const outline = await readPptxOutline(Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as Buffer));

    expect(outline.slides).toHaveLength(2);
    expect(outline.slides[0].lines).toEqual([]);
    expect(outline.slides[1].lines.join()).toContain('有字的一页');
  });
});
