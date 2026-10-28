import type {
  CommandsListParams,
  GatewayFailureReason,
  IpcResult,
  MessageAttachment,
  RuntimeBootstrapStatus,
  RuntimeDeployProgress,
} from '@clawwork/shared';

/**
 * V2（2026-10-13 集中整改 step 2）：**可信 transport 元数据**（可选）。
 *
 * 由**真实连接拥有者**（main 进程 ws 客户端）生成 —— renderer 不能猜：
 * - `channel`：主连接 / 审批连接 / 本地；
 * - `connectionEpoch`：连接实例标识，重连后外层 seq 重置仍可区分域。
 * 05 F2：外层 seq 按连接域计数，主/审批连接是不同域、重连不沿用旧域 ——
 * 缺元数据的既有生产者照常工作，来源按 `unknown` 处理。
 */
export interface GatewayEventTransportMeta {
  channel?: 'main' | 'approval' | 'local';
  connectionEpoch?: string;
}

export interface GatewayEvent {
  event: string;
  payload: Record<string, unknown>;
  gatewayId: string;
  seq?: number;
  meta?: GatewayEventTransportMeta;
}

export interface GatewayStatusEvent {
  gatewayId: string;
  connected: boolean;
  error?: string;
  serverVersion?: string;
  /**
   * 网关**协商下来**的单帧字节上限（`hello-ok.policy.maxPayload`）。
   *
   * ⚠️ 缺席 = 没谈到（旧网关 / 没连上）⇒ 发送侧预算回落默认值，**不是** 0 或无限。
   * 用途唯一：渲染层发送字节预算的推导（`ChatInput/constants.ts` 的
   * `deriveMaterialByteBudget`）；不是给界面直接显示的数字。
   */
  maxPayloadBytes?: number;
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
  /** 见 `GatewayStatusEvent.maxPayloadBytes`（初始读与事件同源）。 */
  maxPayloadBytes?: number;
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
  messages: { role: string; content: string; timestamp: string; runId?: string; attachments?: MessageAttachment[] }[];
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
    dispatchContext?: { userContent: string },
  ) => Promise<IpcResult>;
  chatHistory: (gatewayId: string, sessionKey: string, limit?: number) => Promise<IpcResult>;
  abortChat: (gatewayId: string, sessionKey: string) => Promise<IpcResult>;
  patchSession: (gatewayId: string, sessionKey: string, patch: Record<string, unknown>) => Promise<IpcResult>;
  listSessionsBySpawner: (gatewayId: string, spawnedBy: string) => Promise<IpcResult>;
  gatewayStatus: () => Promise<GatewayStatusMap>;
  syncSessions: () => Promise<SyncResult>;
  listGateways: () => Promise<GatewayListItem[]>;
  listModels: (gatewayId: string, agentId?: string) => Promise<IpcResult>;
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
  /**
   * ⚠️ **可选**（与 `onRuntimeStatus` 同一个理由：pwa / 出厂形态没有"本机部署"这件事）。
   *    部署进度事件：`null` = 这一轮部署结束了（成功/失败都算）。
   *    缺了它只影响"准备页看不看得见进度"，别的一概照旧。
   */
  onRuntimeDeployProgress?: ((callback: (progress: RuntimeDeployProgress | null) => void) => () => void) | undefined;
}
