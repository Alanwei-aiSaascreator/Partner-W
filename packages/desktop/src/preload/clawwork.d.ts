import type {
  AgentFileSet,
  ApprovalDecision,
  Artifact,
  ArtifactDeliveryFailure,
  ArtifactDeliverySettled,
  ArtifactDeliveryActivity,
  ArtifactDeliveryActivitySnapshot,
  ArtifactWorkspaceScope,
  ArtifactFileReadResult,
  ArtifactPreview,
  ArtifactSaveAsResult,
  ChatAttachment as SharedChatAttachment,
  ClawDashboardData,
  CommandsListParams,
  CommercialAccountOverview,
  ConfigPatchParams,
  ConfigPatchResult,
  ConfigSchemaLookupResult,
  ConfigSchemaResult,
  ConfigSetParams,
  ConfigSetResult,
  ConfigSnapshot,
  CreateTeamMeetingInput,
  CreateTeamMeetingResult,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronListParams,
  CronListResult,
  CronRunResult,
  CronRunsParams,
  CronStatusResult,
  DocgenFailure,
  FileIndexEntry,
  FileReadResult,
  GatewayFailureReason,
  HtmlgenFailure,
  ImportFilesResult,
  ImportedTaskFile,
  IpcResult as SharedIpcResult,
  JoinTeamResult,
  LikeToggleResult,
  OurSkillsListResult,
  ParsedTeam,
  QuestionResolveParams,
  RelayBootstrapPublicState,
  RuntimeBootstrapStatus,
  SaveTeamMeetingInput,
  SessionsPreviewResult,
  SkillBinsResult,
  SkillDetailResult,
  SkillInstallParams,
  SkillInstallResult,
  SkillSearchParams,
  SkillSearchResult,
  SkillUpdateParams,
  SkillUpdateResult,
  SlidegenFailure,
  SlidegenWarning,
  TaskContextSource,
  Team,
  TeamHubRegistry,
  TeamPosition,
  TeamMeetingRecord,
  WorkspaceFsIdentity,
} from '@clawwork/shared';
// 隐私工单状态的**归一化后**形状（snake→camel、字节数字、真布尔）由 core 定义，
// 这里只引用 —— 渲染层不该再抄一份字段名。
import type { PrivacyState } from '@clawwork/core';

type IpcResult<T = Record<string, unknown>> = SharedIpcResult<T>;

interface ConnectionStatus {
  connected: boolean;
  error?: string;
}

interface GatewayEvent {
  event: string;
  payload: Record<string, unknown>;
  gatewayId: string;
  seq?: number;
}

interface GatewayStatusEvent {
  gatewayId: string;
  connected: boolean;
  error?: string;
  serverVersion?: string;
  reconnectAttempt?: number;
  maxAttempts?: number;
  gaveUp?: boolean;
  /** 有结论时的公开原因（闭集）；缺席 = **还没有结论**，不是"没问题"。 */
  reason?: GatewayFailureReason;
}

/**
 * 本机运行时（我们**自己**那个网关）起没起来，以及起不来时的**公开**原因。
 *
 * ⚠️ 与 `GatewayStatusEvent` 是两层事：那是"连上了没有"，这是"我们自己的网关进程
 *    有没有起来"。端口被**别的**程序占着时往往连 WS 都没建起来，从连接层读不到。
 * ⚠️ `reason` 是**闭集**：原始错误、Token、地址、堆栈一律**不进**这条通道。
 */
type RuntimeStatusEvent = RuntimeBootstrapStatus;

interface DebugEvent {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  domain: string;
  event: string;
  traceId?: string;
  feature?: string;
  message?: string;
  gatewayId?: string;
  sessionKey?: string;
  taskId?: string;
  requestId?: string;
  durationMs?: number;
  error?: { message: string; code?: string; stack?: string };
  data?: Record<string, unknown>;
}

export interface GatewayServerConfig {
  id: string;
  name: string;
  url: string;
  token?: string;
  password?: string;
  pairingCode?: string;
  authMode?: 'token' | 'password' | 'pairingCode';
  tlsVerify?: boolean;
  isDefault?: boolean;
  color?: string;
}

interface GatewayStatusMap {
  [gatewayId: string]: { connected: boolean; name: string; error?: string; serverVersion?: string };
}

interface GatewayListItem extends GatewayServerConfig {
  connected: boolean;
}

interface QuickLaunchSettings {
  enabled: boolean;
  shortcut: string;
}

interface CommercialProfile {
  userId: string;
  email: string | null;
  phone: string | null;
  nickname: string | null;
  avatar: string | null;
}

interface CommercialOrg {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: string;
}

interface CommercialSessionState {
  signedIn: boolean;
  profile: CommercialProfile | null;
  orgs: CommercialOrg[];
}

interface CommercialLicenseStatus {
  configured: boolean;
  licenseId: string | null;
  orgId: string | null;
  licenseKey: string | null;
  sku: string | null;
  status: string | null;
  expiresAt: string | null;
  maxActivations: number;
  tokenQuotaMicros: number;
  tokenUsedMicros: number;
  activated: boolean;
  deviceFingerprint: string;
}

interface QuickLaunchConfigResult {
  enabled: boolean;
  shortcut: string;
  sendShortcut: string;
}

interface NotificationSettings {
  taskComplete?: boolean;
  approvalRequest?: boolean;
  gatewayDisconnect?: boolean;
}

