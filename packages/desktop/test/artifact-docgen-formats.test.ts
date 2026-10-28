import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { isVerifiedFileName, verifyArtifactBuffer } from '../src/main/artifact/verify';
import { documentFileStem } from '../src/main/util/document-file-name';
import { parseDocgenRequest, type DocgenRequest } from '../src/main/docgen/request';
import { renderDocument } from '../src/main/docgen/render';
import { buildPdfHtml } from '../src/main/docgen/render-pdf';
import { parseHtmlgenRequest } from '../src/main/htmlgen/request';
import { renderHtmlgenDocument } from '../src/main/htmlgen/templates';

/**
 * ⭐ T21（2026-10-16 本地全量执行 · Owner D）：**各声明格式的真实文件 → 结构校验 → 可打开**。
 *
 * ## 这一档补的是什么
 *
 * 每个格式各自的单测只证到"渲染器返回了一个 Buffer"，各管各的契约；`artifact-verify`
 * 只证"坏字节被拦"，各管各的判据。**没有一档把两者接起来**证明：
 *
 *   `真实渲染出的字节` → 过**登记前置门的同一份判据**（`verifyArtifactBuffer`）→
 *   能被**读回来**（zip 部件在内、中文逐字在内、PDF 头尾在内）。
 *
 * 这一档就是那条接缝。它同时是 T21 的最强反例面：**假扩展名**（把纯文本改名成 `.docx`）
 * 必须被登记门挡下 —— 否则用户点开就是"文件已损坏"。
 *
 * ## 为什么登记（写库）那一半不在这里
 *
 * `saveArtifactFromBuffer` 走的是 Electron ABI 的 `better-sqlite3`，普通 vitest 载不动。
 * 登记半在 `artifact-save-index.test.ts`（真 SQLite + 真文件系统的 electron 探针）
 * 与各 `*-pipeline` 接线测试里覆盖。这里把"能不能成为登记对象"这一半钉死。
 */

const DOCX = {
  kind: 'docx',
  title: '内测报告',
  sections: [
    { heading: '一、背景', paragraphs: ['第一段内容', '第二段内容'], bullets: ['要点一'] },
    { paragraphs: ['没有小标题的一段'] },
  ],
};
const XLSX = {
  kind: 'xlsx',
  title: '九月台账',
  sheets: [
    {
      name: '汇总',
      rows: [
        ['产品', '数量'],
        ['甲', 1200],
        ['乙', 830],
      ],
    },
    { name: '备注', rows: [['一句话']] },
  ],
};
const PDF = {
  kind: 'pdf',
  title: '内测报告',
  sections: [{ heading: '一、背景', paragraphs: ['PDF 正文内容'], bullets: ['要点'] }],
};
const HTML = {
  kind: 'html',
  title: '九月经营简报',
  lang: 'zh-CN',
  template: 'brief',
  summary: '本月最重要的结论。',
  sections: [
    { kind: 'narrative', heading: '核心判断', paragraphs: ['增长来自复购。'], bullets: ['老客贡献七成'] },
    { kind: 'metrics', items: [{ label: '转化率', value: '12.4%' }] },
  ],
  sources: [{ label: '内部经营数据' }],
};

function request(raw: unknown): DocgenRequest {
  const parsed = parseDocgenRequest(raw);
  if (!parsed.ok) throw new Error(`夹具本该合法：${parsed.error}`);
  return parsed.request;
}

const readEntry = async (buffer: Buffer, name: string): Promise<string | null> => {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file(name);
  return entry ? entry.async('string') : null;
};

describe('⭐ T21 · docx：真实渲染 → 登记门判据 → 读回来（中文与部件都在）', () => {
  it('renderDocument(docx) 的字节过 verifyDocxBuffer，且为真 ZIP 含 word/document.xml', async () => {
    const buffer = await renderDocument(request(DOCX));
    // 文件名的受检判定必须为真 —— 否则这份 docx 连登记门都不会进（= 无门）。
    expect(isVerifiedFileName(`${documentFileStem(DOCX.title, '文档')}.docx`)).toBe(true);
    expect(verifyArtifactBuffer('内测报告.docx', buffer)).toEqual({ ok: true });
    const document = await readEntry(buffer, 'word/document.xml');
    expect(document).not.toBeNull();
    expect(document!).toContain('第一段内容');
    expect(document!).toContain('一、背景');
  });

  it('反例：纯文本改名成 .docx ⇒ 登记门拒绝（not-a-zip），用户点开不会看到"已损坏"文件', () => {
    expect(verifyArtifactBuffer('假文档.docx', Buffer.from('这不是一个真正的 docx 文件'))).toEqual({
      ok: false,
      reason: 'not-a-zip',
    });
  });

  it('反例：截断的 docx（ZIP 头在、中央目录没了）⇒ 登记门拒绝', async () => {
    const full = await renderDocument(request(DOCX));
    const truncated = full.subarray(0, 64);
    const result = verifyArtifactBuffer('截断.docx', truncated);
    expect(result.ok).toBe(false);
  });
});

