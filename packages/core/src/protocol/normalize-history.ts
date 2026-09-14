import type { Message, MessageAttachment, ToolCall } from '@clawwork/shared';
import type { RawContentBlock, RawHistoryMessage, NormalizedAssistantTurn, DiscoveredMessageShape } from './types.js';
import { safeJsonParse } from './parse-content.js';

const GATEWAY_INJECTED_MODEL = 'gateway-injected';

export const INTERNAL_ASSISTANT_MARKERS = new Set(['NO_REPLY']);

export function sanitizeModel(model?: string): string | undefined {
  return model === GATEWAY_INJECTED_MODEL ? undefined : model;
}

export function isVisibleAssistantContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.length > 0 && !INTERNAL_ASSISTANT_MARKERS.has(trimmed);
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)(?:[?#].*)?$/i;
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp|avif);base64,/i;
const GATEWAY_MEDIA_PATH_RE = /^\/(?:api\/chat\/media\/outgoing\/|media\/|__openclaw__\/media\/)/;

function cleanMediaCandidate(raw: string): string {
  const trimmed = raw.trim();
  const wrapped = trimmed.match(/^`([^`]+)`$/) ?? trimmed.match(/^"([^"]+)"$/) ?? trimmed.match(/^'([^']+)'$/);
  return (wrapped?.[1] ?? trimmed).replace(/[`"'\\})\],]+$/, '').trim();
}

function hasUnsafePathSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === '..');
}

