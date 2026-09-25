/**
 * 从 ZIP 里**按名字取一条**（`.docx` / `.pptx` / `.xlsx` 都是 ZIP）。
 *
 * 为什么要自己写：`jszip` 在 pnpm 的严格 node_modules 下**不可达**（它只是 pptxgenjs 的传递依赖），
 * 而**加一个依赖**在这个项目里是有前科的 —— 打包态压平 pnpm 树会丢嵌套依赖
 * （见 `pnpm-flattening-drops-nested-deps`：`require('exceljs')` 当场炸、开发态全绿）。
 * `node:zlib` 是内置的，零依赖、零打包风险。
 *
 * ⭐ 夹具是**真库产的真文件**（`docx` / `pptxgenjs`），不是我自己拼的 zip ——
 *    自己拼的话，测试和实现会共享同一个误解，一起错还一起绿。
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { Packer, Document, Paragraph, TextRun } from 'docx';
import PptxGenJS from 'pptxgenjs';
import { describe, expect, it } from 'vitest';
import { readZipEntry, listZipEntries } from '../src/main/preview/zip-entry.js';

/**
 * 手搓一份**流式形状**的 zip：本地头里的 crc 与两个长度**都写 0**，
 * 真值放在数据描述符和中央目录里。这是真实存在的产出方式（边写边压、事先不知道长度）。
 */
function buildStreamingZip(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const compressed = deflateRawSync(data);
  const crc = crc32(data);
  const nameBuf = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  // 14 crc / 18 压缩长度 / 22 原始长度：留 0 —— 这正是流式形状
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);

  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressed.length, 8);
  descriptor.writeUInt32LE(data.length, 12);

  const cen = Buffer.alloc(46 + nameBuf.length);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(8, 10); // method
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(compressed.length, 20); // ← 真长度只在这儿
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt32LE(0, 42); // 本地头偏移
  nameBuf.copy(cen, 46);

  const cenOffset = local.length + compressed.length + descriptor.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cen.length, 12);
  eocd.writeUInt32LE(cenOffset, 16);

  return Buffer.concat([local, compressed, descriptor, cen, eocd]);
}

async function realDocx(text = '你好'): Promise<Buffer> {
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun(text)] })] }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function realPptx(): Promise<Buffer> {
  const pptx = new PptxGenJS();
  const slide = pptx.addSlide();
  slide.addText('第一页', { x: 1, y: 1, w: 4, h: 1 });
  return Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as Buffer);
}

describe('readZipEntry', () => {
  it('⭐ 从**真 .docx** 里取出 `word/document.xml`（中文不许变乱码）', async () => {
    const zip = await realDocx('你好，世界');

    const xml = readZipEntry(zip, 'word/document.xml')?.toString('utf8');

    expect(xml).toBeTruthy();
    expect(xml).toContain('你好，世界');
  });

  it('⭐ 从**真 .pptx** 里取出首页 XML', async () => {
    const zip = await realPptx();

    const names = listZipEntries(zip);
    expect(names).toContain('ppt/slides/slide1.xml');
    expect(readZipEntry(zip, 'ppt/slides/slide1.xml')?.toString('utf8')).toContain('第一页');
  });

  it('⭐ 名字里有 `[` 这种正则元字符也要能找到（`[Content_Types].xml`）', async () => {
    const zip = await realDocx();

    expect(readZipEntry(zip, '[Content_Types].xml')?.toString('utf8')).toContain('Types');
  });

  it('对照：名字不存在 ⇒ null（不是抛，也不是猜一个最近的）', async () => {
    expect(readZipEntry(await realDocx(), 'nope/missing.xml')).toBeNull();
  });

  it('对照：根本不是 zip 的字节 ⇒ null（不是崩）', () => {
    expect(readZipEntry(Buffer.from('这不是 zip'), 'a.xml')).toBeNull();
  });

  it('对照：空 buffer ⇒ null', () => {
    expect(readZipEntry(Buffer.alloc(0), 'a.xml')).toBeNull();
  });

  it('⭐ 大条目也完整（几万字的一次会议记录，跨多个解压块）', async () => {
    const big = '这是一段很长的正文。'.repeat(4_000);
    const zip = await realDocx(big);

    expect(readZipEntry(zip, 'word/document.xml')?.toString('utf8')).toContain('这是一段很长的正文。');
  });

  /**
   * ⭐⭐ **流式写出的 zip**：本地头里的压缩长度是 **0**，真长度只在中央目录里。
   *
   * 为什么必须单独造一个：`docx` / `pptxgenjs` 这些库**本地头里写的就是真长度**
   * （变异电池实测：把"用中央目录"改成"用本地头"，全部用例照样绿 ⇒ 那些夹具根本证伪不了
   * 这个选择）。所以这里手搓一份流式形状 —— 它是真实存在的产出方式，不是假想。
   */
  it('⭐⭐ 本地头长度为 0 的流式 zip：真长度只信中央目录，不然取出来是空的', () => {
    const content = 'Word 流式写出来的正文';
    const zip = buildStreamingZip('word/document.xml', content);

    // 先证明这份夹具**确实是**流式形状：本地头里那个字段是 0
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(18)).toBe(0);
    expect(readZipEntry(zip, 'word/document.xml')?.toString('utf8')).toBe(content);
  });
});