interface AppSettings {
  workspacePath: string;
  theme?: 'dark' | 'light' | 'auto';
  density?: 'compact' | 'comfortable' | 'spacious';
  language?: string;
  gateways: GatewayServerConfig[];
  defaultGatewayId?: string;
  sendShortcut?: 'enter' | 'cmdEnter';
  gatewayUrl?: string;
  bootstrapToken?: string;
  password?: string;
  tlsFingerprint?: string;
  voiceInput?: {
    introSeen?: boolean;
  };
  quickLaunch?: QuickLaunchSettings;
  trayEnabled?: boolean;
  notifications?: NotificationSettings;
  leftNavShortcut?: 'Comma' | 'BracketLeft';
  rightPanelShortcut?: 'Period' | 'BracketRight';
  devMode?: boolean;
  teamHubRegistries?: Array<{ id: string; url: string; isOfficial: boolean }>;
  updateChannel?: 'stable' | 'beta';
  /**
   * 联网搜索开关。
   *
   * ⚠️ 缺省 = **开**（与主进程的 `webSearchEnabled` 一致）：老盘升级上来没有这个字段，
   *    按关处理等于"升一次级静默拿走一个功能"。
   */
  webSearch?: boolean;
  /**
   * 「电脑操控权限」两档：`'safe'`（缺省）/ `'full'`。
   *
   * ⚠️ **缺省 = 安全档**（与主进程 `AppConfig` 一致，方向与 `webSearch` **相反**）：
   *    这个字段缺了必须是"更窄"的那一档，不能是"更宽"的。
   */
  computerAccess?: 'safe' | 'full';
  /** 随包技能的内容指纹记账（见主进程 `AppConfig.bundledSkillRecords`）。 */
  bundledSkillRecords?: Record<string, Record<string, string>>;
}

export type VoicePermissionStatus = 'granted' | 'not-determined' | 'denied' | 'unsupported';

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | PortableUpdatePhase;

interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string | null;
  /** 主进程此刻的更新状态：自动下载可能已经跑完，界面要照实显示。 */
  state: UpdateState;
  /** 盘上运行（U 盘形态）：不自动下载也不安装，界面提示"换包"。 */
  portable: boolean;
}

interface UpdateDownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

interface UpdateDownloadedInfo {
  version: string;
}

interface UpdateError {
  message: string;
  code: 'dev-not-supported' | 'network' | 'no-release-metadata' | 'signature' | 'unknown';
}

interface SearchResult {
  type: 'task' | 'message' | 'artifact';
  id: string;
  title: string;
  snippet: string;
  taskId?: string;
}

interface SearchResponse {
  ok: boolean;
  results?: SearchResult[];
  error?: string;
}

interface PersistedTask {
  id: string;
  sessionKey: string;
  sessionId: string;
  title: string;
  status: string;
  ensemble?: boolean;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  artifactDir: string;
  gatewayId: string;
}

interface PersistedMessage {
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
  /** 实际生成这条回复的模型 id（逐条来自网关）。老数据为 null。 */
  model?: string | null;
}

interface DiscoveredSession {
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
  messages: { role: string; content: string; timestamp: string }[];
}

interface SyncResult {
  ok: boolean;
  discovered?: DiscoveredSession[];
  error?: string;
}

interface ListResult<T> {
  ok: boolean;
  rows?: T[];
  error?: string;
}

type ChatAttachment = SharedChatAttachment;

/**
 * 资料库（T6c）。
 *
 * ⚠️ 这几个类型是**结构性重复**了一份：真正的定义在 `src/main/kb/service.ts`，
 * 而那份不在 preload 的构建范围里，跨不过来。字段名与那边**逐字一致** ——
 * 改了一边不改另一边时，tsc 抓不到（两边各自合法），只有运行时字段是 undefined。
 * 所以改动时**两处一起改**（`test/kb-ipc.test.ts` 会把返回形状钉住）。
 */
export interface KbSourceSummaryView {
  id: string;
  kind: 'file' | 'artifact' | 'note';
  path: string;
  title: string;
  bytes: number;
  addedAt: string;
  chunks: number;
  /** 这份资料还差多少切片没向量。 */
  pending: number;
}

export interface KbStatsView {
  sources: number;
  chunks: number;
  byState: Record<string, number>;
  meta: { embeddingModel: string | null; dim: number | null; updatedAt: string };
}

export interface KbSearchHitView {
  chunkId: string;
  sourceId: string;
  ordinal: number;
  text: string;
  snippet: string;
  sourceKind: 'file' | 'artifact' | 'note';
  sourceTitle: string;
  sourcePath: string;
  score: number;
}

export interface KbSearchOutcomeView {
  hits: KbSearchHitView[];
  /** 这次实际用的是哪种排序：`hybrid` = 关键词 + 语义，`keyword` = 只有关键词。 */
  mode: 'keyword' | 'hybrid';
  /** 向量没参与排序（没引擎 / 嵌不了 / 没东西可排）—— 界面据此标"离线检索"。 */
  degraded: boolean;
  /**
   * 向量为什么没参与排序。⚠️ `no-recall` 与 `no-vectors` 是两件事：
   * 前者是"关键词一条候选都没召回"（向量在库里，只是没东西可排），
   * 后者才是"候选都没有可用向量"。合并会让用户去重建一个好端端的索引
   *（中文查同义词很常见：`unicode61` 不切词 ⇒ 零召回）。
   */
  degradedReason?: 'no-engine' | 'engine-error' | 'no-recall' | 'no-vectors';
  /** 关键词召回了几条候选（**不是**命中数：重排后才截到 `hits`）。 */
  candidateCount: number;
}

export interface KbIngestOutcomeView {
  status: 'indexed' | 'unchanged' | 'skipped';
  reason?: 'empty' | 'unsupported' | 'unreadable' | 'missing';
  sourceId?: string;
  chunkCount: number;
  embeddedCount: number;
  pendingCount: number;
  truncated?: boolean;
  engineError?: string | null;
}

export interface KbIndexReportView {
  attempted: number;
  embedded: number;
  failed: number;
  engineError: string | null;
}

