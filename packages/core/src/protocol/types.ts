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
}

export interface NormalizedAssistantTurn {
  content: string;
  thinkingContent?: string;
  toolCalls: ToolCall[];
  attachments?: MessageAttachment[];
  timestamp: string;
}

export interface DiscoveredMessageShape {
  role: string;
  content: string;
  timestamp: string;
  toolCalls?: ToolCall[];
  attachments?: MessageAttachment[];
}