function encodeFilePath(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

function filePathFromMediaCandidate(candidate: string): string | null {
  if (!candidate.startsWith('file://')) return candidate;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

function fileNameFromSource(source: string, fallback: string): string {
  const withoutQuery = source.split(/[?#]/)[0] ?? source;
  const normalized = withoutQuery.replaceAll('\\', '/');
  const candidate = normalized.split('/').filter(Boolean).at(-1);
  if (!candidate) return fallback;
  try {
    return decodeURIComponent(candidate);
  } catch {
    return candidate;
  }
}

function normalizeRemoteHostname(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (normalized.split('.').some((label) => label.length === 0)) return '';
  return normalized;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isBlockedRemoteHostname(hostname: string): boolean {
  const normalized = normalizeRemoteHostname(hostname);
  if (!normalized || !normalized.includes('.')) return true;
  if (
    normalized === 'localhost' ||
    normalized === 'localhost.localdomain' ||
    normalized === 'metadata.google.internal' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  ) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) return isPrivateIpv4(normalized);
  if (normalized.includes(':')) return true;
  return false;
}

function isAllowedRemoteMediaUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return (
      parsed.protocol === 'https:' && !parsed.username && !parsed.password && !isBlockedRemoteHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function resolveGatewayMediaSource(candidate: string, httpBase?: string): string | null {
  try {
    const parsed = new URL(candidate);
    const base = httpBase ? new URL(httpBase) : null;
    if (base && parsed.origin === base.origin && GATEWAY_MEDIA_PATH_RE.test(parsed.pathname)) return parsed.toString();
    return null;
  } catch {
    if (!candidate.startsWith('/') || !GATEWAY_MEDIA_PATH_RE.test(candidate)) return null;
    if (!httpBase) return null;
    return new URL(candidate, httpBase).toString();
  }
}

function mimeTypeFromSource(source: string, fallback?: string): string | undefined {
  if (fallback?.startsWith('image/')) return fallback;
  const lower = source.split(/[?#]/)[0]?.toLowerCase() ?? '';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.avif')) return 'image/avif';
  const dataMatch = source.match(/^data:(image\/[^;]+);/i);
  return dataMatch?.[1] ?? fallback;
}

function attachmentFromMediaSource(
  source: string,
  alt?: string,
  mimeType?: string,
  httpBase?: string,
): MessageAttachment | null {
  const candidate = cleanMediaCandidate(source);
  if (!candidate || candidate.length > 4096 || hasUnsafePathSegment(candidate) || candidate.startsWith('~'))
    return null;

  if (DATA_IMAGE_RE.test(candidate)) {
    return {
      fileName: alt?.trim() || 'image.png',
      dataUrl: candidate,
      mimeType: mimeTypeFromSource(candidate, mimeType),
    };
  }

  const gatewayMedia = resolveGatewayMediaSource(candidate, httpBase);
  if (gatewayMedia && (IMAGE_EXT_RE.test(gatewayMedia) || mimeType?.startsWith('image/'))) {
    return {
      fileName: alt?.trim() || fileNameFromSource(gatewayMedia, 'image.png'),
      dataUrl: gatewayMedia,
      mimeType: mimeTypeFromSource(gatewayMedia, mimeType),
    };
  }
  if (candidate.startsWith('/') && GATEWAY_MEDIA_PATH_RE.test(candidate)) return null;

  if (isAllowedRemoteMediaUrl(candidate) && (IMAGE_EXT_RE.test(candidate) || mimeType?.startsWith('image/'))) {
    return {
      fileName: alt?.trim() || fileNameFromSource(candidate, 'image.png'),
      dataUrl: candidate,
      mimeType: mimeTypeFromSource(candidate, mimeType),
    };
  }

  const filePath = filePathFromMediaCandidate(candidate);
  if (!filePath) return null;
  if (filePath.startsWith('/') && IMAGE_EXT_RE.test(filePath)) {
    return {
      fileName: alt?.trim() || fileNameFromSource(filePath, 'image.png'),
      dataUrl: encodeFilePath(filePath),
      mimeType: mimeTypeFromSource(filePath, mimeType),
      sourcePath: filePath,
    };
  }

  return null;
}

function splitTextMediaDirectives(text: string, httpBase?: string): { text: string; attachments: MessageAttachment[] } {
  const attachments: MessageAttachment[] = [];
  const kept: string[] = [];
  let inFence = false;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }

    if (!inFence && trimmed.toUpperCase().startsWith('MEDIA:')) {
      const media = attachmentFromMediaSource(trimmed.slice('MEDIA:'.length), undefined, undefined, httpBase);
      if (media) {
        attachments.push(media);
        continue;
      }
    }

    kept.push(line);
  }

  if (attachments.length > 0) {
    while (kept[0]?.trim() === '') kept.shift();
    while (kept.at(-1)?.trim() === '') kept.pop();
  }

  return { text: kept.join('\n'), attachments };
}

export function mergeMessageAttachments(
  base: MessageAttachment[] | undefined,
  incoming: MessageAttachment[] | undefined,
): MessageAttachment[] | undefined {
  const merged = [...(base ?? [])];
  const seen = new Set(merged.map((attachment) => attachment.dataUrl));
  for (const attachment of incoming ?? []) {
    if (seen.has(attachment.dataUrl)) continue;
    seen.add(attachment.dataUrl);
    merged.push(attachment);
  }
  return merged.length ? merged : undefined;
}

export function normalizeContentBlocks(
  blocks: RawContentBlock[],
  httpBase?: string,
): {
  content: string;
  attachments?: MessageAttachment[];
} {
  let content = '';
  let attachments: MessageAttachment[] | undefined;

  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      const parsed = splitTextMediaDirectives(block.text, httpBase);
      content += parsed.text;
      attachments = mergeMessageAttachments(attachments, parsed.attachments);
      continue;
    }

    if (block.type === 'image') {
      const rawSource = block.url ?? block.openUrl;
      if (rawSource) {
        const attachment = attachmentFromMediaSource(rawSource, block.alt, block.mimeType, httpBase);
        attachments = mergeMessageAttachments(attachments, attachment ? [attachment] : undefined);
      }
    }
  }

  return { content, attachments };
}

function toISOTimestamp(epoch: number | undefined): string {
  return epoch ? new Date(epoch).toISOString() : new Date().toISOString();
}

function appendSegment(base: string, segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return base;
  if (!base) return trimmed;
  return `${base}\n\n${trimmed}`;
}

function normalizeSignatureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSignatureValue);
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeSignatureValue(entry)]),
  );
}

function rawHistoryMessageKey(msg: RawHistoryMessage): string {
  return JSON.stringify({
    role: msg.role,
    timestamp: msg.timestamp ?? null,
    content: normalizeSignatureValue(msg.content ?? []),
  });
}

function deduplicateRawHistoryMessages(rawMsgs: RawHistoryMessage[]): RawHistoryMessage[] {
  const seen = new Set<string>();
  const deduped: RawHistoryMessage[] = [];

  for (const msg of rawMsgs) {
    const key = rawHistoryMessageKey(msg);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(msg);
  }

  return deduped;
}

/**
 * 从历史消息里取推理文本（`{type:'thinking', thinking}` 块）。
 *
 * ⚠️ 形状是**实测**的（2026-09-12 打网关 `chatHistory`）：assistant 消息确实带这个块。
 * 实时那条链走 agent 通道（见 `gateway-dispatcher` 的 `case 'thinking'`），落库是主路径；
 * 这里是**换设备 / 清库后重建**推理的唯一来源。
 * 与 `extractThinking`（chat 通道）保持一致：块之间直接相连，不加分隔符。
 */
function extractBlockThinking(blocks: RawContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim())
    .map((block) => block.thinking as string)
    .join('');
}

