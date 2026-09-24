/**
 * 文档生成的**请求契约**（助手写、客户端读）。
 *
 * ## 为什么是这个方向
 *
 * 助手跑在随包运行时里，而运行时**没有** pptx/docx/xlsx 生成库、也没有 npm/python
 * （出厂包 35047 个文件里搜 pptx/pptxgenjs/officegen/exceljs/python-pptx/libreoffice 全 0；
 * 对照串 node_modules 37119 命中 ⇒ 探针有效）。而随包 Node 在
 * `deployed/<key>/node/node.exe`、**不一定在 PATH 上** ⇒ 也不能让助手跑脚本。
 *
 * 所以分工是：**助手负责"想"，客户端负责"排"** ——
 * 助手把它想要的内容写成这个 schema 的 JSON，客户端主进程（完整 Node、库随 App 打包）
 * 渲染成真文件，写回任务目录。产物面板本来就会扫任务目录，于是**不需要新 UI**。
 * 详见 `docs/superpowers/specs/2026-09-24-local-docgen-design.md`。
 *
 * ⚠️ 这个文件只做**解析与校验**，不碰文件系统、不碰任何生成库 ——
 * 于是它可以被穷举测试，而"排版"那部分坏掉时能被立刻定位到另一层。
 *
 * ## 三种 kind 共用一套规则
 *
 * | kind   | 内容字段 | 一格/一条对应什么 |
 * | ------ | -------- | ----------------- |
 * | pptx   | `slides[{title,bullets,notes}]` | 一页 |
 * | docx   | `sections[{heading?,paragraphs,bullets}]` | 一个小节 |
 * | xlsx   | `sheets[{name,rows[][]}]` | 一张工作表 |
 *
 * `title` 三种都必填 —— 它同时是**文件名**的词干（见 `DOCGEN_OUTPUT_BY_KIND`）。
 *
 * ⚠️ 校验的松紧是**按后果**定的，不是按洁癖：
 *  - 空串/空行**丢掉**（模型爱补空行，为此整份失败不值得）；
 *  - 但**整份一个字都没有**要拒（那会产出空白文件，用户只会以为我们坏了）；
 *  - 表格里违反 Excel 硬限制的（表名 >31 字、重复、含 `[]:*?/\`）要拒 ——
 *    否则用户打开时看到的是「文件需要修复」，而那是**我们**生成的文件。
 */
import { join } from 'node:path';

/** 支持的三种格式。加第四种时：这里 + `DOCGEN_OUTPUT_BY_KIND` + 渲染层分发。 */
export const DOCGEN_KINDS = ['pptx', 'docx', 'xlsx'] as const;
export type DocgenKind = (typeof DOCGEN_KINDS)[number];

/**
 * kind ⇒ 产物的扩展名与"标题空了用什么名字"。
 *
 * 放在契约层的理由：扩展名是 **kind 的函数**，让落盘层自己拼 `.docx` 会出现
 * "schema 说是 pptx、文件名是 .docx"这类两边各自漂移的错。
 */
export const DOCGEN_OUTPUT_BY_KIND: Readonly<Record<DocgenKind, { extension: string; fallbackStem: string }>> =
  Object.freeze({
    pptx: { extension: '.pptx', fallbackStem: '演示文稿' },
    docx: { extension: '.docx', fallbackStem: '文档' },
    xlsx: { extension: '.xlsx', fallbackStem: '表格' },
  });

/** 请求文件的后缀（遗留：文件通道用的，见文件末尾 `presentationPathFor`）。 */
export const DOCGEN_REQUEST_SUFFIX = '.docgen.json';

export interface DocgenSlide {
  /** 页标题。 */
  title: string;
  /** 要点列表（可为空 —— 例如纯标题的分隔页）。 */
  bullets: string[];
  /** 备注（讲者备注），可空。 */
  notes?: string;
}

export interface DocgenPptxRequest {
  kind: 'pptx';
  /** 演示标题（封面用）。 */
  title: string;
  /** 副标题（封面用），可空。 */
  subtitle?: string;
  slides: DocgenSlide[];
}

export interface DocgenSection {
  /** 小标题，可空（正文里夹一段没有标题的段落是正常的）。 */
  heading?: string;
  /** 自然段，一段一条。 */
  paragraphs: string[];
  /** 要点列表。 */
  bullets: string[];
}

export interface DocgenDocxRequest {
  kind: 'docx';
  /** 文档标题。 */
  title: string;
  sections: DocgenSection[];
}

