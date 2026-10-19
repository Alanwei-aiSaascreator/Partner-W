/**
 * 已确认记忆 → 助手工作区 `MEMORY.md` 的**受管区块**（渲染 + 合并 + 回读）。
 *
 * ## 为什么召回走这条通道
 *
 * 运行时每轮把 agent workspace 的 `AGENTS/SOUL/IDENTITY/USER/BOOTSTRAP/MEMORY`
 * 六个文件**全文注入**系统提示词（`WORKSPACE_BOOTSTRAP_FILENAMES`，实读结论见
 * `main/capability/capability-boundary-prompt.ts` 头注释）。`MEMORY.md` 正是这六个之一
 * ⇒ **写进去就是真召回**：不需要新增运行时通道、不碰网关 state 目录（那条路被 exFAT 堵死，
 * 也是原记忆规格点名不走的）。
 *
 * ## 为什么是"受管区块"而不是整份文件
 *
 * `MEMORY.md` 不是我们的私有文件：运行时的记忆内核（dreaming / 短期晋升）与用户本人都会
 * 往里写。整份覆盖会把它们一起抹掉。所以只维护**带起止标记的那一段**，区块外一个字节不动。
 *
 * ## 🔴 只写"已确认"的条目
 *
 * 这个文件每轮全文进提示词。草案一旦写进去，就等于**用户还没点头已经被"记住"**了 ——
 * 那正是产品纪律里"未确认不上屏 / 不做自动写入"要挡的事。过滤责任在调用方，
 * 这里再断言一次：`renderMemoryBlock` 只认它有把握的输入。
 */

import { type MemoryEntry } from './memory-entry.js';
import { markedBlockBulletLines, mergeMarkedBlock, readMarkedBlock, type MarkedBlockMerge } from './marked-block.js';

/** 区块版本：区块正文格式变化时 +1；写端据此升级已有区块。 */
export const MEMORY_BLOCK_VERSION = 1;

/** 受管区块的标记前缀（与 `AGENTS.md` 上的记忆**契约**区块是不同前缀，互不干扰）。 */
export const MEMORY_BLOCK_MARKER_PREFIX = 'mofang-memory';

const HEADING = '## 长期记忆（应用自动维护；请勿手改本区块，你自己的笔记请写在区块之外）';
const EMPTY_NOTE = '（当前没有已确认的长期记忆。）';

/**
 * 区块正文。
 *
 * ⚠️ 调用方必须只传**已确认**条目 —— 这里收到什么就写什么，不做状态过滤
 *    （过滤发生在库那一层，见 `main/memory/store.ts`）。空集合写的是"没有已确认记忆"
 *    这句**如实说明**，而不是留一个空标题。
 */
export function renderMemoryBlock(entries: readonly Pick<MemoryEntry, 'text'>[]): string {
  const lines = entries.map((entry) => entry.text.trim()).filter((text) => text.length > 0);
  const body = lines.length > 0 ? lines.map((line) => `- ${line}`) : [EMPTY_NOTE];
  return [HEADING, '', ...body].join('\n');
}

/** 把记忆区块并入一份已有的 `MEMORY.md` 正文（幂等；区块外一字不动）。 */
export function mergeMemoryBlock(
  existing: string,
  block: string,
  version: number = MEMORY_BLOCK_VERSION,
): MarkedBlockMerge {
  return mergeMarkedBlock(existing, MEMORY_BLOCK_MARKER_PREFIX, version, block);
}

/**
 * 从一份 `MEMORY.md` 正文里读回**受管区块**；没有区块返回 `null`。
 *
 * 用途是取证与断言：写完/删完要从**同一个文件**里读回来，而不是只信自己内存里那句字符串。
 */
export function readMemoryBlock(content: string): string | null {
  return readMarkedBlock(content, MEMORY_BLOCK_MARKER_PREFIX);
}

/** 受管区块里列出的记忆正文（去 `- ` 前缀）；没有区块返回 `[]`。 */
export function memoryBlockEntryLines(content: string): string[] {
  return markedBlockBulletLines(content, MEMORY_BLOCK_MARKER_PREFIX);
}
