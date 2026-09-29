export type TaskStatus = 'active' | 'completed' | 'archived';

export type MessageRole = 'user' | 'assistant' | 'system';

export type ArtifactType = 'file' | 'code' | 'image' | 'link' | 'structured_data';
export type ArtifactAvailability = 'available' | 'missing' | 'unsafe';

export type ArtifactSaveAsResult = { status: 'cancelled' } | { status: 'saved'; filePath: string };

/**
 * 工具卡片的状态。
 *
 * ⚠️ `awaitingApproval`（2026-09-19 新增）**不是** `running` 的别名，也**不是**终态：
 * 它表示"这条命令停在审批那儿了，**在等人**"。三处刻意分开：
 *
 * 1. **显示**：卡片/活动条要单独说一句「等待批准」，不许复用"进行中" ——
 *    用户得知道**为什么没有进展**，以及**该谁动**。
 * 2. **合并权重**：与 `running` **同级**（都属"没结束"）⇒ 后来的 `done`/`error` 能覆盖它，
 *    它也能覆盖 `running`（帧序：tool 流的 result 先到落 running，approval 帧随后改判）。
 * 3. **不是**"失败"：审批还没结论时把它算成失败，是另一种撒谎。
 */
export type ToolCallStatus = 'running' | 'done' | 'error' | 'awaitingApproval';

import type { GatewayAuth } from './gateway-protocol.js';

export interface GatewayServer {
  id: string;
  name: string;
  url: string;
  auth: GatewayAuth;
  isDefault: boolean;
  color?: string;
}

export type { GatewayAuth } from './gateway-protocol.js';

export interface Task {
  id: string;
  sessionKey: string;
  sessionId: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  artifactDir: string;
  gatewayId: string;
  agentId?: string;
  ensemble?: boolean;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  teamId?: string;
  /**
   * 置顶时间（ISO）。**空/缺省 = 未置顶**；取消置顶就是清掉它。
   *
   * 为什么存时间戳而不是布尔：多个置顶之间还要有稳定顺序（最近置顶的排最前），
   * 布尔只能靠数组原顺序兜底，而那个顺序会被任何一次列表刷新打乱。
   * 排序与"只显示 5 条"的裁剪规则见 `lib/task-sort`（置顶**不吃**那 5 个名额）。
   */
  pinnedAt?: string;
}

export type TaskContextSourceKind = 'folder';

export interface TaskContextSource {
  id: string;
  taskId: string;
  kind: TaskContextSourceKind;
  absolutePath: string;
  displayName: string;
  createdAt: string;
  lastSeenAt: string;
  availability: 'available' | 'missing';
}

export interface ImportedTaskFile {
  fileName: string;
  localPath: string;
  mimeType: string;
  size: number;
}

export type ImportFileRejectionReason =
  | 'unsupported'
  | 'too-large'
  | 'unavailable'
  | 'copy-failed'
  | 'publish-unavailable';

export interface ImportFilesResult {
  imported: ImportedTaskFile[];
  rejected: Array<{ fileName: string; reason: ImportFileRejectionReason }>;
}

export type RoomStatus = 'active' | 'stopping' | 'stopped';

export interface RoomPerformer {
  sessionKey: string;
  agentId: string;
  agentName: string;
  emoji?: string;
  verifiedAt: string;
}

export interface TaskRoom {
  taskId: string;
  conductorSessionKey: string;
  conductorReady: boolean;
  status: RoomStatus;
  performers: RoomPerformer[];
}

/**
 * 团队里的**职位** —— 决定他在圆桌讨论里怎么发言、按什么顺序发言。
 *
 * ⚠️ 与 `TeamAgent.role` 是**两回事，别合并**：
 * - `role`（'coordinator' | 'worker'）是**编排**角色，`team-installer.ts` 拿它建
 *   subagent 白名单。删了它 conductor 就编不动。
 * - `position` 是**讨论**角色，只在圆桌里用，不影响编排。
 *
 * 数组顺序 = 发言顺序（记录员永远收尾）。
 */
export const TEAM_POSITIONS = ['moderator', 'expert', 'challenger', 'scribe'] as const;
export type TeamPosition = (typeof TEAM_POSITIONS)[number];