/** 单元格：文本 / 数字 / 布尔。**数字保持数字**，否则用户在 Excel 里没法求和。 */
export type DocgenCell = string | number | boolean;

export interface DocgenSheet {
  /** 工作表名（Excel 硬限制：≤31 字、不含 `[]:*?/\`、不与其他表重名）。 */
  name: string;
  /** 一行一条记录，一个单元一个值。 */
  rows: DocgenCell[][];
}

export interface DocgenXlsxRequest {
  kind: 'xlsx';
  /** 表格标题（文件名用）。 */
  title: string;
  sheets: DocgenSheet[];
}

export type DocgenRequest = DocgenPptxRequest | DocgenDocxRequest | DocgenXlsxRequest;

export type DocgenParseResult = { ok: true; request: DocgenRequest } | { ok: false; error: string };

/**
 * 上限：既是防手滑，也是防"助手把整篇文档塞进一个字段"。
 *
 * ⚠️ pptx 那四个是 P1 定下的，**一个都不许动**（技能里也是照这些数写的）。
 */
export const DOCGEN_LIMITS = Object.freeze({
  // ── pptx（P1）────────────────────────────────────────────────────────
  maxSlides: 60,
  maxBulletsPerSlide: 12,
  maxTitleChars: 120,
  maxBulletChars: 300,
  maxNotesChars: 2000,
  // ── docx ─────────────────────────────────────────────────────────────
  maxSections: 40,
  maxParagraphsPerSection: 60,
  maxBulletsPerSection: 40,
  maxHeadingChars: 120,
  maxParagraphChars: 2000,
  // ── xlsx ─────────────────────────────────────────────────────────────
  maxSheets: 12,
  maxRowsPerSheet: 2000,
  maxColumnsPerSheet: 50,
  maxSheetNameChars: 31,
  maxCellChars: 1000,
});

/** Excel 对工作表名的硬限制：这几个字符出现在名字里，文件会被判"需要修复"。 */
const SHEET_NAME_FORBIDDEN = ['[', ']', ':', '*', '?', '/', '\\'];

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** 取"第几项"的前缀（`sections[2].paragraphs` ⇒ `sections[2]`）。 */
function parentPath(where: string): string {
  const cut = where.lastIndexOf('.');
  return cut === -1 ? where : where.slice(0, cut);
}

interface StringListOptions {
  /** 字段路径，例如 `slides[0].bullets` —— 报错里逐字带上，助手才知道改哪。 */
  where: string;
  /** 报错文案里的量词（`a bullet` / `a paragraph`）。 */
  noun: string;
  maxItems: number;
  maxChars: number;
}

/**
 * 一串文本（要点 / 自然段）：空串丢掉、超量或超长报错。
 *
 * 抽出来是因为 pptx 的 `bullets` 与 docx 的 `paragraphs`/`bullets` 是同一条规则；
 * 报错文案与 P1 逐字相同（`slides[0] has a bullet longer than 300 characters`）。
 */
function parseStringList(
  raw: unknown,
  options: StringListOptions,
): { ok: true; items: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, items: [] };
  if (!Array.isArray(raw)) return { ok: false, error: `${options.where} must be an array` };
  // ⚠️ 数量按**原样条数**算（含空串）—— 与 P1 的 pptx 逐字一致，别改成"丢完再数"。
  if (raw.length > options.maxItems) {
    return { ok: false, error: `${options.where} exceeds ${options.maxItems}` };
  }
  const kept: string[] = [];
  for (const item of raw) {
    const text = asTrimmedString(item);
    // ⚠️ 空串直接丢（不是报错）：模型偶尔会补一个空行，为此整份失败不值得。
    if (!text) continue;
    if (text.length > options.maxChars) {
      return {
        ok: false,
        error: `${parentPath(options.where)} has a ${options.noun} longer than ${options.maxChars} characters`,
      };
    }
    kept.push(text);
  }
  return { ok: true, items: kept };
}

function parseTitle(raw: unknown): { ok: true; title: string } | { ok: false; error: string } {
  const title = asTrimmedString(raw);
  if (!title) return { ok: false, error: 'title is required' };
  if (title.length > DOCGEN_LIMITS.maxTitleChars) {
    return { ok: false, error: `title exceeds ${DOCGEN_LIMITS.maxTitleChars} characters` };
  }
  return { ok: true, title };
}