export interface KbRebuildReportView extends KbIndexReportView {
  sources: number;
  chunks: number;
  /**
   * `no-engine` = 没有可用的嵌入模型，**一个字节都没动**（重建会先把向量删干净、
   * 而没引擎补不回来，所以服务直接拒绝）。
   *
   * ⚠️ 界面必须把它跟"重建完成"分开说 —— 显示成完成是最坏的一种撒谎。
   */
  skipped?: 'no-engine';
}

/**
 * 资料库接口的统一答复。
 *
 * ⚠️ `not-ready` 是**独立的一种情况**：运行时是工作区就绪之后**异步**建的
 *（要读 90MB 嵌入模型），界面可能在那之前就问上来。它跟"你还没加过资料"是两回事 ——
 * 混在一起，用户会以为自己的东西丢了。
 */
export type KbReply<T> = (T & { ok: true }) | { ok: false; error?: string; code?: 'not-ready' };

export interface ClawWorkAPI {
  getHttpBase: (gatewayId: string) => Promise<string | undefined>;
  sendMessage: (
    gatewayId: string,
    sessionKey: string,
    content: string,
    attachments?: ChatAttachment[],
    dispatchContext?: { userContent: string },
  ) => Promise<IpcResult>;
  chatHistory: (gatewayId: string, sessionKey: string, limit?: number) => Promise<IpcResult>;
  listSessions: (gatewayId: string) => Promise<IpcResult>;
  abortChat: (gatewayId: string, sessionKey: string) => Promise<IpcResult>;

  listModels: (gatewayId: string, agentId?: string) => Promise<IpcResult>;
  listCommands: (gatewayId: string, params?: CommandsListParams) => Promise<IpcResult>;
  listAgents: (gatewayId: string) => Promise<IpcResult>;
  createAgent: (
    gatewayId: string,
    params: { name: string; workspace: string; emoji?: string; avatar?: string },
  ) => Promise<IpcResult>;
  updateAgent: (
    gatewayId: string,
    params: {
      agentId: string;
      name?: string;
      workspace?: string;
      model?: string;
      avatar?: string;
    },
  ) => Promise<IpcResult>;
  deleteAgent: (gatewayId: string, params: { agentId: string; deleteFiles?: boolean }) => Promise<IpcResult>;
  listAgentFiles: (gatewayId: string, agentId: string) => Promise<IpcResult>;
  getAgentFile: (gatewayId: string, agentId: string, name: string) => Promise<IpcResult>;
  setAgentFile: (gatewayId: string, agentId: string, name: string, content: string) => Promise<IpcResult>;
  patchSession: (gatewayId: string, sessionKey: string, patch: Record<string, unknown>) => Promise<IpcResult>;
  getToolsCatalog: (gatewayId: string, agentId?: string) => Promise<IpcResult>;
  getEffectiveTools: (gatewayId: string, sessionKey: string, agentId?: string) => Promise<IpcResult>;
  getSkillsStatus: (gatewayId: string, agentId?: string) => Promise<IpcResult>;
  searchSkills: (gatewayId: string, params: SkillSearchParams) => Promise<IpcResult<SkillSearchResult>>;
  getSkillDetail: (gatewayId: string, slug: string) => Promise<IpcResult<SkillDetailResult>>;
  installSkill: (gatewayId: string, params: SkillInstallParams) => Promise<IpcResult<SkillInstallResult>>;
  updateSkill: (gatewayId: string, params: SkillUpdateParams) => Promise<IpcResult<SkillUpdateResult>>;
  getSkillBins: (gatewayId: string) => Promise<IpcResult<SkillBinsResult>>;
  /** 「我们自己的技能」—— 随包目录（T-a2）。`installed` 靠主进程问网关要的目录判定。 */
  listOurSkills: (gatewayId?: string, agentId?: string) => Promise<IpcResult<OurSkillsListResult>>;
  installOurSkill: (gatewayId: string, slug: string, agentId?: string) => Promise<IpcResult>;
  /**
   * 开机自装随包技能：**缺了就补**，不动已装的。
   * 尽力而为 —— 失败只记日志，不挡启动（见 main/skills/handlers.ts 的注释）。
   */
  ensureOurSkills: (
    gatewayId: string,
    agentId?: string,
  ) => Promise<IpcResult<{ installed: string[]; failed: Array<{ slug: string; error: string }> }>>;
  removeOurSkill: (gatewayId: string, slug: string, agentId?: string) => Promise<IpcResult>;
  getConfig: (gatewayId: string) => Promise<IpcResult<ConfigSnapshot>>;
  setConfig: (gatewayId: string, params: ConfigSetParams) => Promise<IpcResult<ConfigSetResult>>;
  patchConfig: (gatewayId: string, params: ConfigPatchParams) => Promise<IpcResult<ConfigPatchResult>>;
  getConfigSchema: (gatewayId: string) => Promise<IpcResult<ConfigSchemaResult>>;
  lookupConfigSchema: (gatewayId: string, path: string) => Promise<IpcResult<ConfigSchemaLookupResult>>;

  gatewayStatus: () => Promise<GatewayStatusMap>;
  syncSessions: () => Promise<SyncResult>;
  listGateways: () => Promise<GatewayListItem[]>;

