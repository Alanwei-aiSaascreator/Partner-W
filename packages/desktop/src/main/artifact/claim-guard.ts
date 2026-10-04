import { readdirSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';

/** 用户本轮明确要求交付的文件格式。 */
export type ExpectedArtifactKind = 'pptx' | 'pdf' | 'docx' | 'xlsx' | 'html';

/** 复用现有 claim-violation 提示时展示的人话，不伪造一个具体文件名。 */
export const EXPECTED_ARTIFACT_LABELS: Readonly<Record<ExpectedArtifactKind, string>> = Object.freeze({
  pptx: 'PPT/PPTX 演示文稿',
  pdf: 'PDF 文件',
  docx: 'Word/DOCX 文档',
  xlsx: 'Excel/XLSX 表格',
  html: 'HTML 网页',
});

const EXPECTED_ARTIFACT_EXTENSIONS: Readonly<Record<ExpectedArtifactKind, string>> = Object.freeze({
  pptx: '.pptx',
  pdf: '.pdf',
  docx: '.docx',
  xlsx: '.xlsx',
  html: '.html',
});

const EXPECTED_KIND_TERMS: readonly Readonly<{ kind: ExpectedArtifactKind; term: RegExp }>[] = [
  { kind: 'pptx', term: /\b(?:pptx?|power\s*point)\b|(?:演示文稿|幻灯片)/gi },
  { kind: 'pdf', term: /\bpdf\b/gi },
  { kind: 'docx', term: /\b(?:word|docx)\b/gi },
  { kind: 'xlsx', term: /\b(?:excel|xlsx)\b/gi },
  { kind: 'html', term: /\bhtml\b|网页/gi },
];

/**
 * 只有「要求产出」才算期望格式；格式咨询、教程问题和明确否定都不算。
 *
 * 这是一个刻意保守的入口闸门：漏掉一句少见省略句，只是继续沿用旧行为；
 * 把「PPT 是什么」误判成交付请求，则会在普通聊天结束时弹假失败，代价更大。
 */
const ARTIFACT_REQUEST_ACTION_RE =
  /(?:做(?:成)?|制作|生成|创建|导出|输出|交付|整理成|写成|转换(?:成|为)|转(?:成|为)|保存(?:成|为)|修改|更新|改(?:成|为)|给我|想要|需要|\b(?:make|create|generate|export|deliver|convert|build|produce)\b)/i;
const STRONG_ARTIFACT_REQUEST_RE =
  /(?:(?:帮我|为我|替我|请(?:帮我)?|给我).{0,16}(?:做(?:成)?|制作|生成|创建|导出|输出|交付|整理成|写成|转换(?:成|为)|转(?:成|为)|保存(?:成|为)|修改|更新|改(?:成|为)|一份|一个)|(?:我要|我想要|我需要)(?:一份|一个)|\bcan\s+you(?:\s+please)?\s+(?:make|create|generate|export|deliver|convert|build|produce)\b)/i;
const INFORMATIONAL_REQUEST_RE =
  /(?:是什么|什么意思|区别|哪个好|教程|方法|怎么|如何|为什么|是否|能否|会不会|学习|介绍|解释|了解|支持.{0,12}吗|难吗|\b(?:what|how|why|whether|can you|do you support)\b)/i;
const STRONG_INFORMATIONAL_REQUEST_RE = /(?:教程|方法|操作指南|使用指南|\b(?:tutorial|guide)\b)/i;
const GENERIC_NO_FILE_OUTPUT_RE =
  /(?:不要|不用|无需|不需要|别|不)(?:再)?(?:帮我|给我|为我)?(?:生成|制作|创建|导出|输出|交付|保存)?(?:任何|实际|真实)?\s*(?:文件|产物|成品)|\b(?:do\s+not|don't|no\s+need\s+to)\s+(?:create|generate|export|deliver|save)(?:\s+any)?\s+(?:files?|artifacts?)\b/i;
const EXPLICIT_ARTIFACT_CREATION_RE =
  /(?:做(?:成)?|制作|生成|创建|导出|输出|交付|整理成|写成|转换(?:成|为)|转(?:成|为)|保存(?:成|为)|修改|更新|改(?:成|为)|\b(?:make|create|generate|export|deliver|convert|build|produce)\b)/i;
const NEGATED_ARTIFACT_TERM_RE =
  /(?:不要|不用|无需|不需要|别)(?:再)?(?:给我|帮我|为我)?(?:做|做成|制作|生成|创建|导出|输出|交付|转换(?:成|为)|转(?:成|为)|整理成|写成|保存(?:成|为))?(?:一份|一个)?\s*$|\b(?:do\s+not|don't|no\s+need\s+to|without)(?:\s+\w+){0,3}\s*$/i;

function isOutlineOnlyRequest(segment: string): boolean {
  const outline = /(?:大纲|提纲|内容框架|\boutline\b)/i.exec(segment);
  if (!outline) return false;
  if (GENERIC_NO_FILE_OUTPUT_RE.test(segment)) return true;

  for (const { term } of EXPECTED_KIND_TERMS) {
    term.lastIndex = 0;
    for (const match of segment.matchAll(term)) {
      const before = segment.slice(Math.max(0, (match.index ?? 0) - 48), match.index ?? 0);
      if (NEGATED_ARTIFACT_TERM_RE.test(before)) continue;
      if (EXPLICIT_ARTIFACT_CREATION_RE.test(before)) return false;
    }
  }
  return true;
}

/** `A 转成 B` 这类请求里，A 是输入，只有 B 是本轮必须新增的产物。 */
function conversionTargetClause(segment: string): string | null {
  const chinese = /(?:转换(?:成|为)|转(?:成|为)|改(?:成|为)|保存(?:成|为)|导出(?:成|为)|输出(?:成|为))/g;
  const chineseMatches = [...segment.matchAll(chinese)];
  const lastChinese = chineseMatches.at(-1);
  if (lastChinese?.index !== undefined) return segment.slice(lastChinese.index + lastChinese[0].length);

  const english = /\b(?:convert(?:ed|ing)?|export(?:ed|ing)?|save[ds]?|saving)\b[\s\S]*?\b(?:to|as)\b/gi;
  const englishMatches = [...segment.matchAll(english)];
  const lastEnglish = englishMatches.at(-1);
  if (lastEnglish?.index !== undefined) return segment.slice(lastEnglish.index + lastEnglish[0].length);

  return null;
}

/** 从用户本轮文本中提取明确的文件交付格式；顺序固定且去重。 */
export function expectedArtifactKindsFromRequest(content: string): ExpectedArtifactKind[] {
  const expected = new Set<ExpectedArtifactKind>();
  // 逗号保留在同一句里：例如「帮我做季度汇报，用 PPT」的动作与格式分列在逗号两边。
  const segments = content.split(/[\n。！？!?；;]+/).filter(Boolean);

  for (const segment of segments) {
    if (!ARTIFACT_REQUEST_ACTION_RE.test(segment)) continue;
    const strongRequest = STRONG_ARTIFACT_REQUEST_RE.test(segment);
    if (
      (!strongRequest && INFORMATIONAL_REQUEST_RE.test(segment)) ||
      STRONG_INFORMATIONAL_REQUEST_RE.test(segment) ||
      isOutlineOnlyRequest(segment)
    ) {
      continue;
    }
    const artifactTerms = conversionTargetClause(segment) ?? segment;

    for (const { kind, term } of EXPECTED_KIND_TERMS) {
      term.lastIndex = 0;
      for (const match of artifactTerms.matchAll(term)) {
        const before = artifactTerms.slice(Math.max(0, (match.index ?? 0) - 48), match.index ?? 0);
        if (NEGATED_ARTIFACT_TERM_RE.test(before)) continue;
        expected.add(kind);
        break;
      }
    }
  }

  return EXPECTED_KIND_TERMS.map(({ kind }) => kind).filter((kind) => expected.has(kind));
}

/** 本轮实际新增/更新的产物里，哪些明确要求的格式仍然没有出现。 */
export function missingExpectedArtifactKinds(
  expected: readonly ExpectedArtifactKind[],
  artifactNames: readonly string[],
): ExpectedArtifactKind[] {
  const normalizedNames = artifactNames.map((name) => name.toLowerCase());
  return [...new Set(expected)].filter(
    (kind) => !normalizedNames.some((name) => name.endsWith(EXPECTED_ARTIFACT_EXTENSIONS[kind])),
  );
}

/**
 * 「声称成功但没产物」的通用守卫。
 *
 * 模型会在回复里说「文件写好了，叫 xxx.pptx」，但实际没写。
 * 两条出片路（slidegen 围栏 / .slidegen 文件）都要求"有内容"才启动，
 * 所以「只有一句话声称」时两条路都不进 ⇒ 不报错、不出片、界面说"已完成"。
 *
 * 这条守卫在所有产物通道跑完之后、reconcile 之后跑一遍：
 * 从回复里抠出提到的产物文件名，逐个到工作区查存在性。
 * 声称了但不存在 ⇒ 报一条失败，让界面说人话。
 *
 * ⭐ 判据是「东西真的在」，不是「流程跑完了」。
 * ⭐ 这条跨所有产物类功能（slidegen / docgen / htmlgen / 助手直接写文件），不是 PPT 专属。
 */

/** 从回复里抠出的「声称的产物文件名」。 */
export interface ClaimedFile {
  /** 原始文件名（含扩展名），如 `Nova产品发布会.slidegen`。 */
  name: string;
  /** 在回复里出现的位置（字符偏移），用于调试。 */
  offset: number;
  /**
   * 核对存在性时额外尝试的拼写（带空格全名 / 逐级丢前导词的后缀）。
   *
   * ⭐ 抽取的语义**不变**（名字仍是正则抠出的那截）；宽松只发生在"到盘上找"这一步。
   *    起因：产品自己的命名就带空格（`荣盈魔方 · AI桌面工作台-12ddb119.pptx`），
   *    而抽取正则把空格当边界 ⇒ 只抠到尾巴 token ⇒ 拿半截名去查 ⇒ 误报 missing。
   */
  variants?: string[];
}

/**
 * 抠名字用的正则。
 *
 * 三处都是踩过的坑，别改回去：
 * - **`、，。；：！？` 等标点必须在排除集里**。否则 `a.pptx、b.docx、c.xlsx`
 *   会被贪婪地吃成**一个**名字（`a.pptx、b.docx、c.xlsx`），既漏了两个，
 *   又会拿这个假名字去查存在性 ⇒ 凭空报"缺失"。
 * - `(?<![\\/])` 挡住路径里的文件名（`C:\...\a.pptx`）—— 模型说的是文件名，不是路径。
 * - 排除 Windows 非法文件名字符（`<>|*?"`），免得把 markdown 标记吃进来。
 */
const CLAIMED_NAME_RE =
  /(?<![\\/])([^\s`"'<>|*?\\/\n、，。；：！？,;:!?「」『』“”‘’]{1,200}\.(?:pptx|docx|xlsx|pdf|html|slidegen))\b/gi;

/**
 * 「这一句在**声称做出了文件**」的措辞。
 *
 * ⭐ 为什么要这一关（2026-09-28）：**"提到扩展名"不等于"声称做了文件"**。
 *   - 「我可以给你做成 .docx、.xlsx 或 .pdf，你要哪种？」
 *   - 「产物支持 a.pptx、b.docx、c.xlsx 三种。」
 *   - 「像 PowerPoint 里的 demo.pptx 那样排版就行。」
 * 这三种都只是**在说格式或举例子**，旧判据却当成"声称" ⇒ 界面弹「说好的文件不在」。
 * 对用户来说，**冤枉模型的提示比不提示更糟**：他会真的以为自己丢了东西。
 *
 * 宁可这一列写长一点，也别把真话漏掉 —— 漏报才是最初那个 bug。
 */
const CLAIM_MARKERS = [
  // ── 中文：做出来了 / 放哪了 ──
  '写好',
  '已写',
  '写完',
  '生成',
  '做好',
  '做完',
  '做了',
  '完成',
  '存成',
  '存为',
  '保存',
  '导出',
  '输出为',
  '产出',
  '文件在',
  '文件已',
  '文件：',
  '文件:',
  '产物：',
  '产物:',
  '放在',
  '已放',
  '给你了',
  '已就绪',
  // ── 英文 ──
  'generated',
  'saved',
  'written',
  'exported',
  'created',
  'wrote',
  'output',
] as const;

/** 回复里提到的产物文件名（去重、按出现顺序）。 */
export function extractClaimedFileNames(content: string): ClaimedFile[] {
  const found: ClaimedFile[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(CLAIMED_NAME_RE)) {
    const name = match[1];
    const offset = match.index ?? 0;
    // ⭐ 先过"这一句是不是在声称"，再看去重 —— 顺序反了会把
    //    先出现的那次"列举"占掉名额，后面真正的声称反而被去重掉。
    if (!lineClaimsFile(content, offset)) continue;
    // ⭐ 再排除"在说它没有了"的句子（2026-10-04 真机误报，见函数注释）。
    if (lineExplainsAbsence(content, offset, name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const variants = buildClaimVariants(content, offset, name);
    found.push(variants.length > 0 ? { name, offset, variants } : { name, offset });
  }
  return found;
}

/**
 * 说了"这个文件**已经没了**"的措辞。
 *
 * ⚠️ 这是判"缺席说明"，不是判"否定式声称"。典型真机原句：
 *    「修订版文件 `f08787c6.pptx` 及来源 JSON **已不在**。我需从零**重新生成**」
 *    ——同一行里有「生成」这个声称标记（行级判据），这处**解释缺失**的提及于是被
 *    当成声称，守卫反过来冤枉模型（界面弹"说好的文件不在"）。
 *    判据刻意收窄：只认**同一句**里的明确缺失措辞，且只作用于**紧邻名字**的那一句；
 *    真声称（"已生成 report.pptx"）与缺席说明里的**其他**文件都不受影响。
 */
const ABSENCE_RE =
  /(?:已不在|已不存在|不再存在|不存在|找不到|无法找到|没有找到|已(?:被)?(?:删除|删掉|清理|清空|移除|丢失)|丢失了|no longer|not found|does not exist|deleted|missing)/i;

/** 这一处提到名字的**同一句**里，是否在说它没有了。 */
function lineExplainsAbsence(content: string, offset: number, name: string): boolean {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  const lineEndIdx = content.indexOf('\n', offset);
  const line = content.slice(lineStart, lineEndIdx === -1 ? content.length : lineEndIdx);
  const rel = offset - lineStart;
  // 名字之后 → 到句末为止；名字之前 → 到句首为止。
  const after = line.slice(rel + name.length);
  const sentenceEnd = after.search(/[。！？!?；;\n]/);
  const afterSegment = sentenceEnd >= 0 ? after.slice(0, sentenceEnd + 1) : after;
  if (ABSENCE_RE.test(afterSegment)) return true;
  const before = line.slice(0, rel);
  const sentenceStart = Math.max(
    before.lastIndexOf('。'),
    before.lastIndexOf('！'),
    before.lastIndexOf('？'),
    before.lastIndexOf('；'),
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
  );
  return ABSENCE_RE.test(before.slice(sentenceStart + 1));
}

/**
 * 这个位置所在的那一行，有没有「声称做出了文件」的措辞。
 *
 * 判据放在**行**上而不是整篇：markdown 回复里一行就是一句话，
 * 一行里出现"已生成"就说明这句话在交付，不会误伤别的段落里的列举。
 */
function lineClaimsFile(content: string, offset: number): boolean {
  const start = content.lastIndexOf('\n', offset - 1) + 1;
  const endIdx = content.indexOf('\n', offset);
  const line = content.slice(start, endIdx === -1 ? content.length : endIdx).toLowerCase();
  return CLAIM_MARKERS.some((marker) => line.includes(marker));
}

/** 回扫的止步字符：行尾、句读标点、路径分隔符、代码/引号边界。 */
const CLAIM_BACKSCAN_STOP_RE = /[\n，。；：！？,;:!?、（）()「」『』“”‘’`\\/]/;
/** 回扫跨过 markdown 装饰符时先摘掉它们（`**荣盈魔方 · ` ⇒ `荣盈魔方 · `）。 */
const CLAIM_MARKDOWN_NOISE_RE = /[*`"'<>]/g;

/**
 * 给一个抽到的名字补「核对用拼写」。
 *
 * ⭐ 2026-10-03 场景一真机误报的修法（guard 报 missing 而文件真实存在）：
 *   产品自己生成的成品名就带空格——`荣盈魔方 · AI桌面工作台-12ddb119.pptx`。
 *   抽取正则把空格当边界（那是"顿号列举不能拼成一条"的纪律），于是只抠到
 *   `AI桌面工作台-12ddb119.pptx`；再拿这半截名去盘上找 ⇒ 明明在，报"不在"。
 *   名字的抽取语义不动，只在这里补两种更宽的拼写供"找文件"用：
 *     ① **带空格全名**：从 token 起点往回扫到句读/行尾，摘掉 markdown 装饰符后拼回；
 *        ⚠️ 跨度里出现**另一个扩展名**就不拼（那是列举，不是全名——见六种扩展名那条测试）；
 *     ② **逐级丢前导词的后缀**（`已生成 Nova 产品发布 v2.pptx` ⇒
 *        `Nova 产品发布 v2.pptx` ⇒ `产品发布 v2.pptx` ⇒ `v2.pptx`），最多 4 个。
 *   有文件命中任一拼写即算 present —— 冤枉模型比漏报更糟（模块开头那条纪律）。
 */
function buildClaimVariants(content: string, offset: number, name: string): string[] {
  const variants: string[] = [];
  let start = offset;
  let span = '';
  while (start > 0 && span.length < 80) {
    const ch = content[start - 1];
    if (CLAIM_BACKSCAN_STOP_RE.test(ch)) break;
    span = ch + span;
    start -= 1;
  }
  const cleaned = span.replace(CLAIM_MARKDOWN_NOISE_RE, '').replace(/^\s+/, '');
  if (cleaned && !/\.(?:pptx|docx|xlsx|pdf|html|slidegen)\b/i.test(cleaned)) {
    const joined = cleaned + name;
    if (joined !== name) variants.push(joined);
  }
  const base = variants.at(-1) ?? name;
  const tokens = base.split(/\s+/).filter(Boolean);
  for (let i = 1; i < tokens.length && variants.length < 5; i += 1) {
    variants.push(tokens.slice(i).join(' '));
  }
  return [...new Set(variants)].filter((variant) => variant && variant !== name);
}

/** 检查结果。 */
export interface ClaimCheckResult {
  /** 声称了但不存在于工作区的文件名。 */
  missing: ClaimedFile[];
  /** 声称了且存在的文件名。 */
  present: ClaimedFile[];
}

/** 查存在性的选项。 */
export interface ClaimCheckOptions {
  /**
   * 只有**比这个时刻新**（mtime >= sinceMs）的文件才算「这一轮生成的」。
   *
   * ⭐ 生产调用**必须**传（传本轮 artifact run 的 `createdAt`）。不传 = 只查名字，
   * 会把**上一轮留下的同名文件**当成满足本轮的声称 ⇒ "让助手再改一版"这种最常见的用法
   * 依然静默，也就是最初那个 bug 原封不动。选项在单测里可省，生产路径不可省。
   */
  sinceMs?: number;
}

/**
 * 逐个到工作区查存在性。
 *
 * @param content 助手回复正文
 * @param roots 要搜的工作区根目录列表（应用工作区 + 助手工作区）
 * @param options 见 {@link ClaimCheckOptions}（生产必须传 `sinceMs`）
 * @returns 缺失的 + 存在的
 *
 * ⚠️ 只查「文件名在根目录或其子目录里存在」—— 不要求路径完全匹配，
 *    因为模型说的文件名和实际落盘的路径可能不完全一致（中间有 taskId 子目录等）。
 *    判据是「工作区里有没有一个文件叫这个名字」，不是「路径对不对」。
 */
export function checkClaimedFiles(
  content: string,
  roots: readonly string[],
  options: ClaimCheckOptions = {},
): ClaimCheckResult {
  const claimed = extractClaimedFileNames(content);
  if (claimed.length === 0) return { missing: [], present: [] };

  const missing: ClaimedFile[] = [];
  const present: ClaimedFile[] = [];

  for (const file of claimed) {
    // 主名 + 核对用拼写（带空格全名 / 丢前导词后缀）——任一命中即 present。
    const spellings = [file.name, ...(file.variants ?? [])];
    if (spellings.some((spelling) => existsInRoots(spelling, roots, options.sinceMs))) {
      present.push(file);
    } else {
      missing.push(file);
    }
  }

  return { missing, present };
}

/** 工作区根目录列表里有没有叫这个名字的、够新的文件。 */
function existsInRoots(fileName: string, roots: readonly string[], sinceMs: number | undefined): boolean {
  for (const root of roots) {
    if (!root) continue;
    try {
      if (findFileRecursive(root, fileName, sinceMs, 0)) return true;
    } catch {
      // 读不到就当没有 —— 不抛，这是守卫不是主路径。
    }
  }
  return false;
}

/**
 * 递归查找，限制深度 3 层（工作区 → taskId → 子目录）。
 *
 * 命中同名文件后**不立刻返回**：还得看它够不够新。
 * 同名但旧 ⇒ 继续往别处找（同一轮可能落在另一个根目录里）。
 */
function findFileRecursive(dir: string, fileName: string, sinceMs: number | undefined, depth: number): boolean {
  if (depth > 3) return false;
  const entries = readdirSyncSafe(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (entry.name !== fileName) continue;
      if (isFreshEnough(entry.mtimeMs, sinceMs)) return true;
      continue;
    }
    if (entry.isDirectory()) {
      // 跳过明显的非工作区目录
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (findFileRecursive(full, fileName, sinceMs, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * 时间戳容差：mtime 不早于 `sinceMs - 这个值` 就算「这一轮」。
 *
 * ⭐ 这不是保险，是**必需**的：U 盘常见 exFAT/FAT32 的时间戳**粒度是 2 秒**（NTFS 是 100ns），
 *    写入时间会被**向下取整**到 2 秒边界 ⇒ 一个在 run 开始后 1 秒写好的文件，
 *    mtime 可能比 `createdAt` 还早 2 秒。死磕 `mtime >= createdAt` 就会
 *    **把刚写好的产物判成"不存在"** —— 那是对着干对了活的模型开枪。
 *    而上一轮留下的文件是**几分钟到几小时**前，4 秒容差吃不掉它。
 */
const CLAIM_MTIME_SLACK_MS = 4_000;

/** mtime 够新吗。没给 sinceMs ⇒ 不判新旧。 */
function isFreshEnough(mtimeMs: number | undefined, sinceMs: number | undefined): boolean {
  if (sinceMs === undefined) return true;
  if (mtimeMs === undefined) return false; // 连时间都读不到 ⇒ 不敢认
  return mtimeMs >= sinceMs - CLAIM_MTIME_SLACK_MS;
}

/** 目录项：名字 + 类型 + 修改时间。读不到的一律当成"不存在"，不抛。 */
interface SafeEntry {
  name: string;
  isFile: () => boolean;
  isDirectory: () => boolean;
  mtimeMs: number | undefined;
}

/**
 * readdirSync 的安全包装，不抛。
 *
 * ⚠️ 类型判定用 `statSync`（**跟随**链接）而不是 `Dirent.isDirectory()`：
 *    工作区里可能有 junction（见 openclaw state 目录那档子事），
 *    `dirent` 会把 junction 报成符号链接 ⇒ 那一整棵子树都搜不到。
 *    一次 stat 把类型和 mtime 一起取回来，比原来的两次 stat 更省。
 */
function readdirSyncSafe(dir: string): SafeEntry[] {
  let raw: Dirent[];
  try {
    raw = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return raw.map((e) => {
    let isFile = false;
    let isDirectory = false;
    let mtimeMs: number | undefined;
    try {
      const st = statSync(path.join(dir, e.name));
      isFile = st.isFile();
      isDirectory = st.isDirectory();
      mtimeMs = st.mtimeMs;
    } catch {
      // 读不到就当它既不是文件也不是目录
    }
    return { name: e.name, isFile: () => isFile, isDirectory: () => isDirectory, mtimeMs };
  });
}
