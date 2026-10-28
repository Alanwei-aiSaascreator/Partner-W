import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { isVerifiedFileName, verifyArtifactBuffer, type ArtifactIntegrityFailure } from './verify.js';

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
   *    起因：产品自己的命名就带空格（`Partner-W · AI桌面工作台-12ddb119.pptx`），
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
 * - lookbehind 挡住路径里的文件名（`C:\...\a.pptx`）—— 模型说的是文件名，不是路径。
 * - 排除 Windows 非法文件名字符（`<>|*?"`），免得把 markdown 标记吃进来。
 *
 * ⭐ 文件名/链接不被当成真实文件名（2026-10-15 F owner）：旧口径把 **markdown 链接**
 *    `[报告.pptx](relative/报告.pptx)` 抠成假名并据此报"缺失" ⇒ 整轮 delivery-failed
 *    （冤枉模型的代价见模块开头那条纪律）。两处成因、两处修：
 *    ① **链接语法**：`[文字](地址)` 里的方括号是 markdown 结构，不是文件名的一部分。
 *       在抽取**之前**先把链接改写成它的文字（见 `claimScanText`），地址整段丢弃 ——
 *       这样链接文字照常当名字、地址里的路径不再掺进来，而**真名带方括号**的
 *       （`[Q3]报告.docx`，产品按标题出片时确实会出现）也不被误伤。
 *    ② **半截名**：旧 lookbehind 只有 `(?<![\\/])`，在 `sub/report.pptx` 里 `/` 挡住
 *       `report` 后引擎会**回退**到 `eport.pptx`（从句中切出半截名）。现在改成
 *       "**不许紧跟在一个名字字符或路径分隔符之后**"：既保留"挡住 `C:\...\a.pptx` 这类
 *       路径中的文件名"，又堵住半截名（`sub/report.pptx` / `relative/季度汇报.pptx`
 *       里一个都不抠）。
 *
 * ⭐ BUG-132（2026-10-17 第二位独立审核）：**括号**（半角 `()` / 全角 `（）`）双向都要正确。
 *
 *   复现：`已生成（报告.pptx）` 旧口径把括号当普通名字字符贪婪左吃 ⇒ 抠出**半截假名**
 *   `已生成（报告.pptx` ⇒ 盘上真有 `报告.pptx` 也判 missing ⇒ 弹「说好的文件不在」
 *   （冤枉模型）。半角 `(报告.pptx)` 同病。
 *
 *   ⚠️ 但**不能**简单把括号塞进名字体的排除集：`文件名（含括号）.docx` / `报告(2024).pptx`
 *      这类**括号长在名字内部**的真名会被从中间切断（整名抠不出来）—— 那是"半截名"的
 *      对称面，同样冤枉模型。两者**不可兼得**时只能二选一，实测见 `claim-guard.test.ts`。
 *      留在这里的口径是**括号只以"成对的组"身份进入名字体**：
 *      `文件名（含括号）.docx` 的 `（含括号）` 是成对组 ⇒ 整名保留；而 `已生成（报告.pptx）`
 *      里 `（报告.pptx` 那截的 `（` **没有配对的 `）` 落在名字内**（`）` 在扩展名之后）
 *      ⇒ 不构成组 ⇒ 名字体从 `（` 处断开，只抠出 `报告.pptx`。半角/全角/混用（`（…）` /
 *      `(…)`）一视同仁：lookbehind 与名字体基类都把四种括号当边界，成对组按**同型**配对。
 */
