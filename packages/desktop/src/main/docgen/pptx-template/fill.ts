/**
 * 用 `pptx-automizer` 把结构化内容**填进设计师做好的模板页**。
 *
 * 与 `render-pptx.ts`（pptxgenjs，从坐标上画）的根本区别：
 * 那一版每一页都是"白底 + 标题 + 项目符号"，因为它只有画矩形和文本框的能力；
 * 这一版**不动任何样式** —— 版式、配色、字体、留白全是设计师在模板里定死的，
 * 我们只替换文本框里的文字。这就是"效果差"那个问题的正解。
 *
 * ## 为什么值只经 `textContent` 写入就安全
 *
 * `modify.setText()` 内部是 `element.firstChild.textContent = sanitize(value)`。
 * `@xmldom/xmldom` 在**序列化时**对文本节点里的 `&` `<` `>` 做转义，
 * 所以助手写 `<a:hlinkClick>` 出来只会是一串字，不会变成标记。
 * `sanitize` 另外还剥掉控制字符（`\u0000`-`\u0008` 等）。
 * ⚠️ 这是**库的行为，不是我们的判断** —— 所以 `test/pptx-template-fill.test.ts`
 *    有一条专门的断言：把 `<script>` 塞进字段，从产出的 pptx 里解出 XML，
 *    必须读到转义后的 `&lt;script&gt;`。库哪天改了行为，那条会红。
 *
 * ## 输出仍是**可编辑**的 pptx
 *
 * 这一点与"截图铺满幻灯片"那条路（Gamma 那类产品）是取舍关系：
 * 我们**不**把页面栅格化成图片，因为用户要拿它继续改。
 * 代价是效果上限由模板决定，而不是由浏览器排版引擎决定 —— 这是刻意的选择。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { Automizer, modify, type XmlElement } from 'pptx-automizer';
import { findPptxTemplate, pageNumberShapeFor, PPTX_BLANK_ROOT_FILE, PPTX_TEMPLATE_FILE } from './catalog.js';
import type { TemplateDeckSpec } from './parse.js';
import { CONTROLLED_TEMPLATE_FILE } from './controlled.js';

/** `load()` 给模板起的内部名字，只在本文件里用。 */
const TEMPLATE_KEY = 'deck';

export class PptxTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PptxTemplateError';
  }
}

export interface FillTemplateDeckOptions {
  deck: TemplateDeckSpec;
  /** `<resources>/pptx-templates`（打包态）或 `packages/desktop/resources/pptx-templates`（开发态）。 */
  templatesRoot: string;
  /** 临时目录 —— automizer 的 `outputDir`，最终产物由调用方读成 Buffer 后走现成的产物通道。 */
  outputDir: string;
  /** 输出文件名（不含目录）。 */
  outputName: string;
}

/**
 * 按 `deck` 生成一份 pptx，返回它的绝对路径。
 *
 * ⚠️ 模板**只读不写**：automizer 读 `<templatesRoot>/<file>`，
 *    往 `outputDir` 写。安装目录通常没有写权限，而且模板是随包资源不是用户数据。
 */