  onGatewayEvent: (callback: (data: GatewayEvent) => void) => () => void;
  onGatewayStatus: (callback: (status: GatewayStatusEvent) => void) => () => void;
  /** 初始读（渲染层挂载时补读一次）：`null` = 还没有结论，**不是**"没问题"。 */
  runtimeStatus: () => Promise<RuntimeStatusEvent | null>;
  onRuntimeStatus: (callback: (status: RuntimeStatusEvent) => void) => () => void;
  onDebugEvent: (callback: (event: DebugEvent) => void) => () => void;
  exportDebugBundle: (filter?: {
    gatewayId?: string;
    sessionKey?: string;
    taskId?: string;
    limit?: number;
  }) => Promise<{ ok: boolean; path?: string; eventCount?: number; error?: string }>;
  reportDebugEvent: (event: {
    domain: string;
    event: string;
    traceId?: string;
    feature?: string;
    data?: Record<string, unknown>;
  }) => void;

  loadTasks: () => Promise<ListResult<PersistedTask>>;
  loadMessages: (taskId: string) => Promise<ListResult<PersistedMessage>>;
  loadDashboardStats: () => Promise<IpcResult<ClawDashboardData>>;

  saveArtifact: (params: {
    taskId: string;
    sourcePath: string;
    messageId: string;
    fileName?: string;
    mediaType?: string;
  }) => Promise<IpcResult>;
  listArtifacts: (taskId?: string) => Promise<IpcResult<Artifact[]>>;
  getArtifact: (id: string) => Promise<IpcResult<Artifact>>;
  /**
   * 朴素读法：整份读出来给界面。
   *
   * ⚠️ 结果里**可能是 `{ tooLarge, size }`**（文件是好的，只是超过我们能整份搬进内存的上限）。
   *    调用方必须判这一支 —— 当成"内容为空"发出去比报错难查得多。
   *    上限定在主进程（`artifact-handlers.ts` 的 `MAX_PLAIN_*_SOURCE_BYTES`）。
   */
  readArtifactFile: (artifactId: string, taskId?: string) => Promise<IpcResult<ArtifactFileReadResult>>;
  /**
   * 富预览：`.docx` / `.xlsx` / `.pptx` / `.pdf` 读成界面能直接渲染的形状。
   *
   * ⚠️ 形状与主进程的 `ArtifactPreview` **必须一致**（IPC 是运行时边界，两边各写一份类型）。
   */
  previewArtifact: (artifactId: string, taskId?: string) => Promise<IpcResult<ArtifactPreview>>;
  readArtifactThumbnail: (
    artifactId: string,
    taskId?: string,
    size?: number,
  ) => Promise<IpcResult<{ dataUrl: string }>>;
  onArtifactSaved: (callback: (artifact: Artifact) => void) => () => void;
  /**
   * 助手在回复里给了 ```` ```docgen ```` 块，但有一份没能变成文件。
   *
   * 形状与 shared 的 `DocgenFailure` **必须一致**（IPC 是运行时边界，两边各写一份类型）。
   * 一次消息只推一次，可能带多条。
   */
  onDocgenFailed: (callback: (failures: DocgenFailure[]) => void) => () => void;
  /**
   * 助手在回复里给了 ```` ```htmlgen ```` 块，但有一份网页没能生成出来。
   *
   * 形状与 shared 的 `HtmlgenFailure` **必须一致**（IPC 是运行时边界，两边各写一份类型）。
   * 一次消息只推一次，可能带多条 —— 与 `onDocgenFailed` 分开两条通道，
   * 因为两边的失败原因与文案完全不相干（"PPT 某页装不下" vs "版式不认识"）。
   */
  onHtmlgenFailed: (callback: (failures: HtmlgenFailure[]) => void) => () => void;
  /**
   * 幻灯片那条通道的**两档**结果。
   *
   * ⚠️ 分开是刻意的：`onSlidegenWarned` 表示**文件已经在产物里了**，
   *    只是有几页版式要改（元素冲出画布 / 文字被盖住）。把两者合起来，
   *    用户会在一个其实存在的文件上找半天。
   */
  onSlidegenFailed: (callback: (failures: SlidegenFailure[]) => void) => () => void;
  onSlidegenWarned: (callback: (warnings: SlidegenWarning[]) => void) => () => void;
  onArtifactDeliverySettled: (callback: (result: ArtifactDeliverySettled) => void) => () => void;
  onClaimViolation: (callback: (violation: ArtifactDeliveryFailure) => void) => () => void;
  getArtifactWorkspaceScope: () => Promise<ArtifactWorkspaceScope>;
  getArtifactDeliveryActivitySnapshot: () => Promise<ArtifactDeliveryActivitySnapshot>;
  onArtifactWorkspaceScopeChanged: (callback: (scope: ArtifactWorkspaceScope) => void) => () => void;
  onArtifactDeliveryActivity: (callback: (activity: ArtifactDeliveryActivity) => void) => () => void;
  saveCodeBlock: (params: {
    taskId: string;
    messageId: string;
    content: string;
    language?: string;
    fileName?: string;
  }) => Promise<IpcResult>;
  saveImageFromUrl: (params: { taskId: string; messageId: string; url: string; alt?: string }) => Promise<IpcResult>;
  searchArtifacts: (
    query: string,
    options?: { kind?: 'all' | 'image' | 'code' | 'file' | 'other' },
  ) => Promise<IpcResult>;
  saveArtifactAs: (artifactId: string, taskId?: string) => Promise<IpcResult<ArtifactSaveAsResult>>;
  openArtifactFile: (artifactId: string, taskId?: string) => Promise<IpcResult>;
  showArtifactInFolder: (artifactId: string, taskId?: string) => Promise<IpcResult>;
  saveInboxAttachment: (params: {
    taskId: string;
    fileName: string;
    base64: string;
  }) => Promise<IpcResult<{ localPath: string }>>;
  readInboxFile: (localPath: string) => Promise<IpcResult<{ content: string; encoding: 'base64' }>>;
  readInboxFileForSend: (
    localPath: string,
  ) => Promise<IpcResult<{ content: string; encoding: 'base64'; byteLength: number }>>;
  openInboxFile: (localPath: string) => Promise<IpcResult>;
  showInboxInFolder: (localPath: string) => Promise<IpcResult>;
  readMediaFile: (sourcePath: string) => Promise<IpcResult<{ content: string; encoding: 'base64' }>>;
  exportSessionMarkdown: (taskId: string) => Promise<IpcResult>;
  exportSessionMarkdownAs: (taskId: string) => Promise<IpcResult>;

