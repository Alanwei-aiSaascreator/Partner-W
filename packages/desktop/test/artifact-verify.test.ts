import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  isVerifiedFileName,
  verifyArtifactBuffer,
  verifyDocxBuffer,
  verifyMp4Buffer,
  verifyPdfBuffer,
  verifyPptxBuffer,
  verifyXlsxBuffer,
} from '../src/main/artifact/verify.js';

/**
 * M1「登记前置门」判据的单元测试（纯 buffer，零 mock）。
 *
 * 背景：真机把半截/缺件的 `.pptx` 登记进产物，用户点开是坏文件（图14/16，"打不开"族）。
 * 本判据把"物理上打不开"挡在登记之外——这里钉的就是这份判据本身。
 */

async function pptxBuffer(omit: string[] = []): Promise<Buffer> {
  const zip = new JSZip();
  const parts: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml':
      '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    'ppt/slides/slide1.xml':
      '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
  };
  for (const [name, content] of Object.entries(parts)) {
    if (!omit.includes(name)) zip.file(name, content);
  }
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
}

describe('verifyPptxBuffer（M1 登记前置门判据）', () => {
  it('最小合法包 → ok', async () => {
    expect(verifyPptxBuffer(await pptxBuffer())).toEqual({ ok: true });
  });

  it('⭐ 截断（切掉中央目录）→ 拒 —— 真机半截文件的结构', async () => {
    const full = await pptxBuffer();
    const truncated = full.subarray(0, Math.floor(full.length * 0.6));
    expect(verifyPptxBuffer(truncated).ok).toBe(false);
  });

  it('非 ZIP 垃圾字节 → 拒', () => {
    expect(verifyPptxBuffer(Buffer.from('this is not a zip at all'))).toEqual({ ok: false, reason: 'not-a-zip' });
  });

  it('空 buffer → 拒', () => {
    expect(verifyPptxBuffer(Buffer.alloc(0)).ok).toBe(false);
  });

  it('缺 [Content_Types].xml → 拒', async () => {
    expect(verifyPptxBuffer(await pptxBuffer(['[Content_Types].xml']))).toEqual({
      ok: false,
      reason: 'missing-content-types',
    });
  });

  it('缺 presentation.xml → 拒', async () => {
    expect(verifyPptxBuffer(await pptxBuffer(['ppt/presentation.xml']))).toEqual({
      ok: false,
      reason: 'missing-presentation',
    });
  });

  it('一张幻灯片都没有 → 拒', async () => {
    expect(verifyPptxBuffer(await pptxBuffer(['ppt/slides/slide1.xml']))).toEqual({ ok: false, reason: 'no-slides' });
  });
});

/**
 * `.docx` 判据（2026-10-06 追加）。
 *
 * 用户反馈 #9 原话："重新生成 docx：桌面出现 js 文件；**新 docx 打不开/乱码**。"
 * 机制：`.docx` 不在登记前置门内 ⇒ 模型把纯文本改成 `.docx` 名字、或 docgen 写了一半，
 * 照样进产物列表 —— Word/WPS 打开报损坏。这里把与 pptx 同构的门钉在 docx 上。
 */
async function docxBuffer(omit: string[] = []): Promise<Buffer> {
  const zip = new JSZip();
  const parts: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml':
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
  };
  for (const [name, content] of Object.entries(parts)) {
    if (!omit.includes(name)) zip.file(name, content);
  }
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
}

describe('verifyDocxBuffer（docx 登记前置门判据）', () => {
  it('最小合法包 → ok', async () => {
    expect(verifyDocxBuffer(await docxBuffer())).toEqual({ ok: true });
  });

  it('⭐ 纯文本改名（真机形态：内容根本不是 ZIP）→ 拒', () => {
    expect(verifyDocxBuffer(Buffer.from('这不是文档，是模型写出来的纯文本'))).toEqual({
      ok: false,
      reason: 'not-a-zip',
    });
  });

  it('截断（切掉中央目录，docgen 写了一半）→ 拒', async () => {
    const full = await docxBuffer();
    expect(verifyDocxBuffer(full.subarray(0, Math.floor(full.length * 0.6))).ok).toBe(false);
  });

  it('缺 [Content_Types].xml → 拒', async () => {
    expect(verifyDocxBuffer(await docxBuffer(['[Content_Types].xml']))).toEqual({
      ok: false,
      reason: 'missing-content-types',
    });
  });

  it('缺 word/document.xml（word 文档的正身）→ 拒', async () => {
    expect(verifyDocxBuffer(await docxBuffer(['word/document.xml']))).toEqual({
      ok: false,
      reason: 'missing-document',
    });
  });

  it('空 buffer → 拒', () => {
    expect(verifyDocxBuffer(Buffer.alloc(0)).ok).toBe(false);
  });
});

