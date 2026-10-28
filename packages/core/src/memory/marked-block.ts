/**
 * 「受管区块」的通用合并/读取原语。
 *
 * ## 为什么要有它
 *
 * 这个仓库里已经有三处**同一形状**的需求：能力边界写进 `AGENTS.md`、长期记忆写进
 * `MEMORY.md`、记忆草案契约也写进 `AGENTS.md`（不同标记）。三处的纪律完全一样：
 *
 * · 空文本 ⇒ 直接写；
 * · 已有**我们的**区块（任意版本）⇒ 只替换区块本身，区块外一字不动；
 * · 没有我们的区块但有别人的正文 ⇒ 追加到末尾，原文原样保留；
 * · 同版本同内容 ⇒ `changed: false`（幂等，写端据此跳过 RPC）。
 *
 * 抄三遍就一定会漂移（这个仓库已经为"抄第二遍"付过代价），所以抽成一个函数，
 * 各自只提供**标记前缀 + 版本**。
 *
 * ## 标记为什么是 HTML 注释
 *
 * 这些文件都是**运行时每轮全文注入的提示词**。注释在模型看到的正文里是隐形的，
 * 不会把"这是应用自动维护的"变成提示词噪音；同时对用户仍然可读可搜。
 */

export interface MarkedBlockMerge {
  content: string;
  /** 需要写盘吗（false = 一个字节都不用写）。 */
  changed: boolean;
}

function markerRegex(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`<!-- ${escaped}:\\d+:begin -->[\\s\\S]*?<!-- ${escaped}:\\d+:end -->`);
}

export function markedBlockStartMarker(prefix: string, version: number): string {
  return `<!-- ${prefix}:${version}:begin -->`;
}

export function markedBlockEndMarker(prefix: string, version: number): string {
  return `<!-- ${prefix}:${version}:end -->`;
}

/**
 * 把区块并入一份已有文本。**幂等**：同样的输入调两次，第二次 `changed === false`。
 *
 * ⚠️ 前缀里的 `:` 是认区块的一部分：`partner-w-memory` 与 `partner-w-memory-contract`
 *    两个前缀**不互相匹配**（正则要求 `:<数字>:begin`），所以同一份 `AGENTS.md` 里
 *    可以同时住着多个不同用途的受管区块。
 */
export function mergeMarkedBlock(existing: string, prefix: string, version: number, block: string): MarkedBlockMerge {
  const wrapped = `${markedBlockStartMarker(prefix, version)}\n${block.trim()}\n${markedBlockEndMarker(prefix, version)}`;
  const text = typeof existing === 'string' ? existing : '';
  const match = markerRegex(prefix).exec(text);
  if (match) {
    if (match[0] === wrapped) return { content: text, changed: false };
    return {
      content: `${text.slice(0, match.index)}${wrapped}${text.slice(match.index + match[0].length)}`,
      changed: true,
    };
  }
  if (text.trim().length === 0) return { content: `${wrapped}\n`, changed: true };
  const separator = text.endsWith('\n') ? '\n' : '\n\n';
  return { content: `${text}${separator}${wrapped}\n`, changed: true };
}

/** 从一份文本里读回受管区块（任意版本）；没有返回 `null`。 */
export function readMarkedBlock(content: string, prefix: string): string | null {
  const match = markerRegex(prefix).exec(typeof content === 'string' ? content : '');
  return match ? match[0] : null;
}

/** 区块里以 `- ` 开头的条目正文（去掉前缀）。 */
export function markedBlockBulletLines(content: string, prefix: string): string[] {
  const block = readMarkedBlock(content, prefix);
  if (!block) return [];
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}
