import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { DocgenDocxRequest } from './request.js';

/**
 * 把校验过的请求渲染成 docx 字节（Word / WPS 都能开）。
 *
 * ⚠️ **中文字体必须落到 `w:eastAsia` 上** —— 判断"中文用什么字体"的是这个属性，
 *    `w:ascii` / `w:hAnsi` 只管西文（这是 `cn-docx-writer` 那份踩坑记录的头一条）。
 *    ⭐ **本库（`docx` 9.7.2）不存在 python-docx 那个"只写 font.name 就漏 eastAsia"的坑** ——
 *    读过它的 `createRunFonts`：传**字符串**时四个属性（`ascii`/`cs`/`eastAsia`/`hAnsi`）写的是同一个名字。
 *    所以这里仍然显式写成对象，是因为**中西文的字体名不总是同一个字符串**
 *    （西文 SimSun / 中文 宋体 是同一族的两面），并且让"哪个属性管哪一半"在代码里看得见；
 *    而 `test/docgen-render-docx.test.ts` 里那条 `w:eastAsia` 断言，钉的是
 *    **将来换库、或有人把对象写歪（漏了 eastAsia）**这类回归 —— 不是本库的已知缺陷。
 *
 * 字体选择照 `cn-docx-writer` 那份踩坑记录：正文**宋体**、标题**黑体**；
 * 刻意**不用微软雅黑**（部分 WPS 版本对它的渲染不稳）。
 *
 * 版式：A4 默认、页边距按中文文档的习惯（上下 2.54cm / 左右 3.18cm）、
 * 正文 1.5 倍行距 + 首行缩进两字、小标题用 Word 的 Heading 1 样式
 * （这样导航窗格与自动目录认得出层级）。**不做**模板/封面/页眉页脚 —— P3 的事。
 */

/** 中西分写：`ascii`/`hAnsi` 管西文，`eastAsia` 管中文（缺了它 WPS 会用西文字体渲染中文）。 */
const BODY_FONT = { ascii: 'SimSun', eastAsia: '宋体', hAnsi: 'SimSun' } as const;
const HEADING_FONT = { ascii: 'SimHei', eastAsia: '黑体', hAnsi: 'SimHei' } as const;

/** docx 的字号单位是**半磅**（half-point）：24 = 12pt = 小四。 */
const TITLE_SIZE = 44; // 22pt
const HEADING_SIZE = 28; // 14pt
const BODY_SIZE = 24; // 12pt

/** 长度单位是 twip（1/20 磅，1440 = 1 英寸 = 2.54cm）。 */
const PAGE_MARGIN = { top: 1440, bottom: 1440, left: 1800, right: 1800 } as const;
/** 1.5 倍行距；首行缩进两字 = 24pt = 480 twip。 */
const BODY_SPACING = { line: 360, after: 120 } as const;
const FIRST_LINE_INDENT = 480;

export async function renderDocx(request: DocgenDocxRequest): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 360 },
      children: [new TextRun({ text: request.title, font: HEADING_FONT, size: TITLE_SIZE, bold: true })],
    }),
  ];

  for (const section of request.sections) {
    if (section.heading) {
      children.push(
        new Paragraph({
          // 样式给 Word 的导航/目录看，字体给渲染看 —— 两件都要。
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
          children: [new TextRun({ text: section.heading, font: HEADING_FONT, size: HEADING_SIZE, bold: true })],
        }),
      );
    }

    for (const text of section.paragraphs) {
      children.push(
        new Paragraph({
          spacing: BODY_SPACING,
          indent: { firstLine: FIRST_LINE_INDENT },
          children: [new TextRun({ text, font: BODY_FONT, size: BODY_SIZE })],
        }),
      );
    }

    for (const text of section.bullets) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: BODY_SPACING,
          children: [new TextRun({ text, font: BODY_FONT, size: BODY_SIZE })],
        }),
      );
    }
  }

  const document = new Document({
    creator: 'Partner-W',
    title: request.title,
    styles: {
      default: {
        // 文档级兜底：万一有 run 忘了带字体（将来加版式时容易漏），也还是中文可读的。
        document: { run: { font: BODY_FONT, size: BODY_SIZE }, paragraph: { spacing: BODY_SPACING } },
      },
    },
    sections: [{ properties: { page: { margin: PAGE_MARGIN } }, children }],
  });

  return Packer.toBuffer(document);
}
