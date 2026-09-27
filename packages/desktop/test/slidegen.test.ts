import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SlideDslError, transformSlideJsx } from '../src/main/slidegen/dsl';
import { evaluateSlide } from '../src/main/slidegen/evaluate';
import { renderSlide, styleToCss } from '../src/main/slidegen/layout';
import { hexOf, parseGradient, sampleGradient, toShapes, type Shape } from '../src/main/slidegen/emit';
import { findOccludedText, findOutOfBounds } from '../src/main/slidegen/validate';
import { extractSlidegenBlocks } from '../src/main/slidegen/blocks';
import { resolveOurSkillsRoot } from '../src/main/skills/locate';
import type { MeasuredElement } from '../src/main/slidegen/measure';

/**
 * `slidegen` —— **模型自己排版的幻灯片**。
 *
 * 这条通道与 `docgen` / `htmlgen` 的根本差别：版面**由模型写**（JSX + CSS），
 * 客户端拿真浏览器排版、量出每个元素的最终矩形，再写回成可编辑的 pptx。
 *
 * ⚠️ 这个文件只测**纯的部分**（转换 / 求值 / 映射 / 校验 / 围栏）。
 *    真正要起浏览器的那一段（`measure.ts`）不在这里 —— 它需要 Electron，
 *    在单测里起不来，硬桩一个假浏览器只会测到桩自己。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, '..');

describe('slidegen DSL：JSX → JS', () => {
  it('基本元素与属性', () => {
    const js = transformSlideJsx(`<Slide style={{ width: 1280 }}>hi</Slide>`);
    expect(js).toContain('__h("Slide"');
    expect(js).toContain('"style": ({ width: 1280 })');
    expect(js).toContain('"hi"');
  });

  it('自闭合标签**必须自己闭掉**', () => {
    // 这条是实测踩出来的：只发开标签会让 <div>/</div> 不平衡，
    // 后面所有元素都被塞进它里面（页脚跑到画布外 250px）。
    const js = transformSlideJsx(`<Slide><Box style={{ width: 6 }} /><Text>x</Text></Slide>`);
    const open = (js.match(/__h\(/g) ?? []).length;
    expect(open, '三个元素各一次 __h').toBe(3);
    // 自闭合的那个**没有子节点参数**
    expect(js).toMatch(/__h\("Box", \{[^}]*\}\)/);
  });

  it('⭐ `{}` 里的 JS **一个字符都不动**（`.map()` 因此是活的）', () => {
    const src = `<Slide>{[1,2].map((n) => (<Text>{n}</Text>))}</Slide>`;
    const js = transformSlideJsx(src);
    expect(js).toContain('[1,2].map((n) => (');
  });

  it('认不出的标签**抛错**，不猜', () => {
    expect(() => transformSlideJsx(`<div>x</div>`)).toThrow(SlideDslError);
  });

  it('模板串里的花括号不会把表达式提前截断', () => {
    const js = transformSlideJsx('<Slide>{`a${1 + 1}b`}</Slide>');
    expect(js).toContain('`a${1 + 1}b`');
  });
});

describe('slidegen 求值', () => {
  it('单个 `<Slide>` ⇒ 一页', () => {
    const pages = evaluateSlide(`<Slide style={{ width: 1280, height: 720 }} />`);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.tag).toBe('Slide');
  });

  it('⭐ 多个并列 `<Slide>` ⇒ 多页（一个围栏写完整份 deck）', () => {
    const pages = evaluateSlide(`<Slide /><Slide /><Slide />`);
    expect(pages).toHaveLength(3);
  });

  it('⭐ `.map()` 真的展开', () => {
    const pages = evaluateSlide(`<Slide>{['a','b','c'].map((x, i) => (<Text key={i}>{x}</Text>))}</Slide>`);
    const children = pages[0]?.children ?? [];
    expect(children).toHaveLength(3);
  });

  it('顶层不是 `<Slide>` ⇒ 拒', () => {
    expect(() => evaluateSlide(`<Box />`)).toThrow(SlideDslError);
  });

  it('⭐ 死循环被超时掐掉，不会把主进程挂死', () => {
    expect(() => evaluateSlide(`<Slide>{(() => { while (true) {} })()}</Slide>`)).toThrow(SlideDslError);
  }, 10_000);

  it('沙箱里**没有宿主能力**（require / process 取不到）', () => {
    // 这两条是边界的另一半：拿不到 I/O，最多烧 CPU。
    expect(() => evaluateSlide(`<Slide>{typeof require}</Slide>`)).not.toThrow();
    const pages = evaluateSlide(`<Slide>{String(typeof require)}</Slide>`);
    const text = pages[0]?.children?.[0];
    expect(String(text)).toBe('undefined');
  });
});

describe('slidegen 版面 → DOM', () => {
  it('⭐ `Box` / `Slide` 必须带 `display:flex`', () => {
    // 实测踩过两次：一次是没设、一次是被 styleToCss 跳过。
    // 没有它，`flexDirection` / `gap` 全是死的 —— 一整页的三栏会被竖着排、冲出画布。
    const pages = evaluateSlide(`<Slide style={{ width: 1280 }}><Box style={{ flexDirection: 'row' }} /></Slide>`);
    const { html } = renderSlide(pages[0]!);
    expect(html).toContain('display:flex');
  });

  it('`Text` **不**变成 flex 容器', () => {
    expect(styleToCss({ display: 'flex' })).toBe('display:flex');
    const pages = evaluateSlide(`<Slide><Text>hi</Text></Slide>`);
    const { html } = renderSlide(pages[0]!);
    const textDiv = html.slice(html.indexOf('data-sg-kind="text"'));
    expect(textDiv.slice(0, 60)).not.toContain('display:flex');
  });

  it('数值默认加 px，少数属性不加', () => {
    expect(styleToCss({ width: 548, fontWeight: 600, lineHeight: 1.5 })).toBe(
      'width:548px;font-weight:600;line-height:1.5',
    );
  });
});

describe('slidegen 比例尺（拿参考产物反推出来的）', () => {
  it('颜色：`rgb()` 与 `rgba(…,0)`', () => {
    expect(hexOf('rgb(16, 13, 19)')).toBe('100D13');
    expect(hexOf('rgba(0, 0, 0, 0)')).toBeNull(); // 全透明 = 没有背景
    expect(hexOf('nonsense')).toBeNull();
  });

  it('⭐ 渐变：**计算样式给的是 rgb()，不是十六进制**', () => {
    // 只认 `#RRGGBB` 的话会一路掉到兜底色 —— 实测渐变副标题变成纯白、顶栏变成纯粉。
    const g = parseGradient(
      'linear-gradient(90deg, rgb(199, 123, 255) 0%, rgb(217, 33, 121) 52%, rgb(255, 122, 41) 100%)',
    );
    expect(g).not.toBeNull();
    expect(g!.stops.map((s) => s.color)).toEqual(['C77BFF', 'D92179', 'FF7A29']);
    expect(g!.angleDeg).toBe(90);
  });

  it('渐变取色：两端与中点', () => {
    const g = parseGradient('linear-gradient(90deg, #000000 0%, #FFFFFF 100%)')!;
    expect(sampleGradient(g, 0)).toBe('000000');
    expect(sampleGradient(g, 1)).toBe('FFFFFF');
    expect(sampleGradient(g, 0.5)).toBe('808080');
  });
});

/** 造一个量测结果，只用来验映射。 */
function measured(over: Partial<MeasuredElement>): MeasuredElement {
  return {
    id: 0,
    kind: 'text',
    x: 0,
    y: 0,
    w: 100,
    h: 20,
    text: '',
    fontSize: 16,
    fontWeight: 'normal',
    color: 'rgb(0,0,0)',
    textAlign: 'left',
    letterSpacing: 0,
    background: 'rgba(0,0,0,0)',
    backgroundImage: 'none',
    borderRadius: 0,
    borderWidth: 0,
    borderColor: 'rgb(0,0,0)',
    lines: 1,
    occludedBy: null,
    ...over,
  };
}