const CLAIMED_NAME_RE =
  /(?<![^\s`"'<>|*?\n、，。；：！？（）(),;:!?「」『』“”‘’])((?:[^\s`"'<>|*?\\/\n、，。；：！？（）(),;:!?「」『』“”‘’]|\([^()（）\n]*\)|（[^()（）\n]*）){1,200}\.(?:pptx|docx|xlsx|pdf|html|slidegen))\b/gi;

/**
 * 「这个碎片自己就是交付文件名吗」的**词法**判据（不带前后文判据）。
 *
 * 只用于链接碎片（链接文字 / 链接目标的 basename）这类**先被隔离出来**的局部判断；
 * 正文抽取仍由 `CLAIMED_NAME_RE` 独占 —— 两者的扩展名表必须同步改。
 */
const FILE_NAME_EXTENSIONS_RE = /\.(?:pptx|docx|xlsx|pdf|html|slidegen)$/i;
/** 串里**含**一个文件名（用于"链接文字本身是不是文件名"）。 */
const FILE_NAME_IN_TEXT_RE = /[^\s/\\:*?"<>|]{1,200}\.(?:pptx|docx|xlsx|pdf|html|slidegen)\b/i;
/**
 * Windows 非法字符 + 控制字符（方括号/圆括号是**合法**的：`[Q3](final).docx` 就是真名）。
 *
 * ⚠️ 这里的控制字符是**判据本身**（把它们当非法名），不是误写 ⇒ 关掉 `no-control-regex`。
 *    刻意用 `\u0000-\u001f` 精确覆盖 C0，**不**换 `\p{Cc}`（后者连带 DEL 与 C1，会扩大拒绝面）。
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_FILE_NAME_CHARS_RE = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * 链接**目标**里那个「本地文件名」；不是本地文件就回 `null`。
 *
 * ⭐ D2-a（2026-10-16 审计反例）：`已生成 [下载报告](report.docx)，请查收` —— 文件名
 *   **只写在地址里**。旧改写把地址整段丢掉 ⇒ 这条回复里一个文件名都不剩 ⇒ 空工作区、
 *   空登记也照样判"交付成功"。链接目标是**下载目标**，它里面的文件名必须能作为交付声明
 *   参与存在性核对，不能只依赖显示文字。
 *
 * ⚠️ 只认**本地**目标：带 scheme 的远端地址、站点绝对路径（`/…`）、协议相对地址（`//…`）
 *    都不是"这份回复产出了本地文件"的证据 —— 否则 `[官网](https://x/guide.html)` 会凭空
 *    报一条「说好的文件不在」，而"冤枉模型"正是这个守卫明确要避免的方向（见模块开头）。
 * ⚠️ 地址可能带 markdown 的 `"标题"` 与 `?query` / `#fragment`，先摘掉再取 basename。
 * ⚠️ **允许空格**：产品自己的成品名就带空格（`Partner-W · AI桌面工作台-12ddb119.pptx`），
 *    所以这里把 basename 原样送回扫描文本（抽取正则只抠到最后一个 token，带空格的全名由
 *    既有的候选拼写回扫 `buildClaimVariants` 还原 —— 与散文里那条路完全同一套）。
 */
function localLinkTargetFileName(target: string): string | null {
  const withoutTitle = target.replace(/\s+"[^"]*"\s*$/, '').trim();
  const path = withoutTitle.split(/[?#]/)[0].trim();
  if (!path) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//') || path.startsWith('/')) return null;
  const rawBase = (path.split(/[\\/]/).at(-1) ?? '').trim();
  // ⭐ BUG-089 残余（2026-10-16 r14 独立终审）：**链接目标是 URL，先按百分号解码**。
  //    `[下载报告](%E6%8A%A5%E5%91%8A.docx)` 指的就是盘上的 `报告.docx`；不解码就拿
  //    编码串去查存在性 ⇒ 明明在，判 missing（误名/误缺失）。
  //    ⚠️ 解码后不合用（非法字符 / 不带受检扩展名）就回退到字面串 —— 旧行为一个字不变，
  //       不发明结论。
  const decoded = decodePercentEscapes(rawBase);
  const base = isLocalLinkFileName(decoded) ? decoded : rawBase;
  if (!isLocalLinkFileName(base)) return null;
  return base;
}

/** 「这一截自己就够格当本地文件名」：非空、不过长、无非法字符、带受检扩展名。 */
function isLocalLinkFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    !ILLEGAL_FILE_NAME_CHARS_RE.test(value) &&
    FILE_NAME_EXTENSIONS_RE.test(value)
  );
}

/**
 * 百分号解码。**解不开就原样返回**（非法序列 `100%报告.docx` 是"读不懂"，不是"没有名字"）。
 *
 * ⚠️ `decodeURIComponent` 不把 `+` 当空格（那是 form-urlencoded 的规矩），正是我们要的：
 *    文件名里的 `+` 就是 `+`。
 */
function decodePercentEscapes(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * markdown 行内链接 `[文字](地址 "可选标题")` ⇒ 只留**文字** + 目标里的本地文件名。
 *
 * ⚠️ 只认**行内链接**这一种写法（`](`）：`[文字][引用]` / `[文字]` 不在这里处理 ——
 *    它们要么罕见（引用式链接），要么就可能是真名带方括号（`[Q3]报告.docx`），
 *    不能一刀切。
 * ⚠️ `[...]` 与 `(...)` 内都**不许跨行**（否则会把两行拼成一条，行级判据全乱）。
 * ⭐ 第二个捕获组是**链接目标**：D2-a 起，只写在地址里的文件名也要算交付声明 ——
 *    判据本体在 `localLinkTargetFileName`。
 * ⭐ BUG-089 残余（2026-10-16 r14 独立终审）：目标里**允许一层配对的圆括号**。
 *    旧正则 `[^)\n]*` 在**第一个** `)` 就截断 ⇒ `[下载报告](report(final).docx)`
 *    的目标被认成 `report(final`（不带扩展名 ⇒ 整段丢弃）⇒ 真正缺失的
 *    `report(final).docx` 反而变成"已生成 下载报告.docx"（误名，且真名被抹掉）。
 *    圆括号是**合法**文件名（见 `ILLEGAL_FILE_NAME_CHARS_RE`），CommonMark 的目标本来
 *    就允许配对括号。
 */
const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))*)\)/g;