  openWorkspaceFolder: () => Promise<void>;
  isWorkspaceConfigured: () => Promise<boolean>;
  getWorkspacePath: () => Promise<string | null>;
  /** 这一进程是不是**盘上运行**（U 盘形态）。只读、现问现答。 */
  isPortableWorkspace: () => Promise<boolean>;
  /**
   * 量工作区所在文件系统的身份（`dev`/`ino` 是否为零）。
   *
   * 用途见 `main/workspace/fs-identity.ts`：FAT32 上 `dev=0` 会让随包运行时的
   * 文件身份守卫 fail-closed，**六个预置助手全部失败**，而界面上只有一句"助手失败"。
   */
  probeWorkspaceFsIdentity: () => Promise<WorkspaceFsIdentity>;
  getDefaultWorkspacePath: () => Promise<string>;
  getTeamWorkspacePath: (slug: string) => Promise<string>;
  browseWorkspace: () => Promise<string | null>;
  setupWorkspace: (path: string) => Promise<IpcResult>;
  changeWorkspace: (path: string) => Promise<IpcResult>;
  onWorkspaceChanged: (callback: (newPath: string) => void) => () => void;

  getSettings: () => Promise<AppSettings | null>;
  updateSettings: (partial: Partial<AppSettings>) => Promise<{ ok: boolean; config: AppSettings }>;
  rebuildMenu: () => Promise<void>;
  getMicrophonePermission: () => Promise<{ status: VoicePermissionStatus }>;
  requestMicrophonePermission: () => Promise<{ status: VoicePermissionStatus }>;
  checkWhisper: () => Promise<{
    available: boolean;
    binaryPath: string | null;
    modelPath: string | null;
    unsupportedPlatform?: boolean;
    error?: string;
  }>;
  transcribeAudio: (audio: ArrayBuffer) => Promise<{ ok: boolean; transcript?: string; error?: string }>;

  reconnectGateway: (gatewayId: string) => Promise<IpcResult>;

  addGateway: (gateway: GatewayServerConfig) => Promise<IpcResult>;
  removeGateway: (gatewayId: string) => Promise<IpcResult>;
  updateGateway: (gatewayId: string, partial: Partial<GatewayServerConfig>) => Promise<IpcResult>;
  setDefaultGateway: (gatewayId: string) => Promise<IpcResult>;
  testGateway: (
    url: string,
    auth: { token?: string; password?: string; pairingCode?: string; tlsVerify?: boolean },
  ) => Promise<IpcResult>;

  getAppVersion: () => Promise<string>;
  reportPortableUpdateRendererReady: () => void;
  checkForUpdates: () => Promise<UpdateCheckResult>;
  getUpdateState: () => Promise<PortableUpdatePublicState | null>;
  onUpdateStateChanged: (callback: (state: PortableUpdatePublicState) => void) => () => void;
  downloadUpdate: () => Promise<{ ok: boolean; error?: string }>;
  cancelUpdateDownload: () => Promise<{ ok: boolean; error?: string }>;
  installUpdate: () => Promise<{ ok: boolean; error?: string }>;
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => () => void;
  onUpdateDownloaded: (callback: (info: UpdateDownloadedInfo) => void) => () => void;
  onUpdateError: (callback: (error: UpdateError) => void) => () => void;

  globalSearch: (query: string) => Promise<SearchResponse>;

  persistTask: (task: {
    id: string;
    sessionKey: string;
    sessionId: string;
    title: string;
    status: string;
    ensemble?: boolean;
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
    ensemble?: boolean;
    model?: string;
    modelProvider?: string;
    thinkingLevel?: string;
    inputTokens?: number;
    outputTokens?: number;
    contextTokens?: number;
    teamId?: string | null;
    /** 采纳对比结果后改会话指针用（见 core 的 updateTaskMetadata）。 */
    sessionKey?: string;
    /** 置顶时间（ISO）；`null` = 取消置顶。与 `updatedAt` 无关。 */
    pinnedAt?: string | null;
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
    /** 实际生成这条回复的模型 id（逐条来自网关）。 */
    model?: string;
  }) => Promise<IpcResult>;

  deleteTask: (taskId: string) => Promise<IpcResult>;
  createTeamMeeting: (input: CreateTeamMeetingInput) => Promise<IpcResult<CreateTeamMeetingResult>>;
  saveTeamMeeting: (input: SaveTeamMeetingInput) => Promise<IpcResult<TeamMeetingRecord>>;
  listTeamMeetings: () => Promise<IpcResult<TeamMeetingRecord[]>>;

  persistRoom: (params: { taskId: string; status: string; conductorReady: boolean }) => Promise<IpcResult>;
  loadRoom: (taskId: string) => Promise<{
    ok: boolean;
    room: { taskId: string; status: string; conductorReady: boolean } | null;
    performers: Array<{
      sessionKey: string;
      taskId: string;
      agentId: string;
      agentName: string;
      emoji: string | null;
      verifiedAt: string;
    }>;
    error?: string;
  }>;
  persistPerformer: (params: {
    taskId: string;
    sessionKey: string;
    agentId: string;
    agentName: string;
    emoji?: string;
    verifiedAt: string;
  }) => Promise<IpcResult>;
  deleteRoom: (taskId: string) => Promise<IpcResult>;