describe('slidegen 几何 → pptx 形状', () => {
  it('⭐ 字号 `px × 0.75`（与参考产物逐条相同的那条换算）', () => {
    // 参考 deck：`.slide` 里 fontSize 66 → pptx 里 sz="4950" = 49.5pt。
    const [shape] = toShapes([measured({ kind: 'text', text: 'x', fontSize: 66 })]) as Shape[];
    expect(shape).toMatchObject({ kind: 'text', fontSize: 49.5 });
  });

  it('⭐ 单行文字 `wrap:false`（否则 PowerPoint 会折行）', () => {
    // 框宽是量出来的**紧贴宽度**，PowerPoint 字宽差一点点就折
    // （实测：「战略落地」被折成「战略落」+「地」）。
    const [single] = toShapes([measured({ kind: 'text', text: 'x', lines: 1 })]) as Shape[];
    const [multi] = toShapes([measured({ kind: 'text', text: 'x', lines: 3 })]) as Shape[];
    expect(single).toMatchObject({ wrap: false });
    expect(multi).toMatchObject({ wrap: true });
  });

  it('多行文字给一点宽度余量（折行位置由 PowerPoint 决定）', () => {
    const [shape] = toShapes([measured({ kind: 'text', text: 'x', w: 100, lines: 2 })]) as Shape[];
    expect((shape as { w: number }).w).toBeGreaterThan(100);
  });

  it('渐变文字变成**逐字 run**（每个字一个色）', () => {
    const [shape] = toShapes([
      measured({
        kind: 'text',
        text: '整体落地',
        color: 'rgba(0, 0, 0, 0)',
        backgroundImage: 'linear-gradient(90deg, rgb(199,123,255) 0%, rgb(255,122,41) 100%)',
      }),
    ]) as Shape[];
    expect(shape).toMatchObject({ kind: 'text' });
    expect((shape as { gradient: unknown }).gradient).not.toBeNull();
  });

  it('⭐ 纯布局容器（没有背景的 `Box`）**不产生形状**', () => {
    expect(toShapes([measured({ kind: 'box' })])).toHaveLength(0);
    expect(toShapes([measured({ kind: 'box', background: 'rgb(255,255,255)' })])).toHaveLength(1);
  });

  it('圆角与描边带过去', () => {
    const [shape] = toShapes([
      measured({
        kind: 'box',
        w: 548,
        h: 120,
        background: 'rgb(255,255,255)',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgb(236,233,240)',
      }),
    ]) as Shape[];
    expect(shape).toMatchObject({ radius: 14, borderWidth: 1, borderColor: 'ECE9F0' });
  });

  it('⭐ 圆角超过短边一半时**钳到一半**（否则形状会变形）', () => {
    // 卡片很扁而圆角写很大时，OOXML 的圆角会退化成怪形状 —— 钳制是刻意的。
    const [shape] = toShapes([
      measured({ kind: 'box', w: 400, h: 20, background: 'rgb(255,255,255)', borderRadius: 40 }),
    ]) as Shape[];
    expect((shape as { radius: number }).radius).toBe(10);
  });
});

