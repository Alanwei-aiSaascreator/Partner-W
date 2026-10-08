import type { ToolCall } from '@clawwork/shared';
import { explainToolFailure, matchToolFailure, type ToolFailureKind } from './tool-failure-explain';

export type ToolActivityKind =
  | 'listDirectory'
  | 'readFile'
  | 'search'
  | 'execute'
  | 'writeFile'
  | 'browseWeb'
  | 'generateImage'
  | 'generateVideo'
  | 'other';

/**
 * **展示层状态**：`unreported`（未收到结果）不在 `ToolCall['status']` 的词表里 ——
 * 它由渲染期判定（消息已定稿、这一步却还停在 `running`/`awaitingApproval`，且没有结果），
 * 只在展示副本上存在，**不回写**真实的工具调用（落库仍是 `running`，见 BUG 台账的遗留项）。
 *
 * ⚠️ 为什么必须有第三态：把它硬写成 `error` 会凭空造出一次失败 —— 用户中途取消/历史截断
 *    的一轮，重启后会看到「这一步暂时无法完成」+ 重试 CTA（重试=重发=计费）。
 *    没收到结果 ≠ 失败：我们只是**不知道**结果。
 */
export type ToolDisplayStatus = ToolCall['status'] | 'unreported';

export interface DisplayToolCall extends Omit<ToolCall, 'status'> {
  status: ToolDisplayStatus;
}

export interface ToolActivityGroup {
  key: string;
  kind: ToolActivityKind;
  status: ToolDisplayStatus;
  calls: DisplayToolCall[];
}

export interface ToolActivitySummaryModel {
  totalCount: number;
  completedCount: number;
  runningCount: number;
  errorCount: number;
  /** 「没收到结果」的条数（`unreported`）—— **不计入 `errorCount`**（没收到结果不是失败）。 */
  unreportedCount: number;
  durationMs: number | null;
  groups: ToolActivityGroup[];
}

const EXACT_KINDS: Readonly<Record<string, ToolActivityKind>> = {
  ls: 'listDirectory',
  dir: 'listDirectory',
  rg: 'search',
  grep: 'search',
  find: 'search',
  exec: 'execute',
  shell: 'execute',
  bash: 'execute',
  image_generate: 'generateImage',
  video_generate: 'generateVideo',
  // 2026-10-08 BUG-049（P4）：内核看图工具 = "把一个文件读进上下文"，归 readFile。
  // 它一度落到 `other`，活动条于是显示网关原文 `view_image D:\…\x.png`（裸工具名 + 绝对路径）。
  // 归 readFile 后上屏复用既有产品文案 `toolActivity.actions.readFile`（「读取文件」），
  // **不需要新增 i18n 键**（九语言键位对等不受影响）。
  view_image: 'readFile',
};

export function classifyToolActivity(name: string): ToolActivityKind {
  const normalized = name.trim().toLowerCase().replaceAll('-', '_');
  const exact = EXACT_KINDS[normalized];
  if (exact) return exact;
  if (/(^|[._])(?:ls|list_directory|list_files)(?:$|[._])/.test(normalized)) return 'listDirectory';
  if (/(?:read|open|get)_?(?:file|document)|read_file/.test(normalized)) return 'readFile';
  if (/(?:search|find|grep|ripgrep|query)/.test(normalized)) return 'search';
  if (/(?:apply_patch|write|edit|save|create|move|rename|delete|remove)_?(?:file|directory)?/.test(normalized)) {
    return 'writeFile';
  }
  if (/(?:browser|web|url|navigate|fetch_page|open_page)/.test(normalized)) return 'browseWeb';
  if (/(?:exec|shell|terminal|command|powershell|cmd|bash)/.test(normalized)) return 'execute';
  return 'other';
}