export interface TeamAgent {
  agentId: string;
  role: string;
  isManager: boolean;
  skills: string[];
  /** 讨论职位。老数据可能没有 ⇒ 一律用 `normalizePosition` 兜底，别直接当联合类型用。 */
  position?: TeamPosition;
}

export interface Team {
  id: string;
  name: string;
  emoji: string;
  description: string;
  gatewayId: string;
  source: 'local' | 'hub';
  version: string;
  hubSlug?: string;
  agents: TeamAgent[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamHubEntry {
  slug: string;
  name: string;
  emoji: string;
  description: string;
  version: string;
  agentCount: number;
  category: string;
  tags: string[];
  author: string;
  registryId?: string;
}

export interface TeamHubRegistry {
  id: string;
  name: string;
  description: string;
  url: string;
  isOfficial: boolean;
  teams: TeamHubEntry[];
  fetchedAt: string;
}

export interface TeamHubRegistryConfig {
  id: string;
  url: string;
  isOfficial: boolean;
}

export interface ParsedTeamAgent {
  id: string;
  name: string;
  role: 'coordinator' | 'worker';
  /** 讨论职位；从向导一路透传到 team_agents，不能在安装时丢失。 */
  position?: TeamPosition;
}

export interface AgentFileSet {
  agentMd?: string;
  soulMd?: string;
  skillsJson?: string;
}

export interface ParsedTeam {
  name: string;
  description: string;
  version: string;
  agents: ParsedTeamAgent[];
  body: string;
}

export interface SkillRef {
  id: string;
  source: string;
  sourceType: 'github' | 'clawhub' | 'local';
}

export type InstallEventType =
  | 'agent_creating'
  | 'agent_created'
  | 'file_setting'
  | 'file_set'
  | 'skill_installing'
  | 'skill_installed'
  | 'team_persisting'
  | 'team_persisted'
  | 'warning'
  | 'error'
  | 'done';

export interface InstallEvent {
  type: InstallEventType;
  agentSlug?: string;
  agentId?: string;
  skillId?: string;
  fileName?: string;
  message?: string;
  progress?: { current: number; total: number };
}

export interface MessageAttachment {
  fileName: string;
  dataUrl: string;
  mimeType?: string;
  localPath?: string;
  sourcePath?: string;
  size?: number;
}

export interface Message {
  id: string;
  taskId: string;
  role: MessageRole;
  content: string;
  artifacts: Artifact[];
  toolCalls: ToolCall[];
  attachments?: MessageAttachment[];
  timestamp: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  thinkingContent?: string;
  /**
   * 实际生成这条回复的模型 id —— 逐条来自网关（`chat.history` 的 assistant 记录 / transcript）。
   *
   * ⚠️ 不是会话选中的模型、不是 picker 当前值、不是模型自述（模型会照抄历史里上一轮的答案，
   * 实测过切到 qwen 仍自称 glm）。没有就是没有：老数据留空、不 backfill、不拿会话级模型兜底。
   */
  model?: string;
}

/**
 * `localPath` 相对哪个根解析。
 *
 * - `'workspace'` —— 应用工作区（`<appWorkspace>/<taskId>/…`）。**老行为，也是默认值。**
 * - `'agent'` —— 该任务所属**助手自己的工作区**（网关 `agents.entries.<id>.workspace`）。
 *   助手直接在它工作区里生成的文件走这一支，见 `main/artifact/access.ts` 的说明。
 *
 * ⚠️ 可选字段（`undefined` 一律按 `'workspace'` 处理）：这样老行、老 IPC 载荷、
 *    以及所有既有调用点都不用改，语义与加这一列之前**逐字相同**。
 */
export type ArtifactRootKind = 'workspace' | 'agent';

export interface Artifact {
  id: string;
  taskId: string;
  messageId: string;
  type: ArtifactType;
  name: string;
  filePath: string;
  localPath: string;
  /** 见 `ArtifactRootKind`。缺省 = `'workspace'`。 */
  root?: ArtifactRootKind;
  mimeType: string;
  size: number;
  sourceKey?: string;
  contentText?: string;
  createdAt: string;
  availability: ArtifactAvailability;
}

export interface ToolCall {
  id: string;
  name: string;
  status: ToolCallStatus;
  args?: Record<string, unknown>;
  result?: string;
  startedAt: string;
  completedAt?: string;
  /**
   * 网关**自己拼好的**一行"做了什么"人话，形如 `memory_search 游戏 爆款 创作 内容`
   *（工具名 + 参数摘要）。来自 `agent` 通道的 `item` 流（`kind:"tool"` 的 `title`）。
   *
   * 有它才谈得上"显示做了什么操作"：`name` 只有工具名，`args` 是原始 JSON，
   * 而这行是网关替你摘要好的、可直接给人看的。缺失时界面退回 `name`。
   */
  title?: string;
}

export type ErrorSource = 'local' | 'gateway' | 'upstream' | 'agent' | 'tool' | 'sync' | 'db';
export type ErrorStage = 'send' | 'stream' | 'final' | 'lifecycle' | 'sync' | 'persist';
export type Retryable = 'yes' | 'no' | 'unknown';

export interface AppError {
  source: ErrorSource;
  stage: ErrorStage;
  code?: string;
  /**
   * 网关给的**结构化**错误类别（chat 错误帧的 `errorKind`，协议里的闭集枚举）。
   *
   * ⚠️ 与 `code` 是两回事：`code` 来自 RPC 那套（`RATE_LIMIT` / `TIMEOUT` …），
   * 而 chat 错误帧**不带 `code`**（协议 schema 里没有这个字段）—— 所以只靠 `code`
   * 的话，聊天这条路上永远是 undefined。
   */
  kind?: string;
  rawMessage: string;
  details?: Record<string, unknown>;
  retryable: Retryable;
}

export interface IpcResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
  pairingRequired?: boolean;
}

/**
 * Atomic snapshot of everything the Account settings panel needs.
 *
 * Deliberately a single payload: the panel shows identity, plan and token
 * balance together, and reading them from separate round-trips would let the
 * UI render a mix of two different points in time.
 */
export interface CommercialAccountOverview {
  account: {
    userId: string;
    phone: string | null;
    email: string | null;
    nickname: string | null;
    avatar: string | null;
  };
  org: { id: string; name: string; plan: string; role: string } | null;
  /** null when the org has no license yet — a normal state, not an error. */
  license: CommercialLicenseSummary | null;
  device: { fingerprint: string; shortFingerprint: string };
  /** ISO timestamp of when this snapshot was read. */
  fetchedAt: string;
}

export interface CommercialLicenseSummary {
  /**
   * 账号**拥有**这张卡 —— 不是"本设备在册"。
   *
   * 这两个含义曾经混为一谈：早先它还要求本机在 `license_activations` 里有一行，
   * 于是重装/换机的人被自己的卡锁在门外，而防的是另一回事（见迁移 20260911000008）。
   * 现在只看归属：这个账号的计费组织里有生效的卡 ⇒ `true`。
   * ⚠️ 因此 `activated === true` **不等于**"能用"：卡可能已停用或过期，
   *    消费侧还要看 `status` / `expiresAt`（见 renderer 的 `evaluateCommercialSendAccess`）。
   */
  activated: boolean;
  /** Exact card identity used by relay authentication and quota accounting. */
  licenseId: string;
  /** Exact owner organization to which that card is bound. */
  orgId: string;
  licenseKey: string | null;
  sku: string | null;
  status: string | null;
  expiresAt: string | null;
  tokenQuotaMicros: number;
  tokenUsedMicros: number;
}

export interface ChatAttachment {
  mimeType: string;
  fileName: string;
  content: string;
}

export interface AgentIdentity {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
}

export interface AgentModelInfo {
  primary?: string;
  fallbacks?: string[];
}

export interface AgentInfo {
  id: string;
  name?: string;
  identity?: AgentIdentity;
  model?: AgentModelInfo;
}

export interface AgentListResponse {
  defaultId: string;
  mainKey: string;
  scope: string;
  agents: AgentInfo[];
}

export interface AgentCreateParams {
  name: string;
  workspace: string;
  emoji?: string;
  avatar?: string;
}

export interface AgentCreateResponse {
  agentId: string;
  name: string;
  workspace: string;
}

export interface AgentUpdateParams {
  agentId: string;
  name?: string;
  workspace?: string;
  model?: string;
  avatar?: string;
}

export interface AgentDeleteParams {
  agentId: string;
  deleteFiles?: boolean;
}

export interface AgentFileEntry {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
}

export interface AgentFilesListResponse {
  agentId: string;
  workspace: string;
  files: AgentFileEntry[];
}

export interface AgentFileContentResponse {
  agentId: string;
  file: AgentFileEntry & { content?: string };
}

export interface AgentFileSetParams {
  agentId: string;
  name: string;
  content: string;
}

export interface AgentFileSetResponse {
  ok: true;
  agentId: string;
  workspace: string;
  file: AgentFileEntry & { content?: string };
}

export interface ModelCatalogEntry {
  id: string;
  name?: string;
  provider?: string;
  reasoning?: boolean;
  contextWindow?: number;
  [key: string]: unknown;
}

export interface ModelListResponse {
  models: ModelCatalogEntry[];
}

export type CommandSource = 'native' | 'skill' | 'plugin';

export type CommandScope = 'text' | 'native' | 'both';

export type CommandCategory = 'session' | 'options' | 'status' | 'management' | 'media' | 'tools' | 'docks';

export interface CommandArgChoice {
  value: string;
  label: string;
}

export interface CommandArg {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  choices?: CommandArgChoice[];
  dynamic?: boolean;
}

export interface CommandEntry {
  name: string;
  nativeName?: string;
  textAliases?: string[];
  description: string;
  category?: CommandCategory;
  source: CommandSource;
  scope: CommandScope;
  acceptsArgs: boolean;
  args?: CommandArg[];
}

export interface CommandsListParams {
  agentId?: string;
  provider?: string;
  scope?: CommandScope;
  includeArgs?: boolean;
}

export interface CommandsListResponse {
  commands: CommandEntry[];
}

export interface ToolEntry {
  id: string;
  label: string;
  description: string;
  source: 'core' | 'plugin';
  pluginId?: string;
  optional?: boolean;
  defaultProfiles: string[];
}

export interface ToolGroup {
  id: string;
  label: string;
  source: 'core' | 'plugin';
  pluginId?: string;
  tools: ToolEntry[];
}

export interface ToolsCatalog {
  agentId: string;
  profiles: Array<{ id: string; label: string }>;
  groups: ToolGroup[];
}

export type EffectiveToolSource = 'core' | 'plugin' | 'channel' | 'mcp';

export interface EffectiveToolEntry {
  id: string;
  label: string;
  description: string;
  rawDescription: string;
  source: EffectiveToolSource;
  pluginId?: string;
  channelId?: string;
  mcpServer?: string;
  mcpToolName?: string;
  deniedBySession?: true;
  risk?: 'low' | 'medium' | 'high';
  tags?: string[];
}

export interface EffectiveToolGroup {
  id: EffectiveToolSource;
  label: string;
  source: EffectiveToolSource;
  tools: EffectiveToolEntry[];
}

export interface EffectiveToolNotice {
  id: string;
  severity: 'info' | 'warning';
  message: string;
  servers?: string[];
}

export interface EffectiveToolsInventory {
  agentId: string;
  profile: string;
  groups: EffectiveToolGroup[];
  notices?: EffectiveToolNotice[];
}

export type EffectiveToolsLoadState =
  | { status: 'loading' }
  | { status: 'ready'; inventory: EffectiveToolsInventory }
  | { status: 'error'; error: string };

export interface SkillStatusConfigCheck {
  path: string;
  satisfied: boolean;
}

export interface SkillRequirements {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
}

export interface SkillInstallOption {
  id: string;
  kind: string;
  label: string;
  bins: string[];
}

export interface SkillStatusEntry {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: SkillRequirements;
  missing: SkillRequirements;
  configChecks: SkillStatusConfigCheck[];
  install: SkillInstallOption[];
}

export interface SkillStatusReport {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
}

export type SkillInstallParams =
  | { name: string; installId: string; dangerouslyForceUnsafeInstall?: boolean; timeoutMs?: number }
  | { source: 'clawhub'; slug: string; version?: string; force?: boolean; timeoutMs?: number };

export interface SkillInstallResult {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  code: number;
  slug?: string;
  version?: string;
  targetDir?: string;
}

export type SkillUpdateParams =
  | { skillKey: string; enabled?: boolean; apiKey?: string; env?: Record<string, string> }
  | { source: 'clawhub'; slug?: string; all?: boolean };

export interface SkillUpdateResult {
  ok: boolean;
  skillKey?: string;
  config?: Record<string, unknown>;
}

export interface SkillSearchParams {
  query?: string;
  limit?: number;
}

export interface SkillSearchResultEntry {
  score: number;
  slug: string;
  displayName: string;
  summary?: string;
  version?: string;
  updatedAt?: number;
}

export interface SkillSearchResult {
  results: SkillSearchResultEntry[];
}

export interface SkillDetailParams {
  slug: string;
}

export interface SkillDetailResult {
  skill: {
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    createdAt: number;
    updatedAt: number;
  } | null;
  latestVersion?: {
    version: string;
    createdAt: number;
    changelog?: string;
  } | null;
  metadata?: {
    os?: string[] | null;
    systems?: string[] | null;
  } | null;
  owner?: {
    handle?: string | null;
    displayName?: string | null;
    image?: string | null;
  } | null;
}

export interface SkillBinsResult {
  bins: string[];
}

/**
 * 「我们自己的技能」—— 随包发的那批（T-a2）。
 *
 * 与 `SkillStatusEntry` 的差别：那是**网关报告的状态**（`skills.status` 的产物），
 * 这是**我们打包带上来的目录清单**。两者不是一回事 —— 网关没连上时前者根本拿不到，
 * 但技能市场仍然应该能显示"我们有什么"。
 *
 * `name` / `description` 来自 `SKILL.md` 的 frontmatter，**不是** i18n 键：
 * 与市场里的官方模板同一个口径（内容自带，不随界面语言变）。
 */
export interface OurSkillEntry {
  /** 目录名，也是 `metadata.openclaw.skillKey`（内容闸钉住了这个相等关系）。 */
  slug: string;
  /** ⚠️ `undefined` = 这份 SKILL.md 格式不对（运行时会静默丢掉）。由内容闸判红。 */
  name?: string;
  description?: string;
  emoji?: string;
  skillKey?: string;
  installed: boolean;
}

export interface OurSkillsListResult {
  skills: OurSkillEntry[];
  /**
   * 网关报出 `managedSkillsDir` 了吗。
   *
   * ⚠️ 为 `false` 时 `installed` 全是 `false` —— 但那是**"不知道"**，不是"没装"。
   * 界面必须分开说：网关没连上时说"未连接"，别让用户以为技能丢了。
   */
  managedDirKnown: boolean;
}

export interface ConfigSnapshot {
  raw: string;
  hash: string;
  config: Record<string, unknown>;
  path: string;
}

export interface ConfigSetParams {
  raw: string;
  baseHash?: string;
}

export interface ConfigPatchParams {
  raw: string;
  baseHash?: string;
  sessionKey?: string;
  note?: string;
  restartDelayMs?: number;
}

export interface ConfigSetResult {
  ok: boolean;
  path: string;
  config: Record<string, unknown>;
}

export interface ConfigPatchResult {
  ok: boolean;
  noop?: boolean;
  path: string;
  config: Record<string, unknown>;
}

export interface ConfigSchemaResult {
  schema: unknown;
  uiHints: Record<string, unknown>;
  version: string;
  generatedAt: string;
}

export interface ConfigSchemaLookupResult {
  path: string;
  schema: unknown;
  hint?: unknown;
  hintPath?: string;
  children: Array<{ path: string; schema: unknown; hint?: unknown }>;
}

export interface SessionPatchParams {
  sessionKey: string;
  thinkingLevel?: string | null;
  fastMode?: boolean | null;
  model?: string | null;
  reasoningLevel?: string | null;
  elevatedLevel?: string | null;
  verboseLevel?: string | null;
  responseUsage?: string | null;
  label?: string | null;
}

export type FileTier = 'text' | 'image' | 'document' | 'unsupported';

export interface FileIndexEntry {
  relativePath: string;
  absolutePath: string;
  fileName: string;
  size: number;
  mtime: number;
  mimeType: string;
  tier: FileTier;
}

export interface FileReadResult {
  content: string;
  mimeType: string;
  size: number;
  truncated: boolean;
  tier: 'text' | 'image' | 'document';
}

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export interface ExecApprovalMutableFileOperand {
  argvIndex: number;
  path: string;
  sha256: string;
}

export interface ExecApprovalSystemRunBinding {
  argv: string[];
  cwd?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
  envHash?: string | null;
}

export interface ExecApprovalSystemRunPlan {
  argv: string[];
  cwd?: string | null;
  commandText: string;
  commandPreview?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
  mutableFileOperand?: ExecApprovalMutableFileOperand | null;
}

export interface ExecApprovalRequestDetails {
  command: string;
  commandPreview?: string | null;
  commandArgv?: string[];
  envKeys?: string[];
  systemRunBinding?: ExecApprovalSystemRunBinding | null;
  systemRunPlan?: ExecApprovalSystemRunPlan | null;
  cwd?: string | null;
  nodeId?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
}

export interface ExecApprovalRequest {
  id: string;
  request: ExecApprovalRequestDetails;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ExecApprovalResolved {
  id: string;
  decision?: ApprovalDecision | null;
  resolvedBy?: string | null;
  ts?: number | null;
  request?: ExecApprovalRequestDetails | null;
}

export type UsageProviderId =
  | 'anthropic'
  | 'github-copilot'
  | 'google-gemini-cli'
  | 'minimax'
  | 'openai-codex'
  | 'xiaomi'
  | 'zai';

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetAt?: number;
}

export interface ProviderUsageSnapshot {
  provider: UsageProviderId;
  displayName: string;
  windows: UsageWindow[];
  plan?: string;
  error?: string;
}

export interface UsageStatus {
  updatedAt: number;
  providers: ProviderUsageSnapshot[];
}

export interface CostUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  missingCostEntries: number;
}

