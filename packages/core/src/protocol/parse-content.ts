import type { ToolCall } from '@clawwork/shared';
import type { ChatEventPayload, ChatContentBlock } from './types.js';

/**
 * `chat` 的 delta 帧里**该追加什么、还是该替换**。
 *
 * ## 为什么必须有这个函数（真 bug，2026-09-19 定位）
 *
 * 原来对 delta 一律 `appendStreamDelta(extractText(payload))`，而 `extractText` 取的是
 * `message.content[0].text` —— 那是**到此刻为止的全文**，不是增量。两条独立证据：
 *
 * 1. **白皮书 §4.2**（2026.4.2 时代，也就是这套代码当初照着写的契约）明写：
 *    「delta: `message.content[0].text` contains the **full accumulated text** up to this
 *    point (not just the delta)」。
 * 2. **真实日志**（09-14，`renderer.chat.delta.applied`）：一轮 118 帧的 Σ字符数 **84,927**，
 *    而那一轮的 `final` 只有 **1,486** —— **57 倍**。5–57 倍的膨胀只可能是"把全文当增量拼"。
 *
 * ⇒ 症状是**流式期间正文重复膨胀**，到 `final`（正文以网关历史为准）才纠正回来；
 *    中途看到的字是错的。帧少的时候看不出来（多轮实测每轮只有 1 帧）。
 *
 * ## 三种形状，每种一个理由（不能一律 append 或一律 replace）
 *
 * | 帧 | 正文在哪 | 语义 | 做什么 |
 * | --- | --- | --- | --- |
 * | v4 delta | `deltaText` | **增量**（网关用 `text.slice(previous.length)` 切出来的） | 追加 |
 * | v4 delta + `replace: true` | `deltaText` | **全文**（网关发现新文本不是旧文本的前缀，重发一份） | 替换 |
 * | 旧形状 delta / final | `message.content` | **全文** | 替换 |
 *
 * ⚠️ **v4 帧两者都有**（`deltaText` 是增量、`message.content[0].text` 是全文）
 *    ⇒ 必须优先取 `deltaText`，取错一个就是那个 57 倍。
 * ⚠️ 空的 `deltaText` **不做替换**：`replace` 却带空文本会把已生成的正文**清空**，
 *    用户眼看着内容消失。
 */
export function extractDeltaText(payload: ChatEventPayload): { text: string; replace: boolean } {
  const deltaText = payload.deltaText;
  if (typeof deltaText === 'string' && deltaText.length > 0) {
    return { text: deltaText, replace: payload.replace === true };
  }
  // 旧形状：`message.content` / 顶层 `content` 是**全文快照** ⇒ 替换，不是追加。
  const full = extractText(payload);
  return { text: full, replace: full.length > 0 };
}

export function extractText(payload: ChatEventPayload): string {
  const blocks = payload.message?.content ?? payload.content;
  if (blocks) {
    return blocks
      .filter((b: ChatContentBlock) => b.type === 'text' && b.text)
      .map((b: ChatContentBlock) => b.text!)
      .join('');
  }
  return payload.text ?? '';
}

export function extractThinking(payload: ChatEventPayload): string {
  const blocks = payload.message?.content ?? payload.content;
  if (!blocks) return '';
  return blocks
    .filter((b: ChatContentBlock) => b.type === 'thinking' && b.thinking)
    .map((b: ChatContentBlock) => b.thinking!)
    .join('');
}

export function extractToolCalls(payload: ChatEventPayload): ToolCall[] {
  const blocks = payload.message?.content ?? payload.content;
  if (!blocks) return [];
  const result: ToolCall[] = [];
  for (const b of blocks) {
    if (b.type === 'toolCall' && b.id && b.name) {
      result.push({
        id: b.id,
        name: b.name,
        status: 'running',
        args: parseToolArgs(b.arguments),
        startedAt: new Date().toISOString(),
      });
    }
  }
  return result;
}

/**
 * 工具参数归一。
 *
 * ⚠️ **必须同时吃对象和字符串**：网关两条路径给的形状不一样 ——
 * `chat.history` 里的 `arguments` 是**对象**，而实时 `agent`/`tool` 事件里的 `args`
 * 实测**也是对象**（2026-09-18 真机帧：`{"name":"memory_search","args":{"query":"…"}}`）。
 * 早先这里只声明 `string`、只做 `JSON.parse` —— 传对象进去 `JSON.parse` 抛错落进 catch，
 * 于是参数被裹成 `{raw:{…}}` 显示在卡片里（形如 `{"raw":{"query":"游戏 爆款"}}`）。
 * 类型写成 `string` 是**谎**，它让调用点传对象时 tsc 不吭声。
 */
export function parseToolArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'object') {
    // 数组不是合法的参数对象；宁可当没有，也不要显示成 {"0":…}
    return Array.isArray(raw) ? undefined : (raw as Record<string, unknown>);
  }
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { raw };
  } catch {
    return { raw };
  }
}

/**
 * 从工具结果里取出**给人看的文本**。
 *
 * 实时事件里真正的输出在 `data.result.content[].text`（2026-09-18 真机帧），
 * 而 `data.meta` 只是网关自己拼的**一行摘要**（工具名 + 参数摘要）。
 * 从前我们只存 `meta` ⇒ 用户点开工具卡看不到工具到底返回了什么。
 * `chat.history` 那边存的是字符串结果，两种形状都要吃得下。
 */
export function extractToolResultText(result: unknown): string | undefined {
  if (typeof result === 'string') return result || undefined;
  if (!result || typeof result !== 'object') return undefined;

  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type?: unknown; text?: unknown } => Boolean(b) && typeof b === 'object')
      .filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text)
      .map((b) => b.text as string)
      .join('\n');
    if (text) return text;
  }

  // 认不出的形状：不要静默丢，序列化出来至少能看
  try {
    const json = JSON.stringify(result);
    return json && json !== '{}' ? json : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 这个工具结果是不是**「命令还没跑，正等着人批准」**？
 *
 * ## 为什么必须单独判
 *
 * 运行时的 `ExecToolDetails.status` 是个闭集，其中 **`approval-pending`**
 *（`src/agents/bash-tools.exec-types.ts`）表示 exec 已挂起、等人批准。
 * 而工具流那一帧带的是 **`isError: false`**，两道都放行：
 *
 * 1. `isToolResultError` 的失败清单（`src/agents/tool-result-error.ts`）里
 *    **没有** `approval-pending`；
 * 2. 它的兜底是 `exitCode !== 0`，而 `approval-pending` 那个分支**根本没有
 *    `exitCode` 字段** ⇒ `typeof undefined !== 'number'` ⇒ `return false`。
 *
 * ⇒ 照 `isError` 落地，**一条一步都没跑的命令会显示成「已完成」**。
 *
 * ## 为什么只认这一个值
 *
 * 同族的 `approval-unavailable`（没有审批通道）**在**失败清单里，但它被
 * `approvalUnavailable` 压掉 ⇒ 那一帧**同样**是 `isError: false`。
 * **那条路不归这里管**：它由 `approval` 流兜住，且有回归用例钉着
 *（连"只看 tool 流会给 done"这个前置都显式断言了）。把它一起收进来是对既有
 * 行为的改动，属另一个决定 —— 所以这里**刻意收窄**。
 *
 * ⚠️ 形状认不出时一律 `false`：说错了会把**真结果**压成"还在跑"（卡片永远转圈），
 *    那个方向的错更贵。
 */
export function isAwaitingApproval(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return false;
  return (details as { status?: unknown }).status === 'approval-pending';
}

export function safeJsonParse(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
