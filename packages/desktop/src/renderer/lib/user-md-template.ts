/**
 * 内核默认 `USER.md` 模板的识别 + 本地化骨架（纯函数，可直接单测）。
 *
 * ## 根因（2026-10-18，用户反馈"这个记忆为什么自带了英文"）
 *
 * OpenClaw 2026.9.3 在工作区首次准备时，把
 * `<openclaw>/docs/reference/templates/USER.md` 的**正文**（去掉 YAML frontmatter）
 * 落成盘上真实的 `USER.md` —— 见 runtime 的 `dist/workspace-*.mjs`
 * （`FALLBACK_DOCS_TEMPLATE_DIR` + `GENERATED_WORKSPACE_BOOTSTRAP_FILENAMES`）。
 * 因此设置页「关于你」读到的是**一份真实的英文文件**，不是"网关的缺省回包"：
 *
 * ```
 * # USER.md - User Model
 * ...
 * <!-- observed: YYYY-MM-DD | status: active -->
 * ```
 *
 * 而且这份英文同时是**每轮注入给助手**的提示词。
 *
 * ## 这里的判据（刻意保守）
 *
 * **只认"一字未改的内核模板"**（归一化后与模板全文相等 / 或行集合是模板子集且关键标记齐全）。
 * 只要用户动过任何一行（追加 directive、把 `- Prefer ...` 换成真话），就判定为
 * **真实内容**，调用方必须逐字节保留 —— 记忆是用户的数据，宁可少本地化一次，
 * 也不能猜错后覆盖。
 *
 * ⚠️ **版本绑定**：基准是随包 runtime 2026.9.3 的模板正文。内核升级若改了模板措辞，
 *    判据会失效（表现为英文又上屏，**不会**误改用户内容）。届时按新版
 *    `docs/reference/templates/USER.md` 更新 `KERNEL_USER_MD_TEMPLATE_BODY` 即可。
 */

/**
 * 内核 `docs/reference/templates/USER.md` 的**正文**（真机盘上 1137 B 的那份，
 * 已去掉 YAML frontmatter）。判据与测试都以它为基准。
 */
export const KERNEL_USER_MD_TEMPLATE_BODY = [
  '# USER.md - User Model',
  '',
  'Store stable user preferences and profile facts as directives that can guide future sessions.',
  '',
  'Use one directive per entry:',
  '',
  '```md',
  '<!-- observed: YYYY-MM-DD | status: active -->',
  '',
  '- Prefer concise progress updates during implementation work.',
  '```',
  '',
  '- Begin each directive with an imperative such as `Always`, `Never`, or `Prefer`.',
  '- Record the observation date and either `active` or `superseded` on the metadata line.',
  '- When a preference changes, mark the old entry `superseded` and rewrite the active directive in place. Never append a contradictory active directive.',
  '- Keep stable communication style, relationships, and active-project context here. Put durable non-profile facts and decisions in `MEMORY.md`.',
  '- Save this file at the workspace root as `USER.md`. It loads every session with a separate 4,000-character budget.',
  '',
  '## Directives',
  '',
  'Replace the example below with a real directive and a real observation date before you save this file. Never leave a placeholder directive `active`.',
  '',
  '<!-- observed: YYYY-MM-DD | status: active -->',
  '',
  '- Prefer ...',
  '',
  '## Related',
  '',
  '- [Agent workspace](/concepts/agent-workspace)',
].join('\n');

/** 归一化后仍必须出现的结构性标记（防止"行集合是子集"的判据退化）。 */
const TEMPLATE_MARKERS = [
  '# USER.md - User Model',
  'Store stable user preferences and profile facts as directives that can guide future sessions.',
  '## Directives',
  '<!-- observed: YYYY-MM-DD | status: active -->',
  '- Prefer ...',
];

/**
 * 归一化：BOM / CRLF / 行尾空白 / 行首尾空行 / 连续空行 / 前置 YAML frontmatter。
 *
 * ⚠️ 只做"排版层"的归一化 —— 任何**内容行**的增删改都会让结果不同（这是判据的核心）。
 */
export function normalizeUserMd(text: string): string {
  const withoutBom = text.replace(/^\uFEFF/, '');
  const lines = withoutBom.replace(/\r\n?/g, '\n').split('\n');

  // 前置 YAML frontmatter：只在前 40 行内成对出现时才认（防止把用户正文里的 `---` 当分隔符）
  let start = 0;
  if (lines[0]?.trim() === '---') {
    for (let index = 1; index < Math.min(lines.length, 41); index += 1) {
      if (lines[index].trim() === '---') {
        start = index + 1;
        break;
      }
    }
  }

  const normalized: string[] = [];
  for (const line of lines.slice(start)) {
    const trimmedRight = line.replace(/[ \t]+$/, '');
    if (trimmedRight === '' && normalized[normalized.length - 1] === '') continue;
    normalized.push(trimmedRight);
  }
  while (normalized.length > 0 && normalized[0] === '') normalized.shift();
  while (normalized.length > 0 && normalized[normalized.length - 1] === '') normalized.pop();
  return normalized.join('\n');
}

const NORMALIZED_TEMPLATE = normalizeUserMd(KERNEL_USER_MD_TEMPLATE_BODY);
const TEMPLATE_LINE_SET = new Set(
  NORMALIZED_TEMPLATE.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0),
);

/**
 * 是不是**一字未改**的内核默认模板。
 *
 * 判定顺序：
 * 1. 归一化后与模板逐行相等（最常见：真机盘上那份）；
 * 2. 否则要求：关键标记齐全 + 每一条非空行都在模板行集合里
 *    （容忍行序/空行差异，但**不容忍任何新增内容行** —— 那说明用户写过东西）。
 */
export function isKernelDefaultUserMd(text: string): boolean {
  if (typeof text !== 'string' || text.trim().length === 0) return false;
  const normalized = normalizeUserMd(text);
  if (normalized === NORMALIZED_TEMPLATE) return true;

  const lines = normalized.split('\n');
  const trimmedLines = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (!TEMPLATE_MARKERS.every((marker) => trimmedLines.includes(marker))) return false;
  return trimmedLines.every((line) => TEMPLATE_LINE_SET.has(line));
}

/** 本地化的骨架文案（全部由调用方按当前语言从 i18n 取，**不在代码里硬编码任何语言**）。 */
export interface AboutYouSkeletonTexts {
  /** 一级标题（不含 `# `）。 */
  title: string;
  /** 观察注释的正文（`<!-- ... -->` 里那一句，含 `{{date}}` 已替换）。 */
  observed: (date: string) => string;
  /** 一条示例 directive（含 `- ` 前缀，便于各语言自己决定标点）。 */
  sampleDirective: string;
}

/**
 * 中文骨架替代内核英文模板。**写进 `USER.md` 的就是这个字符串** ——
 * 它必须是可编辑的、每轮注入时对模型有意义的正文，而不是一句"请填写"。
 */
export function buildAboutYouSkeleton(texts: AboutYouSkeletonTexts, date: string): string {
  return [`# ${texts.title}`, `<!-- ${texts.observed(date)} -->`, '', texts.sampleDirective].join('\n');
}

/** 本地日期 `YYYY-MM-DD`（观察日期用本地时区，别让用户看到"昨天"）。 */
export function todayLocalIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}