export interface CostUsageDailyEntry extends CostUsageTotals {
  date: string;
}

export interface CostUsageSummary {
  updatedAt: number;
  days: number;
  daily: CostUsageDailyEntry[];
  totals: CostUsageTotals;
}

export interface SessionCostSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  missingCostEntries: number;
  firstActivity?: number;
  lastActivity?: number;
  durationMs?: number;
}

export interface SessionUsageEntry {
  key: string;
  label?: string;
  sessionId?: string;
  updatedAt?: number;
  agentId?: string;
  model?: string;
  modelProvider?: string;
  usage: SessionCostSummary | null;
}

export interface SessionsUsageResult {
  updatedAt: number;
  startDate: string;
  endDate: string;
  sessions: SessionUsageEntry[];
  totals: CostUsageTotals;
}

export type SessionPreviewItemRole = 'user' | 'assistant' | 'tool' | 'system' | 'other';

export interface SessionPreviewItem {
  role: SessionPreviewItemRole;
  text: string;
}

export type SessionPreviewStatus = 'ok' | 'empty' | 'missing' | 'error';

export interface SessionsPreviewEntry {
  key: string;
  status: SessionPreviewStatus;
  items: SessionPreviewItem[];
}

export interface SessionsPreviewResult {
  ts: number;
  previews: SessionsPreviewEntry[];
}