/**
 * ⭐ BUG-089 残余（2026-10-16 r14 独立终审）：**`)` 后面紧跟一个受检扩展名 ⇒ 这一段是字面文件名**。
 *
 * 反例：真文件名 `[report.docx](final).docx` 被反引号包裹时，`MARKDOWN_LINK_RE` 只吃掉
 * `[report.docx](final)`（目标 `final` 不是文件名），拼回去就成了 `report.docx` + `.docx`
 * ⇒ 抠出 `report.docx.docx` ⇒ 真件在盘上却判 missing ⇒ 整轮假失败（误名 / 误缺失）。
 *
 * 判据刻意**只认这一种形状**（紧跟一个受检扩展名）：真正的 markdown 链接后面
 * 不会直接跟 `.docx` 这种后缀 —— 句末的 `.` 后面是空白或换行，不构成扩展名。
 * 收窄到这一步是为了**不削弱链接保护本身**：漏改写会切出半截名 ⇒ 反过来冤枉模型。
 */
const TRAILING_FILE_EXTENSION_RE = /^\.(?:pptx|docx|xlsx|pdf|html|slidegen)\b/i;

/**
 * ⭐ D2-b（2026-10-16 审计反例）：**代码区域**里的方括号/圆括号是**字面文件名**的一部分，
 * 不是 markdown 链接。实际文件名 `[Q3](final).docx` 被回复用反引号包裹时，全串改写会把它
 * 改成 `Q3.docx` ⇒ 真件在盘上却判 missing ⇒ 整轮假失败（HEAD 为 succeeded）。
 *
 * 判据：改写**跳过**代码区域（默认一个字符都不动）；唯一的例外是"模型在反引号里演示
 * markdown 链接"这个形状 —— 那时方括号里的文字或链接目标**自己就是一个文件名**
 * （`[报告.docx](sub/报告.docx)`），只可能是链接。见 `rewriteLinks`。
 *
 * ⚠️ 行内代码不许跨行（`` ` `` 里的换行会把两行拼成一条）；围栏按成对匹配。
 */
const CODE_REGION_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;

