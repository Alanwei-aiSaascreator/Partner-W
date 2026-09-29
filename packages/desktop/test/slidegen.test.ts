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
    const js = transformSlideJsx(`<Slide style={{ width: 1280 }}><Text>hi</Text></Slide>`);
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

  /**
   * 🔴 2026-09-28 真机：**JSX 注释让整份 deck 求值失败** —— 而模型到处在用它。
   *
   * 现场：模型写的 13 KB deck 里满是「花括号包起来的块注释」（版面分节说明那种），
   * 而转换器把注释也当成"一个表达式孩子"，产出「左括号 + 注释 + 右括号」——
   * **一个空的括号表达式** ⇒ `SyntaxError: Unexpected token ')'` ⇒ 整份 deck 一个文件都出不来。
   *
   * ⚠️ 注释**不是**一个孩子（它不画任何东西），所以正确做法是**整段丢掉**，
   *    而不是包一层括号。这也解释了为什么它一直没被发现：
   *    以前没人写过带注释的 deck —— 而模型写版面时**天然会写注释**。
   */
  describe('JSX 注释：必须被丢掉，不能变成一个空括号', () => {
    it('⭐ 块注释不产出孩子，也不让求值炸', () => {
      const src = `<Slide>{/* 说明 */}<Text>x</Text></Slide>`;
      const js = transformSlideJsx(src);
      expect(js, '注释不该变成 (/* … */) 这种空括号表达式').not.toContain('(/*');
      const pages = evaluateSlide(src);
      expect(pages).toHaveLength(1);
      expect(pages[0]?.children, '注释不该占一个孩子位').toHaveLength(1);
    });

    it('⭐ 多行 / 连续多个注释也一样', () => {
      const src = `<Slide>\n  {/* 顶栏 */}\n  {/* 标题 */}\n  <Text>x</Text>\n</Slide>`;
      const pages = evaluateSlide(src);
      expect(pages[0]?.children).toHaveLength(1);
    });

    it('⭐ 注释夹在别的孩子中间，不影响前后', () => {
      const src = `<Slide><Text>a</Text>{/* 中间 */}<Text>b</Text></Slide>`;
      const pages = evaluateSlide(src);
      expect(pages[0]?.children).toHaveLength(2);
    });

    it('属性里的 `style={{…}}` 对象字面量不受影响（别把对象也当注释删了）', () => {
      const js = transformSlideJsx(`<Slide style={{ width: 1280 }}><Text>x</Text></Slide>`);
      expect(js, 'style 对象被误删了').toContain('width');
      expect(js).toContain('1280');
      expect(evaluateSlide(`<Slide style={{ width: 1280 }}><Text>x</Text></Slide>`)[0]?.props?.style).toMatchObject({
        width: 1280,
      });
    });
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
    expect(() => evaluateSlide(`<Slide><Text>{typeof require}</Text></Slide>`)).not.toThrow();
    const pages = evaluateSlide(`<Slide><Text>{String(typeof require)}</Text></Slide>`);
    expect(pages[0]?.children?.[0]).toMatchObject({ tag: 'Text', children: ['undefined'] });
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

  /**
   * 🔴 2026-09-28 真机：**没写 `flexDirection` 时默认横排（CSS 的默认），而模型期望竖着堆。**
   *
   * 现场：模型写的封面上是「标题 → 装饰线 → 副标题」这种最自然的堆叠，它**没写方向**
   * （因为没人会想到"容器默认横着排"）。结果三件东西被挤在同一行、互相压住，
   * 副标题还和"报告期"叠在一起 —— 一份本来设计得不错的 deck 毁在这一条上。
   *
   * ⇒ 对一个**给人排版的 DSL** 来说，容器的默认方向该是 `column`（与"文档流"的直觉一致），
   *    而不是 CSS flex 的 `row`。显式写了 `row` 的照旧 —— 只改**缺省**。
   */
  describe('Box 的默认排版方向：竖着堆', () => {
    it('⭐ 没写 flexDirection ⇒ 默认 column（模型写的"标题+线+副标题"要竖着排）', () => {
      const pages = evaluateSlide(`<Slide><Box><Text>标题</Text><Text>副标题</Text></Box></Slide>`);
      const { html } = renderSlide(pages[0]!);
      expect(html, '默认横排会把它们挤成一行 —— 真机就是这个形状').toContain('flex-direction:column');
    });

    it('写了 row 就还是 row（别把显式的盖掉）', () => {
      const pages = evaluateSlide(`<Slide><Box style={{ flexDirection: 'row' }}><Text>甲</Text></Box></Slide>`);
      const { html } = renderSlide(pages[0]!);
      // ⚠️ 只看那个 **Box** 自己的 style —— 外层 `<Slide>` 也会拿到 column，
      //    对整个 HTML 断言 `not.toContain` 会被它误伤（第一版就是这么栽的）。
      const boxDiv = html.slice(html.indexOf('data-sg-kind="box"'));
      expect(boxDiv.slice(0, 160), '显式写的 row 被缺省盖掉了').toContain('flex-direction:row');
      expect(boxDiv.slice(0, 160)).not.toContain('flex-direction:column');
    });

    it('`Text` 不是 flex 容器，别给它塞方向', () => {
      const pages = evaluateSlide(`<Slide><Text>甲</Text></Slide>`);
      const { html } = renderSlide(pages[0]!);
      const textDiv = html.slice(html.indexOf('data-sg-kind="text"'));
      expect(textDiv.slice(0, 80)).not.toContain('flex-direction');
    });
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

  /**
   * ⭐ 2026-09-28 定：**整份版面写成工作区里的一个文件**，不是写进回复正文。
   *
   * 理由是真机量出来的：显示层把**单条消息**切在 8,000 字符，所以"整份写进回复"
   * 连续四次都死在 8,000；而同一次**写进文件的那份是完整的**（13 KB）。
   * ⇒ 客户端现在**优先读文件**（`slidegen/deck-file.ts`），聊天正文只作回落。
   *
   * 所以技能必须同时说清三件事，缺一条这条路就白走：
   *  1. 用**写文件工具**、文件名以 `.slidegen` 结尾；
   *  2. 文件**里面**仍是一个**闭合**的 `slidegen` 围栏（客户端按围栏取源码）；
   *  3. 回复正文**别复述源码**（复述了就还会撞上限，而且用户会看到两遍）。
   */
  it('技能要求整份版面写成 `.slidegen` 文件，而不是贴进回复', () => {
    const root = resolveOurSkillsRoot({ isPackaged: false, appPath: PROJECT_DIR })!;
    const text = fs.readFileSync(path.join(root, 'deck-layout', 'SKILL.md'), 'utf-8').replace(/\r\n/g, '\n');

    expect(text, '要点名文件名以 `.slidegen` 结尾').toMatch(/\.slidegen/);
    expect(text, '要说清用写文件工具').toMatch(/写文件工具/);
    expect(text, '要写明一次写完').toMatch(/一次写完/);
    expect(text, '要说清文件里的围栏必须闭合（客户端按围栏取源码）').toMatch(/围栏必须闭合/);
    expect(text, '要写明正文里不要复述源码').toMatch(/不要复述源码/);
    expect(text, '要写明一栅最多 200 页').toMatch(/200 页/);
    expect(text, '不要再教模型拆成两条消息').not.toMatch(/分成?两条|分两条/);
  });
});

/**
 * 🔴 2026-09-28 真机：**助手的长回复被截断 ⇒ 围栏没有结尾 ⇒ 静默丢掉一整份演示。**
 *
 * 现场形状（不是推测）：助手消息 8,220 字符，里面有 ```slidegen 开头、**没有结尾围栏**，
 * 末尾 literally 是 `...(truncated)...`。模型写了 13 KB 的 JSX（存成了工作区里的
 * `.slidegen.jsx` 文件），版面做得很好 —— 可客户端**一条 `slidegen.*` 日志都没打**，
 * 产物面板空的，用户什么都没拿到、也没有任何提示。
 *
 * 为什么这是**这一族里最坏的一种**：`FENCE_RE` 只认**闭合**的围栏，于是"被截断"
 * 既进不了 `decks` 也进不了 `failures` ⇒ `generateSlidesFromMessage` 两个分支都不进，
 * **直接 return**。用户看到的是"助手干完了、结果已保存"，然后什么都没有。
 *
 * 判据：**只要出现了开头围栏而没有对应的结尾，就必须产一条失败** ——
 * 让 `slidegen.blocks-invalid` 落日志、让界面能说一句人话（"这份内容太长被截断了"）。
 */
describe('未闭合的 slidegen 围栏：必须报出来，不许静默', () => {
  const TRUNCATED = [
    '好的，我来做这份演示。',
    '',
    '```slidegen',
    '// title: 九月经营简报-跨境电商',
    '<Slide style={{ width: 1280, height: 720, background: "#0F0D1A" }}>',
    '  <Text style={{ fontSize: 58, color: "#FFFFFF" }}>九月经营简报</Text>',
    '...(truncated)...',
  ].join('\n');

  it('⭐ 只有开头没有结尾 ⇒ 一条 failure，而不是"什么都没发生"', () => {
    const { decks, failures } = extractSlidegenBlocks(TRUNCATED);

    expect(decks, '截断的块不该被当成完整的 deck').toHaveLength(0);
    expect(failures, '真机上就是这里静默了 —— 用户拿到的是"结果已保存"加一个空产物面板').toHaveLength(1);
    expect(failures[0].failure.code).toBe('slidegen-block-unclosed');
  });

  it('⭐ 完整的块**不受影响**（别把好的也判坏）', () => {
    const good = [
      '```slidegen',
      '// title: 九月经营简报',
      '<Slide style={{ width: 1280, height: 720, background: "#FFFFFF" }}>',
      '  <Text style={{ fontSize: 40 }}>九月</Text>',
      '</Slide>',
      '```',
    ].join('\n');

    const { decks, failures } = extractSlidegenBlocks(good);

    expect(failures).toHaveLength(0);
    expect(decks).toHaveLength(1);
    expect(decks[0].title).toBe('九月经营简报');
  });

  it('前面一个好的 + 后面一个被截断的 ⇒ 报出好的，也报出坏的', () => {
    const good = [
      '```slidegen',
      '// title: 第一份',
      '<Slide style={{ width: 1280, height: 720, background: "#FFFFFF" }}>',
      '  <Text style={{ fontSize: 40 }}>甲</Text>',
      '</Slide>',
      '```',
    ].join('\n');

    const { decks, failures } = extractSlidegenBlocks(`${good}\n\n${TRUNCATED}`);

    expect(decks).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].failure.code).toBe('slidegen-block-unclosed');
  });

  it('正文里只是**提到**这个词（没有围栏）⇒ 不报，别误伤', () => {
    const { decks, failures } = extractSlidegenBlocks('我会用 slidegen 这条路来做，稍等。');
    expect(decks).toHaveLength(0);
    expect(failures).toHaveLength(0);
  });
});

/**
 * ⚠️ 2026-09-28 删掉了这一组（原「显示层截断了，历史里的全文还在：用全文出片」）。
 *
 * 它测的是 `preferClosedSlidegenSource` —— **按"更长"挑候选、并要求候选里有一个闭合围栏**。
 * 那两条**正是新规格明令禁止的取法**（"禁止按最长消息选取 / 禁止按最近闭合 fence 猜测"）。
 * ⇒ 连同 `slidegen/full-reply.ts` 整个模块一起删了，改成按 `__openclaw.runId`
 *    **精确匹配**（见 `test/recover-full-reply.test.ts`）。
 *
 * `assistantHistoryText` 是通用的正文提取，**没删** —— 搬进了
 * `artifact/recover-full-reply.ts`，断言也跟着搬到了那个测试文件里。
 */