/** 行内思考分隔符。网关的 `text` 块里可能出现它。 */
const INLINE_THINK_CLOSE_RE = /<\/think>/i;

/**
 * 有些模型的推理是**混在正文里**的，不是单独的 `thinking` 块。
 *
 * 2026-09-14 线上实测（qwen3.5-27b）—— 同一轮对话里各模型的形状**不一样**：
 *
 * ```
 * deepseek-v4-flash / glm-4.7 / kimi-*  →  content: [ {thinking}, {text} ]   ← 规范形状
 * qwen3.5-27b                           →  content: [ {text: "<推理></think>\n<答案>"} ]
 * ```
 *
 * 第二类**没有开标签**（`<think>` 位置 = -1），只有 `</think>`，且**没有单独的
 * thinking 块**。不切开的话，用户看到的正文就是一大段推理 —— 这正是
 * 「切换模型后思考内容全显示正文」那个现象（见 [[model-subsystem-issues]]）。
 *
 * ⚠️ 优先级：**有结构化 thinking 块时绝不动 text**。那条路径本来就是对的，
 *    再切一次只会把正常回复切坏。
 * ⚠️ 切完左边为空（回复以 `</think>` 开头）时，**保留右侧**，不要造出一个
 *    空思考块。右边为空时也保留左侧 —— 推理也是内容，总比整条消失强。
 */
export function splitInlineThinking(text: string, blockThinking = ''): { text: string; thinkingText: string } {
  if (blockThinking) return { text, thinkingText: blockThinking };

  const m = INLINE_THINK_CLOSE_RE.exec(text);
  if (!m || m.index === undefined) return { text, thinkingText: '' };

  const head = text.slice(0, m.index).trim();
  const tail = text.slice(m.index + m[0].length).trim();
  if (!head) return { text, thinkingText: '' }; // 没有可分离的推理 ⇒ 原样
  return { text: tail, thinkingText: head };
}

function shouldStartVisibleAssistantTurn(
  turn: NormalizedAssistantTurn | null,
  timestamp: string,
  canMergeToolFinal: boolean,
): boolean {
  return Boolean((turn?.content || turn?.attachments?.length) && turn.timestamp !== timestamp && !canMergeToolFinal);
}