/**
 * 抽取用的**扫描文本**：markdown 链接改写成「文字 + 目标里的本地文件名」，代码区域原样。
 *
 * 为什么返回新串而不是就地改：`extractClaimedFileNames` 之后的行级判据（是否在声称 /
 * 是否在说"没有了"）与变体回扫都按**同一份文本**的偏移工作 —— 三者必须同源，
 * 否则偏移与文本错位会得出自相矛盾的结论。
 *
 * ⚠️ 代码区域**逐段原样拼回**（不改写），散文区才走链接改写 —— 见 `CODE_REGION_RE`。
 */
function claimScanText(content: string): string {
  let scan = '';
  let cursor = 0;
  for (const region of content.matchAll(CODE_REGION_RE)) {
    const index = region.index ?? 0;
    scan += rewriteLinks(content.slice(cursor, index), false);
    scan += rewriteLinks(region[0], true);
    cursor = index + region[0].length;
  }
  return scan + rewriteLinks(content.slice(cursor), false);
}

/**
 * 片段里的行内链接改写：散文区一律按链接处理（`[文字](地址)` ⇒ 文字 + 目标里的本地文件名）。
 *
 * ⚠️ 代码区域（`insideCodeRegion`）**只有**方括号文字或目标本身就是一个文件名时才当链接
 *    （模型在反引号里演示 markdown）；否则整段是字面文件名（`[Q3](final).docx`），一个字都不许改。
 * ⚠️ 但**两种区域**都要先过那一关"这一段是不是被扩展名继续粘住"——
 *    见 `TRAILING_FILE_EXTENSION_RE`，那是 r14 反例 `[report.docx](final).docx` 的判据。
 */