describe('slidegen 版式校验：**警告，不挡交付**', () => {
  it('冲出画布 ⇒ 一条警告（不是失败）', () => {
    const w = findOutOfBounds([measured({ id: 3, kind: 'box', x: 1200, y: 700, w: 400, h: 200 })]);
    expect(w).toHaveLength(1);
    expect(w[0]?.code).toBe('layout-out-of-bounds');
    expect(w[0]?.detail, '要说清超出多少，用户才能照着改').toMatch(/px/);
  });

  it('贴边（亚像素）不算越界', () => {
    expect(findOutOfBounds([measured({ kind: 'box', x: 0, y: 0, w: 1280, h: 720 })])).toHaveLength(0);
  });

  it('⭐ 文字被盖住 ⇒ 一条警告；**色块被盖住不报**（层叠装饰是正常的）', () => {
    expect(findOccludedText([measured({ id: 7, kind: 'text', text: '副标题', occludedBy: '#10' })])).toHaveLength(1);
    expect(findOccludedText([measured({ id: 8, kind: 'box', occludedBy: '#10' })])).toHaveLength(0);
  });

  it('空白文字被盖住不报（没内容可丢）', () => {
    expect(findOccludedText([measured({ kind: 'text', text: '   ', occludedBy: '#10' })])).toHaveLength(0);
  });
});

