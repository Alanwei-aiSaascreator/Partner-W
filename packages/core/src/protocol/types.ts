import type { MessageAttachment, ToolCall } from '@clawwork/shared';

export interface ChatMessage {
  role?: string;
  content?: ChatContentBlock[];
  timestamp?: number;
}

export interface ChatEventPayload {
  sessionKey: string;
  runId?: string;
  /**
   * 帧的状态（`ChatEventSchema` 的判别键）。
   *
   * ⚠️ **这不是封闭联合** —— 前四个是我们**处理**的；而运行时
   *    （`~/git/openclaw` 2026-09-09，`packages/gateway-protocol/src/schema/logs-chat.ts`）
   *    的 `ChatEventSchema` 是**五个** schema 的联合，在它们之外还有
   *    `ChatStatusEventSchema`（`state:"status"`）。
   *    照实测样本写成封闭联合，代价我们**已经付过一次**：`AgentLifecycleData.phase`
   *    那样写 ⇒ switch 的穷尽性检查反过来**挡住**了新取值，只能静默走 `default`
   *    （`finishing` 就是这么被吞掉的）。
   * ⇒ `(string & {})` 保住自动补全，同时**不许**这个类型替运行时保证"没有别的了"。
   */
  state?: 'delta' | 'final' | 'aborted' | 'error' | (string & {});
  message?: ChatMessage;
  content?: ChatContentBlock[];
  text?: string;
  /**
   * **增量**正文（协议 v4 的 `ChatDeltaEventSchema.deltaText`）。
   *
   * ⚠️ v4 的 delta 帧**同时**带它和 `message.content`：这里是**增量**，
   *    而 `message.content[0].text` 是**到此刻为止的全文**。取错一个就会把全文
   *    当增量拼起来（实测膨胀 5–57 倍）。见 `extractDeltaText` 的说明。
   */
  deltaText?: string;
  /**
   * `deltaText` 是**全文**而不是增量（网关发现新文本不是旧文本的前缀时会这么标）。
   * 契约是 `ChatDeltaEventSchema.replace`。
   */
  replace?: boolean;
  errorMessage?: string;
  /**
   * 网关给的**结构化**错误类别 —— 协议里有 validator（`ChatEventErrorKindSchema`）。
   *
   * ⚠️ 这才是稳定的那一半：`errorMessage` 是各厂商自己的措辞（改一个字就认不出），
   * 而这里是闭集。用它选文案比按措辞猜可靠。
   */
  errorKind?: 'refusal' | 'timeout' | 'rate_limit' | 'context_length' | 'unknown';
  /** 脱敏后的厂商诊断信息（协议里的 `errorDetail`）。 */
  errorDetail?: Record<string, unknown>;
  /** 结束原因（如 `stop` / `length`）。 */
  stopReason?: string;
  /**
   * ⚠️ 下面两个**当前协议 schema 里没有** —— 它们是我们照着 RPC 那套猜的形状。
   * 实测运行时的 `ChatErrorEventSchema` 只有：`state` / `message` / `errorMessage` /
   * `errorKind` / `errorDetail` / `usage` / `stopReason`（外加 base 的 runId/sessionKey/seq）。
   * 保留读取是为了容错（万一别的版本发），但**别把它们当准**：真实数据走 `errorKind`。
   */
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
  fileName?: string;
  artifactId?: string;
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
  stopReason?: string;
  toolCallId?: string;
  isError?: boolean;
  __openclaw?: { runId?: string };
  content?: RawContentBlock[];
  timestamp?: number;
  /** 实际生成这条回复的模型 id。**只有 assistant 记录带**（实测网关 transcript）。 */
  model?: string;
}

export interface NormalizedAssistantTurn {
  runId?: string;
  content: string;
  thinkingContent?: string;
  toolCalls: ToolCall[];
  attachments?: MessageAttachment[];
  timestamp: string;
  /** 见 `RawHistoryMessage.model`。同一次回复由多条记录拼成时取最后一条带它的。 */
  model?: string;
}

export interface DiscoveredMessageShape {
  runId?: string;
  role: string;
  content: string;
  timestamp: string;
  toolCalls?: ToolCall[];
  attachments?: MessageAttachment[];
  /** 见 `RawHistoryMessage.model`。 */
  model?: string;
}