export interface SessionsPreviewParams {
  keys: string[];
  limit?: number;
  maxChars?: number;
}

export interface DashboardBreakdownEntry {
  name: string;
  count: number;
  percent: number;
}

export interface DashboardBreakdowns {
  /**
   * ⚠️ 2026-09-12 起「模型」维度**不再**放这里。
   *
   * 这里原来是 `SELECT model, COUNT(*) FROM tasks GROUP BY model` —— 统计的是
   * **会话选中的模型**（一个会话一行），既不反映用户中途切模型，也不反映
   * 网关的自动回退（fallback 事件只弹一条不落库的提示，见 gateway-dispatcher）。
   * 那是彻底的读数错误。
   *
   * 正确的模型维度是 `modelUsage`（来自服务端计费表，每次调用一行、记的是
   * **实际发到上游的模型名**）。这个字段留给「按会话数看模型分布」这类
   * 与计费无关的用途；空数组表示不展示。
   */
  models: DashboardBreakdownEntry[];
  gateways: DashboardBreakdownEntry[];
  agents: DashboardBreakdownEntry[];
}

/**
 * 一个模型（provider × model）在窗口内的真实消耗。
 *
 * 数据来自服务端 `usage_billing_by_model` 视图（迁移 32）—— 即**计费表本身**，
 * 所以它与「额度扣了多少」是同一份数据，能对账。
 *
 * ⚠️ `model` 是每次调用**真正发到上游的名字**（relay 用请求体 body.model 落账），
 *    不是会话默认模型。用户从 qwen-plus 切到 kimi-k3 会分成两条；
 *    网关自动回退时出现的是实际生效的那个模型 —— 这正是「不是黑箱」的判据。
 */