function parsePptx(input: Record<string, unknown>, title: string): DocgenParseResult {
  const rawSlides = input.slides;
  if (!Array.isArray(rawSlides)) return { ok: false, error: 'slides must be an array' };
  if (rawSlides.length === 0) return { ok: false, error: 'slides must not be empty' };
  if (rawSlides.length > DOCGEN_LIMITS.maxSlides) {
    return { ok: false, error: `slides exceeds ${DOCGEN_LIMITS.maxSlides}` };
  }

  const slides: DocgenSlide[] = [];
  for (let i = 0; i < rawSlides.length; i += 1) {
    const where = `slides[${i}]`;
    const rawSlide = rawSlides[i];
    if (rawSlide === null || typeof rawSlide !== 'object' || Array.isArray(rawSlide)) {
      return { ok: false, error: `${where} must be an object` };
    }
    const slide = rawSlide as Record<string, unknown>;

    const slideTitle = asTrimmedString(slide.title);
    if (!slideTitle) return { ok: false, error: `${where}.title is required` };
    if (slideTitle.length > DOCGEN_LIMITS.maxTitleChars) {
      return { ok: false, error: `${where}.title exceeds ${DOCGEN_LIMITS.maxTitleChars} characters` };
    }

    const bullets = parseStringList(slide.bullets, {
      where: `${where}.bullets`,
      noun: 'bullet',
      maxItems: DOCGEN_LIMITS.maxBulletsPerSlide,
      maxChars: DOCGEN_LIMITS.maxBulletChars,
    });
    if (!bullets.ok) return { ok: false, error: bullets.error };

    let notes: string | undefined;
    if (slide.notes !== undefined && slide.notes !== null) {
      const trimmed = asTrimmedString(slide.notes);
      if (trimmed && trimmed.length > DOCGEN_LIMITS.maxNotesChars) {
        return { ok: false, error: `${where}.notes exceeds ${DOCGEN_LIMITS.maxNotesChars} characters` };
      }
      notes = trimmed ?? undefined;
    }

    slides.push(
      notes ? { title: slideTitle, bullets: bullets.items, notes } : { title: slideTitle, bullets: bullets.items },
    );
  }

  const subtitle = asTrimmedString(input.subtitle) ?? undefined;
  if (subtitle && subtitle.length > DOCGEN_LIMITS.maxTitleChars) {
    return { ok: false, error: `subtitle exceeds ${DOCGEN_LIMITS.maxTitleChars} characters` };
  }

  return { ok: true, request: subtitle ? { kind: 'pptx', title, subtitle, slides } : { kind: 'pptx', title, slides } };
}

function parseDocx(input: Record<string, unknown>, title: string): DocgenParseResult {
  const rawSections = input.sections;
  if (!Array.isArray(rawSections)) return { ok: false, error: 'sections must be an array' };
  if (rawSections.length === 0) return { ok: false, error: 'sections must not be empty' };
  if (rawSections.length > DOCGEN_LIMITS.maxSections) {
    return { ok: false, error: `sections exceeds ${DOCGEN_LIMITS.maxSections}` };
  }

  const sections: DocgenSection[] = [];
  let hasContent = false;
  for (let i = 0; i < rawSections.length; i += 1) {
    const where = `sections[${i}]`;
    const rawSection = rawSections[i];
    if (rawSection === null || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
      return { ok: false, error: `${where} must be an object` };
    }
    const section = rawSection as Record<string, unknown>;

    const heading = asTrimmedString(section.heading);
    if (heading && heading.length > DOCGEN_LIMITS.maxHeadingChars) {
      return { ok: false, error: `${where}.heading exceeds ${DOCGEN_LIMITS.maxHeadingChars} characters` };
    }

    const paragraphs = parseStringList(section.paragraphs, {
      where: `${where}.paragraphs`,
      noun: 'paragraph',
      maxItems: DOCGEN_LIMITS.maxParagraphsPerSection,
      maxChars: DOCGEN_LIMITS.maxParagraphChars,
    });
    if (!paragraphs.ok) return { ok: false, error: paragraphs.error };

    const bullets = parseStringList(section.bullets, {
      where: `${where}.bullets`,
      noun: 'bullet',
      maxItems: DOCGEN_LIMITS.maxBulletsPerSection,
      maxChars: DOCGEN_LIMITS.maxBulletChars,
    });
    if (!bullets.ok) return { ok: false, error: bullets.error };

    if (heading || paragraphs.items.length > 0 || bullets.items.length > 0) hasContent = true;
    sections.push(
      heading
        ? { heading, paragraphs: paragraphs.items, bullets: bullets.items }
        : { paragraphs: paragraphs.items, bullets: bullets.items },
    );
  }

  // 全是空小节 ⇒ 会渲染出一份空白 Word。宁可整份失败（日志里有原因、助手能重发）。
  if (!hasContent) return { ok: false, error: 'sections have no content' };
  return { ok: true, request: { kind: 'docx', title, sections } };
}

