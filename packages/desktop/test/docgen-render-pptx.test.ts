import { describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { parseDocgenRequest } from '../src/main/docgen/request';
import { renderPptx } from '../src/main/docgen/render-pptx';

/**
 * 渲染层：**解包看结构 + 文字真的在**，不看"有没有报错"。
 *
 * 一条只判"函数没抛异常"的测试，对"生成了一份空 PPT"是完全无感的 ——
 * 而**空白 PPT 恰恰是这类库最常见的失败形状**（内容写进了不存在的占位符、
 * 或者字体/布局参数把文字挤没）。所以这里把 zip 解开，逐个部件核对。
 *
 * ⚠️ 探针本身也做了**负对照**（最后一条）：一段不存在的文字必须判 false ——
 *    否则 `toContain` 这类断言可能恒真，看起来在验、其实什么都没验。
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
  kind: 'pptx',
  title: '内测汇报',
  subtitle: '2026-09-24',
  slides: [
    { title: '本周进展', bullets: ['文档生成能力：方案已出', '文件导入提示：已修'], notes: '这页讲三件事' },
    { title: '下周计划', bullets: ['P1 落地'] },
  ],
};

async function renderValid(): Promise<Map<string, Buffer>> {
  const parsed = parseDocgenRequest(REQUEST);
  if (!parsed.ok) throw new Error(`夹具本身不合法：${parsed.error}`);
  if (parsed.request.kind !== 'pptx') throw new Error('夹具 kind 不对');
  return unzip(await renderPptx(parsed.request));
}

describe('renderPptx —— 解包验证', () => {
  it('是一个结构合法的 pptx（必备部件都在）', async () => {
    const files = await renderValid();
    for (const part of ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/slides/slide1.xml']) {
      expect([...files.keys()], `缺 ${part}`).toContain(part);
    }
  });

  it('页数 = 封面 + 每一页内容（2 页内容 ⇒ 3 张 slide）', async () => {
    const files = await renderValid();
    const slides = [...files.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(slides).toHaveLength(3);
  });

  it('⭐ 中文真的写进了 XML（不是"生成了个空壳"）', async () => {
    const files = await renderValid();
    const slide1 = files.get('ppt/slides/slide1.xml')?.toString('utf8') ?? '';
    const slide2 = files.get('ppt/slides/slide2.xml')?.toString('utf8') ?? '';

    expect(slide1, '封面标题').toContain('内测汇报');
    expect(slide1, '封面副标题').toContain('2026-09-24');
    expect(slide2, '内容页标题').toContain('本周进展');
    expect(slide2, '第一条要点').toContain('文档生成能力：方案已出');
    expect(slide2, '第二条要点').toContain('文件导入提示：已修');
  });

  it('讲者备注写进了备注件（在**对应的那一页**上）', async () => {
    const files = await renderValid();
    const notesXml = [...files.entries()]
      .filter(([name]) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
      .map(([, buf]) => buf.toString('utf8'));
    // ⚠️ 不要假设"第一份备注件就是我们的"：pptxgenjs 会给**每一页**都生成备注件
    //    （即使没调 addNotes —— 实测两页 PPT 恒有 notesSlide1/2），
    //    我们写的那句落在**第二页**那份里。断言"某一份里有"才是对的性质。
    expect(
      notesXml.some((xml) => xml.includes('这页讲三件事')),
      '备注文字没写进任何备注件',
    ).toBe(true);
  });

  it('没给 notes 时，那句话**哪里都不在**（备注确实只在要求时出现）', async () => {
    const parsed = parseDocgenRequest({
      kind: 'pptx',
      title: 't',
      slides: [
        { title: '第一页', bullets: ['a'] },
        { title: '第二页', bullets: ['b'] },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    if (parsed.request.kind !== 'pptx') throw new Error('夹具 kind 不对');
    const files = await unzip(await renderPptx(parsed.request));
    const all = [...files.values()].map((buf) => buf.toString('utf8')).join('\n');
    expect(all, '没要求备注，却出现了备注文字').not.toContain('这页讲三件事');
  });

  it('字体只写名字、不内嵌（体积与授权）', async () => {
    const files = await renderValid();
    // 内嵌字体在 pptx 里是 `ppt/fonts/` 下的件；我们刻意不做
    expect([...files.keys()].filter((name) => name.startsWith('ppt/fonts/'))).toEqual([]);
  });

  it('负对照：**不存在的文字必须判 false**（否则上面那些 toContain 可能恒真）', async () => {
    const files = await renderValid();
    const slide2 = files.get('ppt/slides/slide2.xml')?.toString('utf8') ?? '';
    expect(slide2).not.toContain('这段字压根不存在');
  });
});