export function normalizeAssistantTurns(rawMsgs: RawHistoryMessage[], httpBase?: string): NormalizedAssistantTurn[] {
  const messages = deduplicateRawHistoryMessages(rawMsgs);
  const toolResultMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'toolResult') continue;
    for (const block of msg.content ?? []) {
      if (block.type === 'toolResult' && block.id && block.result !== undefined) {
        toolResultMap.set(block.id, typeof block.result === 'string' ? block.result : JSON.stringify(block.result));
      }
    }
  }

  const turns: NormalizedAssistantTurn[] = [];
  let current: NormalizedAssistantTurn | null = null;
  let canMergeToolFinal = false;

  // 消息级 model：同一次回复可能由多条 assistant 记录拼成（toolCall / 推理 / 最终正文），
  // 它们各自带 model —— 取**最后一条带它的**（= 产出最终正文的那次调用）。
  // ⚠️ 缺 model 的记录**不清空**已记下的值：老网关/老记录可能没有这个字段。
  function startCurrent(timestamp: string, model?: string): NormalizedAssistantTurn {
    current = { content: '', toolCalls: [], timestamp, ...(model ? { model } : {}) };
    turns.push(current);
    return current;
  }

  function ensureCurrent(timestamp: string, model?: string): NormalizedAssistantTurn {
    if (!current) return startCurrent(timestamp, model);
    if (model) current.model = model;
    return current;
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      current = null;
      canMergeToolFinal = false;
      continue;
    }
    if (msg.role !== 'assistant') continue;

    const timestamp = toISOTimestamp(msg.timestamp);
    const normalizedContent = normalizeContentBlocks(msg.content ?? [], httpBase);
    const { text, thinkingText } = splitInlineThinking(
      normalizedContent.content,
      extractBlockThinking(msg.content ?? []),
    );
    const toolCalls = (msg.content ?? [])
      .filter((block: RawContentBlock) => block.type === 'toolCall' && block.id && block.name)
      .map(
        (block: RawContentBlock): ToolCall => ({
          id: block.id!,
          name: block.name!,
          status: toolResultMap.has(block.id!) ? 'done' : 'running',
          args:
            typeof block.arguments === 'object' && block.arguments !== null
              ? (block.arguments as Record<string, unknown>)
              : typeof block.arguments === 'string'
                ? safeJsonParse(block.arguments)
                : undefined,
          result: toolResultMap.get(block.id!),
          startedAt: timestamp,
          completedAt: toolResultMap.has(block.id!) ? timestamp : undefined,
        }),
      );

    // ⚠️ 只有推理、没有正文的**不能丢**：生产实测过 `content` 为空、整条回复都在
    // `reasoning_content` 里的调用 —— 丢了就是「界面上一个字都没有，而账照扣」。
    if (!text.trim() && !thinkingText && toolCalls.length === 0 && !normalizedContent.attachments?.length) continue;

    const model = sanitizeModel(msg.model);

    // 推理挂在当前 turn 上，不新起 turn —— 它属于同一次回复。
    if (thinkingText) {
      const turn = ensureCurrent(timestamp, model);
      turn.thinkingContent = (turn.thinkingContent ?? '') + thinkingText;
    }

    const visibleText = isVisibleAssistantContent(text) ? text.trim() : '';

    if (toolCalls.length > 0) {
      const turn = ensureCurrent(timestamp, model);
      const existingIds = new Set(turn.toolCalls.map((toolCall) => toolCall.id));
      turn.toolCalls.push(...toolCalls.filter((toolCall) => !existingIds.has(toolCall.id)));
      if (visibleText) {
        turn.content = appendSegment(turn.content, visibleText);
      }
      turn.attachments = mergeMessageAttachments(turn.attachments, normalizedContent.attachments);
      turn.timestamp = timestamp;
      canMergeToolFinal = true;
      continue;
    }

    if (!visibleText && normalizedContent.attachments?.length) {
      const turn = ensureCurrent(timestamp, model);
      turn.attachments = mergeMessageAttachments(turn.attachments, normalizedContent.attachments);
      turn.timestamp = timestamp;
      canMergeToolFinal = false;
      continue;
    }

    if (!visibleText) continue;

    if (shouldStartVisibleAssistantTurn(current, timestamp, canMergeToolFinal)) {
      startCurrent(timestamp, model);
    }

    const turn = ensureCurrent(timestamp, model);
    turn.content = appendSegment(turn.content, visibleText);
    turn.attachments = mergeMessageAttachments(turn.attachments, normalizedContent.attachments);
    turn.timestamp = timestamp;
    canMergeToolFinal = false;
  }

  return turns.filter(
    (turn) => turn.content || turn.thinkingContent || turn.toolCalls.length > 0 || (turn.attachments?.length ?? 0) > 0,
  );
}

export function collapseDiscoveredMessages(messages: DiscoveredMessageShape[], taskId: string): Message[] {
  const collapsed: Message[] = [];
  let currentAssistant: Message | null = null;

  function flushAssistant(): void {
    if (!currentAssistant) return;
    if (
      currentAssistant.content ||
      currentAssistant.toolCalls.length > 0 ||
      (currentAssistant.attachments?.length ?? 0) > 0
    ) {
      collapsed.push(currentAssistant);
    }
    currentAssistant = null;
  }

  for (const message of messages) {
    if (message.role === 'user') {
      flushAssistant();
      collapsed.push({
        id: crypto.randomUUID(),
        taskId,
        role: 'user',
        content: message.content,
        artifacts: [],
        toolCalls: [],
        timestamp: message.timestamp,
      });
      continue;
    }

    if (message.role !== 'assistant') continue;

    const visibleText = isVisibleAssistantContent(message.content) ? message.content.trim() : '';
    const toolCalls = message.toolCalls ?? [];
    if (!visibleText && toolCalls.length === 0 && !message.attachments?.length) continue;

    // 同 normalizeAssistantTurns：取最后一条带 model 的，缺的不清空。
    const model = sanitizeModel(message.model);

    if (!currentAssistant) {
      currentAssistant = {
        id: crypto.randomUUID(),
        taskId,
        role: 'assistant',
        content: '',
        artifacts: [],
        toolCalls: [],
        timestamp: message.timestamp,
        ...(model ? { model } : {}),
      };
    } else if (model) {
      currentAssistant.model = model;
    }

    if (visibleText) {
      currentAssistant.content = appendSegment(currentAssistant.content, visibleText);
    }
    currentAssistant.attachments = mergeMessageAttachments(currentAssistant.attachments, message.attachments);
    if (toolCalls.length > 0) {
      const existingIds = new Set(currentAssistant.toolCalls.map((toolCall) => toolCall.id));
      currentAssistant.toolCalls.push(...toolCalls.filter((toolCall) => !existingIds.has(toolCall.id)));
    }
    currentAssistant.timestamp = message.timestamp;
  }

  flushAssistant();
  return collapsed;
}