function parseSheetName(raw: unknown, where: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = asTrimmedString(raw);
  if (!name) return { ok: false, error: `${where}.name is required` };
  if (name.length > DOCGEN_LIMITS.maxSheetNameChars) {
    return { ok: false, error: `${where}.name exceeds ${DOCGEN_LIMITS.maxSheetNameChars} characters` };
  }
  const forbidden = SHEET_NAME_FORBIDDEN.find((ch) => name.includes(ch));
  if (forbidden) {
    return { ok: false, error: `${where}.name contains "${forbidden}" which Excel does not allow in a sheet name` };
  }
  return { ok: true, name };
}

function parseSheetRows(
  raw: unknown,
  where: string,
): { ok: true; rows: DocgenCell[][]; nonEmptyRows: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, rows: [], nonEmptyRows: 0 };
  if (!Array.isArray(raw)) return { ok: false, error: `${where}.rows must be an array` };
  if (raw.length > DOCGEN_LIMITS.maxRowsPerSheet) {
    return { ok: false, error: `${where}.rows exceeds ${DOCGEN_LIMITS.maxRowsPerSheet}` };
  }

  const rows: DocgenCell[][] = [];
  let nonEmptyRows = 0;
  for (let r = 0; r < raw.length; r += 1) {
    const rawRow = raw[r];
    if (!Array.isArray(rawRow)) return { ok: false, error: `${where}.rows[${r}] must be an array` };
    if (rawRow.length > DOCGEN_LIMITS.maxColumnsPerSheet) {
      return { ok: false, error: `${where}.rows[${r}] exceeds ${DOCGEN_LIMITS.maxColumnsPerSheet} cells` };
    }

    const cells: DocgenCell[] = [];
    for (let c = 0; c < rawRow.length; c += 1) {
      const cell = rawRow[c];
      // null / undefined = 留空（JSON 里表达"这格没有值"的常规写法）。
      if (cell === null || cell === undefined) {
        cells.push('');
        continue;
      }
      if (typeof cell === 'string') {
        const text = cell.trim();
        if (text.length > DOCGEN_LIMITS.maxCellChars) {
          return { ok: false, error: `${where}.rows[${r}][${c}] exceeds ${DOCGEN_LIMITS.maxCellChars} characters` };
        }
        cells.push(text);
        continue;
      }
      if (typeof cell === 'number') {
        // NaN / Infinity 写进 xlsx 是坏值（而且 JSON 本身也表达不了）⇒ 拒。
        if (!Number.isFinite(cell)) {
          return { ok: false, error: `${where}.rows[${r}][${c}] must be a finite number` };
        }
        cells.push(cell);
        continue;
      }
      if (typeof cell === 'boolean') {
        cells.push(cell);
        continue;
      }
      return { ok: false, error: `${where}.rows[${r}][${c}] must be a string, number or boolean` };
    }

    // ⚠️ 空行丢掉：判断"空"必须是**逐格比空串**，不能用真值判断 ——
    //    `0` 与 `false` 都是合法内容，误丢会把用户的数字吃掉。
    if (cells.every((cell) => cell === '')) continue;
    nonEmptyRows += 1;
    rows.push(cells);
  }

  return { ok: true, rows, nonEmptyRows };
}

