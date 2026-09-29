/**
 * **把整份版面写成工作区里的一个文件** —— 这条路的"找文件"那一半。
 *
 * ## 为什么要有这条路（2026-09-28 真机定的）
 *
 * 随包网关把**单条消息**截在 8,000 字符（`truncateChatHistoryText`）。
 * 那条截断另有恢复通道，见 `artifact/recover-full-reply.ts`。
 * 于是"整份写进回复里"在真机上**四次都死在 8,000**：围栏没有结尾 ⇒
 * `extractSlidegenBlocks` 只认闭合围栏 ⇒ 整份丢掉。
 *
 * 而**写文件拿得到全文** —— ⚠️ 这不是推断，是量出来的：真机那份
 * `sept_briefing.slidegen.jsx` 在盘上是 **13,052 字节、结尾完整**（`</Slide>` + 闭合围栏），
 * 而同一条回复的正文被切在 8,000。所以截断只发生在**聊天投影**上，不发生在工具参数上。
 *
 * ## 分工
 *
 * 本模块只负责 **找 → 读 → 拼**，返回文本与失败；**排版与写出**仍是
 * `generateSlidesFromMessage`（它只吃字符串，所以这里拼好的文本直接喂给它）。
 * 这样"读文件"这条新路不需要碰 DSL、量框、写 pptx 任何一处。
 *
 * ## 三条边界都是刻意钉住的
 *
 * 1. **文件名认 `.slidegen` 的每一种写法**（见 `isDeckFileName`）——
 *    真机那份叫 `x.slidegen.jsx`，只认精确扩展名会**恰好漏掉唯一一份成功样本**。
 * 2. **"新的"按 size 或 mtime 判** ⇒ 同名覆盖也算新的，否则重写一遍不生效。
 * 3. ⭐ **读了文件却一份 deck 都没解析出来、失败列表也是空 ⇒ 必须报错**（见 `deckFileNoFenceFailure`）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { SlidegenFailure } from '@clawwork/shared';
import { extractSlidegenBlocks } from './blocks.js';

/** 扫的时候跳过的目录。助手的 workspace 里有 `.git`（真机确认过），没必要往里走。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);

/** 文件名里含这个就归这条路。**前后都要有分隔**，所以 `slidegen.md` 不算。 */
const DECK_NAME_MARKER = '.slidegen';

/** 一行文件名的指纹。`size` 与 `mtimeMs` 任一变了就算新的。 */
export interface DeckFileStamp {
  size: number;
  mtimeMs: number;
}

/** 基线：相对路径（`/` 分隔）→ 指纹。 */
export type DeckFileBaseline = Record<string, DeckFileStamp>;

/**
 * 这个文件名归不归这条路。
 *
 * ⚠️ 判据是**文件名里含 `.slidegen`**，不是"扩展名等于 `.slidegen`"：
 *    真机模型写出来的是 `sept_briefing.slidegen.jsx`，`extname()` 拿到的是 `.jsx`。
 *    只认精确扩展名 ⇒ 唯一一份成功样本会被漏掉。
 * ⚠️ 大小写不敏感：Windows 上 `.SLIDEGEN` 是合法的，模型也确实会写出大写。
 */
export function isDeckFileName(name: string): boolean {
  return name.toLowerCase().includes(DECK_NAME_MARKER);
}

/** 走一遍目录，回调每个**文件**的路径与文件名。目录不存在 / 读不动时安静地停 —— 由调用方判断。 */
function walk(root: string, visit: (absolute: string, name: string) => void): boolean {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(absolute, visit);
      continue;
    }
    if (!entry.isFile()) continue;
    visit(absolute, entry.name);
  }
  return true;
}