export interface DashboardModelUsage {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  /** 微积分（1e-6 积分）。显示时走 formatCredits。 */
  costMicros: number;

  // ───────────────────────────────────────────────────────────────────────
  // M4 透明计费：以下字段全部是**落账时的快照**，不是拿今天的价目回算的。
  // 对「改当前价目表 ⇒ 历史展示必须一字不变」这条，有服务端负对照测试锁着
  // （scripts/tests/billing_transparency.sql 最后一条断言）。
  //
  // ⚠️ 三条不许违反的口径：
  //   ① `costMicros` 是账本事实；官方参考费用是**测算**，两者不是一个东西。
  //   ② 官方参考费用 **≠ 供应商 invoice**（我们没做供应商账单对账）。
  //   ③ 历史 v1 行没有快照 ⇒ 这些字段为 null，**不许当 0 显示**。
  // ───────────────────────────────────────────────────────────────────────

  /** 落账时**实际命中**的售价（元/百万 token）。null = 未记录 / 窗口内多档。 */
  saleInputYuanPerMtok: number | null;
  saleOutputYuanPerMtok: number | null;
  saleCachedYuanPerMtok: number | null;

  /** 官方挂牌价（元/百万 token）。null = 历史未记录 / 窗口内多档。 */
  officialInputYuanPerMtok: number | null;
  officialOutputYuanPerMtok: number | null;
  officialCachedYuanPerMtok: number | null;