  listSessionsBySpawner: (gatewayId: string, spawnedBy: string) => Promise<IpcResult>;
  createSession: (gatewayId: string, params: { key: string; agentId: string; message?: string }) => Promise<IpcResult>;

  getUsageStatus: (gatewayId: string) => Promise<IpcResult>;
  previewSessions: (
    gatewayId: string,
    keys: string[],
    options?: { limit?: number; maxChars?: number },
  ) => Promise<IpcResult<SessionsPreviewResult>>;

  resolveExecApproval: (gatewayId: string, id: string, decision: ApprovalDecision) => Promise<IpcResult>;

  /** 回答（或取消）网关的结构化提问 `ask_user`。 */
  resolveQuestion: (gatewayId: string, params: QuestionResolveParams) => Promise<IpcResult>;
  /** 重连 / 重启后捞回仍在挂起的问题。 */
  listQuestions: (gatewayId: string) => Promise<IpcResult<{ questions: unknown[] }>>;

  resetSession: (gatewayId: string, sessionKey: string, reason?: 'new' | 'reset') => Promise<IpcResult>;
  deleteSession: (gatewayId: string, sessionKey: string) => Promise<IpcResult>;
  compactSession: (
    gatewayId: string,
    sessionKey: string,
    maxLines?: number,
  ) => Promise<IpcResult<{ compacted: boolean; reason?: string; kept?: number }>>;

  updateTrayStatus: (
    status: 'idle' | 'running' | 'unread',
    tasks?: { taskId: string; title: string; snippet: string; duration: string }[],
  ) => void;
  getTrayEnabled: () => Promise<boolean>;
  setTrayEnabled: (enabled: boolean) => Promise<boolean>;
  onTrayNavigateTask: (callback: (taskId: string) => void) => () => void;
  onTrayOpenSettings: (callback: () => void) => () => void;

  setWindowButtonVisibility: (visible: boolean) => void;

  getDeviceId: () => Promise<string>;

  importTaskFiles: (taskId: string) => Promise<IpcResult<ImportFilesResult>>;
  listImportedTaskFiles: (taskId: string) => Promise<IpcResult<ImportedTaskFile[]>>;
  grantTaskContextFolder: (taskId: string) => Promise<IpcResult<TaskContextSource | null>>;
  listTaskContextSources: (taskId: string) => Promise<IpcResult<TaskContextSource[]>>;
  revokeTaskContextSource: (taskId: string, sourceId: string) => Promise<IpcResult<boolean>>;
  listTaskContextFiles: (taskId: string, sourceId: string, query?: string) => Promise<IpcResult<FileIndexEntry[]>>;
  readTaskContextFile: (taskId: string, sourceId: string, relativePath: string) => Promise<IpcResult<FileReadResult>>;
  readTaskContextFileForSend: (
    taskId: string,
    sourceId: string,
    relativePath: string,
  ) => Promise<IpcResult<FileReadResult & { byteLength: number }>>;

  quickLaunchSubmit: (message: string) => void;
  quickLaunchHide: () => void;
  getQuickLaunchConfig: () => Promise<QuickLaunchConfigResult>;
  updateQuickLaunchConfig: (enabled: boolean, shortcut?: string) => Promise<boolean>;
  onQuickLaunchSubmit: (callback: (message: string) => void) => () => void;

  sendNotification: (params: { title: string; body: string; taskId?: string }) => Promise<IpcResult>;
  onNotificationNavigateTask: (callback: (taskId: string) => void) => () => void;

  listCronJobs: (gatewayId: string, params?: CronListParams) => Promise<IpcResult<CronListResult>>;
  getCronStatus: (gatewayId: string) => Promise<IpcResult<CronStatusResult>>;
  addCronJob: (gatewayId: string, params: CronJobCreate) => Promise<IpcResult<CronJob>>;
  updateCronJob: (gatewayId: string, jobId: string, patch: CronJobPatch) => Promise<IpcResult<CronJob>>;
  removeCronJob: (gatewayId: string, jobId: string) => Promise<IpcResult>;
  runCronJob: (gatewayId: string, jobId: string, mode?: 'due' | 'force') => Promise<IpcResult<CronRunResult>>;
  listCronRuns: (gatewayId: string, params?: CronRunsParams) => Promise<IpcResult>;

  listTeams: () => Promise<IpcResult<Team[]>>;
  getTeam: (id: string) => Promise<IpcResult<Team | null>>;
  persistTeam: (team: {
    id: string;
    name: string;
    emoji?: string;
    description?: string;
    gatewayId: string;
    source?: string;
    version?: string;
    hubSlug?: string;
    agents: Array<{
      agentId: string;
      role?: string;
      isManager?: boolean;
      skills?: string[];
      /** 讨论职位（圆桌用）。'' = 没选。 */
      position?: TeamPosition;
    }>;
    createdAt: string;
    updatedAt: string;
  }) => Promise<IpcResult>;
  deleteTeam: (id: string) => Promise<IpcResult>;

  saveAgentAvatar: (gatewayId: string, agentId: string, dataUrl: string) => Promise<IpcResult>;
  deleteAgentAvatar: (gatewayId: string, agentId: string) => Promise<IpcResult>;
  listLocalAvatars: (gatewayId: string) => Promise<IpcResult<string[]>>;

  hubListRegistries: () => Promise<IpcResult<TeamHubRegistry[]>>;
  hubFetchRegistry: (id: string) => Promise<IpcResult<TeamHubRegistry>>;
  hubAddRegistry: (url: string) => Promise<IpcResult<TeamHubRegistry>>;
  hubRemoveRegistry: (id: string) => Promise<IpcResult>;
  hubDownloadTeam: (
    registryId: string,
    slug: string,
  ) => Promise<IpcResult<{ parsed: ParsedTeam; agentFiles: Record<string, AgentFileSet> }>>;