/**
 * `.xlsx` / `.pdf` 判据（2026-10-07 体检 P2-6）。
 *
 * 这两类原来**完全无门**：半截表格 / 截断 PDF 照样登记，点开就是"打不开"。
 * 判据仍是"必要件在场 + 条目字节能取出"（pdf 换成头尾两个标记），不做内容质量裁决。
 */
async function xlsxBuffer(omit: string[] = []): Promise<Buffer> {
  const zip = new JSZip();
  const parts: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
  };
  for (const [name, content] of Object.entries(parts)) {
    if (!omit.includes(name)) zip.file(name, content);
  }
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
}

describe('verifyXlsxBuffer（xlsx 登记前置门判据）', () => {
  it('最小合法包 → ok', async () => {
    expect(verifyXlsxBuffer(await xlsxBuffer())).toEqual({ ok: true });
  });

  it('⭐ 截断（切掉中央目录，写了一半就停）→ 拒', async () => {
    const full = await xlsxBuffer();
    expect(verifyXlsxBuffer(full.subarray(0, Math.floor(full.length * 0.6))).ok).toBe(false);
  });

  it('非 ZIP / 缺 workbook → 拒', async () => {
    expect(verifyXlsxBuffer(Buffer.from('csv,not,xlsx'))).toEqual({ ok: false, reason: 'not-a-zip' });
    expect(verifyXlsxBuffer(await xlsxBuffer(['xl/workbook.xml']))).toEqual({
      ok: false,
      reason: 'missing-workbook',
    });
  });
});

describe('verifyPdfBuffer（pdf 登记前置门判据）', () => {
  const pdf = (body = ''): Buffer => Buffer.from(`%PDF-1.7\n1 0 obj\n${body}\nstartxref\n9\n%%EOF\n`);

  it('最小合法 PDF（头 + %%EOF）→ ok', () => {
    expect(verifyPdfBuffer(pdf())).toEqual({ ok: true });
  });

  it('⭐ 截断（写到一半，%%EOF 还没落）→ 拒 —— 真机半截文件的形态', () => {
    const full = pdf('stream'.repeat(400));
    expect(verifyPdfBuffer(full.subarray(0, Math.floor(full.length * 0.7)))).toEqual({
      ok: false,
      reason: 'truncated-pdf',
    });
  });

  it('纯文本改名 / 空 buffer → 拒（not-a-pdf）', () => {
    expect(verifyPdfBuffer(Buffer.from('这是一份假 PDF'))).toEqual({ ok: false, reason: 'not-a-pdf' });
    expect(verifyPdfBuffer(Buffer.alloc(0))).toEqual({ ok: false, reason: 'not-a-pdf' });
  });

  it('尾部换行/空白不影响判定（各家生成器的收尾差异）', () => {
    expect(verifyPdfBuffer(Buffer.from('%PDF-1.4\n%%EOF\n\n \n'))).toEqual({ ok: true });
  });
});

describe('verifyArtifactBuffer（按扩展名派给对应判据的单一入口）', () => {
  it('.docx 走 docx 判据：pptx 形状的包照样拒（缺 word/document.xml）', async () => {
    expect(verifyArtifactBuffer('总结.docx', await pptxBuffer())).toEqual({
      ok: false,
      reason: 'missing-document',
    });
  });

  it('.pptx 走 pptx 判据：docx 形状的包照样拒（缺 ppt/slides）', async () => {
    expect(verifyArtifactBuffer('deck.pptx', await docxBuffer())).toEqual({
      ok: false,
      reason: 'missing-presentation',
    });
  });

  it('各自的最小合法包 → ok', async () => {
    expect(verifyArtifactBuffer('总结.docx', await docxBuffer())).toEqual({ ok: true });
    expect(verifyArtifactBuffer('deck.pptx', await pptxBuffer())).toEqual({ ok: true });
    expect(verifyArtifactBuffer('表格.xlsx', await xlsxBuffer())).toEqual({ ok: true });
    expect(verifyArtifactBuffer('报告.pdf', Buffer.from('%PDF-1.7\n%%EOF\n'))).toEqual({ ok: true });
  });

  it('.xlsx / .pdf 走各自判据（表格包按 pptx 判据会被拒，反之亦然）', async () => {
    expect(verifyArtifactBuffer('表格.xlsx', await pptxBuffer())).toEqual({ ok: false, reason: 'missing-workbook' });
    expect(verifyArtifactBuffer('deck.pptx', Buffer.from('%PDF-1.7\n%%EOF'))).toEqual({
      ok: false,
      reason: 'not-a-zip',
    });
  });

  it('不受检的扩展名照旧放行（调用点先过 isVerifiedFileName；这里放行不是报错）', () => {
    expect(verifyArtifactBuffer('notes.md', Buffer.from('whatever'))).toEqual({ ok: true });
  });
});

