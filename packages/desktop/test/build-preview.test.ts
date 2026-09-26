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
import { MAX_HTML_PREVIEW_BYTES, buildArtifactPreview } from '../src/main/preview/build-preview.js';

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

/**
 * `.html` 富预览（2026-09-26）。
 *
 * ⚠️ 这是本项目里**唯一一种"内容本身就是可执行的东西"**的预览：
 *    一份 HTML 里可以带 `<script>`，而渲染它的地方是**应用自己的界面**。
 *    所以判据不是"能不能画出来"，而是**"脚本跑不跑、外链连不连"**。
 *    真正的封堵在渲染层（`<iframe sandbox>` 不给 allow-scripts / allow-same-origin），
 *    主进程这一层负责**注入 CSP**（第二道锁：就算哪天 sandbox 属性被改错，外联仍然断）。
 */
describe('buildArtifactPreview — .html', () => {
  const page = (body: string) =>
    Buffer.from(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`, 'utf8');

  it('.html ⇒ html（原文保留）', async () => {
    const preview = await buildArtifactPreview('页面.html', page('<h1>标题</h1>'));

    expect(preview.kind).toBe('html');
    if (preview.kind === 'html') expect(preview.html).toContain('<h1>标题</h1>');
  });

  it('⭐ 必须注入 CSP，且**禁脚本、禁外联**（这是第二道锁）', async () => {
    const preview = await buildArtifactPreview('页面.html', page('<p>x</p>'));

    expect(preview.kind).toBe('html');
    if (preview.kind !== 'html') return;
    expect(preview.html).toContain('http-equiv="Content-Security-Policy"');
    expect(preview.html).toContain("default-src 'none'");
    expect(preview.html).not.toContain("script-src 'unsafe-inline'");
  });

  it('⭐ CSP 要插在 <head> 里（放 body 里对后面的内容不生效）', async () => {
    const preview = await buildArtifactPreview('页面.html', page('<p>x</p>'));

    if (preview.kind !== 'html') throw new Error('不是 html');
    const headEnd = preview.html.indexOf('</head>');
    const cspAt = preview.html.indexOf('Content-Security-Policy');
    expect(cspAt, 'CSP 必须在 </head> 之前').toBeLessThan(headEnd);
  });

  it('没有 <head> 的裸片段也能看（插在最前面）', async () => {
    const preview = await buildArtifactPreview('片段.html', Buffer.from('<p>裸片段</p>', 'utf8'));

    if (preview.kind !== 'html') throw new Error('不是 html');
    expect(preview.html).toContain('Content-Security-Policy');
    expect(preview.html).toContain('<p>裸片段</p>');
  });

  it('中文按 UTF-8 解码（不能是乱码）', async () => {
    const preview = await buildArtifactPreview('中文.html', page('<p>荣盈魔方</p>'));

    if (preview.kind !== 'html') throw new Error('不是 html');
    expect(preview.html).toContain('荣盈魔方');
  });

  it('⭐ 大小写混写与 .htm 都认', async () => {
    expect((await buildArtifactPreview('报告.HTML', page('a'))).kind).toBe('html');
    expect((await buildArtifactPreview('老页面.htm', page('a'))).kind).toBe('html');
  });

  it('⭐ 超过上限 ⇒ unsupported（回退成文本视图，而不是把几十兆塞进 IPC）', async () => {
    const huge = Buffer.alloc(MAX_HTML_PREVIEW_BYTES + 1, 0x61);

    expect(await buildArtifactPreview('巨大.html', huge)).toEqual({ kind: 'unsupported' });
  });
});