  commercialGetConfig: () => Promise<IpcResult<{ supabaseUrl: string; hasAnonKey: boolean; licenseKey: string }>>;
  commercialSetConfig: (payload: { supabaseUrl?: string; supabaseAnonKey?: string }) => Promise<IpcResult>;
  commercialSendOtp: (target: string) => Promise<IpcResult<{ target: string; channel: string }>>;
  commercialVerifyOtp: (target: string, token: string) => Promise<IpcResult<{ userId: string | null }>>;
  commercialSignInPassword: (email: string, password: string) => Promise<IpcResult<{ userId: string | null }>>;
  commercialSignOut: () => Promise<IpcResult>;
  commercialSession: () => Promise<IpcResult<CommercialSessionState>>;
  /**
   * B7 **本地快速态**：本地存着一个会话吗。**不发网络**。
   *
   * ⚠️ 只用来决定"网络慢时兜底该怎么判"，**不是**"已登录"的结论 ——
   *    token 可能早就失效了。结论只认 `commercialSession()`。
   */
  commercialLocalSession: () => Promise<IpcResult<boolean>>;
  commercialAccountOverview: () => Promise<IpcResult<CommercialAccountOverview>>;
  commercialLicenseStatus: () => Promise<IpcResult<CommercialLicenseStatus>>;
  commercialLicenseActivate: (licenseKey: string) => Promise<IpcResult<CommercialLicenseStatus>>;
  commercialLicenseClear: () => Promise<IpcResult>;
  commercialDeviceFingerprint: () => Promise<string>;
  commercialUsageReport: () => Promise<number>;
  commercialRechargeSkus: () => Promise<IpcResult<RechargeSku[]>>;
  commercialRechargeCreate: (sku: string) => Promise<IpcResult<RechargeOrderHandle>>;
  /** Free-form recharge, in cents. Range is enforced by the RPC (¥1–¥500). */
  commercialRechargeCreateCustom: (amountCents: number) => Promise<IpcResult<RechargeOrderHandle>>;
  commercialRechargeOrder: (orderNo: string) => Promise<IpcResult<RechargeOrderStatus>>;

  /**
   * 中转 bootstrap 的**公开状态**（无密 DTO，定义在 `@clawwork/shared`）。
   *
   * ⚠️ 它只回答"这一轮跑到哪了、是不是确定性地不行了"，**不含**卡密 / relay key /
   *    token / 原始后端文案 —— 那些只在主进程的调试日志里（且已脱敏）。
   *
   * - `commercialRelayBootstrapState()`：**初始读**。bootstrap 在窗口建好之前就跑过
   *   一轮，那之前的事件没人收，只能靠这次补读；
   * - `onCommercialRelayBootstrapState(cb)`：**挂上之后**的每次转变（返回退订函数）。
   *   幂等键是 `(phase, errorCode, updatedAt)`（`updatedAt` 严格单调）；**内容相同的
   *   事件可能重复发**，按幂等键去重，别把重复当成"又跑了一轮"；
   * - `commercialRelayBootstrapRetry()`：请求重试。只**排队**（不等这一轮跑完），
   *   进度跟状态事件走。
   */
  commercialRelayBootstrapState: () => Promise<IpcResult<RelayBootstrapPublicState>>;
  onCommercialRelayBootstrapState: (callback: (state: RelayBootstrapPublicState) => void) => () => void;
  commercialRelayBootstrapRetry: () => Promise<IpcResult>;

  // ── 广场 / 团队（P1）───────────────────────────────────────────────
  // ⚠️ 列表类返回的是**后端原样的行**（snake_case），由 core 的 normalizer 归一；
  //    单个对象的三个（like / inviteCreate / join）在 IPC 层已经翻成驼峰 DTO。
  //    这里刻意不写 `CommunityPost[]` —— 类型要对得上实际拿到的东西。
  communityInfo: () => Promise<IpcResult<unknown>>;
  communityMembers: () => Promise<IpcResult<unknown[]>>;
  communitySwitchTeam: (orgId: string) => Promise<IpcResult<null>>;
  communityFeed: (params?: { limit?: number; before?: string | null }) => Promise<IpcResult<unknown[]>>;
  communityCreatePost: (params: { body: string; visibility: 'private' | 'org' }) => Promise<IpcResult<string>>;
  communityDeletePost: (postId: string) => Promise<IpcResult<null>>;
  communityComments: (postId: string, limit?: number) => Promise<IpcResult<unknown[]>>;
  communityAddComment: (postId: string, body: string) => Promise<IpcResult<string>>;
  communityLikeToggle: (postId: string) => Promise<IpcResult<LikeToggleResult>>;
  communityInviteCreate: (params: {
    role: 'admin' | 'member';
    maxUses: number;
    expiresInHours: number;
  }) => Promise<IpcResult<{ code: string; expiresAt: string }>>;
  communityInviteList: () => Promise<IpcResult<unknown[]>>;
  communityInviteRevoke: (id: string) => Promise<IpcResult<null>>;
  communityJoin: (code: string) => Promise<IpcResult<JoinTeamResult>>;
  communityMemberSetRole: (userId: string, role: 'admin' | 'member') => Promise<IpcResult<null>>;
  communityMemberRemove: (userId: string) => Promise<IpcResult<null>>;
  communityLeave: () => Promise<IpcResult<null>>;

