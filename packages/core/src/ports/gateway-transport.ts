import type {
  CommandsListParams,
  GatewayFailureReason,
  IpcResult,
  MessageAttachment,
  RuntimeBootstrapStatus,
} from '@clawwork/shared';

export interface GatewayEvent {
  event: string;
  payload: Record<string, unknown>;
  gatewayId: string;
  seq?: number;
}

export interface GatewayStatusEvent {
  gatewayId: string;
  connected: boolean;
  error?: string;
  serverVersion?: string;
  reconnectAttempt?: number;
  maxAttempts?: number;
  gaveUp?: boolean;
  /**
   * **有结论**时的公开原因（闭集，见 `@clawwork/shared`）。
   *
   * ⚠️ 缺席 = **还没有结论**（普通断线、还在重连），不是"没问题"：
   *    界面按"还没结论"处理，不许替它编一个。
   * ⚠️ 与 `error` 是两件事：那是给人看的原文（进日志），这是给界面选文案的闭集值。
   */
  reason?: GatewayFailureReason | undefined;
}

/**
 * 本机运行时（我们**自己**那个网关）起没起来，以及起不来时的**公开**原因。
 *
 * ⚠️ 与 `GatewayStatusEvent` 是两层事，别混：那是"连上了没有"，这是"我们自己的网关
 *    进程有没有起来"。端口被**别的**程序占着时，往往连 WS 都没建起来 ——
 *    从连接层一个字都读不到，界面只能一直显示"正在准备模型"。
 * ⚠️ 形状由 `@clawwork/shared` 定义（它要跨主进程 / IPC / 渲染层三道边界，
 *    每层各写一遍必然漂移）；这里只是给这个 port 起个短名字。
 */
export type RuntimeStatusEvent = RuntimeBootstrapStatus;

export interface GatewayStatusInfo {
  connected: boolean;
  name: string;
  error?: string;
  serverVersion?: string;
}

export interface GatewayStatusMap {
  [gatewayId: string]: GatewayStatusInfo;
}

export interface GatewayListItem {
  id: string;
  name: string;
  url: string;
  token?: string;
  password?: string;
  pairingCode?: string;
  authMode?: 'token' | 'password' | 'pairingCode';
  isDefault?: boolean;
  color?: string;
  connected: boolean;
}

export interface DiscoveredSession {
  gatewayId: string;
  taskId: string;
  sessionKey: string;
  title: string;
  updatedAt: string;
  agentId: string;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  messages: { role: string; content: string; timestamp: string; attachments?: MessageAttachment[] }[];
}

export interface SyncResult {
  ok: boolean;
  discovered?: DiscoveredSession[];
  error?: string;
}

export interface ChatAttachment {
  mimeType: string;
  fileName: string;
  content: string;
}

export interface GatewayTransportPort {
  getHttpBase?: (gatewayId: string) => string | undefined | Promise<string | undefined>;
  sendMessage: (
    gatewayId: string,
    sessionKey: string,
    content: string,
    attachments?: ChatAttachment[],
  ) => Promise<IpcResult>;
  chatHistory: (gatewayId: string, sessionKey: string, limit?: number) => Promise<IpcResult>;
  abortChat: (gatewayId: string, sessionKey: string) => Promise<IpcResult>;
  patchSession: (gatewayId: string, sessionKey: string, patch: Record<string, unknown>) => Promise<IpcResult>;
  listSessionsBySpawner: (gatewayId: string, spawnedBy: string) => Promise<IpcResult>;
  gatewayStatus: () => Promise<GatewayStatusMap>;
  syncSessions: () => Promise<SyncResult>;
  listGateways: () => Promise<GatewayListItem[]>;
  listModels: (gatewayId: string) => Promise<IpcResult>;
  listCommands: (gatewayId: string, params?: CommandsListParams) => Promise<IpcResult>;
  listAgents: (gatewayId: string) => Promise<IpcResult>;
  getToolsCatalog: (gatewayId: string, agentId?: string) => Promise<IpcResult>;
  getEffectiveTools: (gatewayId: string, sessionKey: string, agentId?: string) => Promise<IpcResult>;
  getSkillsStatus: (gatewayId: string, agentId?: string) => Promise<IpcResult>;
  createSession: (gatewayId: string, params: { key: string; agentId: string; message?: string }) => Promise<IpcResult>;
  deleteSession: (gatewayId: string, sessionKey: string) => Promise<IpcResult>;
  onGatewayEvent: (callback: (data: GatewayEvent) => void) => () => void;
  onGatewayStatus: (callback: (status: GatewayStatusEvent) => void) => () => void;
  /**
   * ⚠️ **可选**：pwa 与出厂形态没有"本机运行时"这件事，它们不该被迫实现这条通道。
   *    缺了它只影响"说不说得清是哪一类失败"，别的一概照旧。
   */
  onRuntimeStatus?: ((callback: (status: RuntimeStatusEvent) => void) => () => void) | undefined;
  /**
   * **初始读**：这条结论往往在窗口挂上来之前就产生了，那次推送没人收
   * （窗口不在时 `sendToWindow` 返回 false）。`null` = 还没有结论，**不是**"没问题"。
   */
  runtimeStatus?: (() => Promise<RuntimeStatusEvent | null>) | undefined;
}