/** 相对路径统一成 `/` 分隔 —— 基线要跨机器/跨轮次可比，不能一半 `\` 一半 `/`。 */
function unify(absolute: string, root: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/**
 * 采一次基线。
 *
 * ⚠️ **根读不到时回 `null`，不回 `{}`** —— 调用方必须能分辨
 *    "读不到工作区"（这一轮**不跑**文件路）和"工作区里确实没有 deck 文件"（正常回落）。
 *    把两者都做成空基线，就会把"读不到"当成"全是新的"，每一轮把陈年 deck 重排一遍。
 */
export function captureDeckFileBaseline(root: string): DeckFileBaseline | null {
  const baseline: DeckFileBaseline = {};
  let looked = false;
  const ok = walk(root, (absolute, name) => {
    looked = true;
    if (!isDeckFileName(name)) return;
    try {
      const stats = statSync(absolute);
      baseline[unify(absolute, root)] = { size: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
      // 采基线时读不到指纹就当它不在基线里 ⇒ 这一轮收尾时会把它算成"新的"（偏保守，宁可多做）。
    }
  });
  if (!ok && !looked) return null;
  return baseline;
}

/**
 * 比基线**新的**文件（相对路径，`/` 分隔）。
 *
 * 判据就是 `size` 或 `mtime` 变了 —— 所以"同名覆盖"也算新的。
 * 不在基线里的（新增）自然也算。
 *
 * 顺序确定：先按 mtime 升序，同刻按路径 —— 让"模型一次写了两份"的产物顺序可复现。
 */
export function changedDeckFiles(baseline: DeckFileBaseline, root: string): string[] {
  const found: { path: string; mtimeMs: number }[] = [];
  walk(root, (absolute, name) => {
    if (!isDeckFileName(name)) return;
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      return;
    }
    const path = unify(absolute, root);
    const before = baseline[path];
    if (before && before.size === stats.size && before.mtimeMs === stats.mtimeMs) return;
    found.push({ path, mtimeMs: stats.mtimeMs });
  });
  found.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  return found.map((entry) => entry.path);
}

/**
 * 单个版面文件的**字节**上限。
 *
 * ## 为什么要有（这条路已经绕开了运行时两层顶）
 *
 * 文件不走聊天投影 ⇒ 没有 8,000 的显示截断、也没有单条消息 131,072 字节那层顶。
 * 但"没有运行时上限"**不等于**"可以没有上限"：一份失控的大文件会在**消息收尾路径**上
 * 被整份读进内存并送进排版，那正是本项目踩过的"收尾链拖垮界面"。
 *
 * ## 取值
 *
 * **1 MiB**。标定依据（可测）：真机那份成功的 deck 是 **13,052 字节**，
 * 这里给了约 **80 倍**余量 —— 足够长演示在 200 页预算（`SLIDEGEN_MAX_PAGES`）内
 * 共享样式、保留完整内容，同时把内存与收尾耗时钉在有限值上。
 * ⚠️ 单位为**字节**：中文一个字 3 字节 ⇒ 约 34 万个汉字。**别用"多少字"当判据。**
 */
export const DECK_FILE_MAX_BYTES = 1024 * 1024;

export interface DeckSources {
  /** 拼好的正文，直接喂给 `generateSlidesFromMessage`。 */
  text: string;
  /** 读不动的文件（相对路径）。**不许静默丢** —— 调用方要把它变成失败。 */
  unreadable: string[];
  /** 超限的文件（相对路径 + 实际字节数）。同样**不许静默丢**。 */
  oversized: { path: string; bytes: number }[];
}

/**
 * 读正文并拼起来。超限的文件**不读**（先看字节数再读，别先读进内存再说）。
 *
 * 每份之间补一个空行：围栏必须在**行首**才被 `FENCE_RE` 认出来，
 * 前一份若没有以换行收尾，后一份的 ```` ```slidegen ```` 就会黏在上一行末尾而**不被认**。
 */
export function readDeckSources(root: string, relatives: readonly string[]): DeckSources {
  const parts: string[] = [];
  const unreadable: string[] = [];
  const oversized: { path: string; bytes: number }[] = [];
  for (const relativePath of relatives) {
    const absolute = join(root, relativePath);
    let bytes: number;
    try {
      bytes = statSync(absolute).size;
    } catch {
      unreadable.push(relativePath);
      continue;
    }
    // ⚠️ 先量大小再读 —— `readFileSync` 之后再判会把整份大文件先吞进内存，
    //    而这道上限的**全部意义**就是别那么干。
    if (bytes > DECK_FILE_MAX_BYTES) {
      oversized.push({ path: relativePath, bytes });
      continue;
    }
    try {
      parts.push(readFileSync(absolute, 'utf8'));
    } catch {
      unreadable.push(relativePath);
    }
  }
  return {
    text: parts.map((part) => (part.endsWith('\n') ? part : `${part}\n`)).join('\n'),
    unreadable,
    oversized,
  };
}

/**
 * ⭐ **读了文件却一份 deck 都没解析出来、失败列表也是空 ⇒ 必须报"文件里没有围栏"。**
 *
 * 这条正对着刚修完的那类静默：`extractSlidegenBlocks` 只认闭合围栏，
 * 文件里没围栏时它**既不进 `decks` 也不进 `failures`**，上层两个分支都不进 ⇒
 * 产物空、日志空、界面说"已完成"。
 *
 * ⚠️ **只在"确实有合格文件"时才报**：没有文件是**常规回落**（该去看聊天正文里的围栏），
 *    不是失败 —— 否则每一轮与 PPT 无关的对话都会多出一条假失败。
 * ⚠️ 已经有失败时不抢着再报一条：`slidegen-block-unclosed`（围栏开了没闭合）比这条更准。
 */
export function deckFileNoFenceFailure(input: {
  fileCount: number;
  deckCount: number;
  failureCount: number;
}): SlidegenFailure | null {
  if (input.fileCount === 0) return null;
  if (input.deckCount > 0 || input.failureCount > 0) return null;
  return { code: 'slidegen-file-no-fence' };
}

/**
 * 一步到位：读文件 → 拼文本 → 该报的失败都报出来。
 *
 * 失败有两类，都会出现在返回值里（**任何一类都不许吞**）：
 *   · 读不动的文件 ⇒ `slidegen-file-unreadable`
 *   · 有文件但一份 deck 都没有、也没有别的失败 ⇒ `slidegen-file-no-fence`
 */
export function decksFromFiles(input: { root: string; relatives: readonly string[] }): {
  text: string;
  failures: SlidegenFailure[];
} {
  const { text, unreadable, oversized } = readDeckSources(input.root, input.relatives);
  const failures: SlidegenFailure[] = [];
  if (unreadable.length > 0) failures.push({ code: 'slidegen-file-unreadable' });
  // 超限每份单独报一条，带上 max/got —— 用户要能看到"超了多少"，而不是一句"失败了"。
  for (const entry of oversized) {
    failures.push({ code: 'slidegen-file-too-large', max: DECK_FILE_MAX_BYTES, got: entry.bytes });
  }
  const extracted = extractSlidegenBlocks(text);
  const noFence = deckFileNoFenceFailure({
    // ⚠️ 这里数的是**真读到了正文的**文件，不是"试图读的"。
    //    用 `relatives.length` 会在**整份都读不动**时多报一条"文件里没有围栏"——
    //    那是在**没拿到的内容**上下结论。（这条是被测试逮出来的。）
    //    超限的那份同理：它根本没被读，不能算进"文件里没有围栏"的判据。
    fileCount: input.relatives.length - unreadable.length - oversized.length,
    deckCount: extracted.decks.length,
    failureCount: extracted.failures.length,
  });
  if (noFence) failures.push(noFence);
  return { text, failures };
}
