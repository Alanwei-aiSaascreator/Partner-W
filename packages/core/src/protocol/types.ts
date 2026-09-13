import type { MessageAttachment, ToolCall } from '@clawwork/shared';

export interface ChatMessage {
  role?: string;
  content?: ChatContentBlock[];
  timestamp?: number;
}

export interface ChatEventPayload {
  sessionKey: string;
  runId?: string;
  state?: 'delta' | 'final' | 'aborted' | 'error';
  message?: ChatMessage;
  content?: ChatContentBlock[];
  text?: string;
  errorMessage?: string;
  errorCode?: string;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export interface RawContentBlock {
  type: string;
  text?: string;
  /** 推理块（`type:'thinking'`）。实测网关 chatHistory 里带这个块，见 normalizeAssistantTurns。 */
  thinking?: string;
  url?: string;
  openUrl?: string;
  alt?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown> | string;
  result?: unknown;
}

export type ChatContentBlock = RawContentBlock & {
  thinking?: string;
};

export interface RawHistoryMessage {
  role: string;
  content?: RawContentBlock[];
  timestamp?: number;
  /** 实际生成这条回复的模型 id。**只有 assistant 记录带**（实测网关 transcript）。 */
  model?: string;
}

export interface NormalizedAssistantTurn {
  content: string;
  thinkingContent?: string;
  toolCalls: ToolCall[];
  attachments?: MessageAttachment[];
  timestamp: string;
  /** 见 `RawHistoryMessage.model`。同一次回复由多条记录拼成时取最后一条带它的。 */
  model?: string;
}

export interface DiscoveredMessageShape {
  role: string;
  content: string;
  timestamp: string;
  toolCalls?: ToolCall[];
  attachments?: MessageAttachment[];
  /** 见 `RawHistoryMessage.model`。 */
  model?: string;
}