export async function fillTemplateDeck(opts: FillTemplateDeckOptions): Promise<string> {
  const templateFile = opts.deck.controlledNative ? CONTROLLED_TEMPLATE_FILE : PPTX_TEMPLATE_FILE;
  const templatePath = path.join(opts.templatesRoot, templateFile);
  if (!existsSync(templatePath)) {
    // 这条几乎只会在"打包时忘了 extraResources"时出现。
    // 说清楚是**模板文件缺失**，别让它表现成一句泛泛的渲染失败。
    throw new PptxTemplateError(`pptx template file not found: ${templatePath}`);
  }
  const rootPath = path.join(opts.templatesRoot, PPTX_BLANK_ROOT_FILE);
  if (!existsSync(rootPath)) {
    throw new PptxTemplateError(`pptx blank root not found: ${rootPath}`);
  }

  const automizer = new Automizer({ templateDir: opts.templatesRoot, outputDir: opts.outputDir });

  // ⚠️ 根模板是一份**零页**的 pptx（只有母版/版式/主题），不是那份模板集本身。
  //    两个原因，都是实测出来的，别图省事改回 `loadRoot(PPTX_TEMPLATE_FILE)`：
  //
  //    ① 用模板集当根、再靠 `removeExistingSlides: true` 清掉它那 8 页 ——
  //       那个开关**只从 `p:sldIdLst` 删条目，部件留在包里**（库自己的注释写了这是
  //       已知行为，见 issue #166）。于是成品里躺着 8 页孤儿，每页还带着
  //       `{{占位符}}`：包更大、而且谁要是按部件列表去读就会读到它们。
  //    ② 更早一版里那份模板集的 `presentation.xml` 根元素**没声明 `xmlns:r`**
  //       （WPS 把命名空间下推到各元素上），而追加 `p:sldId` 时会用到 `r:id`
  //       ⇒ 文档不是命名空间良构的 ⇒ **WPS 判 0 页**，而所有单测全绿。
  //       零页根是干净重打包出来的，这个问题在源头就不存在。
  const pres = automizer.loadRoot(PPTX_BLANK_ROOT_FILE).load(templateFile, TEMPLATE_KEY);

  for (let index = 0; index < opts.deck.slides.length; index += 1) {
    const slide = opts.deck.slides[index];
    const spec = findPptxTemplate(slide.templateId);
    // parse.ts 已经保证 templateId 在白名单里；这里是**第二道**，
    // 防的是"有人绕过 parse 直接调 fill"（比如以后加别的调用方）。
    if (!spec) throw new PptxTemplateError(`unknown templateId: ${slide.templateId}`);

    // 页脚页码按**在成品里的位置**写，不沿用模板里那个写死的数。
    // 模板里的 FOOTER_PAGE_6 = "06" 记的是它在模板文件里排第六，
    // 而一副 3 页的 deck 里它可能只排第二 —— 不换的话页脚会印 01 / 06 / 07。
    const pageNumber = String(index + 1).padStart(2, '0');
    const pageShape = pageNumberShapeFor(spec.id);

    pres.addSlide(TEMPLATE_KEY, spec.slide, (target) => {
      // ⚠️ 遍历**目录里的全部占位符**，而不是 `slide.data` 里的键。
      //    差别在"没给值的可选字段"：`data` 里没有它，但模板里那个 `{{note_3}}`
      //    还在 —— 只遍历 data 的话，成品上会挂着一个没被换掉的 `{{note_3}}`，
      //    那是给用户看的假字。`parse.ts` 已经把所有缺的补成空串，
      //    这里再按目录走一遍，等于"只要白名单里有，就一定被写到"。
      for (const [token, tokenSpec] of Object.entries(spec.tokens)) {
        const value = slide.data[token] ?? '';
        if (opts.deck.controlledNative && slide.chart && !['SLIDE_TITLE', 'SLIDE_SUBTITLE'].includes(tokenSpec.shape))
          continue;
        if (opts.deck.controlledNative && !value.trim() && !tokenSpec.keepTemplateTextWhenEmpty) {
          target.removeElement(tokenSpec.shape);
          continue;
        }
        if (tokenSpec.keepTemplateTextWhenEmpty && !value.trim()) continue;
        target.modifyElement(tokenSpec.shape, [modify.setText(value)]);
      }
      if (pageShape) target.modifyElement(pageShape, [modify.setText(pageNumber)]);
      if (opts.deck.controlledNative && spec.id === 'insight') {
        const takeaway = !!slide.data.takeaway;
        if (!takeaway) {
          for (const name of ['TAKEAWAY_LABEL', 'INSIGHT_RULE']) target.removeElement(name);
        }
        const evidence = [1, 2, 3].filter((row) => slide.data[`evidence_${row}`]);
        for (let row = 1; row <= 3; row++) {
          if (!evidence.includes(row)) {
            target.removeElement(`EVIDENCE_${row}_NUMBER`);
          } else {
            const column = evidence.indexOf(row);
            const width = (11.6 - (evidence.length - 1) * 0.4) / evidence.length;
            const x = 0.67 + column * (width + 0.4);
            const y = takeaway ? 4.65 : 2.95;
            target.modifyElement(`EVIDENCE_${row}`, [
              modify.setPosition({
                x: x * 914400,
                y: y * 914400,
                w: width * 914400,
                h: (takeaway ? 1.65 : 3.25) * 914400,
              }),
            ]);
            target.modifyElement(`EVIDENCE_${row}_NUMBER`, [
              modify.setPosition({ x: x * 914400, y: (y - 0.4) * 914400 }),
            ]);
          }
        }
        for (const name of ['EVIDENCE_DIVIDER_1', 'EVIDENCE_DIVIDER_2']) target.removeElement(name);
      }
      if (opts.deck.controlledNative && spec.id === 'cover' && !slide.data.date && !slide.data.author)
        target.removeElement('COVER_META_SEPARATOR');
      if (opts.deck.controlledNative && spec.id === 'cover')
        target.modifyElement('COVER_INDEX', [modify.setText(pageNumber)]);
      if (opts.deck.controlledNative && spec.id === 'closing')
        target.modifyElement('CLOSING_INDEX', [modify.setText(pageNumber)]);
      if (opts.deck.controlledNative && slide.chart) {
        for (const token of Object.values(spec.tokens)) {
          if (!['SLIDE_TITLE', 'SLIDE_SUBTITLE'].includes(token.shape)) target.removeElement(token.shape);
        }
        for (const name of ['METRIC_DIVIDER_1', 'METRIC_DIVIDER_2']) target.removeElement(name);
        const chart = slide.chart;
        target.generate((native, pptx) => {
          native.addChart(
            pptx.ChartType.bar,
            chart.data.map((series) => ({ ...series, labels: [...series.labels], values: [...series.values] })),
            {
              x: 0.67,
              y: 2.65,
              w: 7.15,
              h: 2.4,
              showLegend: true,
              legendPos: 'b',
              legendFontSize: 18,
              catAxisLabelFontSize: 18,
              valAxisLabelFontSize: 18,
              chartColors: ['087CB8', '4D6077'],
              showValue: false,
            },
          );
          native.addText(chart.unit, { x: 0.67, y: 2.32, w: 7.15, h: 0.3, fontSize: 18, margin: 0, color: '4D6077' });
          const rows = [
            ['Period', ...chart.data.map((series) => series.name)],
            ...chart.data[0].labels.map((label, index) => [
              label,
              ...chart.data.map((series) => String(series.values[index])),
            ]),
          ];
          native.addTable(
            rows.map((row) => row.map((text) => ({ text }))),
            {
              x: 8.15,
              y: 2.65,
              w: 4.05,
              h: 2.4,
              fontSize: 18,
              border: { type: 'solid', pt: 0.5, color: 'CBD6DF' },
              margin: 0.08,
              color: '17171C',
              rowH: 0.43,
              autoPage: false,
            },
          );
          for (let metric = 1; metric <= 3; metric++) {
            const text = ['label', 'value', 'note']
              .map((field) => slide.data[`${field}_${metric}`])
              .filter(Boolean)
              .join('\n');
            if (text)
              native.addText(text, {
                x: 0.67 + (metric - 1) * 3.87,
                y: 5.15,
                w: 3.65,
                h: 1.1,
                fontSize: 18,
                color: '17171C',
                margin: 0,
              });
          }
          if (slide.data.source_or_note)
            native.addText(
              slide.data.source_or_note,
              {
                x: 0.67,
                y: 6.3,
                w: 11.6,
                h: 0.55,
                fontSize: 16,
                color: '4D6077',
                margin: 0,
              },
              [
                (shape: XmlElement) => {
                  const properties = shape.getElementsByTagName('p:cNvPr').item(0);
                  if (!properties) throw new Error('native-note-role-unavailable');
                  properties.setAttribute('name', 'ROYIN_SOURCE_NOTE');
                },
              ],
            );
        });
      }
      if (spec.id === 'actions') {
        for (let row = 1; row <= 4; row += 1) {
          const empty = ['action', 'owner', 'due'].every((key) => !(slide.data[`${key}_${row}`] ?? '').trim());
          if (empty) {
            target.removeElement(`ACTION_${row}_NUMBER`);
            target.removeElement(`ACTION_RULE_${row}`);
          }
        }
      }
    });
  }

  // ⚠️ 上面每一次 addSlide/modifyElement 都只是**排队**；真正干活在 write()。
  await pres.write(opts.outputName);
  return path.join(opts.outputDir, opts.outputName);
}
