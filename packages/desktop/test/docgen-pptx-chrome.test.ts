import { describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { parseDocgenRequest } from '../src/main/docgen/request';
import { renderPptx } from '../src/main/docgen/render-pptx';

/**
 * 版面装饰（页脚 / 页码 / 封面色带）。
 *
 * 判据都在**生成出来的 XML** 上，不在"函数没抛异常"上 —— 装饰这类东西最容易
 * "写了但没画"，而空白 PPT 恰恰是这类库最常见的失败形状。
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

const TITLE = '内测汇报';

async function slidesOf(deck: { title: string; subtitle?: string; slides: { title: string; bullets: string[] }[] }) {
  const parsed = parseDocgenRequest({ kind: 'pptx', ...deck });
  if (!parsed.ok) throw new Error(`夹具不合法：${parsed.error}`);
  if (parsed.request.kind !== 'pptx') throw new Error('夹具 kind 不对');
  const files = await unzip(await renderPptx(parsed.request));
  return (name: string) => files.get(name)?.toString('utf8') ?? '';
}

const THREE_PAGES = {
  title: TITLE,
  subtitle: '2026-09-26',
  slides: [
    { title: '本周进展', bullets: ['文档生成能力：方案已出', '文件导入提示：已修'] },
    { title: '下周计划', bullets: ['PPT 排版保真', '多版式与主题'] },
    { title: '需要支持', bullets: ['一台干净的测试机'] },
  ],
};

describe('renderPptx —— 版面装饰', () => {
  it('每一张内容页都有页码，且是「第几页 / 共几页」', async () => {
    const slide = await slidesOf(THREE_PAGES);
    // 封面是第 1 张，内容页从第 2 张起；总数把封面算进去，与 PowerPoint 自己的编号一致
    expect(slide('ppt/slides/slide2.xml')).toContain('2 / 4');
    expect(slide('ppt/slides/slide3.xml')).toContain('3 / 4');
    expect(slide('ppt/slides/slide4.xml')).toContain('4 / 4');
  });

  it('封面不显示页码（封面挂个「1 / 4」是外行做法）', async () => {
    const slide = await slidesOf(THREE_PAGES);
    expect(slide('ppt/slides/slide1.xml')).not.toContain('1 / 4');
  });

  it('内容页页脚带着演示标题（脱离上下文单看一页也知道是哪个文件）', async () => {
    const slide = await slidesOf(THREE_PAGES);
    expect(slide('ppt/slides/slide2.xml')).toContain(TITLE);
  });

  it('封面也带演示标题 —— 但那是因为它就是封面标题，别把这条当成页脚生效', async () => {
    const slide = await slidesOf(THREE_PAGES);
    expect(slide('ppt/slides/slide1.xml')).toContain(TITLE);
  });

  it('页脚与页码用的是小字号（不能跟正文抢视线）', async () => {
    const slide = await slidesOf(THREE_PAGES);
    const sizes = [...slide('ppt/slides/slide2.xml').matchAll(/sz="(\d+)"/g)].map((m) => Number(m[1]) / 100);
    // 正文 18pt、标题 26pt 都在；页脚那两处必须是明显的更小号
    expect(Math.min(...sizes)).toBeLessThanOrEqual(11);
  });

  it('负对照：不存在的文字必须判 false（否则上面的 toContain 可能恒真）', async () => {
    const slide = await slidesOf(THREE_PAGES);
    expect(slide('ppt/slides/slide2.xml')).not.toContain('这段字压根不存在');
  });
});
