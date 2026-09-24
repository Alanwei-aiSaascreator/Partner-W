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
 * ⚠️ 这个文件只做**解析与校验**，不碰文件系统、不碰 pptxgenjs ——
 * 于是它可以被穷举测试，而"排版"那部分坏掉时能被立刻定位到另一层。
 */
import { join } from 'node:path';

/** 现在只支持 pptx。docx / xlsx 是同一套形状，P2 再加。 */
export const DOCGEN_KINDS = ['pptx'] as const;
export type DocgenKind = (typeof DOCGEN_KINDS)[number];

/** 请求文件的后缀：助手写 `xxx.docgen.json` ⇒ 产出 `xxx.pptx`。 */
export const DOCGEN_REQUEST_SUFFIX = '.docgen.json';

export interface DocgenSlide {
  /** 页标题。 */
  title: string;
  /** 要点列表（可为空 —— 例如纯标题的分隔页）。 */
  bullets: string[];
  /** 备注（讲者备注），可空。 */
  notes?: string;
}

export interface DocgenRequest {
  kind: DocgenKind;
  /** 演示标题（封面用）。 */
  title: string;
  /** 副标题（封面用），可空。 */
  subtitle?: string;
  slides: DocgenSlide[];
}

export type DocgenParseResult = { ok: true; request: DocgenRequest } | { ok: false; error: string };

/** 上限：既是防手滑，也是防"助手把整篇文档塞进一页"。 */
export const DOCGEN_LIMITS = Object.freeze({
  maxSlides: 60,
  maxBulletsPerSlide: 12,
  maxTitleChars: 120,
  maxBulletChars: 300,
  maxNotesChars: 2000,
});

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 解析并校验请求。
 *
 * 认不出来一律**返回错误而不是猜**：这个函数的下游是要写进用户工作区的文件，
 * "猜一个能跑的形状"会让用户拿到一份内容不对的 PPT，比直接失败更糟。
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

  const title = asTrimmedString(input.title);
  if (!title) return { ok: false, error: 'title is required' };
  if (title.length > DOCGEN_LIMITS.maxTitleChars) {
    return { ok: false, error: `title exceeds ${DOCGEN_LIMITS.maxTitleChars} characters` };
  }

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

    const rawBullets = slide.bullets ?? [];
    if (!Array.isArray(rawBullets)) return { ok: false, error: `${where}.bullets must be an array` };
    if (rawBullets.length > DOCGEN_LIMITS.maxBulletsPerSlide) {
      return { ok: false, error: `${where}.bullets exceeds ${DOCGEN_LIMITS.maxBulletsPerSlide}` };
    }
    const bullets: string[] = [];
    for (const rawBullet of rawBullets) {
      const bullet = asTrimmedString(rawBullet);
      // ⚠️ 空串直接丢（不是报错）：模型偶尔会补一个空行，为此整份失败不值得。
      if (!bullet) continue;
      if (bullet.length > DOCGEN_LIMITS.maxBulletChars) {
        return { ok: false, error: `${where} has a bullet longer than ${DOCGEN_LIMITS.maxBulletChars} characters` };
      }
      bullets.push(bullet);
    }

    let notes: string | undefined;
    if (slide.notes !== undefined && slide.notes !== null) {
      const trimmed = asTrimmedString(slide.notes);
      if (trimmed && trimmed.length > DOCGEN_LIMITS.maxNotesChars) {
        return { ok: false, error: `${where}.notes exceeds ${DOCGEN_LIMITS.maxNotesChars} characters` };
      }
      notes = trimmed ?? undefined;
    }

    slides.push(notes ? { title: slideTitle, bullets, notes } : { title: slideTitle, bullets });
  }

  const subtitle = asTrimmedString(input.subtitle) ?? undefined;
  if (subtitle && subtitle.length > DOCGEN_LIMITS.maxTitleChars) {
    return { ok: false, error: `subtitle exceeds ${DOCGEN_LIMITS.maxTitleChars} characters` };
  }

  return {
    ok: true,
    request: subtitle ? { kind: 'pptx', title, subtitle, slides } : { kind: 'pptx', title, slides },
  };
}

/**
 * 请求文件路径 ⇒ 产物文件路径。
 *
 * 约定（**技能里也要照这个写**）：请求文件是 `.<名字>.docgen.json`，产物是 `<名字>.pptx`。
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