describe('isVerifiedFileName', () => {
  it.each([
    ['deck.pptx', true],
    ['DECK.PPTX', true],
    ['deck.docx', true],
    ['DECK.DOCX', true],
    // 2026-10-07（P2-6）：xlsx / pdf 并入受检名单（登记门 + 打开前复核都按它）
    ['表格.xlsx', true],
    ['表格.XLSX', true],
    ['报告.pdf', true],
    ['报告.PDF', true],
    // 2026-10-12（视频接入）：mp4 并入受检名单（下载截断挡在登记之外）
    ['短片.mp4', true],
    ['SHORT.MP4', true],
    ['deck.xls', false],
    ['deck.doc', false],
    ['deck.pptx.exe', false],
    ['deck.docx.exe', false],
    ['deck', false],
  ])('%s → %s', (name, expected) => {
    expect(isVerifiedFileName(name)).toBe(expected);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-10-12 视频接入：`.mp4` 判据（顶层 box 链遍历）。
 * 最常见的坏法 = 下载被截断——头几个字节照样是 `ftyp`，只有 size 链走到底才能现形。
 * ──────────────────────────────────────────────────────────────────────────── */

function box(type: string, payload: Buffer, forceLargesize = false): Buffer {
  if (forceLargesize) {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0); // size==1 ⇒ 读 64 位 largesize
    header.write(type, 4, 'latin1');
    header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

/** ftyp + moov + mdat 的最小结构性 mp4（负载内容随意——本判据不做解码）。 */
function mp4Buffer(): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('isomisoftyp1', 'latin1')),
    box('moov', Buffer.alloc(32, 7)),
    box('mdat', Buffer.alloc(256, 1)),
  ]);
}

describe('verifyMp4Buffer（视频下载完整性判据）', () => {
  it('结构性完整（ftyp+moov+mdat，链铺满）→ ok', () => {
    expect(verifyMp4Buffer(mp4Buffer())).toEqual({ ok: true });
  });

  it('⭐ 下载截断（切掉尾部 10 字节）→ 拒 —— 最常见的坏法', () => {
    const full = mp4Buffer();
    const cut = full.subarray(0, full.length - 10);
    expect(verifyMp4Buffer(cut)).toEqual({ ok: false, reason: 'truncated-mp4' });
  });

  it('头都不是 ftyp（如别的二进制改名）→ not-an-mp4', () => {
    const wrong = Buffer.concat([box('mdat', Buffer.alloc(64)), box('moov', Buffer.alloc(16))]);
    expect(verifyMp4Buffer(wrong)).toEqual({ ok: false, reason: 'not-an-mp4' });
  });

  it('缺 mdat（只有元数据没有画面）→ no-media-data', () => {
    const shell = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('moov', Buffer.alloc(32))]);
    expect(verifyMp4Buffer(shell)).toEqual({ ok: false, reason: 'no-media-data' });
  });

  it('缺 moov（播放器拿不到元数据）→ truncated-mp4', () => {
    const noMoov = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('mdat', Buffer.alloc(64))]);
    expect(verifyMp4Buffer(noMoov)).toEqual({ ok: false, reason: 'truncated-mp4' });
  });

  it('64 位 largesize box（size==1）也认', () => {
    const big = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.alloc(16)),
      box('mdat', Buffer.alloc(64), true),
    ]);
    expect(verifyMp4Buffer(big)).toEqual({ ok: true });
  });

  it('size==0 的收尾 box（"到文件尾"）按铺满语义放行', () => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(0, 0); // 0 = extends to end of file
    header.write('mdat', 4, 'latin1');
    const tail = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.alloc(16)),
      header,
      Buffer.alloc(64, 2),
    ]);
    expect(verifyMp4Buffer(tail)).toEqual({ ok: true });
  });

  it('空 / 过短 buffer → 拒（不当成"没有内容所以放行"）', () => {
    expect(verifyMp4Buffer(Buffer.alloc(0)).ok).toBe(false);
    expect(verifyMp4Buffer(Buffer.from('ftyp')).ok).toBe(false);
  });

  it('派发入口按扩展名走 mp4 判据（.mp4 → truncated 拒；.mov 不在受检名单 → 放行）', () => {
    const cut = mp4Buffer().subarray(0, 40);
    expect(verifyArtifactBuffer('短片.mp4', cut).ok).toBe(false);
    expect(isVerifiedFileName('短片.mov')).toBe(false);
    expect(verifyArtifactBuffer('短片.mov', cut)).toEqual({ ok: true });
  });
});
