import type { IpcResult } from '@clawwork/shared';

export interface PersistedTask {
  id: string;
  sessionKey: string;
  sessionId: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  artifactDir: string;
  gatewayId: string;
  /** 任务模式；老数据是 NULL（按 custom 语义处理，见 `@clawwork/shared` 的 task-modes）。 */
  mode?: string | null;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
}

export interface PersistedMessage {
  id: string;
  taskId: string;
  role: string;
  content: string;
  timestamp: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  attachments?: unknown[];
  toolCalls?: unknown[];
  thinkingContent?: string;
  /** 实际生成这条回复的模型 id（逐条来自网关）。老行为 `null`。 */
  model?: string | null;
}

export interface ListResult<T> {
  ok: boolean;
  rows?: T[];
  error?: string;
}

export interface PersistencePort {
  loadTasks: () => Promise<ListResult<PersistedTask>>;
  loadMessages: (taskId: string) => Promise<ListResult<PersistedMessage>>;
  persistTask: (task: {
    id: string;
    sessionKey: string;
    sessionId: string;
    title: string;
    status: string;
    mode?: string;
    model?: string;
    modelProvider?: string;
    thinkingLevel?: string;
    inputTokens?: number;
    outputTokens?: number;
    contextTokens?: number;
    createdAt: string;
    updatedAt: string;
    tags: string[];
    artifactDir: string;
    gatewayId: string;
  }) => Promise<IpcResult>;
  persistTaskUpdate: (params: {
    id: string;
    title?: string;
    status?: string;
    mode?: string;
    model?: string;
    modelProvider?: string;
    thinkingLevel?: string;
    inputTokens?: number;
    outputTokens?: number;
    contextTokens?: number;
    /** 置顶时间（ISO）；`null` = 取消置顶。与 `updatedAt` 无关。 */
    pinnedAt?: string | null;
    /** deck 路由标记（演示文稿 → DeepSeek 的粘性开关）；见 `Task.deckRouted`。 */
    deckRouted?: boolean;
    updatedAt: string;
  }) => Promise<IpcResult>;
  persistMessage: (msg: {
    id: string;
    taskId: string;
    role: string;
    content: string;
    timestamp: string;
    sessionKey?: string;
    agentId?: string;
    runId?: string;
    attachments?: unknown[];
    toolCalls?: unknown[];
    thinkingContent?: string;
    model?: string;
  }) => Promise<IpcResult>;
  deleteTask: (taskId: string) => Promise<IpcResult>;
}