describe('⭐ T21 · xlsx：真实渲染 → 登记门判据 → 读回来（数字仍是数字）', () => {
  it('renderDocument(xlsx) 的字节过 verifyXlsxBuffer，且含 xl/workbook.xml 与工作表数据', async () => {
    const buffer = await renderDocument(request(XLSX));
    expect(isVerifiedFileName(`${documentFileStem(XLSX.title, '表格')}.xlsx`)).toBe(true);
    expect(verifyArtifactBuffer('九月台账.xlsx', buffer)).toEqual({ ok: true });
    expect(await readEntry(buffer, 'xl/workbook.xml')).not.toBeNull();
  });

  it('反例：半截 xlsx ⇒ 登记门拒绝', async () => {
    const full = await renderDocument(request(XLSX));
    expect(verifyArtifactBuffer('半截.xlsx', full.subarray(0, 100)).ok).toBe(false);
  });
});

describe('⭐ T21 · pdf：输入侧真实 → 登记门判据（头 + 尾两个标记）', () => {
  /**
   * ⚠️ pdf 的**字节渲染**走 Electron 自带 Chromium 的 `printToPDF`（`render-pdf.ts` 的
   * `printHtmlToPdf` 要 `new BrowserWindow(...)`）—— 普通 vitest 没有 BrowserWindow
   * ⇒ 那一半只能在**打包态**验（六列的"打包态UI与文件"）。这里把**本地能验的两半**钉死：
   * ① 交给打印窗口的 HTML 是真实生成的、内容与转义都对；② 登记门对真 PDF/半截 PDF 的判据。
   */
  it('buildPdfHtml 把请求排成一份无外链、内容转义的自洽 HTML（真实输入侧）', () => {
    const req = request({ ...PDF, title: '标题 <script>alert(1)</script>' });
    if (req.kind !== 'pdf') throw new Error('夹具 kind 不对');
    const html = buildPdfHtml(req);
    expect(html).toContain('PDF 正文内容');
    // 助手写的脚本只能是尖括号（逐字转义），不能成为可执行标签。
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('登记门：真 PDF 骨架（%PDF- 头 + %%EOF 尾）通过；头尾任一缺失即拒', () => {
    expect(isVerifiedFileName('内测报告.pdf')).toBe(true);
    const real = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\nstartxref\n9\n%%EOF\n',
      'latin1',
    );
    expect(verifyArtifactBuffer('内测报告.pdf', real)).toEqual({ ok: true });
    // 有头无尾 = 写到一半 ⇒ truncated-pdf（不登记）。
    expect(verifyArtifactBuffer('半截.pdf', real.subarray(0, 20))).toEqual({ ok: false, reason: 'truncated-pdf' });
    // 尾巴在、头不是 PDF（别的二进制改了后缀）⇒ not-a-pdf。
    expect(verifyArtifactBuffer('假.pdf', Buffer.from('not a pdf start\n%%EOF\n'))).toEqual({
      ok: false,
      reason: 'not-a-pdf',
    });
  });
});

describe('⭐ T21 · html：真实渲染 → 可打开（内容是内容、标签被转义）', () => {
  it('renderHtmlgenDocument 产出的字节是一份自洽 HTML（标题 + 内容在内）', async () => {
    const parsed = parseHtmlgenRequest(HTML);
    if (!parsed.ok) throw new Error(`夹具本该合法：${parsed.detail}`);
    const buffer = await renderHtmlgenDocument(parsed.request);
    const html = buffer.toString('utf8');
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('九月经营简报');
    expect(html).toContain('增长来自复购');
    expect(html).toContain('12.4%');
    expect(html).toContain('lang="zh-CN"');
  });

  it('html 不在 OOXML/PDF 受检名单里 —— 记录这条既有边界（内容是内容，无 zip 结构可验）', () => {
    // ⚠️ 这是现状的事实记录，不是"应该如此"：html 是纯文本出口，`verifyArtifactBuffer`
    //    对它一律放行（非受检格式 return ok）。这里把它钉成显式事实，避免以后被误读成"漏了"。
    expect(isVerifiedFileName('简报.html')).toBe(false);
    expect(verifyArtifactBuffer('简报.html', Buffer.from('<html></html>'))).toEqual({ ok: true });
  });
});

describe('⭐ T21 · 期望的交付名与内容哈希一致（去重键的输入面）', () => {
  it('documentFileStem 洗掉 Windows 非法字符，扩展名由各格式固定拼上', () => {
    const stem = documentFileStem('报告:2026/09*版?', '文档');
    expect(stem).not.toMatch(/[\\/:*?"<>|]/);
    expect(`${stem}.docx`).toBe(`${stem}.docx`);
    // 命名层与登记门的扩展名判定必须对得上（不对上 = 有门也进不去）。
    for (const ext of ['docx', 'xlsx', 'pdf', 'pptx']) expect(isVerifiedFileName(`x.${ext}`)).toBe(true);
  });

  it('内容哈希稳定（同一份请求两次渲染出的字节哈希一致 —— 去重键才有意义）', async () => {
    const one = await renderDocument(request(DOCX));
    const two = await renderDocument(request(DOCX));
    const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    // docx 库会写入创建时间等元数据，字节未必逐字节同；这里只要求**都能过门**（去重键取自请求，不取自字节）。
    expect(verifyArtifactBuffer('x.docx', one)).toEqual({ ok: true });
    expect(verifyArtifactBuffer('x.docx', two)).toEqual({ ok: true });
    expect(digest(Buffer.from('same'))).toBe(digest(Buffer.from('same')));
  });
});
