import { describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { parseDocgenRequest } from '../src/main/docgen/request';
import { renderDocx } from '../src/main/docgen/render-docx';

/**
 * Word 渲染层：**解包看结构 + 文字真的在**。
 *
 * ⚠️ 这里有一条 pptx 没有的断言：**中文字体必须落在 `w:eastAsia` 上**。
 *    判断"中文用什么字体"的是这个属性；`w:ascii`/`w:hAnsi` 只管西文
 *    （只写西文属性时 WPS 会拿西文字体渲染中文，用户看到的是糊字/方框 ——
 *    `cn-docx-writer` 那份踩坑记录的头一条）。
 *    ⭐ 查过 `docx@9.7.2` 的 `createRunFonts`：**传字符串时它四个属性同写** ⇒
 *    本库不存在 python-docx 那个坑。这条断言于是钉的是**回归**（换库、或对象写法漏了 eastAsia），
 *    变异电池里对应的那条改法就是"把 eastAsia 从对象里拿掉"。
 */

function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error('no zipfile'));
      const files = new Map<string, Buffer>();
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) return zipfile.readEntry();
        zipfile.openReadStream(entry, (readErr, stream) => {
          if (readErr || !stream) return reject(readErr ?? new Error('no stream'));
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve(files));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

const REQUEST = {
  kind: 'docx',
  title: '内测报告',
  sections: [
    {
      heading: '一、背景',
      paragraphs: ['本轮目标是补齐文档生成能力。', '第二条自然段。'],
      bullets: ['要点甲', '要点乙'],
    },
    { paragraphs: ['没有小标题的一段收尾。'] },
  ],
};

async function renderValid(): Promise<Map<string, Buffer>> {
  const parsed = parseDocgenRequest(REQUEST);
  if (!parsed.ok) throw new Error(`夹具本身不合法：${parsed.error}`);
  if (parsed.request.kind !== 'docx') throw new Error('夹具 kind 不对');
  return unzip(await renderDocx(parsed.request));
}

function documentXml(files: Map<string, Buffer>): string {
  return files.get('word/document.xml')?.toString('utf8') ?? '';
}

describe('renderDocx —— 解包验证', () => {
  it('是一个结构合法的 docx（必备部件都在）', async () => {
    const files = await renderValid();
    for (const part of ['[Content_Types].xml', 'word/document.xml']) {
      expect([...files.keys()], `缺 ${part}`).toContain(part);
    }
  });

  it('⭐ 标题 / 小标题 / 自然段 / 要点，文字都真的在正文里', async () => {
    const xml = documentXml(await renderValid());
    expect(xml, '文档标题').toContain('内测报告');
    expect(xml, '小标题').toContain('一、背景');
    expect(xml, '第一段').toContain('本轮目标是补齐文档生成能力。');
    expect(xml, '第二段').toContain('第二条自然段。');
    expect(xml, '没有小标题的那一段').toContain('没有小标题的一段收尾。');
    expect(xml, '要点甲').toContain('要点甲');
    expect(xml, '要点乙').toContain('要点乙');
  });

  it('⭐ 中文字体落在 `w:eastAsia` 上（漏了它 WPS 会用西文字体渲染中文）', async () => {
    const xml = documentXml(await renderValid());
    expect(xml, '没有任何 eastAsia 声明').toMatch(/w:eastAsia="[^"]+"/);
    expect(xml, '正文中文字体').toContain('w:eastAsia="宋体"');
  });

  it('小标题走的是 Word 的标题样式（导航窗格 / 目录才认得出层级）', async () => {
    const xml = documentXml(await renderValid());
    expect(xml).toMatch(/w:pStyle w:val="Heading1"/);
  });

  it('要点是**真的项目符号**（有编号定义，不是普通段落）', async () => {
    const files = await renderValid();
    const numbering = files.get('word/numbering.xml')?.toString('utf8') ?? '';
    expect(numbering, '没有 numbering.xml ⇒ 要点只是普通段落').not.toBe('');
    expect(documentXml(files), '正文里没有引用编号定义').toMatch(/w:numPr/);
  });

  it('负对照：**不存在的文字必须判 false**（否则上面那些 toContain 可能恒真）', async () => {
    const xml = documentXml(await renderValid());
    expect(xml).not.toContain('这段字压根不存在');
  });
});