function parseXlsx(input: Record<string, unknown>, title: string): DocgenParseResult {
  const rawSheets = input.sheets;
  if (!Array.isArray(rawSheets)) return { ok: false, error: 'sheets must be an array' };
  if (rawSheets.length === 0) return { ok: false, error: 'sheets must not be empty' };
  if (rawSheets.length > DOCGEN_LIMITS.maxSheets) {
    return { ok: false, error: `sheets exceeds ${DOCGEN_LIMITS.maxSheets}` };
  }

  const sheets: DocgenSheet[] = [];
  const seenNames = new Set<string>();
  let totalRows = 0;
  for (let i = 0; i < rawSheets.length; i += 1) {
    const where = `sheets[${i}]`;
    const rawSheet = rawSheets[i];
    if (rawSheet === null || typeof rawSheet !== 'object' || Array.isArray(rawSheet)) {
      return { ok: false, error: `${where} must be an object` };
    }
    const sheet = rawSheet as Record<string, unknown>;

    const name = parseSheetName(sheet.name, where);
    if (!name.ok) return { ok: false, error: name.error };
    // Excel 判重不区分大小写（Sheet1 与 sheet1 会撞），这里也照它的规矩。
    const nameKey = name.name.toLowerCase();
    if (seenNames.has(nameKey)) {
      return { ok: false, error: `duplicate sheet name "${name.name}"` };
    }
    seenNames.add(nameKey);

    const rows = parseSheetRows(sheet.rows, where);
    if (!rows.ok) return { ok: false, error: rows.error };
    totalRows += rows.nonEmptyRows;

    sheets.push({ name: name.name, rows: rows.rows });
  }

  // 一格都没有 ⇒ 会渲染出一份空表（连表头都没有），比失败更让人困惑。
  if (totalRows === 0) return { ok: false, error: 'sheets have no content' };
  return { ok: true, request: { kind: 'xlsx', title, sheets } };
}

/**
 * 解析并校验请求。
 *
 * 认不出来一律**返回错误而不是猜**：这个函数的下游是要写进用户工作区的文件，
 * "猜一个能跑的形状"会让用户拿到一份内容不对的文档，比直接失败更糟。
 */
export function parseDocgenRequest(raw: unknown): DocgenParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'request must be a JSON object' };
  }
  const input = raw as Record<string, unknown>;

  const kind = asTrimmedString(input.kind);
  if (!kind) return { ok: false, error: 'kind is required' };
  if (!(DOCGEN_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `unsupported kind "${kind}" (only: ${DOCGEN_KINDS.join(', ')})` };
  }

  const title = parseTitle(input.title);
  if (!title.ok) return { ok: false, error: title.error };

  switch (kind as DocgenKind) {
    case 'pptx':
      return parsePptx(input, title.title);
    case 'docx':
      return parseDocx(input, title.title);
    case 'xlsx':
      return parseXlsx(input, title.title);
  }
}

/**
 * 请求文件路径 ⇒ 产物文件路径。
 *
 * ⚠️ **这是"文件通道"的遗留**（P1 最初想让助手写请求文件、客户端扫目录，
 * 后来发现助手沙箱与任务目录是兄弟目录、写不过去，改走消息里的 `docgen` 块；
 * 见设计稿 §9）。**产品里没有任何地方调用它**，只有测试在养着它，而且它只认 pptx。
 * P2 不动它（删不删是单独的决定），但**不要**照它的形状加 docx/xlsx ——
 * 现在的契约是 `parseDocgenRequest` 那条路。
 *
 * 约定（曾经的）：请求文件是 `.<名字>.docgen.json`，产物是 `<名字>.pptx`。
 *
 * ⚠️ **前导点不是装饰**：产物扫描会跳过点文件（`artifact/reconcile.ts:190`
 * 的 `name.startsWith('.')`，实测 `.secret.txt` 就被跳过）⇒ 这样用户不会在
 * 产物面板里看到一份 `.docgen.json` 噪音，只看到那份 pptx。
 */
export function presentationPathFor(requestFileName: string): string | null {
  if (!requestFileName.toLowerCase().endsWith(DOCGEN_REQUEST_SUFFIX)) return null;
  const withoutSuffix = requestFileName.slice(0, -DOCGEN_REQUEST_SUFFIX.length);

  // ⚠️ 允许**普通子目录**（助手常会先建个 `output/`），但拒绝任何能越界的写法：
  //    `..`、以及隐藏目录（产物扫描本来就会跳过点开头的东西，藏进 `.x/` 的请求
  //    即使生成了用户也看不见）。这个返回值会被拿去 join 后**写文件**，所以宁可严。
  const segments = withoutSuffix.split(/[\\/]+/).filter((part) => part !== '');
  const base = segments.pop();
  if (!base) return null;
  const stem = base.replace(/^\.+/, '').trim();
  if (!stem || stem === '.' || stem === '..') return null;
  if (segments.some((part) => part === '.' || part === '..' || part.startsWith('.'))) return null;

  return join(...segments, `${stem}.pptx`);
}