describe('slidegen 围栏抽取', () => {
  it('取到版面源码与标题', () => {
    const content = '前言\n\n```slidegen\n// title: 九月简报\n<Slide />\n```\n\n后记';
    const { decks, failures } = extractSlidegenBlocks(content);
    expect(failures).toHaveLength(0);
    expect(decks).toHaveLength(1);
    expect(decks[0]?.title).toBe('九月简报');
  });

  it('⭐ 缺 `// title:` ⇒ 明确失败（标题就是文件名）', () => {
    const { decks, failures } = extractSlidegenBlocks('```slidegen\n<Slide />\n```');
    expect(decks).toHaveLength(0);
    expect(failures[0]?.failure.code).toBe('slidegen-title-missing');
  });

  it('语法错 ⇒ 在抽取阶段就带上**精确的**失败码', () => {
    const { failures } = extractSlidegenBlocks('```slidegen\n// title: x\n<div>hi</div>\n```');
    expect(failures[0]?.failure).toMatchObject({ code: 'slidegen-unknown-tag' });
  });

  it('语言标记必须**恰好**是 slidegen（`jsx` / `slide` 都不算）', () => {
    // 用户贴一段 React 代码时，他期望那是**代码产物**，不是"我们试图当版面解析然后报错"。
    expect(extractSlidegenBlocks('```jsx\n// title: x\n<Slide />\n```').decks).toHaveLength(0);
  });
});

describe('⭐ 技能示例必须能被**真解析器**吃下（漂移守卫）', () => {
  it('`deck-layout` 技能里每一段 slidegen 示例都是合法版面', () => {
    // 这条守卫的来历：合并两条功能线时，它当场抓出两个技能里的模板示例**漏了必填的 title** ——
    // 助手照着示例写，整份被拒，而两条线各自的单测全绿（它们都绕过契约层直接调解析器）。
    // ⇒ 判据只能是"把示例原文喂给真解析器"。
    const root = resolveOurSkillsRoot({ isPackaged: false, appPath: PROJECT_DIR });
    if (!root) throw new Error('解析不到随包技能根目录 —— 这个测试就失去意义了');
    const text = fs.readFileSync(path.join(root, 'deck-layout', 'SKILL.md'), 'utf-8').replace(/\r\n/g, '\n');
    const blocks = [...text.matchAll(/```slidegen\n([\s\S]*?)\n```/g)];
    expect(blocks.length, '技能里一段 slidegen 示例都没有').toBeGreaterThan(0);

    for (const [, body] of blocks) {
      const { decks, failures } = extractSlidegenBlocks('```slidegen\n' + body + '\n```');
      expect(failures, `技能里的示例被拒了：${JSON.stringify(failures)}`).toHaveLength(0);
      expect(decks.length, '示例应当被识别成一份 deck').toBeGreaterThan(0);
      // 而且要真的能求值出页面（转换通过 ≠ 求值通过）
      const pages = evaluateSlide(decks[0]!.source);
      expect(pages.length).toBeGreaterThan(0);
      expect(pages.every((p) => p.tag === 'Slide')).toBe(true);
    }
  });

  it('技能里点名了四个标签与那个必填的 title 注释', () => {
    const root = resolveOurSkillsRoot({ isPackaged: false, appPath: PROJECT_DIR })!;
    const text = fs.readFileSync(path.join(root, 'deck-layout', 'SKILL.md'), 'utf-8');
    for (const tag of ['Slide', 'Box', 'Text', 'Image']) expect(text).toContain(tag);
    expect(text, '必须写清 title 是必填的').toMatch(/\/\/ title:/);
  });
});