  /** 'implicit_hit' | 'none' | null。null = 未记录 / 窗口内多档。 */
  officialCachePricingMode: string | null;

  /**
   * **目标**倍率（1.6 = 1.6×）。null = 未记录 / 窗口内多档。
   * ⚠️ 是目标不是结果：售价经过 ceil、跨档重定价与 greatest 不退款，
   * 都会让实际结算倍率偏离它。实际值见 `effectiveMultiplier`。
   */
  targetMultiplier: number | null;

  /** 窗口内不同价目档数（0 = 一条 v2 记录都没有）。 */
  pricingVariants: number;
  /** 窗口内价目不一致（多档，或某天内部就多档）⇒ 上面那些标量价已置 null。 */
  pricingMixed: boolean;

  /** 窗口内**已结算**记录总条数。 */
  settledCalls: number;
  /** 其中能**严格算出**官方参考费用的条数。 */
  officialReferenceCoveredCalls: number;
  /**
   * 官方参考费用（微积分）—— **只累加算得出的那些**。
   * `officialReferenceComplete` 为 false 时它是「已覆盖部分」，**不是总额**。
   * null = 一条都算不出（此时不许显示 0）。
   */
  officialReferenceCostMicros: number | null;
  /** 窗口内每一笔都算得出官方参考费用才为 true。 */
  officialReferenceComplete: boolean;

