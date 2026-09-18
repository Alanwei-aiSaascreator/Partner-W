import type { ToolCall } from '@clawwork/shared';
import type { ChatEventPayload, ChatContentBlock } from './types.js';

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

export function safeJsonParse(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