export function toolCallDurationMs(call: DisplayToolCall): number | null {
  const start = Date.parse(call.startedAt);
  const end = call.completedAt ? Date.parse(call.completedAt) : Number.NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function activityDuration(toolCalls: readonly DisplayToolCall[], hasRunning: boolean): number | null {
  if (toolCalls.length === 0 || hasRunning) return null;
  if (toolCalls.some((call) => toolCallDurationMs(call) === null)) return null;
  const starts = toolCalls.map((call) => Date.parse(call.startedAt));
  const completions = toolCalls.map((call) => Date.parse(call.completedAt!));
  return Math.max(...completions) - Math.min(...starts);
}

/**
 * **此刻在跑哪一条**工具调用 —— 「进行中」反馈的唯一出口（§12）。
 *
 * ## 为什么要有它
 *
 * 这个推导原来在**两处各写了一遍**（活动条 `ComposerActivity`、工具汇总
 * `ToolCallSummary`），一字不差：`[...calls].reverse().find(c => c.status === 'running')`。
 * 两处重复 ⇒ 迟早只改一处。
 *
 * ## 它同时是"该收掉了吗"的唯一判据
 *
 * 界面上所有"正在进行"的反馈都该由它驱动：返回 `null` 就**必须收掉**。四个相位都错过过：
 * - **只显示不收** ⇒ 转圈永远不停，用户以为卡死；
 * - **结束不收** ⇒ 明明跑完了还说"正在执行"；
 * - **失败不收** ⇒ 报错了还说在跑，是**在说谎**（与 `item.status:"blocked"` 那条同类）；
 * - **取消不收** ⇒ 那一轮已经作废，还挂着一条"正在跑"。
 *
 * ⚠️ 取的是**最近**一条（`reverse().find`），不是第一条：长任务里前后会跑好几个工具，
 *    显示最早那条等于告诉用户一件早就做完的事。
 * ⚠️ 纯函数、不改动入参 —— 两个调用方都在 React 的 render 路径上。
 */
export function latestRunningCall(toolCalls: readonly DisplayToolCall[]): DisplayToolCall | null {
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    if (toolCalls[i].status === 'running') return toolCalls[i];
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────
   图12（2026-10-06）：工具文本的产品化整理层
   ────────────────────────────────────────────────────────────────────────
   商业验收（图12）要求：生产界面不出现原始 provider/tool 错误、stack、
   本地路径、安全提示；断网等常见失败给**可执行的中文**降级提示。
   这是对 2026-10-03「原文照登、不翻译」口径的**有意反转**——当时为了不编中文，
   现在为了付费用户看不见内部实现。

   ⚠️ 2026-10-07（区1 体检 P2-5）：**展开详情同样走产品化**（`ToolCallCard` 的
   `sanitizedResult`）—— 这里曾写着"详情不删证据、原文仍可查"，与实现不符，已按实现改正。
   原始载荷的唯一出口是 console（`debugToolFailures`），生产界面（含详情区）不出现原文；
   已知的错误形态给产品文案，**认不出的保留清洗后原文**（不编中文指错方向）。
   ──────────────────────────────────────────────────────────────────────── */

const EXTERNAL_BLOCK_RE =
  /<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>[\s\S]*?(?:<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>|$)/gi;
const SECURITY_NOTICE_RE = /(?:^|\n)[ \t]*SECURITY NOTICE:[\s\S]*?(?=\n[ \t]*\n|$)/gi;

/**
 * 剥运行时安全样板（EXTERNAL_UNTRUSTED_CONTENT 包裹 / SECURITY NOTICE 段），**任意位置**。
 *
 * ⚠️ 2026-10-03 真机事故（W03 搜索复现）：`web_search` 失败时，运行时把安全声明整段塞进了
 *    调用的 result（`SECURITY NOTICE:` 开头 / `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` 包裹），
 *    工具卡把它当"失败原因"原样渲染成英文样板 —— 用户既看不懂，看到的也不是真原因。
 *    判据**只认样板形状**（别的一律走后面的清洗/映射），既不在行首也不在段首的样板同样要剥。
 */
export function stripRuntimeBoilerplate(text: string): string {
  return text
    .replace(EXTERNAL_BLOCK_RE, '\n')
    .replace(SECURITY_NOTICE_RE, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const DRIVE_PATH_RE = /(?<![\w])[A-Za-z]:[\\/](?:[^\\/"'<>|?*\r\n:]+[\\/])*[^\\/\s"'<>|?*\r\n:]+/g;
const UNC_PATH_RE = /\\\\[^\\\s"'<>|?*\r\n]+(?:\\[^\\\s"'<>|?*\r\n]+)+/g;
/**
 * POSIX 绝对路径 / `~` 家目录路径（区1 体检 P3-8）：macOS 与 Linux 上本地目录结构同样不上屏。
 *
 * ⚠️ 负向后视 `(?<![\w:.\/~-])` 挡的是两类**不该被遮**的东西：
 *    - URL（`https://host/a/b` 里的 `/a/b` 前面是字母）；
 *    - 比值/日期这类写法（`10/12` 前面是数字）与协议分隔（`C:/x` 前面是冒号）。
 */
const POSIX_PATH_RE = /(?<![\w:./~-])~?\/(?:[^\s/\\'"<>|?*:,;)\]]+\/)*[^\s/\\'"<>|?*:,;)\]]+/g;

/** 遮蔽本地绝对路径（盘符/UNC/POSIX）→ 只留文件名。路径是内部实现细节，不上生产界面。 */
export function maskLocalPaths(text: string): string {
  const mask = (match: string) => match.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  const absolute = /^(?:[A-Za-z]:[\\/]|\\\\|~?\/)/;
  const hasUrl = (value: string): boolean => /\b[a-z][a-z0-9+.-]*:\/\//i.test(value);
  text = text.replace(
    /(["'])((?:[A-Za-z]:[\\/]|\\\\|~?\/)[^\r\n]*?)\1/g,
    (match: string, quote: string, value: string) => (hasUrl(value) ? match : quote + mask(value) + quote),
  );
  if (absolute.test(text.trim()) && !/[\r\n"']/.test(text) && !hasUrl(text)) return mask(text.trim());
  return text.replace(DRIVE_PATH_RE, mask).replace(UNC_PATH_RE, mask).replace(POSIX_PATH_RE, mask);
}

/** 上屏前的完整清洗：剥样板 + 遮路径 + 折叠多余空白。 */
// Match complete runtime frame shapes, never an ordinary word prefix.
const JS_STACK_FRAME_RE =
  /^[ \t]*at[ \t]+(?:[^\r\n]+\((?:[^\r\n]+:\d+:\d+|native|<anonymous>|index \d+)\)|[^\s()\r\n]+:\d+:\d+|<anonymous>)[ \t]*$/;
const PYTHON_STACK_LINE_RE =
  /^[ \t]*(?:Traceback \(most recent call last\):|File "[^"\r\n]+", line \d+(?:, in [^\r\n]+)?)[ \t]*$/;

export function sanitizeToolText(text: string): string {
  return maskLocalPaths(stripRuntimeBoilerplate(text))
    .split(/\r?\n/)
    .filter((line) => !JS_STACK_FRAME_RE.test(line) && !PYTHON_STACK_LINE_RE.test(line))
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 已知失败形态的家族号（网络 / 限流 / 超时）；认不出 = `unknown`。 */
export type ToolFailureFamily = 'network' | 'rateLimit' | 'timeout' | 'unknown';

/**
 * 原始错误文本 → 家族号 —— **唯一判据**（`productizedToolFailure` 与"可降级继续"共用）。
 *
 * ⚠️ 别在别处再抄一份正则：两处各写一遍的话，文案映射与降级判据迟早漂成两套口径。
 * 判据只认**已知形态**，认不出返回 `unknown`（调用方保留清洗后原文，不编中文指错方向）。
 */
export function classifyToolFailure(reason: string): ToolFailureFamily {
  const cleaned = sanitizeToolText(reason);
  if (!cleaned) return 'unknown';
  const lower = cleaned.toLowerCase();
  if (
    /enotfound|eai_again|econn(?:refused|reset|aborted)|etimedout|socket hang up|fetch failed|network|unable to resolve|offline/.test(
      lower,
    )
  ) {
    return 'network';
  }
  if (/rate[ _-]?limit|too many requests|\b429\b/.test(lower)) return 'rateLimit';
  if (/timed? ?out|timeout/.test(lower)) return 'timeout';
  return 'unknown';
}

/**
 * 「认不出来的**内核英文**」判据 —— 2026-10-08（pre19 验收截图实证）新增。
 *
 * 现场：工具聚合视图把内核原文整句摊在失败原因行上
 * （`no paired nodes available; file-transfer tools require a paired node from nodes status.
 *   Use local file/exec tools for local workspace paths.` ×12 重复失败）——普通用户不该看到
 * 内核英文（BUG-012/026 的口径：provider/内核原始异常不上屏）。
 *
 * 判据：清洗之后**非空**且**一个中日韩字符都没有** ⇒ 视为机器英文，走产品兜底句。
 *   ✅ 含中文的认不出文本**照旧原样保留**：那是人话，"不编中文指错方向"的原则不变。
 *   ✅ 安全样板（SECURITY NOTICE / EXTERNAL_UNTRUSTED_CONTENT）会被剥成空串 ⇒ 这里判 false
 *      （那两种情况由 `null` 承担，不进兜底句，否则会把"没有原因"说成"这一步无法完成"）。
 */
export function isOpaqueToolFailure(reason: string): boolean {
  const cleaned = sanitizeToolText(reason);
  if (!cleaned) return false;
  return !CJK_RE.test(cleaned);
}

/** 中日韩（含全角标点区）—— 只要有一个，就认为这段文本是"给人读的中文"。
 *  ⚠️ 区间用 `\u` 转义写（U+3000/U+3040/U+3400/U+4E00/U+FF00 起）：
 *  字面量形态会把 U+3000 这类"非常规空白"写进源码，`no-irregular-whitespace`
 *  会拦 —— 语义完全相同。 */
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

/**
 * 已知的原始错误形态 → 产品化文案。
 *
 * ⚠️ **2026-10-08 口径反转**（pre19 验收截图）：认不出来的**内核英文**不再原样上屏，
 *    统一走**既有兜底文案** `toolActivity.failure.cannotContinue`（「这一步暂时无法完成。」，
 *    BUG-026 已定稿的 9 语言词条 —— **零新增 i18n 键**）。
 *    原始文本不丢：`debugToolFailures()` 照旧把完整载荷写进 console.debug（用户面看不到、排查拿得到）。
 *    ⚠️ **含中文**的认不出文本仍然原样保留（不编中文指错方向）。
 *
 * ⚠️ **2026-10-08 总审（R5）两处调整**：
 *    ① **具名协议错误先于 family 分类**：`Missing required parameter: timeout (received: …)` 里的
 *       "timeout" 是**参数名**，不是"等待超时"（真机实证：整句被判成 `toolActivity.failure.timeout`）；
 *       工具名里带 `network` 的 not found 同理。family 三态内部顺序不变，只是排到具名之后。
 *    ② 具名判据吃**剥样板但未遮路径**的原文（`stripRuntimeBoilerplate`）：参数名不能从**脱敏后**
 *       的文本反推（`C:\…\report.docx` 被遮成 `report.docx` 后会被当参数名用）。
 *        rest 的清洗/判据仍走 `sanitizeToolText`（遮路径照旧，出口不吐路径）。
 * 返回 `null` = 没有任何可展示内容（调用方不渲染该行）。
 */

/**
 * **组件共用入口**（R5）：原始 `ToolCall.result`（可能带样板 / 路径）→ 具名形态号；认不出 `null`。
 *
 * 放在这里（而不是 `tool-failure-explain.ts`）是为了让依赖**单向**：本文件引
 * `tool-failure-explain` 的 `matchToolFailure`/`explainToolFailure`，反向零引用；
 * 而"剥样板"只有这里一份实现。
 *
 * `ToolCallCard` 用它抑制"矛盾的家族类别"（缺 timeout 参数 ≠ 等待超时），
 * `ToolCallSummary` 用它决定弱化态显示具名句而不是泛化的"已跳过"。
 */
export function namedToolFailureKind(reason: string): ToolFailureKind | null {
  return matchToolFailure(stripRuntimeBoilerplate(reason));
}

export function productizedToolFailure(reason: string, t: Translate): string | null {
  const stripped = stripRuntimeBoilerplate(reason);
  const explained = explainToolFailure(stripped, t);
  if (explained) return explained;
  const cleaned = sanitizeToolText(reason);
  if (!cleaned) return null;
  const family = classifyToolFailure(cleaned);
  if (family === 'network') return t('toolActivity.failure.network');
  if (family === 'rateLimit') return t('toolActivity.failure.rateLimit');
  if (family === 'timeout') return t('toolActivity.failure.timeout');
  if (isOpaqueToolFailure(cleaned)) return t('toolActivity.failure.cannotContinue');
  return cleaned;
}

/* ────────────────────────────────────────────────────────────────────────
   BUG-026（2026-10-06 B 组）：同一工具的重复失败 → 一条
   ────────────────────────────────────────────────────────────────────────
   真机形状：模型对同一个工具"失败 → 重试 → 再失败"，每次失败都占一格，
   用户看到的是连环报错。聚合是**渲染期**行为（不动数据库/消息模型）：
   相同工具 + 相同原因的重复失败合并成一条（首次出现的为代表），其余进
   `repeats` 折叠展示 —— **事实不隐藏**（计数如实、原文仍可展开查到）。
   ──────────────────────────────────────────────────────────────────────── */

export interface RepeatedToolFailure {
  /** 代表条目：同一（工具 + **原始**原因）里**首次出现**的那次失败。 */
  call: DisplayToolCall;
  /** 该组合的失败总次数（含代表条目）。 */
  count: number;
  /** 其余重复条目（保序）—— 展示可折叠，数据一个不丢。 */
  repeats: DisplayToolCall[];
}

/**
 * 同一工具的重复失败聚合（只处理 `status === 'error'`，成功调用原样不参与）。
 *
 * 判据 = **工具名 + 原始失败原因**：
 *   - 同一工具、不同原因**不合并**（两个原因都是事实，合了就是藏信息）；
 *   - 不同工具、相同原因也不合并（要求说的就是"同一工具"）。
 *
 * ⚠️ 2026-10-07（区1 体检 P2-3）：这里原来先用 `sanitizeToolText` 清洗再当键 ——
 *    遮蔽路径会把 `C:\a\report.docx` 与 `C:\b\report.docx` 洗成同一个 `report.docx`，
 *    两条**不同文件**的失败被折叠成"同一次"，展开后两条还长得一模一样（"×2"是自造的）。
 *    清洗只作用于**展示**，判据必须用原始文本。
 */
export function aggregateRepeatedToolFailures(toolCalls: readonly DisplayToolCall[]): RepeatedToolFailure[] {
  const byKey = new Map<string, RepeatedToolFailure>();
  const entries: RepeatedToolFailure[] = [];
  for (const call of toolCalls) {
    if (call.status !== 'error') continue;
    const key = `${call.name.trim().toLowerCase()}\u0000${call.result ?? ''}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.repeats.push(call);
      continue;
    }
    const entry: RepeatedToolFailure = { call, count: 1, repeats: [] };
    byKey.set(key, entry);
    entries.push(entry);
  }
  return entries;
}

/**
 * **开发日志**：原始失败载荷（工具名 / 参数 / provider 原文 / stack / 耗时）完整进 console
 * ——用户面看不到的排查材料在这里一个字都不删（BUG-026 契约）。
 *
 * ⚠️ 只进 console，**不进界面**：`tool-activity.ts` 是唯一的"能不能上屏"判据，
 *    这个函数是它的背面（原始层），别把它接到任何 UI 出口上。
 * ⚠️ 2026-10-07（区1 体检 P3-10）：调用方必须传**原始** `toolCalls`，不是展示副本 ——
 *    展示层的「未收到结果」强转会往 `result` 里补一句产品文案，传副本就等于把伪造的
 *    载荷写进日志，"原始载荷一个字段不删"当场失效。
 */
export function debugToolFailures(toolCalls: readonly ToolCall[]): void {
  const failures = toolCalls.filter((call) => call.status === 'error');
  if (failures.length === 0) return;
  console.debug(
    '[tool-failure] raw',
    failures.map((call) => ({
      id: call.id,
      name: call.name,
      title: call.title,
      status: call.status,
      args: call.args,
      // 运行时原文：provider 异常 / stack / traceId 等都在里面，原样保留（不清洗）。
      result: call.result,
      startedAt: call.startedAt,
      completedAt: call.completedAt,
      latencyMs: toolCallDurationMs(call),
      slideProgress: call.slideProgress,
    })),
  );
}

/**
 * 网关拼的 `title`（形如「web_search for "…"」「edit in S:\…\x.slidegen」）→ 上屏形态：
 * 遮蔽路径、剥**开头**的原始工具名（只剥长度 ≥3 的标识符——`ls 目录` 这类短命令名保留，
 * 剥掉会把句子掏空）、清连接词；剥空了返回 `null`（调用方退回产品化动作词）。
 */
export function sanitizeToolTitle(title: string | undefined | null, toolName: string): string | null {
  if (!title) return null;
  let cleaned = maskLocalPaths(title);
  const name = toolName?.trim() ?? '';
  if (name.length >= 3) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`^\\s*${escaped}\\b[\\s:：,，-]*`, 'i'), '');
  }
  cleaned = cleaned.replace(/^\s*(?:for|in|on|at|of|to|from|with|about)\b[\s:：,，-]*/i, ' ');
  cleaned = maskLocalPaths(cleaned)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return cleaned || null;
}

/**
 * 摘要行可展示的失败原因：先整段清洗（剥样板 + 遮路径），再按已知形态映射产品文案；
 * 没有可用原因时返回空串（摘要行少一行灰字，失败本身仍由"N 个失败"与展开详情表达）。
 *
 * ⚠️ **两个分支都不吐内核英文**（2026-10-08，pre19 验收截图）：有 `t` 时走产品兜底句；
 *    **没传 `t` 时宁可返回空串**（拿不到产品文案就不说话），也不把英文原文交给界面。
 */
export function visibleFailureReason(toolCalls: readonly DisplayToolCall[], t?: Translate): string {
  for (const candidate of toolCalls) {
    if (candidate.status !== 'error') continue;
    const raw = candidate.result ?? '';
    const cleaned = sanitizeToolText(raw);
    if (!cleaned) continue;
    // ⚠️ F4（2026-10-08 终审）：与卡片路径（`ToolCallCard` 传原始 `result`）**必须持同一原文** ——
    //    `productizedToolFailure` 内部先"剥样板（未遮路径）"跑具名判据、再做脱敏清洗；
    //    这里若先 `sanitizeToolText`，遮路径会把 `C:\…\report.docx` 洗成 `report.docx`，
    //    被当成"参数名"报出去 ⇒ 同一失败在摘要与卡片给出互相矛盾的说明。
    if (t) return productizedToolFailure(raw, t) ?? cleaned;
    return isOpaqueToolFailure(cleaned) ? '' : cleaned;
  }
  return '';
}

/**
 * 摘要行可展示的「未收到结果」原因：**有真实文本就摊原文**（清洗后），没有才由调用方退回
 * 产品文案（`toolActivity.noResult`）。
 *
 * ⚠️ 2026-10-07（区1 体检 P1-2）：这条路径原来是**无条件**用「这一步没有返回结果」把
 *    `result` 顶掉 —— 而 running 帧常带网关拼的 meta 摘要，settled 后真实输出就这么被
 *    一句"没有结果"抹掉：有证据却说没有。
 */
export function visibleUnreportedReason(toolCalls: readonly DisplayToolCall[]): string {
  for (const candidate of toolCalls) {
    if (candidate.status !== 'unreported') continue;
    const cleaned = sanitizeToolText(candidate.result ?? '');
    if (cleaned) return cleaned;
  }
  return '';
}

/**
 * **展示副本**：已定稿的消息里还停在 `running`/`awaitingApproval` 的调用 ⇒ `unreported`
 * （未收到结果）。**不改写原始数据**（落库/日志仍以 `toolCalls` 原文为准）。
 *
 * ⚠️ `result` 只在**空白**时才补一句 `fallbackResult`（产品文案）——有真值一律保留原文；
 *    下游用 `sanitizeToolText` 清洗后展示。
 */
export function markUnreportedCalls(
  toolCalls: readonly ToolCall[],
  settled: boolean,
  fallbackResult: string,
): DisplayToolCall[] {
  if (!settled) return [...toolCalls];
  return toolCalls.map((call): DisplayToolCall => {
    if (!isUnfinished(call.status)) return call;
    return {
      ...call,
      status: 'unreported',
      ...(call.result?.trim() ? {} : { result: fallbackResult }),
    };
  });
}

/**
 * 还没结束的状态 —— `running` 与 `awaitingApproval`（A2，2026-09-19）。
 *
 * ⚠️ **它们不是一回事，但都"没结束"**：显示上要分开说（`awaitingApproval` 有自己的文案，
 * 见 `ToolCallCard` / `ComposerActivity`），**归类**上必须同一桶 ——
 * 少了 `awaitingApproval`，`summarizeToolActivity` 的 `runningCount` 就是 0，
 * 而 `ToolCallSummary` 会据此把"等着人批准"渲染成 **`done`**（那是撒谎）。
 */
function isUnfinished(status: ToolDisplayStatus): boolean {
  return status === 'running' || status === 'awaitingApproval';
}

/**
 * 最新一条**在等人批准**的调用（没有就 null）。
 *
 * ⚠️ 与 `latestRunningCall` **分开**，因为它们的文案不同：
 * "执行中：X" 说的是"在动"，而这条要说的是"**没动，在等人**" ——
 * 复用前者就等于什么都没说（A2 的口径就是不让复用）。
 */
export function latestAwaitingApproval(toolCalls: readonly DisplayToolCall[]): DisplayToolCall | null {
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    if (toolCalls[i].status === 'awaitingApproval') return toolCalls[i];
  }
  return null;
}

export function summarizeToolActivity(toolCalls: readonly DisplayToolCall[]): ToolActivitySummaryModel {
  const groups = new Map<string, ToolActivityGroup>();
  let completedCount = 0;
  let runningCount = 0;
  let errorCount = 0;
  let unreportedCount = 0;

  for (const call of toolCalls) {
    if (isUnfinished(call.status)) runningCount += 1;
    else if (call.status === 'unreported') unreportedCount += 1;
    else completedCount += 1;
    if (call.status === 'error') errorCount += 1;

    const kind = classifyToolActivity(call.name);
    const key = `${kind}:${call.status}`;
    const group = groups.get(key);
    if (group) group.calls.push(call);
    else groups.set(key, { key, kind, status: call.status, calls: [call] });
  }

  // ⚠️ 「未收到结果」**不进** `errorCount`（没收到结果不是失败，数错了会给用户假失败）；
  //    它同时也不进 `completedCount` —— 「已完成 N 个步骤」不能把没结果的那步算成做完了。
  return {
    totalCount: toolCalls.length,
    completedCount,
    runningCount,
    errorCount,
    unreportedCount,
    durationMs: activityDuration(toolCalls, runningCount > 0),
    groups: [...groups.values()],
  };
}
