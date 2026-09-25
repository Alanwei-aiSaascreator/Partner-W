/**
 * 按扩展名分派到三个读法之一。
 *
 * ⚠️ 分派**按扩展名不按 MIME**：产物的 `mimeType` 是写库那一刻定的，历史数据里五花八门
 *    （甚至是空的），而扩展名是用户看得见的那个。
 */
import { Packer, Document, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { describe, expect, it } from 'vitest';
import { buildArtifactPreview } from '../src/main/preview/build-preview.js';

describe('buildArtifactPreview', () => {
  it('.xlsx ⇒ sheet（读出行列）', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('表').addRow(['甲', '乙']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const preview = await buildArtifactPreview('月度统计.xlsx', buffer);

    expect(preview.kind).toBe('sheet');
    if (preview.kind === 'sheet') expect(preview.sheets[0].rows[0]).toEqual(['甲', '乙']);
  });

  it('.docx ⇒ docx（读出段落）', async () => {
    const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('周报正文')] })] }] });
    const buffer = Buffer.from(await Packer.toBuffer(doc));

    const preview = await buildArtifactPreview('周报.docx', buffer);

    expect(preview.kind).toBe('docx');
    if (preview.kind === 'docx') expect(preview.paragraphs[0]).toBe('周报正文');
  });

  it('.pptx ⇒ pptx（读出逐页）', async () => {
    const pptx = new PptxGenJS();
    pptx.addSlide().addText('封面', { x: 1, y: 1, w: 4, h: 1 });
    const buffer = Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as Buffer);

    const preview = await buildArtifactPreview('汇报.pptx', buffer);

    expect(preview.kind).toBe('pptx');
    if (preview.kind === 'pptx') expect(preview.slides[0].lines.join()).toContain('封面');
  });

  it('.pdf ⇒ pdf（把字节交出去，交给 Chromium 自带的阅读器）', async () => {
    const bytes = Buffer.from('%PDF-1.4\n假的但扩展名对\n');

    const preview = await buildArtifactPreview('说明书.pdf', bytes);

    expect(preview.kind).toBe('pdf');
    if (preview.kind === 'pdf') expect(Buffer.from(preview.dataBase64, 'base64')).toEqual(bytes);
  });

  it('⭐ 大小写混写一样认（`报告.XLSX` 是用户拖进来的常见形状）', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('表').addRow(['甲']);
    const preview = await buildArtifactPreview('报告.XLSX', Buffer.from(await wb.xlsx.writeBuffer()));

    expect(preview.kind).toBe('sheet');
  });

  it('对照：不认识的扩展名 ⇒ unsupported（界面照旧"用系统程序打开"）', async () => {
    expect(await buildArtifactPreview('备注.txt', Buffer.from('随便'))).toEqual({ kind: 'unsupported' });
    expect(await buildArtifactPreview('没有扩展名', Buffer.from('随便'))).toEqual({ kind: 'unsupported' });
  });

  it('⭐ 扩展名对但内容坏 ⇒ **抛**（不是静默说"不支持"）', async () => {
    // 静默降级会让界面说"这种格式本来就不支持" —— 那是假话，且指向错误的下一步
    await expect(buildArtifactPreview('坏表.xlsx', Buffer.from('这不是表格'))).rejects.toThrow();
    await expect(buildArtifactPreview('坏文档.docx', Buffer.from('这不是文档'))).rejects.toThrow();
  });
});