  /**
   * 实际结算倍率 = 实际扣费 ÷ 官方参考费用。
   * ⚠️ **只在 `officialReferenceComplete` 为 true 时才有值。** 覆盖不全时分子分母
   *    不是同一批记录，那个比值没有意义 —— 宁可给 null，也不给一个混合口径的数。
   * ⚠️ 它不是「目标倍率」：售价 ceil、跨档重定价、greatest 不退款都会让它偏离。
   */
  effectiveMultiplier: number | null;
}

export interface DashboardLast30d {
  input: number;
  output: number;
  /**
   * 成本，单位**微积分**（1e-6 积分 = 1e-6 分）。
   *
   * ⚠️ 2026-09-12 之前这里叫 `cost`、单位是**美元**，来自本机网关按内置价目表
   * 算的 `usage.cost`。那个口径与「额度扣了多少」不是同一批调用（网关那份还
   * 包含不走中转的调用），所以和账户页余额永远对不上。现在与额度同源。
   */
  costMicros: number;
  daily: Array<{ date: string; input: number; output: number; costMicros: number }>;
}

export interface ClawDashboardData {
  totalTasks: number;
  activeDays: number;
  totalMessages: number;
  totalArtifacts: number;
  breakdowns: DashboardBreakdowns;
  last30d: DashboardLast30d | null;
  /**
   * 按实际调用模型分的消耗。**账号级**数据（服务端按 org 聚合），
   * 与本机 SQLite 那几项不是一个口径 —— 界面上要标出来。
   *
   * `null` = 拿不到（未登录 / 无商业配置 / 请求失败）；
   * 空数组 = 确实一次中转调用都没有。两者含义不同，别合并。
   */
  modelUsage: DashboardModelUsage[] | null;
}