  // ── 助手市场 / 创作者中心（P2）──────────────────────────────────────
  // ⚠️ 列表类返回后端原样行（snake_case），由 core 的 normalizer 归一；
  //    单对象的 marketTemplateInstalled 已在 IPC 层翻成驼峰。
  marketTemplates: (params?: { category?: string | null; query?: string | null }) => Promise<IpcResult<unknown[]>>;
  marketTemplateDetail: (id: string) => Promise<IpcResult<unknown>>;
  marketTemplateInstalled: (id: string) => Promise<IpcResult<{ installCount: number }>>;
  marketMyTemplates: () => Promise<IpcResult<unknown[]>>;
  marketCreateTemplate: (params: {
    name: string;
    description: string;
    category: string;
    emoji: string;
    instructions: string;
  }) => Promise<IpcResult<unknown>>;
  marketUpdateTemplate: (params: {
    id: string;
    name: string;
    description: string;
    category: string;
    emoji: string;
    instructions: string;
  }) => Promise<IpcResult<null>>;
  marketSetTemplateStatus: (id: string, status: 'draft' | 'published' | 'archived') => Promise<IpcResult<null>>;
  marketDeleteTemplate: (id: string) => Promise<IpcResult<null>>;
  // 成长值 / 悬赏（P3）
  growthSummary: () => Promise<IpcResult<unknown>>;
  growthCheckIn: () => Promise<IpcResult<unknown>>;
  growthHistory: (params?: { limit?: number; before?: string | null }) => Promise<IpcResult<unknown[]>>;
  /** 每日任务（迁移 065）：`done` 决定画不画领取按钮，能不能领以 claim 的返回为准。 */
  growthDailyTaskList: () => Promise<IpcResult<unknown[]>>;
  growthDailyTaskClaim: (params: { task: string }) => Promise<IpcResult<unknown>>;
  bountyList: (params?: { status?: string | null }) => Promise<IpcResult<unknown[]>>;
  bountyCreate: (params: { title: string; description: string; reward: number }) => Promise<IpcResult<unknown>>;
  bountyClaim: (id: string) => Promise<IpcResult<null>>;
  bountyRelease: (id: string) => Promise<IpcResult<null>>;
  bountySubmit: (params: { id: string; note: string }) => Promise<IpcResult<null>>;
  bountyAccept: (id: string) => Promise<IpcResult<null>>;
  bountyReject: (params: { id: string; note: string }) => Promise<IpcResult<null>>;
  bountyCancel: (id: string) => Promise<IpcResult<null>>;

  // ── 埋点上报（P4）────────────────────────────────────────────────────
  // 事件名由主进程按白名单校验（不在名单里返回 `{ok:false,errorCode:'invalid_event'}`）；
  // props 只收标量，超限时**丢 props、保事件**。
  analyticsTrack: (payload: {
    event: string;
    props?: Record<string, string | number | boolean>;
  }) => Promise<IpcResult<null>>;

  // ── 隐私与数据（P4）──────────────────────────────────────────────────
  // 状态已过 core 的 `normalizePrivacyState`：camelCase + 数字字节 + 真布尔。
  // 导出的结果 = 服务端快照 + 本地数据合成**一个** JSON；成功时回落盘路径，
  // 用户在保存对话框取消回 `cancelled`（界面据此安静收场）。
  // ⚠️ 下载结果自 Task 13 审阅修正起带 `truncated` / `notes`（本地那份因上限退化成
  //    元数据时，界面必须提示"这份不是完整历史"）；Task 14 按新形状消费。
  // ── 资料库（T6c）────────────────────────────────────────────────
  kbStats: () => Promise<KbReply<{ stats: KbStatsView; engine: string | null }>>;
  kbListSources: () => Promise<KbReply<{ sources: KbSourceSummaryView[] }>>;
  /** 选文件（只回路径，不入库）；用户取消时 `paths` 为空数组。 */
  kbPickFiles: () => Promise<{ ok: true; paths: string[] }>;
  kbAddFile: (params: { path: string; title?: string }) => Promise<KbReply<{ outcome: KbIngestOutcomeView }>>;
  kbAddNote: (params: { title: string; text: string }) => Promise<KbReply<{ outcome: KbIngestOutcomeView }>>;
  kbRemoveSource: (sourceId: string) => Promise<KbReply<{ removed: boolean }>>;
  kbSearch: (params: { query: string; limit?: number }) => Promise<KbReply<{ outcome: KbSearchOutcomeView }>>;
  kbIndexPending: (params?: { sourceId?: string }) => Promise<KbReply<{ report: KbIndexReportView }>>;
  kbRebuild: (params?: { sourceId?: string }) => Promise<KbReply<{ report: KbRebuildReportView }>>;

  privacyState: () => Promise<IpcResult<PrivacyState>>;
  privacyRequestExport: () => Promise<IpcResult<unknown>>;
  // `reason` = **用户自述理由**（可选，自由文本）。界面目前不收集 ⇒ 让出（`{}`）。
  // ⚠️ 审计口径（落到 `privacy_requests.note` 的固定机器码 `DELETION_REQUEST_NOTE`）**不在
  //    这里传**：由 main 戳上去。界面文案当数据发 = 用户换个语言审计口径就跟着变。
  privacyRequestDeletion: (payload: { reason?: string }) => Promise<IpcResult<unknown>>;
  privacyCancelDeletion: (payload: { id: string }) => Promise<IpcResult<null>>;
  privacyDownloadExport: () => Promise<IpcResult<{ path: string; truncated: boolean; notes: string[] }>>;
}

export interface RechargeSku {
  sku: string;
  label: string;
  amountCents: number;
  bonusCents: number;
}

export interface RechargeOrderHandle {
  orderNo: string;
  amountCents: number;
  payUrl: string;
  expiresAt: string | null;
}

export interface RechargeOrderStatus {
  orderNo: string;
  status: string;
  amountCents: number;
  paidAt: string | null;
}

declare global {
  interface Window {
    clawwork: ClawWorkAPI;
  }
}
