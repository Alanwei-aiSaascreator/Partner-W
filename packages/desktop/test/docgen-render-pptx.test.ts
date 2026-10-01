import { describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { bodyFontSizePt } from '../src/main/docgen/pptx-layout';
import { paginatePptxRequest } from '../src/main/docgen/pptx-pagination';
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

describe('renderPptx —— 正文字号真的由内容量决定', () => {
  /**
   * 这一组钉的是**接线**，不是算法：`pptx-layout.ts` 里那个函数自己测过了，
   * 但"模块写好了却没接上"是这类加固最容易掉的缝（本项目栽过）。
   * 所以这里从**生成出来的 XML** 里把字号读回来，跟那个函数算的比。
   *
   * DrawingML 的字号是 `sz="1800"`（百分之一磅）。
   */
  async function bodySizes(bullets: string[]): Promise<number[]> {
    const parsed = parseDocgenRequest({ kind: 'pptx', title: 't', slides: [{ title: '内容页', bullets }] });
    if (!parsed.ok) throw new Error(`夹具不合法：${parsed.error}`);
    if (parsed.request.kind !== 'pptx') throw new Error('夹具 kind 不对');
    const files = await unzip(await renderPptx(parsed.request));
    // 第 1 张是封面，内容页是第 2 张
    const xml = files.get('ppt/slides/slide2.xml')?.toString('utf8') ?? '';
    return [...xml.matchAll(/sz="(\d+)"/g)].map((match) => Number(match[1]) / 100);
  }

  it('uses 22pt body text for short content', async () => {
    const sizes = await bodySizes(['文档生成能力：方案已出', '文件导入提示：已修']);
    expect(sizes).toContain(22);
  });

  it('uses the size calculated for the first generated continuation page', async () => {
    const bullets = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 条要点，简短一句`);
    const sizes = await bodySizes(bullets);
    const request = { kind: 'pptx' as const, title: 't', slides: [{ title: 'Content', bullets }] };
    const expected = bodyFontSizePt(paginatePptxRequest(request).slides[0].bullets);
    expect(expected).toBeGreaterThanOrEqual(18);
    expect(sizes, '标题仍应是 26pt').toContain(26);
    expect(sizes, '正文必须用算出来的字号').toContain(expected);
  });
});

describe('renderPptx —— 排不下就**不产出文件**，而不是产出一份糊出画面的', () => {
  /** 恰好顶到契约上限的一条要点（300 字）—— 多一个字会被契约层先拒，就不是在验排版了。 */
  const maxBullet = (): string => '内'.repeat(300);

  /** 一页 3600 字：缩到下限也装不下。 */
  const overflowing = (): ReturnType<typeof parseDocgenRequest> =>
    parseDocgenRequest({
      kind: 'pptx',
      title: '内测汇报',
      slides: [{ title: '本周进展', bullets: Array.from({ length: 12 }, () => maxBullet()) }],
    });

  function pptxOf(parsed: ReturnType<typeof parseDocgenRequest>) {
    if (!parsed.ok) throw new Error(`夹具不合法：${parsed.error}`);
    if (parsed.request.kind !== 'pptx') throw new Error('夹具 kind 不对');
    return parsed.request;
  }

  it('generates a real deck for dense legal content by paginating it', async () => {
    const buffer = await renderPptx(pptxOf(overflowing()));
    expect(buffer.byteLength).toBeGreaterThan(10_000);
    const files = await unzip(buffer);
    expect([...files.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length).toBeGreaterThan(2);
  });

  it('判定发生在**写任何一页之前** —— 一份都不许落半成品', async () => {
    // 封面本身没问题，坏的是第 3 页。如果实现是"边写边判"，前两页就已经进了 pptx 对象，
    // 哪怕最后 throw，也可能有人图省事把半成品 write 出去。这里用输出流从根上排除：
    // 一旦 throw，就不可能拿到任何字节。
    let bytes: Buffer | null = null;
    try {
      bytes = await renderPptx(
        pptxOf(
          parseDocgenRequest({
            kind: 'pptx',
            title: '内测汇报',
            slides: [
              { title: '第一页', bullets: ['一条'] },
              { title: '第二页', bullets: ['一条'] },
              { title: '\u6807'.repeat(120), bullets: ['Invalid heading'] },
            ],
          }),
        ),
      );
    } catch {
      bytes = null;
    }
    expect(bytes, '失败时不该产出任何字节').toBeNull();
  });

  it('标题过长同样在渲染层被拒（判定不能只活在界面那一侧）', async () => {
    const parsed = parseDocgenRequest({
      kind: 'pptx',
      title: '标'.repeat(120),
      slides: [{ title: '第一页', bullets: ['一条'] }],
    });
    await expect(renderPptx(pptxOf(parsed))).rejects.toMatchObject({
      problem: { code: 'cover-title-overflow' },
    });
  });
});