function rewriteLinks(segment: string, insideCodeRegion: boolean): string {
  return segment.replace(MARKDOWN_LINK_RE, (match: string, text: string, target: string, offset: number) => {
    // ⭐ 紧接着的字符还在同一个文件名的扩展名里 ⇒ 这是**字面文件名**，不是链接。
    if (TRAILING_FILE_EXTENSION_RE.test(segment.slice(offset + match.length))) return match;
    const targetName = localLinkTargetFileName(target);
    if (insideCodeRegion && !targetName && !FILE_NAME_IN_TEXT_RE.test(text)) return match;
    return targetName ? `${text} ${targetName}` : text;
  });
}

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
  // ⚠️ DOCX-205 合同 §5.C（2026-10-10）：**具名交付语境**——"内容已提交/请查收"
  //    是不带扩展名的完成声称，与文件名同现时必须能被行级判据抓到
  //    （现场句：「内容已提交，稍后会在右侧「产物」面板中出现 验收文档-205.docx」）。
  '已提交',
  '请查收',
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
  // ⭐ markdown 链接先改写成其文字（地址丢弃）—— 见 `claimScanText`。
  //    下面的 `matchAll` / 行级判据 / 变体回扫**全部**只用这份扫描文本，
  //    三者同源，偏移才不会与文本错位（返回的 offset 也按扫描文本计）。
  const scan = claimScanText(content);
  const found: ClaimedFile[] = [];
  const seen = new Set<string>();
  for (const match of scan.matchAll(CLAIMED_NAME_RE)) {
    const name = match[1];
    const offset = match.index ?? 0;
    // ⭐ 先过"这一句是不是在声称"，再看去重 —— 顺序反了会把
    //    先出现的那次"列举"占掉名额，后面真正的声称反而被去重掉。
    if (!lineClaimsFile(scan, offset)) continue;
    // ⭐ 再排除"在说它没有了"的句子（2026-10-04 真机误报，见函数注释）。
    if (lineExplainsAbsence(scan, offset, name)) continue;
    // ⭐ BUG-047：动词短语粘着扩展名（"然后重新渲染生成.pptx"）⇒ 动作描述不是文件名。
    if (isBareVerbPhrase(scan, offset, name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const variants = buildClaimVariants(scan, offset, name);
    found.push(variants.length > 0 ? { name, offset, variants } : { name, offset });
  }
  return found;
}

/**
 * ⭐ BUG-047（2026-10-08 真机实证）：回复句"…然后**重新渲染生成.pptx**文件"里，
 * CJK 正则把动词短语整段抠成"文件名" ⇒ 判 missing ⇒ 整轮 delivery-failed。
 *
 * 判据：剥掉名字末尾的交付动词后**不剩名字**（空 / 只剩连接词、副词），且该处
 * **不是**引号或反引号包裹的显式文件名 ⇒ 是动作描述，不是声称。
 * 真文件名恰好以动词结尾（"学习总结生成.pptx"）剥完还剩「学习总结」⇒ 不误杀。
 *
 * ⚠️ 只作用于「动词与扩展名之间没有分隔符」的形状：真声称的动词与文件名之间
 *    隔着空格/标点（"已生成 季度汇报.pptx"），正则抽出来的 token 只含文件名。
 */
const TRAILING_ACTION_VERBS = [
  // 长词在前：一次剥掉复合动词（"重新渲染生成"），而不是剥一半剩下"重新"误判。
  '重新渲染生成',
  '重新排版生成',
  '重新生成',
  '重新渲染',
  '重新排版',
  '转换生成',
  '渲染生成',
  '排版生成',
  '生成',
  '渲染',
  '写出',
  '写入',
  '保存',
  '导出',
  '转换为',
  '转成',
  '修改',
  '调整',
  '更新',
  '重写',
  '创建',
  '制作',
  '排版',
  '完成',
] as const;
const CONNECTIVE_ONLY_RE = /^(?:然后|接着|随后|再|并|并且|同时|或|或者|和)*$/;

/**
 * ⭐ BUG-047 残余（2026-10-14 M1）：动作描述里插了**量词/修饰词**时不长在动词上 ——
 * `重新渲染生成一份新的.pptx` / `再生成一个新的.docx` 的 stem 以「新的」结尾，
 * 逐词剥动词一个都剥不到 ⇒ 旧判据判它不是动作短语 ⇒ 当真实交付名查存在性 ⇒ 误报 missing。
 *
 * 只列**有限量词/修饰词**（与例句同族），且**单独出现不算数**：必须与至少一个
 * `TRAILING_ACTION_VERBS` 里的动词同时被剥掉、剥完只剩连接词才判动作短语。
 * 于是 `分配方案一份.pptx`（只剥得到量词）、`学习总结生成.pptx`（剥完还剩真名字）
 * 这类真文件名一个都不受影响 —— 不泛化忽略"生成/新/一份"。
 */
const TRAILING_QUANTIFIER_PHRASES = [
  // 长词在前，与动词表同一纪律。
  '一个新的',
  '一份新的',
  '新的',
  '一份',
  '一个',
  '一张',
  '一版',
  '新的版本',
] as const;

/** 这一处名字是不是"动词短语 + 扩展名"（不是真文件名）。 */
function isBareVerbPhrase(content: string, offset: number, name: string): boolean {
  const base = name.replace(/\.(?:pptx|docx|xlsx|pdf|html|slidegen)$/i, '');
  if (!base) return false;
  let rest = base;
  // ⚠️ 必须剥到**动词**才算动作短语（`strippedVerb`）；量词/修饰词只是让动词露出来，
  //    单剥量词（真名恰好以「一份」结尾）不改变判定。
  let strippedVerb = false;
  for (;;) {
    let changed = false;
    for (const verb of TRAILING_ACTION_VERBS) {
      if (rest.endsWith(verb)) {
        rest = rest.slice(0, -verb.length);
        strippedVerb = true;
        changed = true;
        break;
      }
    }
    if (!changed) {
      for (const quantifier of TRAILING_QUANTIFIER_PHRASES) {
        if (rest.endsWith(quantifier)) {
          rest = rest.slice(0, -quantifier.length);
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  if (!strippedVerb || (rest && !CONNECTIVE_ONLY_RE.test(rest))) return false;
  // 显式包裹（反引号 / 引号 / 直角引号）的名字是用户在引用文件名，不算动词短语。
  const before = content[offset - 1];
  const after = content[offset + name.length];
  const wrapped =
    (before === '`' && after === '`') ||
    (before === '"' && after === '"') ||
    (before === "'" && after === "'") ||
    (before === '「' && after === '」');
  return !wrapped;
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
/**
 * ⚠️ DOCX-205 合同 §5.C（2026-10-10）：**否定句 / 待生成句不算声称**。
 *
 * 真机形状（同一行内）：
 *  - 否定：「尚未提交 验收文档-205.docx，我还在整理。」—— 旧判据因行内出现"提交"
 *    而把它当声称 ⇒ missing ⇒ 冤枉模型（界面弹"说好的文件不在"）。
 *  - 待生成：「稍后提交 验收文档-205.docx。」—— 还没发生的动作同样不是完成声称。
 *
 * 判据收窄在**标记词前的小窗口**：紧邻（≤2 字填充）出现否定词，或 ≤8 字内出现
 * 延迟词 ⇒ 这一次出现不算数；同一行**还有别的干净出现**就算数（不影响既有真声称）。
 */
const CLAIM_NEGATION_BEFORE_RE = /(没|没有|未|尚未|还未|还没|并未|别|不要|不会|不想|无需|不必)[^\n]{0,2}$/;
const CLAIM_DEFERRAL_BEFORE_RE = /(稍后|稍候|随后|之后|等下|等会|过会儿|待|即将|将要|将会|马上|回头)[^\n]{0,8}$/;

function markerOccurrenceClaims(line: string, marker: string): boolean {
  let idx = line.indexOf(marker);
  while (idx >= 0) {
    const before = line.slice(Math.max(0, idx - 14), idx);
    if (!CLAIM_NEGATION_BEFORE_RE.test(before) && !CLAIM_DEFERRAL_BEFORE_RE.test(before)) return true;
    idx = line.indexOf(marker, idx + 1);
  }
  return false;
}

function lineClaimsFile(content: string, offset: number): boolean {
  const start = content.lastIndexOf('\n', offset - 1) + 1;
  const endIdx = content.indexOf('\n', offset);
  const line = content.slice(start, endIdx === -1 ? content.length : endIdx).toLowerCase();
  return CLAIM_MARKERS.some((marker) => markerOccurrenceClaims(line, marker));
}

/** 回扫的止步字符：行尾、句读标点、路径分隔符、代码/引号边界。 */
const CLAIM_BACKSCAN_STOP_RE = /[\n，。；：！？,;:!?、（）()「」『』“”‘’`\\/]/;
/** 回扫跨过 markdown 装饰符时先摘掉它们（`**Partner-W · ` ⇒ `Partner-W · `）。 */
const CLAIM_MARKDOWN_NOISE_RE = /[*`"'<>]/g;

/**
 * 给一个抽到的名字补「核对用拼写」。
 *
 * ⭐ 2026-10-03 场景一真机误报的修法（guard 报 missing 而文件真实存在）：
 *   产品自己生成的成品名就带空格——`Partner-W · AI桌面工作台-12ddb119.pptx`。
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
  /**
   * 声称了、盘上**不够新**（按 `sinceMs`），但名字**在本任务已登记的 artifact 集合里**
   * 的文件名 —— 不是 missing（见 `ClaimCheckOptions.isRegisteredName`）。
   */
  registered?: ClaimedFile[];
}

/**
 * 「有真交付时，顺带提到的文件名不算交付失败」（2026-10-17 用户反馈）。
 *
 * 现场：模型生成了 pptx 并**成功登记**进成果列表，回复正文里却顺带写了一个不存在的名字
 * （`edits.PPTX`），于是聊天里多出一条红色便签「回复里提到了 edits.PPTX，工作区里没有这些文件」
 * —— 用户看到的是"我的 PPT 出问题了"，而那一轮交付其实是完整的。
 *
 * 判据（刻意收窄 —— 既有负对照钉住"守卫强度不许松"）：
 *   · 本轮**没有任何**真实产出 ⇒ 声称缺失照旧是失败（P0 守卫的原意就是"说做好了却什么都没有"）；
 *   · 本轮有真实产出、且该名字**与产出的扩展名相同**（如都 .pptx）⇒ 降级为信息项（只写日志）；
 *   · 扩展名不同（产出了 .html、却声称 .docx）⇒ **照旧是失败** —— 那是真的少了一件东西。
 *
 * ⚠️ 这不是放松守卫：被降级的名字仍完整保留在返回值里（日志可见），
 *    "声称成功却零产物"与"跨格式少件"两支一字未动。
 */
export function classifyMissingClaims(
  missing: readonly string[],
  produced: readonly string[],
): { blocked: string[]; informational: string[] } {
  if (missing.length === 0) return { blocked: [], informational: [] };
  if (produced.length === 0) return { blocked: [...missing], informational: [] };
  const producedExts = new Set(produced.map(fileExtension).filter(Boolean));
  const blocked: string[] = [];
  const informational: string[] = [];
  for (const name of missing) {
    const extension = fileExtension(name);
    if (extension && producedExts.has(extension)) informational.push(name);
    else blocked.push(name);
  }
  return { blocked, informational };
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
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
  /**
   * ⭐ BUG-038（2026-10-08）：这个名字**在本任务已经登记成产物**了吗（生产调用按 task 查库）。
   *
   * 判据的理由：`sinceMs` 防的是「声称**全新产出**、盘上却没有」；而模型在后续轮次里
   * **引用已登记过的产物名**（"上一轮生成的 report.pptx 里补充了…"）时，那份文件本来就不该
   * 在本轮变新 —— 拿 mtime 一把否定会让界面每轮弹「说好的文件不在」假失败。
   * **登记本身就是"东西存在"的证据**（比 mtime 更硬），所以已登记名不算 missing。
   *
   * ⚠️ 这是**豁免**不是放松：没登记过的新名字、同名但未登记的老文件，freshness 判据一字未动。
   * ⚠️ 不传 = 老行为（单测与旧调用不受影响）。
   */
  isRegisteredName?: (name: string) => boolean;
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
  const registered: ClaimedFile[] = [];

  for (const file of claimed) {
    // 主名 + 核对用拼写（带空格全名 / 丢前导词后缀）——任一命中即 present。
    const spellings = [file.name, ...(file.variants ?? [])];
    if (spellings.some((spelling) => existsInRoots(spelling, roots, options.sinceMs))) {
      present.push(file);
    } else if (options.isRegisteredName && spellings.some((spelling) => options.isRegisteredName!(spelling))) {
      // ⭐ 已登记名不是 missing（BUG-038，见 `ClaimCheckOptions.isRegisteredName`）。
      registered.push(file);
    } else {
      missing.push(file);
    }
  }

  return registered.length > 0 ? { missing, present, registered } : { missing, present };
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

/** 同名文件的**绝对路径**（任一拼写命中即返回；没有就回 `null`）。 */
function findFileInRoots(fileName: string, roots: readonly string[], sinceMs: number | undefined): string | null {
  for (const root of roots) {
    if (!root) continue;
    try {
      const found = findFileRecursive(root, fileName, sinceMs, 0);
      if (found) return found;
    } catch {
      // 读不到就当没有 —— 不抛，这是守卫不是主路径。
    }
  }
  return null;
}

/**
 * ⭐ T22（2026-10-16 本地全量执行 · Owner D）：文件名比较的**平台口径**。
 *
 * Windows / macOS 的默认文件系统**不区分大小写**：盘上的 `报告.PPTX` 与回复里的
 * `报告.pptx` **是同一个文件**。旧实现用 `entry.name !== fileName` 精确比较 ⇒ 判它
 * "不在" ⇒ 界面弹「说好的文件不在」，正是本模块开头明确要避免的方向（冤枉模型）。
 *
 * ⚠️ 只改**整名比较**的大小写口径 —— 不做前缀/相似/扩展名族匹配（负对照钉住它）。
 */
const FS_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** 两个文件名在**本平台**上是不是同一个文件（仅大小写口径不同）。 */
function sameFileName(left: string, right: string): boolean {
  return FS_CASE_INSENSITIVE ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * 递归查找，限制深度 3 层（工作区 → taskId → 子目录）。
 *
 * 命中同名文件后**不立刻返回**：还得看它够不够新。
 * 同名但旧 ⇒ 继续往别处找（同一轮可能落在另一个根目录里）。
 *
 * 返回**路径**（不是布尔）：BUG-042-c 要多走一步「读它的字节，看它是不是真文档」。
 */
function findFileRecursive(dir: string, fileName: string, sinceMs: number | undefined, depth: number): string | null {
  if (depth > 3) return null;
  const entries = readdirSyncSafe(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      // ⭐ T22：同文件大小写/别名（Windows/macOS 不区分大小写）不许被当成"缺失"。
      if (!sameFileName(entry.name, fileName)) continue;
      if (isFreshEnough(entry.mtimeMs, sinceMs)) return full;
      continue;
    }
    if (entry.isDirectory()) {
      // 跳过明显的非工作区目录
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const found = findFileRecursive(full, fileName, sinceMs, depth + 1);
      if (found) return found;
    }
  }
  return null;
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

/** 声称了、**盘上有、但字节不是那份格式**的文件（BUG-042-c 用）。 */
export interface RejectedClaimedFile {
  /** 声称时的名字（原样，用于界面文案）。 */
  name: string;
  /** 完整性判据说它坏在哪（进日志；文案在界面层）。 */
  reason: ArtifactIntegrityFailure;
}

/** 为"拆穿假文档"读多大的文件。超大文件不值得为一句提示整份读进来。 */
const CLAIM_INTEGRITY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * ⭐⭐ BUG-042-c（2026-10-08 亲验的 C1 静默丢弃）：**写出来的东西不是有效文档**。
 *
 * 真机形状：模型自己把一份 JSON / 纯文本**改名成 `.docx`** 写进工作区，然后回复
 * "已生成 报告.docx"。它骗过了这条守卫的存在性判据（文件**在**盘上）、也骗过了
 * 收编扫描的存在性判据，只在登记门的字节校验那一步被拒（进 `skipped`）——
 * 结果：回复说做好了、产物列表空的、**界面上一条提示都没有**。
 *
 * 这里补上那双眼睛：声称的受检格式（pptx/docx/xlsx/pdf）文件**在且够新**时，
 * 读它的字节过一次与登记门**同一份**判据；不过 ⇒ 它是假的，如实交上去。
 *
 * ⚠️ 只做认定，不做处置（提示怎么说不在这里，由既有 claim 通道负责）。
 * ⚠️ 读不到 / 读到一半出错的**不下结论**（那是"不知道"，不是"假的"）；
 *    非受检格式一个字节都不读。
 */
export function claimedFilesRejectedByIntegrity(
  claimed: readonly ClaimedFile[],
  roots: readonly string[],
  options: { sinceMs?: number; maxBytes?: number } = {},
): RejectedClaimedFile[] {
  const maxBytes = options.maxBytes ?? CLAIM_INTEGRITY_MAX_BYTES;
  const rejected: RejectedClaimedFile[] = [];
  for (const file of claimed) {
    const spellings = [file.name, ...(file.variants ?? [])];
    for (const spelling of spellings) {
      if (!isVerifiedFileName(spelling)) continue;
      const found = findFileInRoots(spelling, roots, options.sinceMs);
      if (!found) continue;
      let buffer: Buffer;
      try {
        const size = statSync(found).size;
        if (size <= 0 || size > maxBytes) break; // 读不动/太大 ⇒ 不下结论
        buffer = readFileSync(found);
      } catch {
        break; // 读失败 ≠ 结构坏（与 reconcile 的 P1-1 同一条纪律）
      }
      const integrity = verifyArtifactBuffer(spelling, buffer);
      if (!integrity.ok) rejected.push({ name: file.name, reason: integrity.reason });
      break; // 这个名字已定性，不再试别的拼写
    }
  }
  return rejected;
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
