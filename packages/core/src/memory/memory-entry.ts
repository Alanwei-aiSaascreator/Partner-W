/**
 * 长时记忆的**纯逻辑**那一半（条目模型 / 校验 / 去重键）。
 *
 * ## 为什么住在这里（而不是渲染层或主进程）
 *
 * 主进程要写库、渲染层要展示、测试要能不起 Electron 就跑到 —— 三边都要的是**同一套
 * 判据**。放到 `@clawwork/core` 就没有第二份实现可以漂移。
 *
 * ## 一次拍定过的产品口径（`docs/superpowers/plans/2026-09-24-p3-plans-web-search-image-video-memory.md` §3）
 *
 * · 记忆**必须随盘走** ⇒ 落盘在工作区，不进网关 state 目录；
 * · 一期**只做确认轨道**：助手**只提草案**，用户点头才落盘，**不做自动写入**；
 * · 验收：写→重启→读得到；跨机插同一块盘读得到；**删除后确实不再召回**；
 *   **越权（别的账号 / 别的盘）读不到**。
 *
 * 本文件承载的是最后一条的**作用域键**（`ownerUserId`）与"删除后不再召回"所依赖的
 * **去重键**（`dedupeKey`）。
 *
 * ## 作用域：为什么有 `ownerUserId` 这一维
 *
 * 冻结语义里"同一块 U 盘的工作区 / 任务 / 文件共用"说的是**盘上工作区内容**；
 * 原记忆规格同时要求"越权（别的账号）读不到"。两者不冲突的做法是：**存储仍是一份
 * （随盘），但每条记忆带归属键**，读的时候按当前账号过滤 —— 换账号既不串记忆，
 * 也不新增第二套库（与 `PRODUCT_ARCHITECTURE §7`"个人资料、会话及额度按各自账号"
 * 同一条线）。
 *
 * ⚠️ `ownerUserId === ''` = **未登录（匿名）**，不是"所有人可见"。未激活用户写下的条目
 * 在登录后**看不到**（宁可让用户重写一次，也不把匿名内容当成某个账号的记忆）。
 */

/** 一条记忆的处置状态。`pending` 就是"草案"——用户还没点头。 */
export type MemoryEntryStatus = 'pending' | 'confirmed' | 'rejected';

/** 这条记忆是谁提的。**UI 必须如实区分**（助手提的要标出来，见"不做自动写入"）。 */
export type MemoryEntrySource = 'user' | 'assistant';

export interface MemoryEntry {
  id: string;
  /** 归属账号（`licenseBinding.userId`）；`''` = 未登录。 */
  ownerUserId: string;
  text: string;
  status: MemoryEntryStatus;
  source: MemoryEntrySource;
  sourceTaskId: string | null;
  sourceMessageId: string | null;
  /** 规范化正文的折叠小写形式；唯一索引拿它挡"同一件事提两次"。 */
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  /** 用户点头/拒绝的时刻；`pending` 时为 `null`。 */
  decidedAt: string | null;
}

/**
 * 单条上限。**不是运行时给的硬限制**（`USER.md` 那条 4,000 才是运行时硬限制），
 * 是我们对"一条"的界定：一句话该说清的事，超过它就是该拆成两条或者该写进资料库。
 */
export const MEMORY_ENTRY_MAX_CHARS = 500;

/** 整块上限（所有已确认条目正文之和）。口径与 `USER.md` 同量级 —— 见文件头的取舍说明。 */
export const MEMORY_BLOCK_MAX_CHARS = 4000;

/** 单账号最多保留多少条已确认记忆。到顶就要求用户删一条，**不静默丢弃最旧的**。 */
export const MEMORY_MAX_CONFIRMED_ENTRIES = 50;

/** 一条回复里最多认几条记忆草案（防模型刷屏）。多的**丢掉**并在返回值里如实计数。 */
export const MEMORY_DRAFT_MAX_PER_MESSAGE = 3;

export type MemoryTextRejection = 'empty' | 'over-limit' | 'control-characters';

export type MemoryTextCheck =
  | { ok: true; text: string; dedupeKey: string }
  | { ok: false; reason: MemoryTextRejection; limit?: number };

/**
 * 规范化：把各种空白折成单个空格并去首尾。
 *
 * ⚠️ **保留原文的其它字符**（中文标点、emoji 都原样留着）—— 这条文本要写进
 * 助手每轮读到的提示词里，改写它等于替用户说话。
 */
export function normalizeMemoryText(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * 去重键 = 规范化 + 折叠大小写。
 *
 * ⚠️ 大小写折叠只影响**判重**，不影响落库的正文。中文没有大小写，`toLowerCase` 对它是恒等；
 * 英文场景下 "Use pnpm" 与 "use PNPM" 是同一件事，不该提两次。
 */
export function memoryDedupeKey(text: unknown): string {
  return normalizeMemoryText(text).toLowerCase();
}

/**
 * 校验一条候选记忆正文。
 *
 * ⚠️ 控制字符要挡：正文会进提示词与 Markdown 区块，夹一个 `\u0000` 进去会让
 * 后面的解析（以及 sqlite 的 TEXT 绑定）行为不可预期。只允许 `\n`/`\t` 之外的
 * C0/C1 控制字符被拒绝 —— 规范化已经把 `\n`/`\t` 折成空格，所以到这里的正文里
 * 出现控制字符就是真的有问题。
 */
export function checkMemoryText(text: unknown): MemoryTextCheck {
  const normalized = normalizeMemoryText(text);
  if (normalized.length === 0) return { ok: false, reason: 'empty' };
  // eslint-disable-next-line no-control-regex -- 这条正则就是在找控制字符，不是漏写
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(normalized)) {
    return { ok: false, reason: 'control-characters' };
  }
  if (normalized.length > MEMORY_ENTRY_MAX_CHARS) {
    return { ok: false, reason: 'over-limit', limit: MEMORY_ENTRY_MAX_CHARS };
  }
  return { ok: true, text: normalized, dedupeKey: memoryDedupeKey(normalized) };
}

/** 已确认条目正文之和；写库与写区块前都拿它判整块预算。 */
export function confirmedBlockChars(entries: readonly { text: string }[]): number {
  return entries.reduce((total, entry) => total + entry.text.length, 0);
}

export type MemoryBudgetCheck = { ok: true } | { ok: false; reason: 'block-over-limit' | 'entry-count-limit' };

/**
 * 加**一条**之前先问"加了还放得下吗"。
 *
 * ⚠️ 刻意**不**做"超了就丢最旧的"——那会让用户在上限处悄悄丢记忆。宁可当场拒绝并
 *    让用户自己删一条（提示语里给上限数字）。
 */
export function checkMemoryBudget(confirmed: readonly { text: string }[], candidateText: string): MemoryBudgetCheck {
  if (confirmed.length + 1 > MEMORY_MAX_CONFIRMED_ENTRIES) return { ok: false, reason: 'entry-count-limit' };
  if (confirmedBlockChars(confirmed) + candidateText.length > MEMORY_BLOCK_MAX_CHARS) {
    return { ok: false, reason: 'block-over-limit' };
  }
  return { ok: true };
}

/**
 * 草案标题/正文是否"值得给用户看"——空正文、纯标点的草案不上屏。
 *
 * 与 `checkMemoryText` 同一套规范化，只是**不**在这里判长度（草案可以超限，
 * 用户编辑时再看长度，编辑框里当场提示比事后拒绝好）。
 */
export function isPresentableDraft(text: unknown): boolean {
  const normalized = normalizeMemoryText(text);
  if (normalized.length === 0) return false;
  return /[\p{L}\p{N}]/u.test(normalized);
}