export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string; staggerMs?: number };

export type CronSessionTarget = 'main' | 'isolated' | 'current' | `session:${string}`;
export type CronWakeMode = 'next-heartbeat' | 'now';

export type CronPayload =
  | { kind: 'systemEvent'; text: string }
  | {
      kind: 'agentTurn';
      message: string;
      model?: string;
      fallbacks?: string[];
      thinking?: string;
      timeoutSeconds?: number;
      allowUnsafeExternalContent?: boolean;
      lightContext?: boolean;
      deliver?: boolean;
      channel?: string;
      to?: string;
      bestEffortDeliver?: boolean;
    };

export type CronDeliveryMode = 'none' | 'announce' | 'webhook';

export interface CronFailureDestination {
  channel?: string;
  to?: string;
  accountId?: string;
  mode?: 'announce' | 'webhook';
}

export interface CronDelivery {
  mode: CronDeliveryMode;
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
  failureDestination?: CronFailureDestination;
}

export interface CronFailureAlert {
  after?: number;
  channel?: string;
  to?: string;
  cooldownMs?: number;
  mode?: 'announce' | 'webhook';
  accountId?: string;
}

export type CronRunStatus = 'ok' | 'error' | 'skipped';
export type CronDeliveryStatus = 'delivered' | 'not-delivered' | 'unknown' | 'not-requested';

export interface CronJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: CronRunStatus;
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  lastDelivered?: boolean;
  lastDeliveryStatus?: CronDeliveryStatus;
  lastDeliveryError?: string;
  lastFailureAlertAtMs?: number;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  agentId?: string;
  sessionKey?: string;
  description?: string;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  delivery?: CronDelivery;
  failureAlert?: CronFailureAlert | false;
  state: CronJobState;
}

export type CronJobCreate = Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'>;

export interface CronJobPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
  agentId?: string;
  sessionKey?: string;
  deleteAfterRun?: boolean;
  schedule?: CronSchedule;
  sessionTarget?: CronSessionTarget;
  wakeMode?: CronWakeMode;
  payload?: CronPayload;
  delivery?: CronDelivery;
  failureAlert?: CronFailureAlert | false;
}

export interface CronRunLogEntry {
  ts: number;
  jobId: string;
  action: 'finished';
  status?: CronRunStatus;
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  jobName?: string;
}

export interface CronListParams {
  enabled?: 'all' | 'enabled' | 'disabled';
  query?: string;
  sortBy?: 'nextRunAtMs' | 'updatedAtMs' | 'name';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CronListResult {
  jobs: CronJob[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
}

export interface CronStatusResult {
  enabled: boolean;
  storePath: string;
  jobs: number;
  nextWakeAtMs?: number;
}

export interface CronRunParams {
  jobId: string;
  mode?: 'due' | 'force';
}

export interface CronRunResult {
  enqueued?: boolean;
  runId?: string;
  ran?: boolean;
  reason?: string;
}

export interface CronRunsParams {
  scope?: 'job' | 'all';
  jobId?: string;
  limit?: number;
  offset?: number;
  statuses?: CronRunStatus[];
  deliveryStatuses?: CronDeliveryStatus[];
  query?: string;
  sortDir?: 'asc' | 'desc';
}

export interface CronRunsResult {
  entries: CronRunLogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}
