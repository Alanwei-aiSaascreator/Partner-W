import {
  parseTaskIdFromSessionKey,
  isSubagentSession,
  isSystemSession,
  parseSlidegenToolStream,
} from '@clawwork/shared';
import type {
  GatewayFailureReason,
  ChatDispatchReceipt,
  ToolCall,
  ToolCallStatus,
  ModelListResponse,
  AgentListResponse,
  CommandEntry,
  CommandsListResponse,
  EffectiveToolsInventory,
  EffectiveToolsLoadState,
  SkillStatusReport,
  ToolsCatalog,
} from '@clawwork/shared';
import {
  extractDeltaText,
  extractText,
  extractThinking,
  extractToolCalls,
  extractToolResultText,
  isExecHeldByApproval,
  parseToolArgs,
} from '../protocol/parse-content.js';
import type { ChatEventPayload } from '../protocol/types.js';
import { buildAppError, formatErrorForUser, formatErrorForToast } from './error-classify.js';
import type { TranslateFn } from './error-classify.js';
import { autoTitleIfNeeded } from './auto-title.js';
import { resolveCatalogAgentId } from './catalog-owner.js';
import type { LateToolUpdate } from './session-sync.js';
import { announceCompaction, currentCompactionEpisode } from './compaction-announce.js';
import { activeTurnProducedOutput } from '../stores/message-store.js';
import type { MessageState } from '../stores/message-store.js';
import type { GatewayReconnectInfo } from '../stores/ui-store.js';
import type {
  GatewayTransportPort,
  GatewayStatusEvent,
  GatewayEvent,
  GatewayEventTransportMeta,
  RuntimeStatusEvent,
} from '../ports/gateway-transport.js';
import { mapNativeToExecution, type ExecutionMapContext } from '../protocol/map-execution-event.js';
import type { ExecutionChannel, ExecutionEvent } from '../protocol/execution-events.js';

type AgentEventStream = 'lifecycle' | 'tool' | 'assistant' | 'thinking' | 'error' | 'compaction';

interface AgentToolData {
  /**
   * 实测**五个**值 —— 权威清单在 `TOOL_PHASE_IDS`（那里有每个的发射点）。
   *
   * ⚠️ 这里**曾经写着「实测四个值」并列举 `start`/`result`/`update`/`review`** ——
   *    那是个**完整性声明，而它是错的**：漏了 `input_delta`。漏的原因不是"难以发现"，
   *    是我当时**只扫了 `handlers.tools.*`**，而第五个的发射点在
   *    `handlers.messages.update.ts`。⇒ 教训：**写"只有这些"之前，先问自己扫描的边界
   *    是不是恰好等于"全部"**；边界之外的发射点不会自己举手。
   *
   * ⚠️ 另外两件同样要记住的：
   *    · **没有 `end`**（早先按 2026-09-18 的真机帧记成"只有 start/result"，不全）；
   *    · **`error` 我们有个防守分支，但运行时一次都不发** —— 失败是 `result` + `isError:true`。
   *
   * ⚠️ 只有 `result` 会收尾；`update` 只带 `partialResult`（既没 args 也没 result）。
   * ⚠️ `phase` **可以整个缺失**（有帧只发 `data:{name}`）—— 缺失也走"认不出"那条路留痕。
   */
  phase?: string;
  name?: string;
  toolCallId?: string;
  /** 网关拼的一行摘要（工具名 + 参数摘要），**不是**工具的真实输出。 */
  meta?: string;
  isError?: boolean;
  /** ⚠️ 实测是**对象**（不是 JSON 串）。写成 `string` 会让调用点传对象时 tsc 不吭声。 */
  args?: unknown;
  /** 工具的真实输出：`{content:[{type:'text',text}]}`。 */
  result?: unknown;
  partialResult?: unknown;
  commandBearing?: boolean;
}

/**
 * `item` 流（`kind:"tool"`）—— 网关的**统一活动条目**。
 *
 * 和 `tool` 流讲的是同一件事，但多了两样这里没有的东西：**人话 `title`**
 *（`"memory_search 游戏 爆款 创作 内容"`）和**真实起止时间**（`startedAt`/`endedAt` 毫秒）。
 * 两边共用同一个 `toolCallId`，所以按 id upsert 就能自然合并。
 */
interface AgentItemData {
  itemId?: string;
  phase?: string;
  kind?: string;
  title?: string;
  status?: string;
  name?: string;
  meta?: string;
  toolCallId?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  /** `kind:"preamble"` 的模型自述进度。 */
  progressText?: string;
}

/**
 * `approval` 流 —— 一个 exec 命令的审批结果。
 *
 * ⚠️ **为什么必须接**：审批不可用而被拦下的命令，`tool` 流发的是
 * `isError:false` 的 result（运行时原文：`isToolError = observerIsError && !approvalUnavailable`）
 * ⇒ 只看 tool 流，卡片会显示「已完成」，而命令**根本没跑**。真相只在这一帧里。
 *
 * 实测取值（2026.9.3）：
 * - `phase:"requested"` + `status:"pending"`（等审批）/ `"unavailable"`（审批不可用）
 * - `phase:"resolved"` + `status:"denied"` / `"failed"`
 */
interface AgentApprovalData {
  phase?: string;
  /** 实测只有 `exec`。 */
  kind?: string;
  status?: string;
  title?: string;
  toolCallId?: string;
  itemId?: string;
  approvalId?: string;
  command?: string;
  host?: string;
  /** 机器码（如 `no-approval-channel`）。 */
  reason?: string;
  /** 网关写的人话解释。 */
  message?: string;
}

interface AgentLifecycleData {
  /**
   * 实测**七个**值（2026-09-19 扫 `~/git/openclaw` 2026-09-09 的 emit 点）：
   * `start` / `end` / `error` / `fallback` / `fallback_step` / `fallback_cleared` / **`finishing`**。
   *
   * ⚠️ `fallback_step` 与 `fallback_cleared` 此前**连类型都没声明**，
   * 而下面那个 switch **没有 default** ⇒ 这两条**完全静默**（连一条日志都没有）。
   *
   * ⚠️ **`finishing` 是 2026-09-19 补的，而它此前没被处理的真正原因就在这个类型上**：
   *    这里是个**封闭联合**，把它声明成"已经齐了" ⇒ 下面那个 switch 的穷尽性检查
   *    **反而挡住了**加 `case 'finishing'`（TS2678），于是它只能走 `default`。
   *    ⇒ 教训：**"我们认得的值"不要写成封闭联合**，除非有东西能保证它真的闭。
   *    （网关那边 `phase` 在协议里是开放字符串，闭的是我们自己的认知。）
   */
  phase?:
    | 'start'
    | 'end'
    | 'error'
    | 'fallback'
    | 'fallback_step'
    | 'fallback_cleared'
    /** ⚠️ **不是结束**：还有后续尝试时发的「本 attempt 收尾」（见 case 里的说明）。 */
    | 'finishing';
  error?: string;
  startedAt?: number;
  endedAt?: number;
  selectedProvider?: string;
  selectedModel?: string;
  activeProvider?: string;
  activeModel?: string;
  /** `fallback_cleared` 专有：切回去**之前**用的是哪个模型。 */
  previousActiveModel?: string;
}

interface AgentErrorData {
  reason?: string;
  expected?: number;
  received?: number;
}

interface AgentCompactionData {
  phase?: 'start' | 'end';
  willRetry?: boolean;
  completed?: boolean;
}

interface AgentThinkingData {
  /** **累计快照**（不是本次增量）—— 各产出方都这么发，见下面 `case 'thinking'` 的说明。 */
  text?: string;
  /** 本次增量。 */
  delta?: string;
  /** 只有进度计数的心跳事件，没有文本。 */
  progressTokens?: number;
}

interface AgentEvent {
  sessionKey: string;
  runId?: string;
  stream?: AgentEventStream | string;
  seq?: number;
  ts?: number;
  data?: AgentToolData | AgentLifecycleData | AgentErrorData | AgentCompactionData;
}

interface SessionChangedEvent {
  sessionKey?: string;
  spawnedBy?: string;
  reason?: string;
  phase?: string;
  /** ⚠️ 只在 `reason === "compact"` 时出现：这次到底压没压成（网关给的）。 */
  compacted?: boolean;
}

const EFFECTIVE_TOOL_SOURCES = new Set(['core', 'plugin', 'channel', 'mcp']);
const EFFECTIVE_TOOL_RISKS = new Set(['low', 'medium', 'high']);
const EFFECTIVE_NOTICE_SEVERITIES = new Set(['info', 'warning']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isEffectiveToolEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.label)) return false;
  if (typeof value.description !== 'string' || typeof value.rawDescription !== 'string') return false;
  if (!isNonEmptyString(value.source) || !EFFECTIVE_TOOL_SOURCES.has(value.source)) return false;
  if (!isOptionalNonEmptyString(value.pluginId)) return false;
  if (!isOptionalNonEmptyString(value.channelId)) return false;
  if (!isOptionalNonEmptyString(value.mcpServer)) return false;
  if (!isOptionalNonEmptyString(value.mcpToolName)) return false;
  if (value.deniedBySession !== undefined && value.deniedBySession !== true) return false;
  if (value.risk !== undefined && (!isNonEmptyString(value.risk) || !EFFECTIVE_TOOL_RISKS.has(value.risk)))
    return false;
  if (value.tags !== undefined && !isNonEmptyStringArray(value.tags)) return false;
  return true;
}

function isEffectiveToolGroup(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id) || !EFFECTIVE_TOOL_SOURCES.has(value.id)) return false;
  if (!isNonEmptyString(value.label)) return false;
  if (!isNonEmptyString(value.source) || !EFFECTIVE_TOOL_SOURCES.has(value.source)) return false;
  return Array.isArray(value.tools) && value.tools.every(isEffectiveToolEntry);
}

function isEffectiveToolNotice(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isNonEmptyString(value.severity) || !EFFECTIVE_NOTICE_SEVERITIES.has(value.severity)) return false;
  if (typeof value.message !== 'string') return false;
  return value.servers === undefined || isNonEmptyStringArray(value.servers);
}

function isEffectiveToolsInventory(value: unknown): value is EffectiveToolsInventory {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.agentId) || !isNonEmptyString(value.profile)) return false;
  if (!Array.isArray(value.groups) || !value.groups.every(isEffectiveToolGroup)) return false;
  return value.notices === undefined || (Array.isArray(value.notices) && value.notices.every(isEffectiveToolNotice));
}

interface ErrorCorrelation {
  taskId: string;
  runId?: string;
  code?: string;
  source: string;
  rawMessage: string;
  displayedAt: number;
}

type NotificationSettingKey = 'taskComplete' | 'approvalRequest' | 'gatewayDisconnect';

/**
 * V3（2026-10-13 step 3）：`exec.approval.resolved` 的类型化结论 ——
 * 由 dispatcher 从原始帧构造（**不猜**字段），渲染层（I）按 `gatewayId + id` 索引审批。
 * `rpcError`：resolve RPC 调用本身失败；`expired`：审批已过期 —— 二者都不是"已批准"。
 */
export interface ApprovalResolvedConclusion {
  id: string;
  gatewayId: string;
  decision?: string | null;
  resolvedBy?: string | null;
  request?: {
    sessionKey?: string | null;
    runId?: string | null;
    toolCallId?: string | null;
    command?: string | null;
  } | null;
  /** 客户端侧的 RPC 结论（由发起方补充；缺省 = 没有本地 RPC 失败信息）。 */
  rpcError?: boolean;
  expired?: boolean;
}

export interface GatewayDispatcherDeps {
  gateway: GatewayTransportPort;
  getSettings: () => Promise<{
    notifications?: { taskComplete?: boolean; approvalRequest?: boolean; gatewayDisconnect?: boolean };
  } | null>;
  sendNotification: (params: { title: string; body: string; taskId?: string }) => Promise<unknown>;

  getTaskStore: () => {
    tasks: { id: string; title: string; gatewayId: string; sessionKey: string; ensemble?: boolean }[];
    updateTaskTitle: (id: string, title: string) => void;
  };
  getMessageStore: () => Pick<
    MessageState,
    | 'messagesByTask'
    | 'activeTurnBySession'
    | 'addMessage'
    | 'upsertToolCall'
    | 'appendStreamDelta'
    | 'bindActiveRun'
    | 'appendThinkingDelta'
    | 'finalizeStream'
    | 'clearActiveTurn'
    | 'setProcessing'
    | 'setRunPhase'
    | 'setSessionProgressText'
    | 'setSessionCompacting'
    | 'announceCompactionOnce'
    | 'beginCompactionEpisode'
    | 'ensureCompactionEpisode'
    | 'setSessionError'
    | 'markRetryableError'
    | 'markAutoRetryFailure'
    | 'replaceStreamText'
    | 'sealTurnActivity'
    // V2：执行投影的写入动作（旁路映射折叠点）。
    | 'applyExecutionEvents'
    // run-promotion（2026-10-14）：可信 run 绑定时显式轮换 execution scope。
    | 'beginExecutionRun'
    // V3：读取交付投影（chat.final 的"任务完成"通知是否被交付门拦下）。
    | 'executionBySession'
  >;

  getActiveTaskId: () => string | null;
  markUnread: (taskId: string) => void;
  /**
   * 这个会话是不是**临时会话**（多模型对比的某一列）。
   *
   * ## 为什么需要这条边界
   *
   * 对比的每一列都是一条**独立网关会话**，但为了让 `resolveTaskId` 把它们的事件
   * 路由回原任务，会话键里嵌的是**真** taskId（伪 deviceId：
   * `agent:X:clawwork:compare-<id>-<n>:task:<taskId>`，见 compare-plan.ts）。
   * 路由通了，副作用也跟着通了 —— 不加这道闸，未采纳的回答会被
   * `syncSessionMessages` 当成该任务的一轮回复写进时间线（用户会看到自己**没采纳**的答案），
   * 报错会插 system 消息、还会弹 toast、把任务标未读、按列的内容自动改标题。
   *
   * ⇒ 临时会话：流式照常（各列要显示），**时间线/未读/通知/自动标题一律不碰**，
   *    失败改走 `messageStore.setSessionError`（按会话存的旁路，只显示在该列上）。
   *
   * ⚠️ 实际宿主（`useGatewayDispatcherSetup`）用的是对比 store 里的一张**登记表**：
   *    键在「开跑」时登记，在「**尽力关掉这一列**」之后摘掉 —— 即 `deleteSession` 成功
   *    （或网关说它本来就不存在），或者任务连 `gatewayId` 都还没有、根本没法删
   *    （见 compare-store 的 `cleanupSessions`）。**不是**"当前对比是否活跃"。
   *    退出/采纳之后事件还会飞一会儿（abort 回执、迟到的 final），
   *    判据若跟着 `active` 走，那些迟到事件就会以**普通回复**的身份写进时间线。
   *    判据必须是**动态**的（每次现读），所以这里不能缓存。
   */
  isEphemeralSession?: (sessionKey: string) => boolean;

  /**
   * 这个会话的**这一轮**是用户自己中断的吗（对比「取消」按钮 → abort 掉那几列）。
   *
   * 为什么需要它、以及为什么不复用 `abortedByUser`（那是 **task 级** 的）：
   * 对比列的登记表在 `deleteSession` 成功那一刻就把键摘掉了（那之后它不再是"临时"的），
   * 可网关那边的 `aborted` 帧可能还在路上。这一帧到了以后：会话看起来是**普通会话**，
   * 而 task 级标记可能已经被别的 delta 清过 —— 于是它会被当成"服务端单方面中断"，
   * 往时间线里插一条 system 消息，还把任务标未读、发通知。
   * 中断是**按会话**发生的（用户点的是某一轮的"取消"），标记就按会话记。
   */
  isSessionAbortedByUser?: (sessionKey: string) => boolean;

  setGatewayStatusByGateway: (gatewayId: string, status: 'connected' | 'connecting' | 'disconnected') => void;
  setGatewayVersion: (gatewayId: string, version: string | undefined) => void;
  /**
   * 网关协商下的单帧字节上限（`hello-ok.policy.maxPayload`），落进
   * `gatewayMaxPayloadByGateway`；`undefined` = 没谈到（清条目）。
   *
   * ⚠️ 可选：缺了它只影响"发送字节预算按协商值收紧"这一件事（回落默认 25MiB 折算），
   *    不影响连接/收发；宿主（desktop）已接，pwa 等形态不需要。
   */
  setGatewayMaxPayloadByGateway?: ((gatewayId: string, bytes: number | undefined) => void) | undefined;
  setGatewayReconnectInfo: (gatewayId: string, info: GatewayReconnectInfo | null) => void;
  /**
   * 本机运行时起不来的**公开原因**（`null` = 清掉这个结论）。
   *
   * ⚠️ 可选：不是每个宿主都有"本机运行时"这件事（pwa / 出厂形态）。
   *    缺了它只影响界面上"说不说得清是哪一类失败"。
   */
  setRuntimeBootstrapFailure?: ((reason: GatewayFailureReason | null) => void) | undefined;
  setDefaultGatewayId: (id: string | null) => void;
  setGatewayInfoMap: (map: Record<string, { id: string; name: string; color?: string }>) => void;
  setGatewaysLoaded: (loaded: boolean) => void;
  getGatewayInfoMap: () => Record<string, { id: string; name: string; color?: string }>;

  setModelCatalogForGateway: (gatewayId: string, models: unknown[]) => void;
  setModelCatalogFailureForGateway: (gatewayId: string, failed: boolean) => void;
  setAgentCatalogForGateway: (gatewayId: string, agents: unknown[], defaultId: string) => void;
  setToolsCatalogForGateway: (gatewayId: string, catalog: ToolsCatalog) => void;
  setEffectiveToolsState: (gatewayId: string, sessionKey: string, state: EffectiveToolsLoadState) => void;
  setSkillsStatusForGateway: (gatewayId: string, report: SkillStatusReport) => void;
  setCommandCatalogForGateway: (gatewayId: string, commands: CommandEntry[]) => void;

  onPerformerCandidate?: (taskId: string, sessionKey: string, gatewayId: string) => void;
  lookupTaskIdBySubagentKey?: (subagentKey: string) => string | undefined;
  onSubagentCandidate?: (sessionKey: string, gatewayId: string) => void;
  onApprovalRequested?: (gatewayId: string, approval: unknown) => void;
  /**
   * V3（2026-10-13 step 3）：resolved 回调从"只给 id"扩为**类型化结论** ——
   * 携带 gateway、decision 与源 request：审批索引/定时器/移除按 **gateway+id** 匹配
   * （相同 approvalId 来自不同 gateway 不串）；来自点击请求与远端确认分开；
   * RPC 失败/过期/重复 resolved 都有可分辨的结论。渲染层（I）据此迁移 removeApproval。
   */
  onApprovalResolved?: (conclusion: ApprovalResolvedConclusion) => void;
  /**
   * 网关结构化提问（`ask_user`）。**必须接**：不接的话问题一直 pending，
   * 而网关会把该 session 里用户发的任何消息当成「答案」吞掉（见 question-flow.ts）。
   */
  onQuestionRequested?: (gatewayId: string, request: unknown) => void;
  onQuestionResolved?: (id: string) => void;
  /**
   * 网关连上（含重连）时与网关对账未决问题。
   * 进程重启 / 断线期间创建的问题不会补发 `question.requested`，
   * 不对账就等于隐形挂起 —— 用户的消息会继续被吞。
   */
  syncPendingQuestions?: (gatewayId: string) => void;
  notifyAgentResponse?: (sessionKey: string) => void;
  onToast?: (type: 'error' | 'warning' | 'success', title: string, opts?: { description?: string }) => void;
  translate: TranslateFn;
  isWindowFocused: () => boolean;
  reportDebugEvent: (event: {
    domain: string;
    event: string;
    traceId?: string;
    feature?: string;
    data?: Record<string, unknown>;
  }) => void;

  hydrateFromLocal: () => Promise<void>;
  syncFromGateway: () => Promise<void>;
  syncSessionMessages: (taskId: string, sessionKeyOverride?: string, lateTool?: LateToolUpdate) => Promise<void>;
  retrySyncPending: () => void;
}

const DEDUP_FALLBACK_WINDOW_MS = 2000;

/**
 * `sessions.changed` 的 `reason` —— **没有权威词表**（这条很重要，别硬凑）。
 *
 * 运行时的类型就写着 `reason: string`：
 * `src/gateway/server-methods/session-change-event.ts` 的 `SessionChangedPayload`
 * **没有联合类型可读**。⇒ 这不是"闭集漏了几个"，而是**开放词表**。
 *
 * ⚠️ 所以这份名单和 `ITEM_STATUS_IDS` / `TOOL_PHASE_IDS` 那类常量**性质不同**：
 * - 那些是**抄运行时的类型**，可以当"已知全集"用；
 * - 这份是**数出来的**（`~/git/openclaw` 0153d84c；生产代码里 44 个带字面量 reason
 *   的发射点），**不是证明只有这些**。
 *
 * 它的用途恰恰相反：让"没见过的新 reason"能被 `unknown_reason` 记出来，
 * 然后**长进这份名单**。⇒ **别把它读成全集。**
 *
 * ⚠️ 记忆里曾经把 reason 记成"五个"（`delete`/`archive`/`cron-binding`/
 * `runner-availability`/`profile-identity`）—— 那份清单**本身就是个盖子**：
 * 真实数是 **26 个以上**。这就是为什么这里要写"数出来的"而不是"实测 N 个"。
 */
export const SESSION_CHANGE_REASONS: readonly string[] = [
  'abort',
  'archive',
  'board',
  'checkpoint-branch',
  'cleanup',
  'compact',
  'create',
  'cron-binding',
  'cron-bindings-loaded',
  'cron-continuation',
  'delete',
  'dispatch',
  'fork',
  'goal',
  'groups',
  'move',
  'owner',
  'patch',
  'placement',
  'plugin-patch',
  'profile-identity',
  'project',
  'reclaim',
  'runner-availability',
  'send',
  'sharing',
];

/** 上面那些 **+** 我们自己宽出来的两个删除别名（`SESSION_DELETE_REASONS` 里的）。 */
const SESSION_CHANGE_KNOWN_REASONS = new Set<string>([...SESSION_CHANGE_REASONS, 'deleted', 'session-delete']);

/**
 * 会话**没了**的 reason（**行为**白名单，不是"已知词表"）。
 *
 * ⚠️ 这两个别名（`deleted` / `session-delete`）在运行时发射点里**数不到** ——
 * 是我们自己宽出来的容错。所以它们进"已知"但不进 `SESSION_CHANGE_REASONS`。
 */
const SESSION_DELETE_REASONS = new Set(['delete', 'deleted', 'session-delete']);

/**
 * 空目录的退避重试间隔（ms）。
 *
 * 网关的 `models.list` 对目录加载有 **750ms 超时**，超时后直接返回空目录
 * （openclaw `dist/model-catalog-browse-*.mjs`：`return { entries: [], routeVariants: [] }`；
 * 它打的日志 "using the prepared catalog when available" 会让人以为退了缓存，其实没有）。
 * 而中转目录要联网拉，网关刚 ready 时往往还没热 —— 客户端一重连就撞上，
 * 拿到空目录**当最终结果缓存下来**，模型下拉就会一直显示「暂无可用模型」。
 * 所以空目录不算数，退避再问几次；问完还是空才认。
 *
 * ⚠️ 预算按实测定：2026-09-11 实测，冷启动的网关目录要 **30~45 秒**才热；
 * 在那之前每次 `models.list` 都恰好等满 750ms 再超时，所以退避得太密是白搭
 *（试过 1s/2s/4s 的版本，三次重试全撞在 757ms 上，最后还是空）。
 * 下面这串累计约 60 秒，覆盖整个冷启动窗口。
 */
const CATALOG_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/**
 * `run_status` 的 phase 是**闭集**，但**不是三个而是七个**。
 *
 * ⚠️ 这里原先只列了三个，理由是"openclaw `resolveRunStartupPhase` 把内部阶段归并成 3 个"。
 * **那句话只对了一半**：`resolveRunStartupPhase` 确实只产出三个，但它**不是唯一发出点** ——
 * 实测随包运行时 2026.9.3 还有两处直接发：
 * - `chat-send-handler-*.mjs`：`preparing_workspace` / `naming_worktree` / `running_setup` /
 *   `creating_worktree`（`onProgress: stage => status(stage === "setup" ? "running_setup" : "creating_worktree")`）
 * - `server-worker-placement-startup-*.mjs`：`provisioning_environment`
 *
 * 权威清单在 `sessions-*.mjs` 的 `ChatRunStartupPhaseSchema`（七个字面量），注释写着
 * *"Coarse startup stages shown while a run has not produced visible activity yet"* ——
 * 也就是说**这七个全都发生在"还没有任何可见活动"的那段**，正是用户抱怨"卡住好久"的那段死时间。
 * 只认三个 ⇒ 另外四个退化成泛化的「正在准备…」，白白丢掉网关已经告诉我们的人话。
 *
 * 认不出的 phase 依旧照常显示（界面自己退化），不能丢。
 */
const RUN_STARTUP_PHASES = new Set([
  'preparing_workspace',
  'naming_worktree',
  'creating_worktree',
  'running_setup',
  'provisioning_environment',
  'preparing_context',
  'starting_model',
]);

/**
 * **重试**相位 —— 第 8 个取值，此前不认。
 *
 * 实测（`~/git/openclaw`，2026-09-09）：`src/agents/embedded-agent-runner/run/attempt-recovery.ts`
 * 在重试时发 `{ stream:"run_status", data:{ phase:"retrying", message, attempt, maxAttempts,
 * reason, delayMs, … } }`。
 *
 * ⚠️ 而 `server-chat.ts` 的 **chat 投影会把它改写成 `phase:"starting_model"`** ——
 *    所以只有 **agent 流**上是原样的 `retrying`，正好是我们消费的那条。
 * ⚠️ 它**不算"启动"相位**（名字里的 startup 是真的在启动），所以单独列。
 *    但它要进 `RUN_PHASE_IDS`，否则界面会把它当"认不出的相位"退回泛化文案。
 */
export const RETRY_RUN_PHASE = 'retrying';

/** 供界面判断「这个 phase 有没有对应的文案」，没有就显示泛化的「正在准备…」。 */
export const RUN_PHASE_IDS: readonly string[] = [...RUN_STARTUP_PHASES, RETRY_RUN_PHASE];

/**
 * `tool` 流实测**五个** `phase` —— 权威清单，别再靠"扫一遍"。
 *
 * （`~/git/openclaw` 0153d84c，生产代码里 25 个 `stream:"tool"` 发射点逐个取 `phase`）
 *
 * | phase | 发射点 |
 * | --- | --- |
 * | `start` | `handlers.tools.start.ts`、`cli-runner/execute-events.ts` |
 * | `result` | `handlers.tools.completion.ts`、`cli-runner/execute-events.ts` |
 * | `update` | `handlers.tools.progress.ts`（只带 `partialResult`） |
 * | `review` | `bash-tools.exec-host-gateway.ts`（guardian 复核，带 `approvalReviewOutcome`） |
 * | **`input_delta`** | **`handlers.messages.update.ts`（活体编辑差异）** |
 *
 * ⚠️ 这份名单的前一版写着「**实测四个值**」，把 `input_delta` 漏了 —— 而且那是个
 * **完整性声明**。漏的原因值得记：当时只扫了 `handlers.tools.*` 那几个文件，
 * **而第五个的发射点不在那里**。「扫过一遍」被写成了「只有这些」，
 * 那句声明就成了盖子：后一个人看到"已实测四个"，就不会再去数第五个。
 * ⇒ 所以现在写成**可测的常量**，并由用例钉住（加了相位这里会红）。
 *
 * ⚠️ 名单里**没有 `error`** —— 那个值运行时一次都不发（见处理点的说明）。
 */
export const TOOL_PHASE_IDS: readonly string[] = ['start', 'result', 'update', 'review', 'input_delta'];

/**
 * 上面那五个里，**知道、但我们不改卡片状态**的四个。
 *
 * 它们不改状态是**对的**（都是非终态，卡片就该停在"进行中"）——
 * 但"不改"和"不留痕"是两件事：留痕是为了让**新冒出来的相位**在日志里一眼看得见
 * （与 `ignored_stream` / `item.ignored_kind` / `chat.ignored_state` 同一条纪律）。
 *
 * ⚠️ `input_delta` 刻意留在名单里而**不是**直接当作已知项静音：它意味着
 *    **agent 正在带活体差异地改文件** —— 那是个现在没用上、但将来可能有用的信号
 *    （`preamble` 当年就是这么被重新发现的）。让它继续在日志里现身，成本是一行。
 */
export const TOOL_IGNORED_PHASES = new Set(['start', 'update', 'review', 'input_delta']);

/**
 * `item` 流的两个词表 —— **抄运行时的类型定义**，不是我们扫出来的。
 *
 * 权威出处：`src/infra/agent-activity-events.ts`（`~/git/openclaw` 0153d84c）
 *
 * ```ts
 * type AgentItemEventPhase  = "start" | "update" | "end";
 * type AgentItemEventStatus = "running" | "completed" | "failed" | "blocked";
 * ```
 *
 * ⚠️ 写成**可测常量**，并由用例钉住（加了取值这里会红）—— 上一刀的教训：
 *    散文里那句"实测 N 个"是**不可测**的，它会变成盖子，让下一个人不再去数 N+1。
 */
export const ITEM_PHASE_IDS: readonly string[] = ['start', 'update', 'end'];
export const ITEM_STATUS_IDS: readonly string[] = ['running', 'completed', 'failed', 'blocked'];

/**
 * `item` 的 `status` 里表示**没成**的取值。
 *
 * 实测（随包运行时 2026.9.3，`builtin-openclaw-*.mjs`）：
 *
 * ```js
 * terminalErrorStatus = terminal.executionStarted ? "failed" : "blocked"
 * emitTrackedItemEvent(ctx, { …, phase: "end", kind: "tool",
 *     status: isToolError ? terminalErrorStatus : "completed", … })
 * ```
 *
 * - `failed` —— 执行了、失败了
 * - `blocked` —— **压根没执行**（被拦下）
 * - `error` —— 容错，<b>运行时的四个取值里没有它</b>（见 `ITEM_STATUS_IDS`），
 *   刻意留着别把见过的形状漏掉
 *
 * ⚠️ 少了 `blocked` 的后果：`phase:"end"` 会让它落进 `settled` ⇒ 算成 `done`
 * ⇒ **一条根本没跑的命令显示成"已完成"**。（平时被 `tool` 流 result 帧的
 * `error` 权重挡着，但那是**帧序在兜底**，不是我们认对了。）
 */
export const ITEM_FAILURE_STATUSES = new Set(['failed', 'blocked', 'error']);

/**
 * 从 `run_status` 的 data 里取重试次数（`{ attempt, maxAttempts }`）。
 *
 * ⚠️ **两个都必须是正整数才返回**：只拿到一半时给界面一个"第 2/?"没有意义，
 *    还不如退回泛化的「正在重试…」。畸形帧不该把这一轮搞坏。
 */
function readRetryProgress(data: unknown): { attempt: number; maxAttempts: number } | undefined {
  const d = data as Record<string, unknown> | undefined;
  const attempt = d?.['attempt'];
  const maxAttempts = d?.['maxAttempts'];
  if (typeof attempt !== 'number' || typeof maxAttempts !== 'number') return undefined;
  if (!Number.isInteger(attempt) || !Number.isInteger(maxAttempts)) return undefined;
  if (attempt < 1 || maxAttempts < 1) return undefined;
  return { attempt, maxAttempts };
}

/**
 * 未知事件种类的告警阈值。
 *
 * 这类问题**会反复出现**：网关的事件种类比我们的 `switch` 多 ——
 * `run_status`（首条消息 9 秒空白）和定时任务的 `heartbeat`（整页白屏）都是这么漏掉的。
 * 静默丢弃一次就够查半天，所以一分钟内累计超阈值就单独上报一条，好在遥测里被发现。
 */
const UNKNOWN_STREAM_ALERT_THRESHOLD = 10;
const UNKNOWN_STREAM_WINDOW_MS = 60_000;

/**
 * **已知形状、但刻意不接**的流 —— 它们不算"未知"。
 *
 * ## 为什么要有这份名单（2026-09-19，C2 调查的结论）
 *
 * 上面那个告警的用途是"协议里冒出我们不认识的东西了"，可它的计数不看流名，
 * 而下面这些流**是认识的**：形状实测过、决定也写在队列「未接流」那一节里。
 * 它们在真实流量里是**常态**（实测客户端日志：`command_output` 72 条、
 * `usage` 73 条），照旧计入就等于让告警在**正常流量**上响 ——
 * 实测日志里已经响过 9 次，真正的新流反而淹在里面。
 *
 * ⇒ 查名单：在名单里 → 记 `ignored_stream` **遥测**（照旧看得见）但不计数；
 *    不在名单里 → 记 `unknown_stream` 并计数。
 *
 * ⚠️ 名单**只**放"验过形状 + 决定不接"的，且每一笔都要能指到队列里的理由。
 *    放错一个（比如把某个其实会变的东西当成稳定接口）就是把告警调聋：
 *    这条名单的**任何新增**都该同时更新队列里的「未接流」表。
 *
 * 逐条理由：
 * - `usage`        —— 计费口径走 rpc 的 `report_usage_v2`，事件流这份是重复的（仅遥测）
 * - `patch`        —— 补丁类输出，与 `command_output` 同族；界面已有 patch 工具卡
 * - `command_output` —— exec 的实时输出。**C2 决定不接**：实测 delta 只比 end 早
 *                      **0.2 秒**（27 对里最长 0.5 秒），而 exec 本身最长 **2.6 秒**、
 *                      中位 0.87 秒 ⇒ 显示出来是一闪而过，用户什么也看不见。
 *                      （`status:"blocked"` 那半边已由 `approval` 流覆盖。）
 * - `stdout`/`stderr` —— 同族；`acp` 是编辑器协议桥
 * - `plan`         —— `progress_card` 内建工具产生；**B9 已定：我们的 agent 不用它**
 */
export const DELIBERATELY_IGNORED_STREAMS = new Set([
  'usage',
  'patch',
  'command_output',
  'stdout',
  'stderr',
  'acp',
  'plan',
]);

/**
 * **网关事件**里的审批家族 —— 已接的那一半。
 *
 * 权威来源：运行时的 `src/gateway/server-methods-list.ts` 的 `GATEWAY_EVENTS`
 *（`~/git/openclaw` 0153d84c）。那是一份**常量清单**（不是"数出来的"）⇒ 可以当准。
 *
 * - `exec.approval.*` → `ApprovalDialog`（`onApprovalRequested` / `onApprovalResolved`）
 * - `question.*` → `QuestionPanel`（`onQuestionRequested` / `onQuestionResolved`）
 */
export const WIRED_APPROVAL_EVENTS = new Set([
  'exec.approval.requested',
  'exec.approval.resolved',
  'question.requested',
  'question.resolved',
]);

/**
 * **知道、但没接**的审批家族 —— 收到就记一条**点名**的日志（见 `start()` 里那一段）。
 *
 * ⚠️ 三个都带 `APPROVALS_SCOPE`，而我们的连接**正好申请了** `operator.approvals`
 *    ⇒ **它们真的会送到我们这儿，然后被丢掉**。
 *
 * ⚠️ **后果要说准**：它们**不会永久卡住** —— 网关那侧有自己的审批超时
 *    （`plugin.approval.request` 的注释：*"Buffer beyond the approval timeout so the
 *    gateway can clean up"*；审批面不可用时直接按 `CANCELLED` 收场）。
 *    **真正的后果是**：用户**永远看不到这个请求** ⇒ 相关能力**静默不可用**。
 *    ⇒ 与 `exec.approval`（`23e909e`）和 `question.*`（曾锁死 15 分钟）**同一类**，
 *      只是有网关超时兜着，所以没到"卡死"那么严重。
 *
 * ⚠️ `session.approval` 的**确切含义我没验**（它由 `operator-approval-session-events.ts`
 *    发出、按 conn id 定向广播）⇒ 归在"没接"里，但**别把它的后果当成已验证的**。
 *
 * ⇒ **接不接是产品决定**，这里只做"丢得有名有姓"。
 */
export const UNWIRED_APPROVAL_EVENTS = new Set([
  'plugin.approval.requested',
  'plugin.approval.resolved',
  'openclaw.approval.requested',
  'openclaw.approval.resolved',
  'session.approval',
]);

export function createGatewayDispatcher(deps: GatewayDispatcherDeps) {
  const perTaskLastError = new Map<string, ErrorCorrelation>();
  const lifecycleErrorBuffer = new Map<
    string,
    { error: string; runId?: string; timer: ReturnType<typeof setTimeout> }
  >();
  const abortedByUser = new Set<string>();
  /** chat.final / lifecycle.end 之后仍涌来的 thinking/delta 要丢掉，否则白屏。 */
  const closedStreams = new Set<string>();
  const currentRuns = new Map<string, { runId: string; confirmed: boolean; retired: Set<string> }>();
  const pendingDispatches = new Map<
    string,
    {
      ticket: symbol;
      gatewayId: string;
      overflowReconciled?: boolean;
      frames: Array<{ event: string; payload: Record<string, unknown>; meta?: GatewayEventTransportMeta }>;
    }
  >();
  const connectedGateways = new Set<string>();
  /** 每个网关最多一个待执行的目录重试定时器（重连/成功后旧的作废）。 */
  const catalogRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  type CatalogRequest = { agentId?: string; isCurrent?: () => boolean };
  const catalogRequests = new Map<string, CatalogRequest>();
  const effectiveToolsRequestTokens = new Map<string, symbol>();
  let synced = false;

  /**
   * V2（2026-10-13 step 2）· 边界状态：执行事件的 ID 与本地回合序号**在这里分配**，
   * 映射器（`mapNativeToExecution`）保持纯函数（不调时钟/UUID/store/日志）。
   * `localFrameId` 首次接收时分配一次（落盘/重放沿用 —— V4 持久化消费方）。
   */
  let localFrameCounter = 0;
  /**
   * 实例 token（history-order 复核，2026-10-14）：`localFrameCounter` 是**本实例**的
   * 帧计数 —— dispatcher 重建（重连/重进页面）后从 0 重来，纯计数会让新事件的
   * `eventId` 与已落盘的旧事件撞 ID（幂等/去重消费方会把新事实误判成重放）。
   * 帧 ID 带实例 token ⇒ 跨实例唯一；main 侧本就是 `main#<uuid>`（见
   * `main/artifact/execution-events.ts`），两侧都满足"边界分配一次、全局唯一"。
   */
  const frameInstanceToken = (() => {
    try {
      return crypto.randomUUID().slice(0, 8);
    } catch {
      return Math.random().toString(36).slice(2, 10);
    }
  })();
  /** 每会话的本地接收序号（lastSeq 单调性用）；有界：超过上限清最旧。 */
  const sessionSeqCounters = new Map<string, number>();
  const SESSION_SEQ_COUNTER_LIMIT = 256;

  function beginDispatch(gatewayId: string, sessionKey: string): symbol {
    const ticket = Symbol();
    const taskId = resolveTaskId(sessionKey);
    if (!deps.getTaskStore().tasks.some((task) => task.id === taskId && task.gatewayId === gatewayId)) {
      throw new Error('Dispatch gateway does not own the task');
    }
    if (!pendingDispatches.has(sessionKey) && pendingDispatches.size >= 128) {
      debugEvent('renderer.dispatch.buffer_limit', { gatewayId, sessionKey });
      throw new Error('Dispatch buffer limit reached');
    }
    pendingDispatches.set(sessionKey, { ticket, gatewayId, frames: [] });
    return ticket;
  }

  function bindRun(sessionKey: string, runId: string, confirmed: boolean): void {
    const previous = currentRuns.get(sessionKey);
    const retired = previous?.retired ?? new Set<string>();
    if (previous && previous.runId !== runId) retired.add(previous.runId);
    if (retired.size > 16) retired.delete(retired.values().next().value!);
    currentRuns.set(sessionKey, { runId, confirmed, retired });
    closedStreams.delete(sessionKey);
    const store = deps.getMessageStore();
    const activeRunId = store.activeTurnBySession[sessionKey]?.runId;
    if (activeRunId && activeRunId !== runId) {
      // run-promotion（2026-10-14）：带期望 run 的清理 —— 只收拾**旧轮**自己的残留，
      // 迟到/重放路径不得误删已属于新轮的投影。
      store.clearActiveTurn(sessionKey, { runId: activeRunId });
    }
    // run-promotion（2026-10-14）：可信 run 绑定/新轮确认边界 = **显式建立 execution scope**。
    // 没有它，canonical 提升摘掉 activeTurn 后留下的孤立投影会一直挡住下一轮：
    // 归约器按 runId 拒收新轮事件 ⇒ 投影不切换、执行历史记录为 0。
    // 同 run（重连/重复确认）幂等；归约器的跨 run 拒收规则不变。
    store.beginExecutionRun?.(sessionKey, runId);
  }

  function settleDispatch(ticket: symbol, receipt?: ChatDispatchReceipt, accepted = true): void {
    for (const [sessionKey, pending] of pendingDispatches) {
      if (pending.ticket !== ticket) continue;
      pendingDispatches.delete(sessionKey);
      if (!accepted) return;
      if (receipt) {
        if (receipt.sessionKey !== sessionKey || !receipt.runId.trim()) return;
        bindRun(sessionKey, receipt.runId, true);
      } else currentRuns.delete(sessionKey);
      for (const frame of pending.frames) {
        routeRunFrame({
          event: frame.event,
          gatewayId: pending.gatewayId,
          payload: frame.payload,
          ...(frame.meta ? { meta: frame.meta } : {}),
        });
      }
      return;
    }
  }

  /**
   * V2（2026-10-13 step 2）· 旁路映射：在**已有归属/陈旧 run 守卫之后**调用（调用点分别在
   * `handleChatEvent` / `handleAgentEvent` 的守卫链下游），把原生帧映射成执行事件并折进
   * store 的执行投影。纯映射 + 纯归约，不改写任何既有写入路径 —— 逐事件族接管是后续步骤
   *（同一路径只允许一个写入者）。
   */
  /** 分配一帧的事件预算（localFrameId / receivedAt / seq）—— 映射与顶层审批折叠共用。 */
  function nextFrameBudget(sessionKey: string): { localFrameId: string; receivedAt: number; seq: number } {
    if (sessionSeqCounters.size >= SESSION_SEQ_COUNTER_LIMIT && !sessionSeqCounters.has(sessionKey)) {
      const oldest = sessionSeqCounters.keys().next().value;
      if (oldest !== undefined) sessionSeqCounters.delete(oldest);
    }
    const seq = (sessionSeqCounters.get(sessionKey) ?? -1) + 1;
    sessionSeqCounters.set(sessionKey, seq);
    localFrameCounter += 1;
    return { localFrameId: `${frameInstanceToken}-${localFrameCounter}`, receivedAt: Date.now(), seq };
  }

  function mapAndFoldExecution(sessionKey: string, frame: GatewayEvent, taskId: string, logicalRunId: string): void {
    const budget = nextFrameBudget(sessionKey);
    const context: ExecutionMapContext = {
      localFrameId: budget.localFrameId,
      receivedAt: budget.receivedAt,
      seq: budget.seq,
      taskId,
      logicalRunId,
      channel: frame.meta?.channel ?? 'unknown',
      ...(frame.meta?.connectionEpoch !== undefined ? { connectionEpoch: frame.meta.connectionEpoch } : {}),
      nativeSessionKey: sessionKey,
      evidence: 'observed',
    };
    const events = mapNativeToExecution(frame, context);
    // ⚠️ 可选调用（与 `bindActiveRun?.` 同纪律）：真实 store 有该动作；测试/旧接线的手写
    // mock store 没有它 —— 旁路映射缺了它只影响投影，不打断任何既有写入路径。
    if (events.length > 0) deps.getMessageStore().applyExecutionEvents?.(sessionKey, events);
  }

  /**
   * V3：顶层 `exec.approval.requested/resolved` 事件（无 session 守卫链）—— 从
   * payload.request 解析归属（sessionKey/runId/toolCallId），归属可解析时折进该会话的
   * 执行投影；不可解析则只留遥测（cron/陌生 session 不归前台）。
   */
  function foldApprovalTopLevel(frame: GatewayEvent, kind: 'requested' | 'resolved'): void {
    const payload = frame.payload as Record<string, unknown>;
    const request = payload.request as Record<string, unknown> | null | undefined;
    const sessionKey = request && typeof request.sessionKey === 'string' ? request.sessionKey : undefined;
    if (!sessionKey) return;
    const taskId = resolveTaskId(sessionKey);
    if (!taskId) return;
    const logicalRunId = request && typeof request.runId === 'string' ? request.runId : '';
    const toolCallId = request && typeof request.toolCallId === 'string' ? request.toolCallId : undefined;
    const approvalId = typeof payload.id === 'string' ? payload.id : undefined;
    if (!approvalId) return;

    const budget = nextFrameBudget(sessionKey);
    const base = {
      schemaVersion: 1 as const,
      eventId: `${budget.localFrameId}#0`,
      seq: budget.seq,
      runId: logicalRunId,
      taskId,
      source: {
        gatewayId: frame.gatewayId,
        channel: (frame.meta?.channel ?? 'unknown') as ExecutionChannel,
        ...(frame.meta?.connectionEpoch !== undefined ? { connectionEpoch: frame.meta.connectionEpoch } : {}),
        nativeSessionKey: sessionKey,
        ...(logicalRunId !== '' ? { nativeRunId: logicalRunId } : {}),
        event: frame.event,
        derivedIndex: 0,
      },
      ...(toolCallId !== undefined ? { stepId: toolCallId } : {}),
      evidence: 'observed' as const,
      receivedAt: budget.receivedAt,
    };
    const event: ExecutionEvent =
      kind === 'requested'
        ? {
            ...base,
            type: 'approval.requested',
            payload: { approvalId, ...(toolCallId !== undefined ? { toolCallId } : {}), status: 'pending' },
          }
        : {
            ...base,
            type: 'approval.resolved',
            payload: {
              approvalId,
              ...(toolCallId !== undefined ? { toolCallId } : {}),
              decision: typeof payload.decision === 'string' ? payload.decision : '(missing)',
            },
          };
    deps.getMessageStore().applyExecutionEvents?.(sessionKey, [event]);
  }

  function acceptsRun(sessionKey: string, runId: string | undefined, start = false): boolean {
    if (!runId) return true;
    const current = currentRuns.get(sessionKey);
    if (!current) {
      bindRun(sessionKey, runId, false);
      return true;
    }
    if (current.runId === runId) return true;
    if ((current.confirmed && !closedStreams.has(sessionKey)) || current.retired.has(runId) || !start) return false;
    bindRun(sessionKey, runId, false);
    return true;
  }

  function reconcileRun(taskId: string, sessionKey: string): void {
    if (deps.isEphemeralSession?.(sessionKey)) return;
    deps
      .syncSessionMessages(taskId, sessionKey)
      .catch((error) => console.error('[dispatcher] stale run sync failed', error));
  }

  function routeRunFrame(frame: GatewayEvent): void {
    const { event, payload, gatewayId } = frame;
    const sessionKey = payload.sessionKey;
    const pending = typeof sessionKey === 'string' ? pendingDispatches.get(sessionKey) : undefined;
    if (pending && pending.gatewayId === gatewayId) {
      if (pending.frames.length >= 64) {
        pending.frames.shift();
        debugEvent('renderer.dispatch.frame_buffer_limit', { gatewayId, sessionKey });
        const taskId = resolveTaskId(sessionKey as string);
        if (taskId && !pending.overflowReconciled) {
          pending.overflowReconciled = true;
          reconcileRun(taskId, sessionKey as string);
        }
      }
      pending.frames.push({ event, payload, meta: frame.meta });
      return;
    }
    if (event === 'chat') handleChatEvent(payload as unknown as ChatEventPayload, gatewayId, frame);
    else handleAgentEvent(payload as unknown as AgentEvent, gatewayId, frame);
  }

  /**
   * 未知流的窗口与计数 —— **按流名各算各的**（§11）。
   *
   * ⚠️ 原来只有一个**全局**计数器，于是告警里那个 `stream` 根本不是肇事者，
   * 只是"凑够第 10 条的那个"。实测日志里 9 次告警的 `stream` 分别是
   * `thinking` / `item` / `usage` —— 其中 `thinking` 和 `item` 是我们**已经处理**的流。
   * 照那条告警去查，只会查到一个没问题的流。
   *
   * 按流分开之后，"同一个陌生流反复出现"才是信号（10 条混合的陌生流不算），
   * 阈值与窗口都没动（仍是 10 / 60 秒）。
   */
  const unknownStreamWindows = new Map<string, { windowStart: number; count: number }>();

  /**
   * 同时跟踪的流名上限。
   *
   * ⚠️ 这张表的键是**外部数据**（网关给的流名）。不设上限的话，一个随机流名的发送方
   * 就能让它无界增长 —— 那是个长驻进程里的内存泄漏。满了先清过期的，还满就丢最早的
   * （被丢的那个最多少报一次告警，代价可接受）。
   */
  const UNKNOWN_STREAM_MAX_TRACKED = 64;

  /** 未知事件种类计数；**同一个流**超阈值时额外上报一条，避免它们永远只躺在 debug 日志里。 */
  function noteUnknownStream(stream: string | undefined, taskId: string, sessionKey: string): void {
    const now = Date.now();
    const key = stream ?? '(missing)';

    if (unknownStreamWindows.size >= UNKNOWN_STREAM_MAX_TRACKED) {
      for (const [k, w] of unknownStreamWindows) {
        if (now - w.windowStart > UNKNOWN_STREAM_WINDOW_MS) unknownStreamWindows.delete(k);
      }
      if (unknownStreamWindows.size >= UNKNOWN_STREAM_MAX_TRACKED) {
        const oldest = unknownStreamWindows.keys().next().value;
        if (oldest !== undefined) unknownStreamWindows.delete(oldest);
      }
    }

    const prev = unknownStreamWindows.get(key);
    const next =
      !prev || now - prev.windowStart > UNKNOWN_STREAM_WINDOW_MS
        ? { windowStart: now, count: 1 }
        : { windowStart: prev.windowStart, count: prev.count + 1 };
    unknownStreamWindows.set(key, next);

    if (next.count === UNKNOWN_STREAM_ALERT_THRESHOLD) {
      deps.reportDebugEvent({
        domain: 'renderer',
        event: 'renderer.agent.unknown_stream.threshold',
        data: {
          stream: stream ?? null,
          // ⚠️ 是**这个流自己的**次数，不是全局累计 —— 告警要能直接读懂
          count: next.count,
          windowMs: UNKNOWN_STREAM_WINDOW_MS,
          taskId,
          sessionKey,
        },
      });
    }
  }

  function debugEvent(
    event: string,
    data: Record<string, unknown>,
    extra?: { traceId?: string; feature?: string },
  ): void {
    console.debug(`[debug] ${event}`, data);
    deps.reportDebugEvent({ domain: 'renderer', event, traceId: extra?.traceId, feature: extra?.feature, data });
  }

  function maybeNotify(
    settingKey: NotificationSettingKey,
    params: { title: string; body: string; taskId?: string },
  ): void {
    deps
      .getSettings()
      .then((settings) => {
        if (settings?.notifications?.[settingKey] === false) return;
        deps.sendNotification(params);
      })
      .catch((err) => console.error('[gateway-dispatcher] getSettings failed:', err));
  }

  function isSameFailure(a: ErrorCorrelation, existing: ErrorCorrelation): boolean {
    if (a.taskId !== existing.taskId) return false;
    if (a.runId && existing.runId) return a.runId === existing.runId;
    if (a.code && existing.code) return a.code === existing.code && a.source === existing.source;
    return false;
  }

  function shouldDisplayError(correlation: ErrorCorrelation): boolean {
    const existing = perTaskLastError.get(correlation.taskId);
    if (!existing) return true;
    if (isSameFailure(correlation, existing)) return false;
    if (Date.now() - existing.displayedAt < DEDUP_FALLBACK_WINDOW_MS) {
      if (
        !correlation.runId &&
        !existing.runId &&
        !correlation.code &&
        !existing.code &&
        correlation.source === existing.source &&
        correlation.rawMessage === existing.rawMessage
      )
        return false;
    }
    return true;
  }

  function recordDisplayedError(correlation: ErrorCorrelation): void {
    perTaskLastError.set(correlation.taskId, { ...correlation, displayedAt: Date.now() });
  }

  function clearTaskErrorState(taskId: string): void {
    perTaskLastError.delete(taskId);
    abortedByUser.delete(taskId);
    const buffered = lifecycleErrorBuffer.get(taskId);
    if (buffered) {
      clearTimeout(buffered.timer);
      lifecycleErrorBuffer.delete(taskId);
    }
    // 临时会话的缓冲键是**会话键**（见 handleAgentLifecycleStream）。这一轮已经开始出正文了，
    // 那条待发的失败就不该再补到该列上 —— 不清的话界面会出现「正在输出 + 同时报错」。
    for (const key of [...lifecycleErrorBuffer.keys()]) {
      if (key === taskId || parseTaskIdFromSessionKey(key) !== taskId) continue;
      const stale = lifecycleErrorBuffer.get(key)!;
      clearTimeout(stale.timer);
      lifecycleErrorBuffer.delete(key);
    }
  }

  function resolveTaskId(sessionKey: string): string | null {
    const direct = parseTaskIdFromSessionKey(sessionKey);
    if (direct) return direct;
    const mapped = deps.lookupTaskIdBySubagentKey?.(sessionKey);
    return mapped ?? null;
  }

  function resolveTaskIdFromSpawnedBy(spawnedBy?: string): string | null {
    if (!spawnedBy) return null;
    const mapped = deps.lookupTaskIdBySubagentKey?.(spawnedBy);
    if (mapped) return mapped;
    return parseTaskIdFromSessionKey(spawnedBy);
  }

  /**
   * chat 帧里**知道但不接**的 `state`。
   *
   * `status` —— 运行时**会发**（`ChatStatusEventSchema`），内容是**准备相位 + 重试次数**
   * （`{ phase, retry: { attempt, maxAttempts, reason } }`）。而这两样我们已经在
   * `agent` 的 `run_status` 流上消费了，且相位清单**逐字相同**
   * （运行时的 `ChatRunStartupPhaseSchema` 对我们 `RUN_STARTUP_PHASES` 的 7 个）
   * ⇒ 这是**同一条信息的第二个来源**，接进来只会多一处要同步的状态。
   *
   * ⚠️ 名单只放**验过会发、且我们决定不接**的。认不出的要落到 `unknown_state` ——
   *    那才是要看见的信号（`item.kind` 那次就是这么把 `preamble` 暴露出来的）。
   */
  const DELIBERATELY_IGNORED_CHAT_STATES = new Set(['status']);

  /**
   * F1（2026-10-08 终审）：**帧级活动封印** —— 一帧里多项都真变化时，"最新活动是谁"必须按
   * **content blocks 的真实顺序**定，不能沿用提取字段后的固定处理顺序（正文→思考→工具）。
   *
   * `changed` 由各写入点的 **state 引用前后比较** 收集：写入器在内容没变时不重写 state
   * （R1 的变化门），所以"引用没变 = 这一项没变"。`sealTurnActivity` 负责按给定顺序
   * 一次算定 kind / revision / 思考段号。
   */
  function sealChatFrameActivity(
    sessionKey: string,
    changed: ReadonlyArray<{ kind: 'output' | 'thinking' | 'tools'; index: number }>,
  ): void {
    if (changed.length === 0) return;
    // 两边都有块序 ⇒ 按块序；块序缺失（例如纯 deltaText 帧）⇒ 稳定排序回落到处理顺序。
    const ordered = [...changed].sort((a, b) => (a.index >= 0 && b.index >= 0 ? a.index - b.index : 0));
    deps.getMessageStore().sealTurnActivity?.(
      sessionKey,
      ordered.map((entry) => entry.kind),
    );
  }

  /**
   * BUG-075 r3/r4（2026-10-13 第三次/窄复核反例）：思考与工具**按 content blocks 的
   * 真实顺序、逐块写入**，且**工具两侧的思考块分属不同段**。
   *
   * 血案（r3）：`upsertToolCall` 的**新工具 id = 思考段边界**（seal 当前段）。固定
   * 「先思考后工具」会把 `[工具, 新思考]` 帧里工具之后的新思考错误归档；反过来固定
   * 「先工具后思考」会把 `[思考, 工具]` 弄错 ⇒ 必须按块序交错。
   *
   * 血案（r4，多思考块跨工具）：此前把全部 thinking 块**拼成一个串**（parse-content
   * 的 extractThinking）写在最后一个块的位置。`[A, T, B]` 帧因此被写成一次 'AB'
   * 追加：工具前的 A 是**已完成段快照**，被错误地重发进当前段（实得 `A\n\nAB`，
   * 应得 `A\n\nB`）。⇒ 逐块处理，**帧内最后一个 thinking 块 = 当前段的实时累计快照
   *（照常并入当前段）；其余 thinking 块 = 历史候选**：若与当前段无关、且能被识别为
   * 已完成段的重发（= 刚归档段的前缀/相等，或**命中已完成文本的段边界**），则跳过
   *（绝不写进当前段、也不归档当前段）；识别不中（如首次投递的历史块）照常走合并，
   * 由其后的工具块正常归档。块序缺失（-1）的写入保持原相对顺序排最后。
   */
  function writeFrameContentInBlockOrder(
    sessionKey: string,
    taskId: string,
    payload: ChatEventPayload,
    toolCalls: readonly ToolCall[],
    toolIndices: readonly number[],
    changed: Array<{ kind: 'output' | 'thinking' | 'tools'; index: number }>,
    readTurn: () =>
      | {
          id: string;
          thinkingCompleted?: string;
          thinkingCurrent?: string;
          thinkingLastSealed?: string;
        }
      | undefined,
  ): void {
    const blocks = payload.message?.content ?? payload.content ?? [];
    type FrameWrite =
      | { kind: 'thinking'; text: string; index: number }
      | { kind: 'tools'; index: number; tc: ToolCall };
    const writes: FrameWrite[] = [];
    toolCalls.forEach((tc, i) => writes.push({ kind: 'tools', index: toolIndices[i] ?? -1, tc }));
    blocks.forEach((block, index) => {
      if (block.type === 'thinking' && block.thinking) {
        writes.push({ kind: 'thinking', text: block.thinking, index });
      }
    });
    const ordered = writes
      .map((write, seq) => ({ write, seq }))
      .sort((a, b) => {
        const ai = a.write.index >= 0 ? a.write.index : Number.MAX_SAFE_INTEGER;
        const bi = b.write.index >= 0 ? b.write.index : Number.MAX_SAFE_INTEGER;
        return ai - bi || a.seq - b.seq;
      })
      .map((entry) => entry.write);
    const lastThinkingIndex = writes.reduce(
      (max, write) => (write.kind === 'thinking' && write.index > max ? write.index : max),
      -1,
    );
    for (const write of ordered) {
      const before = readTurn();
      if (write.kind === 'thinking') {
        const isHistoricCandidate = write.index >= 0 && write.index !== lastThinkingIndex;
        if (isHistoricCandidate) {
          const completed = before?.thinkingCompleted ?? '';
          const current = before?.thinkingCurrent ?? '';
          const sealed = before?.thinkingLastSealed ?? '';
          const relatesCurrent =
            current !== '' &&
            (current === write.text || current.startsWith(write.text) || write.text.startsWith(current));
          // 识别一：刚归档段的前缀/相等（含"已被更新版本覆盖"的窄形状——识别即可跳过）。
          const recognizedSealed =
            sealed !== '' && (sealed === write.text || sealed.startsWith(write.text) || write.text.startsWith(sealed));
          // 识别二：命中已完成文本的**段边界**（'…\n\n' + block + '\n\n…'）——
          // 覆盖"非最近段"的历史重发（多工具帧里中间那些旧块）；不做裸 includes，
          // 防止吞掉与历史同文的合法新段（第二轮复审口径）。
          const recognizedCompleted = completed !== '' && `\n\n${completed}\n\n`.includes(`\n\n${write.text}\n\n`);
          if (!relatesCurrent && (recognizedSealed || recognizedCompleted)) {
            debugEvent('renderer.chat.thinking.historic_block_skipped', {
              taskId,
              sessionKey,
              chars: write.text.length,
              index: write.index,
              via: recognizedSealed ? 'sealed' : 'completed',
            });
            continue; // 重发的历史块：不写当前段、不归档当前段、不算活动
          }
        }
        deps.getMessageStore().appendThinkingDelta(sessionKey, write.text);
      } else {
        deps.getMessageStore().upsertToolCall(sessionKey, taskId, write.tc);
      }
      if (readTurn() !== before) changed.push({ kind: write.kind, index: write.index });
    }
  }

  /** 该类型 block 在 content 里的**最后一个**位置；没有 ⇒ -1（表示"块序不可用"）。 */
  function lastContentBlockIndex(payload: ChatEventPayload, type: 'text' | 'thinking' | 'toolCall'): number {
    const blocks = payload.message?.content ?? payload.content;
    if (!blocks) return -1;
    let idx = -1;
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i]?.type === type) idx = i;
    }
    return idx;
  }

  /**
   * G1（2026-10-08 集中终审 · 条件防御）：**每个有效 toolCall block 各自的位置**。
   *
   * 此前工具循环把所有变化的工具都记成 `lastContentBlockIndex(payload, 'toolCall')`
   * （= 最后一个 toolCall block 的位置）；当同一帧里出现 `[新工具, 新思考, 旧工具回声]`
   * 这类插入/重排快照时，会把排在前面的新工具抬到思考之后 ⇒ 相位定音错误。
   * 有效块过滤必须与 `extractToolCalls` 一致（`type/id/name` 三条件），
   * 保证 `toolCalls[i]` 与返回数组逐位对应。
   */
  function toolCallContentIndices(payload: ChatEventPayload): number[] {
    const blocks = payload.message?.content ?? payload.content;
    if (!blocks) return [];
    const indices: number[] = [];
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'toolCall' && block.id && block.name) indices.push(index);
    }
    return indices;
  }

  /** F1：工具写入 + 帧封（重复快照不重写 state ⇒ 引用比较即"真的变了"）。 */
  function upsertToolCallTracked(sessionKey: string, taskId: string, tc: ToolCall): void {
    const readTurn = () => deps.getMessageStore().activeTurnBySession[sessionKey];
    const before = readTurn();
    deps.getMessageStore().upsertToolCall(sessionKey, taskId, tc);
    if (readTurn() !== before) deps.getMessageStore().sealTurnActivity?.(sessionKey, ['tools']);
  }

  function handleChatEvent(payload: ChatEventPayload, gatewayId: string, frame?: GatewayEvent): void {
    const { sessionKey, state } = payload;
    if (!sessionKey) {
      debugEvent('renderer.event.dropped.missing_session', { state });
      return;
    }

    if (isSystemSession(sessionKey)) return;

    const taskId = resolveTaskId(sessionKey);
    if (!taskId) {
      if (isSubagentSession(sessionKey)) {
        deps.onSubagentCandidate?.(sessionKey, gatewayId);
        debugEvent('renderer.event.subagent_candidate', { gatewayId, sessionKey, state });
      } else {
        debugEvent('renderer.event.dropped.invalid_task', { sessionKey, state });
      }
      return;
    }

    const localTasks = deps.getTaskStore().tasks;
    const matchedTask = localTasks.find((t) => t.id === taskId);
    if (!matchedTask) {
      debugEvent('renderer.event.dropped.unknown_task', { taskId, sessionKey, state });
      return;
    }
    if (matchedTask.gatewayId !== gatewayId) {
      debugEvent('renderer.event.dropped.foreign_gateway', { taskId, sessionKey, gatewayId });
      return;
    }
    if (
      !acceptsRun(
        sessionKey,
        payload.runId,
        state === 'error' && closedStreams.has(sessionKey) && !deps.getMessageStore().activeTurnBySession[sessionKey],
      )
    ) {
      if (state === 'final') reconcileRun(taskId, sessionKey);
      debugEvent('renderer.chat.dropped.stale_run', { taskId, sessionKey, runId: payload.runId });
      return;
    }

    const ephemeral = deps.isEphemeralSession?.(sessionKey) === true;

    const store = deps.getMessageStore();
    // V2 旁路映射：在归属/陈旧 run 守卫**之后**执行 —— chat 声明（step.declared）与
    // model 终态事件折进执行投影；正文/思考写入仍走原逐块 helper（同一路径一个写入者）。
    if (frame) {
      const logicalRunId = payload.runId ?? store.activeTurnBySession[sessionKey]?.runId ?? '';
      mapAndFoldExecution(sessionKey, frame, taskId, logicalRunId);
    }
    const text = extractText(payload);
    const thinking = extractThinking(payload);
    const toolCalls = extractToolCalls(payload);

    /**
     * ⭐ 「助手回应了」的判据 = **这一帧真的带了回应**（正文/推理/工具），
     * 或者这一轮**结束了**（`final`/`aborted`/`error`）。
     *
     * ⚠️ 只看 `state` 是不够的：`state:"status"`（准备相位的 chat 投影）**一个字都没有**，
     * 却被当成"回应了" ⇒ 下游 `composer.notifyResponse` 把 `processing` 关掉
     * ⇒ `MainArea` 的等待块**卸载又重建**。
     * 2026-09-20 实机取证（包住 `setProcessing` 抓调用栈）：一次发送里它被
     * `+1581ms → false`、`+2148ms → true`、`+2235ms → false` 这样来回拨，
     * 而这两次 `false` 都是 `handleChatEvent` → `notifyAgentResponse` 打出来的 ——
     * 用户看到的就是「我发完要求，那个对话头像会消失一下」。
     */
    const carriesResponse =
      Boolean(text || thinking || toolCalls.length > 0) ||
      state === 'final' ||
      state === 'aborted' ||
      state === 'error';

    if (!ephemeral) {
      // ⚠️ `onPerformerCandidate` **不跟着 `carriesResponse` 走**：它记的是
      //    "这个会话在参与这个任务"（**路由事实**），不是"有内容可看"。
      //    一个 worker 只要开着就已经是 performer 了，等它有正文再登记会让房间/派活名单晚一拍。
      if (matchedTask.ensemble && sessionKey !== matchedTask.sessionKey) {
        deps.onPerformerCandidate?.(taskId, sessionKey, matchedTask.gatewayId);
      }

      if (carriesResponse) {
        // 未读小红点的语义 = "那边**有内容**可看"。纯状态帧点亮它，用户点进去一脸茫然
        // （与 `notify` 同一类错误、同一个出口，2026-09-20 一起收掉）。
        if (taskId !== deps.getActiveTaskId()) deps.markUnread(taskId);
        deps.notifyAgentResponse?.(sessionKey);
      }
    }

    if (state === 'delta') {
      if (closedStreams.has(sessionKey)) {
        debugEvent('renderer.chat.dropped_after_final', {
          taskId,
          sessionKey,
          stream: 'delta',
          chars: extractDeltaText(payload).text.length,
        });
        return;
      }
      clearTaskErrorState(taskId);
      if (payload.runId) store.bindActiveRun?.(sessionKey, payload.runId);
      // ⭐ **追加还是替换**：delta 帧的 `message.content` 是**全文快照**（白皮书 §4.2 原文），
      //    只有 v4 的 `deltaText` 才是增量。一律追加会把正文重复膨胀（实测 5–57 倍）。
      const delta = extractDeltaText(payload);
      // F1：逐项写入 + 变更收集。⚠️ `store` 是入口处捕的**状态快照**，读现态必须走
      //     `getMessageStore()`（生产接线每次返回最新 state）；写入器内容没变时不重写 state，
      //     所以"引用没变 = 这一项没变"。
      const readTurn = () => deps.getMessageStore().activeTurnBySession[sessionKey];
      const changed: Array<{ kind: 'output' | 'thinking' | 'tools'; index: number }> = [];
      if (delta.text) {
        store.setProcessing(sessionKey, false);
        const before = readTurn();
        if (delta.replace) store.replaceStreamText(sessionKey, delta.text);
        else store.appendStreamDelta(sessionKey, delta.text);
        if (readTurn() !== before) changed.push({ kind: 'output', index: lastContentBlockIndex(payload, 'text') });
        debugEvent('renderer.chat.delta.applied', {
          taskId,
          sessionKey,
          chars: delta.text.length,
          replace: delta.replace,
        });
      }
      // G1/F1 + BUG-075 r3：思考与工具**按 content blocks 真实顺序交错写入**——
      // 工具 upsert 的新 id 是思考段边界，固定序会把 `[工具, 新思考]` 归档错位
      //（见 helper 注释与第三次复审反例）；每个工具取它自己的 block 位置。
      writeFrameContentInBlockOrder(
        sessionKey,
        taskId,
        payload,
        toolCalls,
        toolCallContentIndices(payload),
        changed,
        readTurn,
      );
      // 帧尾一次定音：多项真变化按 **content blocks 顺序**决定"最新活动"（F1）。
      sealChatFrameActivity(sessionKey, changed);
    } else if (state === 'final') {
      if (payload.runId) store.bindActiveRun?.(sessionKey, payload.runId);
      store.setProcessing(sessionKey, false);
      closedStreams.add(sessionKey);
      const readTurn = () => deps.getMessageStore().activeTurnBySession[sessionKey];
      const changed: Array<{ kind: 'output' | 'thinking' | 'tools'; index: number }> = [];
      // `final` 带的同样是**完整正文** ⇒ 替换（追加等于把答案再重复一遍）
      if (text) {
        const before = readTurn();
        store.replaceStreamText(sessionKey, text);
        if (readTurn() !== before) changed.push({ kind: 'output', index: lastContentBlockIndex(payload, 'text') });
      }
      debugEvent('renderer.chat.final.received', { taskId, sessionKey, chars: text.length });
      // G1/F1 + BUG-075 r3：final 分支与 delta 同形——思考/工具按块序交错（见 helper）。
      writeFrameContentInBlockOrder(
        sessionKey,
        taskId,
        payload,
        toolCalls,
        toolCallContentIndices(payload),
        changed,
        readTurn,
      );
      sealChatFrameActivity(sessionKey, changed);
      store.finalizeStream(sessionKey, { runId: payload.runId });
      debugEvent('renderer.chat.finalized', { taskId, sessionKey });
      // 临时会话到此为止：正文留在 activeTurn 里（各列自己显示），
      // 不进时间线、不改标题、不发通知、**不拉网关历史**。
      // 最后一条尤其重要 —— `syncSessionMessages` 会把这轮回复 promote 进任务时间线，
      // 那正是"没采纳的答案自己跑进对话里"的路径。
      if (!ephemeral) {
        autoTitleIfNeeded(taskId, sessionKey, deps.getTaskStore, deps.getMessageStore);
        // R5（2026-10-14 集中修复）：chat.final **一律不直接**弹"任务完成" —— 完成资格
        // 统一由 `evaluateRunCompletion`（execution-projection 的单一真源）在**封口后**
        // 判定，renderer 交付出口（`useDeliverySettlementNotification`）消费并发送现场
        // 转变通知。为什么不能在 final 当场发（复审旁路一/二/三）：
        //   · final 看到 `delivery.phase === 'none'` **不能证明**这是普通聊天 —— 可信
        //     operation 登记经异步最终交付路径（消息落地时 finalizeAssistantArtifacts）
        //     才到 renderer，先发完成就会"完成后又收到 started"；
        //   · 同 run 已 settled/failed/unconfirmed/partial 时也不能沿用"完成"；
        //   · 需求集合需要"封口"条件（登记窗口关闭）后才能判"全部结算"。
        // 这里只留痕并交接；封口信号 = 模型相位结束 + 轮次关闭（见 renderer 侧实现，
        // 登记广播先于轮次关闭送达，见 `delivery-settlement-notification.ts` 头注）。
        debugEvent('renderer.chat.task_complete_deferred', { taskId, sessionKey });
        deps.syncSessionMessages(taskId, sessionKey).catch((err) => {
          debugEvent('renderer.sync.post-final.failed', {
            taskId,
            sessionKey,
            error: err instanceof Error ? err.message : 'unknown',
          });
        });
      }
    } else if (state === 'error') {
      store.setProcessing(sessionKey, false);
      closedStreams.add(sessionKey);
      // ⭐ BUG-050：这一轮"已产出"的证据必须在 `clearActiveTurn` **之前**快照 ——
      //    清掉之后就再也读不到了，1.5s 后渲染层评估自动重试时会恒判"什么都没做"
      //    ⇒ 一个已经跑过 write/exec 的轮次被整轮重发（副作用重复，不可逆）。
      //    下面登记候选时把它带出去（`AutoRetryFailure.producedOutput`）。
      const producedOutput = activeTurnProducedOutput(store.activeTurnBySession[sessionKey]);
      // run-promotion（2026-10-14）：带本轮 runId 的清理 —— 迟到的失败帧不得误删新轮投影；
      // 帧没带 runId 时退回无条件清理（旧行为，无法归属就按"明确的整轮失败"处理）。
      if (payload.runId) store.clearActiveTurn(sessionKey, { runId: payload.runId });
      else store.clearActiveTurn(sessionKey);

      const errorCode = payload.errorCode ?? payload.error?.code;
      const rawMessage =
        payload.errorMessage ??
        payload.error?.message ??
        (extractText(payload) || deps.translate('errors.requestFailed'));

      debugEvent('renderer.chat.error', { taskId, sessionKey, rawMessage, code: errorCode, runId: payload.runId });

      if (isSubagentSession(sessionKey) && /^\s*terminated\s*$/i.test(rawMessage)) {
        debugEvent('renderer.chat.subagent_terminated', { taskId, sessionKey });
        return;
      }

      const buffered = lifecycleErrorBuffer.get(taskId);
      if (buffered) {
        clearTimeout(buffered.timer);
        lifecycleErrorBuffer.delete(taskId);
      }

      const errorDetails = payload.error?.details;
      const appError = buildAppError({
        source: 'upstream',
        stage: 'stream',
        rawMessage,
        code: errorCode,
        // ⭐ 结构化类别：chat 错误帧只有它（`errorCode` / `error` 在协议 schema 里不存在，
        //    所以上面那个 `errorCode` 在这条路上**永远是 undefined**）。
        //    没有它，我们只能按各厂商五花八门的措辞猜。
        kind: payload.errorKind,
        details: errorDetails,
      });
      const correlation: ErrorCorrelation = {
        taskId,
        runId: payload.runId,
        code: errorCode,
        source: 'upstream',
        rawMessage,
        displayedAt: 0,
      };

      if (ephemeral) {
        // 临时会话的失败**总是**要显示在该列上：`shouldDisplayError` 是按 taskId 去重的，
        // N 列同时撞上同一个错误时它会把第 2..N 列吃掉 —— 那就不是"失败隔离"了。
        store.setSessionError(sessionKey, formatErrorForUser(appError, deps.translate));
      } else if (shouldDisplayError(correlation)) {
        const userText = formatErrorForUser(appError, deps.translate);
        const shown = store.addMessage(taskId, 'system', userText, undefined, { sessionKey });
        // ⭐ B10：只有**重试真能改变结果**的失败才登记 —— 界面据此给「重试」按钮。
        //    `'no'`（模型拒答 / 上下文超长）与 `'unknown'` 一律不给：前者重发必然再失败，
        //    后者我们根本不知道，两种情况下给按钮都是劝用户白花一次钱。
        //    紧跟在 `addMessage` 之后（而不是提前算），是因为按钮要挂在**这一条**消息上。
        if (appError.retryable === 'yes') {
          store.markRetryableError(sessionKey, { taskId, messageId: shown.id });
        }
        // ⭐ 包 D：「整轮失败自动重发 1 次」的候选登记（与上面那只按钮**分开**）。
        //    确定性失败（`'no'`）连候选都不是；`'yes'` 记瞬时、其余（认不出）记未分类
        //    （未分类**不会被自动重发** —— 见 `useAutoRetryFailedTurn` 的类别门）。
        //    `producedOutput` 是本轮产出的证据快照（在上面 `clearActiveTurn` 之前取的，
        //    BUG-050）—— 真正发不发还要过渲染层的严格判据，这里只负责如实传出去。
        if (appError.retryable !== 'no') {
          store.markAutoRetryFailure(sessionKey, {
            taskId,
            messageId: shown.id,
            kind: appError.retryable === 'yes' ? 'transient' : 'unclassified',
            producedOutput,
          });
        }
        const { title, description } = formatErrorForToast(appError, deps.translate);
        deps.onToast?.('error', title, { description });
        recordDisplayedError(correlation);
      }
    } else if (state === 'aborted') {
      store.setProcessing(sessionKey, false);
      closedStreams.add(sessionKey);
      if (payload.runId) store.clearActiveTurn(sessionKey, { runId: payload.runId });
      else store.clearActiveTurn(sessionKey);
      // 用户中断可能记在两处：task 级（普通会话的「停止」）与**会话**级（对比的某一列，
      // 它的登记表在删会话那一刻就摘键了，task 级标记也已经跟不上 —— 见依赖的说明）。
      const userAborted = abortedByUser.has(taskId) || deps.isSessionAbortedByUser?.(sessionKey) === true;
      debugEvent('renderer.chat.aborted', { taskId, sessionKey, userInitiated: userAborted });

      if (!userAborted) {
        const serverAborted = deps.translate('errors.serverAborted', { defaultValue: 'Task interrupted by server' });
        // 用户点「取消对比」是**预期内**的中断（用户中断标记，两边都不显示）；
        // 服务端单方面中断则要让那一列说出原因，否则那一列会永远停在空白。
        if (ephemeral) store.setSessionError(sessionKey, serverAborted);
        else store.addMessage(taskId, 'system', serverAborted, undefined, { sessionKey });
      }
    } else {
      // ⭐ **不许静默**。这条链从前**没有 `else`**，而未处理的 state 就此一声不响地穿过
      //    （整帧的效果只剩上面那次 `notifyAgentResponse` / `markUnread`）。
      //
      // ⚠️ 不写 `else` 不是疏忽，是**类型**这么说的：`ChatEventPayload.state` 曾写成
      //    恰好四个值的封闭联合 ⇒ TS 认为这里不可达。真相是运行时发**五个**
      //    （`ChatEventSchema` = Status/Delta/Final/Aborted/Error）。
      //    这跟 `lifecycle` 的 `finishing` 是**同一个根**：拿实测样本写出来的类型，
      //    被当成了"运行时保证只有这些"的契约。
      const stateName = typeof state === 'string' ? state : '(missing)';
      const statePayload = { taskId, sessionKey, state: stateName };
      if (DELIBERATELY_IGNORED_CHAT_STATES.has(stateName)) {
        debugEvent('renderer.chat.ignored_state', statePayload);
      } else {
        debugEvent('renderer.chat.unknown_state', { ...statePayload, topLevelKeys: Object.keys(payload) });
      }
    }
  }

  function handleAgentEvent(payload: AgentEvent, gatewayId: string, frame?: GatewayEvent): void {
    const { sessionKey, stream, data } = payload;
    if (!sessionKey || !data) {
      debugEvent('renderer.agent.dropped.missing_fields', {
        stream,
        hasData: Boolean(data),
        hasSessionKey: Boolean(sessionKey),
      });
      return;
    }

    if (isSystemSession(sessionKey)) return;

    const taskId = resolveTaskId(sessionKey);
    if (!taskId) {
      if (isSubagentSession(sessionKey)) {
        deps.onSubagentCandidate?.(sessionKey, gatewayId);
        debugEvent('renderer.agent.subagent_candidate', { gatewayId, sessionKey, stream });
      } else {
        debugEvent('renderer.agent.dropped.invalid_task', { sessionKey, stream });
      }
      return;
    }

    const localTasks = deps.getTaskStore().tasks;
    const agentTask = localTasks.find((t) => t.id === taskId);
    if (!agentTask) {
      debugEvent('renderer.agent.dropped.unknown_task', { taskId, sessionKey, stream });
      return;
    }
    if (agentTask.gatewayId !== gatewayId) {
      debugEvent('renderer.agent.dropped.foreign_gateway', { taskId, sessionKey, gatewayId });
      return;
    }
    if (
      !acceptsRun(sessionKey, payload.runId, stream === 'lifecycle' && (data as AgentLifecycleData).phase === 'start')
    ) {
      if (stream === 'tool')
        handleAgentToolStream(
          taskId,
          sessionKey,
          data as AgentToolData,
          deps.isEphemeralSession?.(sessionKey) === true,
          payload.runId,
          gatewayId,
          true,
        );
      else if (stream === 'lifecycle' && (data as AgentLifecycleData).phase === 'end') reconcileRun(taskId, sessionKey);
      debugEvent('renderer.agent.dropped.stale_run', { taskId, sessionKey, runId: payload.runId, stream });
      return;
    }

    const ephemeral = deps.isEphemeralSession?.(sessionKey) === true;

    if (!ephemeral && agentTask.ensemble && sessionKey !== agentTask.sessionKey) {
      deps.onPerformerCandidate?.(taskId, sessionKey, agentTask.gatewayId);
    }
    if (payload.runId && stream === 'lifecycle' && (data as AgentLifecycleData).phase === 'start')
      deps.getMessageStore().bindActiveRun?.(sessionKey, payload.runId);

    // V2 旁路映射：在归属/陈旧 run 守卫**之后**执行。reconcileOnly 分支（上方 stale_run
    // 的 canonicalOnly 路径）**不映射** —— 旧 run 晚包不进执行投影（归约层还有一道
    // runId 守卫），只走既有 syncSessionMessages。
    if (frame) {
      const logicalRunId = payload.runId ?? deps.getMessageStore().activeTurnBySession[sessionKey]?.runId ?? '';
      mapAndFoldExecution(sessionKey, frame, taskId, logicalRunId);
    }

    switch (stream) {
      case 'tool':
        handleAgentToolStream(taskId, sessionKey, data as AgentToolData, ephemeral, payload.runId, gatewayId);
        break;
      case 'lifecycle':
        handleAgentLifecycleStream(taskId, sessionKey, data as AgentLifecycleData, ephemeral);
        break;
      case 'error':
        handleAgentErrorStream(taskId, sessionKey, data as AgentErrorData);
        break;
      case 'assistant':
        debugEvent('renderer.agent.assistant_stream', { taskId, sessionKey });
        break;
      case 'approval':
        handleAgentApprovalStream(taskId, sessionKey, data as AgentApprovalData);
        break;
      case 'item': {
        // 网关的**统一活动条目**。从前没有这个分支 ⇒ 整条被当未知事件丢掉，
        // 而里面正带着「做了什么操作」的人话标题和真实起止时间。
        handleAgentItemStream(taskId, sessionKey, data as AgentItemData);
        break;
      }
      case 'thinking': {
        const reasoning = data as AgentThinkingData;
        const chunk = reasoning.text || reasoning.delta || '';
        if (!chunk) break;
        if (closedStreams.has(sessionKey)) {
          debugEvent('renderer.chat.dropped_after_final', {
            taskId,
            sessionKey,
            stream: 'thinking',
            chars: chunk.length,
          });
          break;
        }
        // F1：agent 通道的思考是**单项帧**（顺序信息为单元素）——同样走帧封，入口统一；
        //     重复快照不重写 state ⇒ 引用比较即"真的变了"（R1 语义保持）。
        {
          const readTurn = () => deps.getMessageStore().activeTurnBySession[sessionKey];
          const before = readTurn();
          deps.getMessageStore().appendThinkingDelta(sessionKey, chunk);
          if (readTurn() !== before) deps.getMessageStore().sealTurnActivity?.(sessionKey, ['thinking']);
        }
        debugEvent('renderer.agent.thinking', { taskId, sessionKey, chars: chunk.length });
        break;
      }
      case 'compaction': {
        const compaction = data as AgentCompactionData;
        // 遥测**保留不动**（它一直有，别顺手删）
        debugEvent('renderer.agent.compaction', {
          taskId,
          sessionKey,
          phase: compaction.phase,
          completed: compaction.completed,
        });

        const store = deps.getMessageStore();

        if (compaction.phase === 'start') {
          // Phase 2：压缩会让界面**停住一会儿** —— 让用户看得见（"正在压缩上下文…"）。
          store.beginCompactionEpisode(sessionKey);
          store.setSessionCompacting(sessionKey, true);
          break;
        }

        // end（含失败/取消）先收掉"正在压缩"的提示 —— 不管成没成，它都不再"正在"了。
        store.setSessionCompacting(sessionKey, false);

        // ⭐ 只有"**真的压完了**"才报：completed && !willRetry。
        //    `!willRetry` 是**运行时自己**判"真正结束"的条件（见 compaction-announce.ts），
        //    少了它"压缩→重试→再压缩"会报两条。
        if (compaction.completed === true && compaction.willRetry !== true) {
          const episode = currentCompactionEpisode(compactionDeps, sessionKey);
          announceCompaction(compactionDeps, { taskId, sessionKey, episode });
        }
        break;
      }
      case 'run_status': {
        // 网关在报「这一轮走到哪一步了」。从前没有这个分支，事件被当未知的丢掉，
        // 于是首条消息有 9 秒界面毫无反应（用户报的「响应太慢」就是这么来的）。
        const phase = (data as Record<string, unknown>)?.phase;
        if (typeof phase === 'string' && phase) {
          // ⭐ 重试相位带**次数**（`attempt`/`maxAttempts`）—— "第 2/4 次"比"正在重试"有用得多：
          //    它同时回答了"在动吗"和"还要多久"。只有重试相位才带，其余传 undefined。
          const retry = phase === RETRY_RUN_PHASE ? readRetryProgress(data) : undefined;
          if (retry) deps.getMessageStore().setRunPhase(sessionKey, phase, retry);
          else deps.getMessageStore().setRunPhase(sessionKey, phase);
          debugEvent('renderer.agent.run_status', {
            taskId,
            sessionKey,
            phase,
            known: RUN_PHASE_IDS.includes(phase),
            ...(retry ? { attempt: retry.attempt, maxAttempts: retry.maxAttempts } : {}),
          });
        }
        break;
      }
      default: {
        const payload = {
          taskId,
          sessionKey,
          stream,
          topLevelKeys: data ? Object.keys(data) : [],
          phase: (data as Record<string, unknown>)?.phase,
          reason: (data as Record<string, unknown>)?.reason,
        };
        // 已知形状、决定不接的流：**照旧看得见**，但不占"未知"的额度（见名单的说明）。
        if (stream && DELIBERATELY_IGNORED_STREAMS.has(stream)) {
          debugEvent('renderer.agent.ignored_stream', payload);
          break;
        }
        debugEvent('renderer.agent.unknown_stream', payload);
        noteUnknownStream(stream, taskId, sessionKey);
        break;
      }
    }
  }

  function handleSessionChangedEvent(payload: SessionChangedEvent, gatewayId: string): void {
    const { sessionKey, spawnedBy, reason, phase } = payload;
    if (!sessionKey) {
      debugEvent('renderer.session.dropped.missing_session', { gatewayId, reason, phase });
      return;
    }

    const taskSession = deps
      .getTaskStore()
      .tasks.find((task) => task.gatewayId === gatewayId && task.sessionKey === sessionKey);
    if (taskSession && (!reason || !SESSION_DELETE_REASONS.has(reason))) {
      void fetchEffectiveTools(gatewayId, sessionKey);
    }

    // ⭐ "压缩完成了" —— **必须排在下面那个过滤之前**。那个过滤只看**子代理**会话，
    //    而压缩发生在**普通任务会话**上 ⇒ 放到它后面就永远收不到（有用例专门钉这个顺序）。
    //
    //    只认 `compacted === true`：网关两处都带了这个字段，而其中一处的守卫只写了
    //    `if (result.ok)`（比"真的压了"宽）⇒ 不加这个判断会把"没压成"也报成压了。
    if (reason === 'compact' && payload.compacted === true) {
      const taskId = resolveTaskId(sessionKey);
      if (taskId) {
        // 取"当前轮次"（手动那条在发 RPC 时已经开了一轮 ⇒ 这里读到的就是同一轮；
        // start 没收到过就现开一轮）。两条路同一个轮次号，去重才成立。
        const episode = currentCompactionEpisode(compactionDeps, sessionKey);
        announceCompaction(compactionDeps, { taskId, sessionKey, episode });
      }
      debugEvent('renderer.session.compacted', { gatewayId, sessionKey, taskId: taskId ?? null });
      return;
    }

    if (isSystemSession(sessionKey) || !isSubagentSession(sessionKey)) return;

    // ⭐ **认不出的 reason 要留痕 —— 位置是刻意的，就在这道过滤下面。**
    //
    // 为什么不在上面：上面那道 `isSystemSession || !isSubagentSession` 是**设计边界**
    //（非子代理会话的任何 reason 我们都不处理），不是"丢弃"。在它上面记 =
    // 对**每一条** `sessions.changed` 记一条 ⇒ 那是噪音，没有信号。
    //
    // 为什么在这里值得记：**在它下面，`reason` 是有后果的** —— 它会一路走到
    // "把这条会话提名为对比列"。⇒ 一个没见过的新 reason 在这里可能做出**错的提名**，
    // 那正是要看见的东西。
    //
    // ⚠️ **行为一个字节不改**：认不出就照旧走 fallthrough（和 `item` 那边"不知道就别改它的
    //    样子"同一条纪律）。留痕只是让"将来要不要为它加分支"这件事**有据可查**。
    const reasonName = reason ? reason : '(missing)';
    if (!SESSION_CHANGE_KNOWN_REASONS.has(reasonName)) {
      debugEvent('renderer.session.unknown_reason', {
        gatewayId,
        sessionKey,
        spawnedBy,
        phase,
        reason: reasonName,
      });
    }

    if (reason && SESSION_DELETE_REASONS.has(reason)) {
      debugEvent('renderer.session.ignored.delete', { gatewayId, sessionKey, reason });
      return;
    }

    const taskId = resolveTaskIdFromSpawnedBy(spawnedBy);
    if (!taskId) {
      debugEvent('renderer.session.subagent_unresolved', { gatewayId, sessionKey, spawnedBy, reason, phase });
      return;
    }

    const localTasks = deps.getTaskStore().tasks;
    const matchedTask = localTasks.find((t) => t.id === taskId);
    if (!matchedTask) {
      debugEvent('renderer.session.dropped.unknown_task', { taskId, sessionKey, reason, phase });
      return;
    }

    if (!matchedTask.ensemble || sessionKey === matchedTask.sessionKey) return;

    deps.onPerformerCandidate?.(taskId, sessionKey, matchedTask.gatewayId);
    debugEvent('renderer.session.performer_candidate', { taskId, sessionKey, spawnedBy, reason, phase });
  }

  function handleAgentToolStream(
    taskId: string,
    sessionKey: string,
    data: AgentToolData,
    ephemeral: boolean,
    runId?: string,
    gatewayId?: string,
    canonicalOnly = false,
  ): void {
    if (!data.name || !data.toolCallId) {
      // ⚠️ 从前是**静默 return**：这张工具卡片永远不出现，而日志里连一行都没有 ——
      //    用户看到的是"模型好像什么都没干"。
      debugEvent('renderer.agent.tool.dropped_missing_fields', {
        taskId,
        sessionKey,
        hasName: Boolean(data.name),
        hasToolCallId: Boolean(data.toolCallId),
        phase: data.phase ?? null,
      });
      return;
    }

    const active = deps.getMessageStore().activeTurnBySession[sessionKey];
    const canonicalExists = Boolean(
      runId &&
      deps
        .getMessageStore()
        .messagesByTask[
          taskId
        ]?.some((message) => message.role === 'assistant' && message.sessionKey === sessionKey && message.runId === runId),
    );
    const reconcileOnly = canonicalOnly || (!active && (canonicalExists || closedStreams.has(sessionKey)));
    if (!ephemeral && !reconcileOnly) {
      deps.notifyAgentResponse?.(sessionKey);

      if (taskId !== deps.getActiveTaskId()) {
        deps.markUnread(taskId);
      }
    }

    // ⭐ V2（2026-10-13 step 2）：非终态相位落 `dispatched`（调用进入处理）——
    //    `tool/start` 不是"已实际执行"的证据（05 F1：prepare 前发 start、跳过/中止也发
    //    start、wire 无 executionStarted）。`running` 只保留给有明确执行证据的适配器。
    let status: ToolCallStatus = 'dispatched';
    if (data.phase === 'result') {
      // ⚠️ **`isError` 不足以判断"跑完了"**：exec 停在「等人批准」时，工具流那一帧
      //    带的是 `isError: false`（运行时的失败清单里没有 `approval-pending`，
      //    且它没有 `exitCode` ⇒ 判断一路兜底 false）。
      //    照它落地 ⇒ **一条一步都没跑的命令显示成「已完成」**，而且**没有任何后续帧
      //    会纠正它**：`approval` 流的 `pending` 是"知道但不接"、`item` 的
      //    `kind:"command"+status:"blocked"` 也在"刻意不接"名单里、合并器**不许降级**。
      //    （2026-09-19 扩：`approval-unavailable` 也归这条 —— 从前它靠 `approval` 流
      //     **事后**压成 `error`，最终态对，但中间**先闪一下「已完成」**。用户拍板"不让它先闪"。
      //    V2 差异白名单：被审批按住的 result **直接落 `awaitingApproval`**（旧行为先落
      //    running、再由 approval 帧改判 —— running 现在有"执行证据"的含义，不再借它。）
      if (data.isError) status = 'error';
      else if (isExecHeldByApproval(data.result)) status = 'awaitingApproval';
      else status = 'done';
    } else if (data.phase === 'error') {
      // ⚠️ **这条分支运行时不发** —— 生产代码 11 个发射点里没有 `phase:"error"`
      //    （失败是 `result` + `isError:true`）。留着是防守：真发出来能接住。
      //    但它**不是活代码**，别把它当"我们处理了 error 相位"读。
      status = 'error';
    } else {
      // ⭐ 其余相位**不改状态** —— 卡片停在"进行中"就是对的（它们都是非终态）。
      //    但"不改"和"不留痕"是两件事：从前这里没有 `else`，未知相位静默变成"进行中"；
      //    而如果它其实是**终态**，卡片会**永远转圈**（`chat.state` / `approval.status`
      //    / `item.kind` 同一类坑，这是第六处）。
      const phase = data.phase ? data.phase : '(missing)';
      const phasePayload = { taskId, sessionKey, phase, toolCallId: data.toolCallId, name: data.name };
      if (TOOL_IGNORED_PHASES.has(phase)) {
        debugEvent('renderer.agent.tool.ignored_phase', phasePayload);
      } else {
        debugEvent('renderer.agent.tool.unknown_phase', { ...phasePayload, topLevelKeys: Object.keys(data) });
      }
    }

    const tc: ToolCall = {
      id: data.toolCallId,
      name: data.name,
      status,
      args: parseToolArgs(data.args),
      // ⭐ 真实输出优先，`meta`（一行摘要）只在拿不到真输出时兜底 —— 顺序反了就等于
      //    用户点开卡片永远看不到工具到底返回了什么。
      result: extractToolResultText(data.result) ?? data.meta,
      startedAt: '',
      // V2：只有 done/error 才带完成时间（dispatched/awaitingApproval 没有结束）。
      completedAt: status === 'done' || status === 'error' ? new Date().toISOString() : undefined,
    };

    const store = deps.getMessageStore();
    const matchingActive = !runId || !active?.runId || active.runId === runId ? active : undefined;
    let previousCall = matchingActive?.toolCalls.find((call) => call.id === tc.id);
    tc.startedAt = previousCall?.startedAt ?? '';
    const existingMsgs = store.messagesByTask[taskId] ?? [];
    for (let i = existingMsgs.length - 1; (!tc.startedAt || !previousCall) && i >= 0; i--) {
      const message = existingMsgs[i];
      if (message.sessionKey !== sessionKey || (runId && message.runId && message.runId !== runId)) continue;
      const existing = message.toolCalls.find((t) => t.id === tc.id);
      if (existing) {
        tc.startedAt = existing.startedAt;
        previousCall ??= existing;
        break;
      }
    }
    if (!tc.startedAt && data.phase === 'start') tc.startedAt = new Date().toISOString();

    const progressArgs = tc.args ?? previousCall?.args;
    const slideCommand =
      data.name === 'exec' &&
      typeof progressArgs?.command === 'string' &&
      /(?:^|[\\/\s"'])deck-layout[\\/]scripts[\\/]generate\.cjs(?:[\s"']|$)/i.test(progressArgs.command);
    const processPoll = data.name === 'process' && progressArgs?.action === 'poll';
    if ((slideCommand || processPoll) && (data.phase === 'update' || data.phase === 'result')) {
      const nativeText = extractToolResultText(data.phase === 'update' ? data.partialResult : data.result);
      const text = processPoll
        ? nativeText
            ?.trim()
            .replace(/\n\nProcess (?:still running\.|exited with code -?\d+\.)$/, '')
            .trim()
        : nativeText;
      const progress =
        typeof text === 'string' ? parseSlidegenToolStream(text, data.phase === 'update')?.progress : undefined;
      if (progress) {
        if (data.phase === 'update') tc.result = undefined;
        // V2：dispatched 与 running 一样是"处理中"证据（update 相位页数进度照常吸附）。
        if (
          data.phase !== 'update' ||
          (!reconcileOnly && (previousCall?.status === 'running' || previousCall?.status === 'dispatched'))
        )
          tc.slideProgress = progress;
      }
    }

    if (reconcileOnly && !ephemeral && runId && gatewayId) {
      deps
        .syncSessionMessages(taskId, sessionKey, { gatewayId, runId, toolCall: tc })
        .catch((error) => console.error('[dispatcher] late tool sync failed', error));
    } else if (!reconcileOnly) upsertToolCallTracked(sessionKey, taskId, tc);
    debugEvent('renderer.toolcall.upserted', {
      taskId,
      sessionKey,
      toolCallId: tc.id,
      status: tc.status,
      name: tc.name,
    });
  }

  function handleAgentItemStream(taskId: string, sessionKey: string, data: AgentItemData): void {
    // `kind:"preamble"` 是**模型自述的进度**（真帧：
    // `{"stream":"item","data":{"kind":"preamble","progressText":"…"}}`）。
    // 它不是工具，所以**不能**写进工具列表（会凭空多出一张卡片）——
    // 但它也不能丢：正文不流式的那段时间里，这是唯一在动的东西。
    if (data.kind === 'preamble') {
      const progress = typeof data.progressText === 'string' ? data.progressText.trim() : '';
      // 空的不写：把上一句盖成空的，用户看到的是"进度突然没了"
      if (progress) deps.getMessageStore().setSessionProgressText(sessionKey, progress);
      return;
    }

    // 其余非工具条目照旧**不往 store 里写** —— 但**不许丢得没声音**。
    //
    // ⚠️ `kind` 是**开放词表**（运行时自己的类型是
    //    `"tool" | "command" | "patch" | "search" | "analysis" | (string & {})`）。
    //    我们踩过一次：`preamble` 当初就是这样整块被丢掉的，后来才发现它有用
    //    （正文不流式时唯一在动的东西）。词表开放 + 丢弃无声 = 下次还会重演。
    //
    // ⇒ 分两种记：**知道但不接的**记 `ignored_kind`，**认不出的**记 `unknown_kind`。
    //    分开是为了让"新冒出来的 kind"在一堆噪音里一眼看得见。
    if (data.kind !== 'tool') {
      const kind = typeof data.kind === 'string' ? data.kind : '(missing)';
      const payload = { taskId, sessionKey, kind, toolCallId: data.toolCallId, phase: data.phase };
      if (DELIBERATELY_IGNORED_ITEM_KINDS.has(kind)) {
        debugEvent('renderer.agent.item.ignored_kind', payload);
      } else {
        debugEvent('renderer.agent.item.unknown_kind', {
          ...payload,
          topLevelKeys: Object.keys(data),
        });
      }
      return;
    }
    if (!data.toolCallId || !data.name) {
      // ⚠️ 从前是**静默 return**：这张条目**永远不会出现在界面上**，日志里一行都没有
      //    （与 `tool` 流那处同形，见 `dropped_missing_fields` 的说明）。
      debugEvent('renderer.agent.item.dropped_missing_fields', {
        taskId,
        sessionKey,
        hasToolCallId: Boolean(data.toolCallId),
        hasName: Boolean(data.name),
        phase: data.phase,
        status: data.status,
      });
      return;
    }

    const failed = (data.status !== undefined && ITEM_FAILURE_STATUSES.has(data.status)) || Boolean(data.error);
    const settled = data.phase === 'end' || failed;
    // ⭐ V2：item/running ⇒ `dispatched`（调用进入处理，不是执行证据）。
    const status: ToolCallStatus = failed ? 'error' : settled ? 'done' : 'dispatched';

    // ⭐ 认不出的 `status` **不许默默归类** —— `blocked` 当初就是被"默默归类"漏掉的
    //    （`fc4afa3`：`phase:"end"` 让它落进 `done`，靠帧序而不是靠我们认对来兜底）。
    //
    // ⚠️ **行为刻意不变**：`phase` 已经告诉我们"这条目结没结束"，
    //    ⇒ 认不出时**保留原有归类**，只把"我认不出"写进日志。
    //    理由：改成 `running` 是**确定的错**（它确实结束了）；改成 `error` 是朝另一个
    //    方向猜。**不知道就别改它的样子，但要留下能被查的痕迹。**
    if (!data.status || !ITEM_STATUS_IDS.includes(data.status)) {
      debugEvent('renderer.agent.item.unknown_status', {
        taskId,
        sessionKey,
        toolCallId: data.toolCallId,
        name: data.name,
        status: data.status ? data.status : '(missing)',
        phase: data.phase,
        // 顺手记下**我们把它归成了什么** —— 否则光看日志没法判断影响面。
        classifiedAs: status,
        topLevelKeys: Object.keys(data),
      });
    }

    // ⭐⭐ `phase` 的护栏 —— 与上面 `status` 那条**同形同纪律**，但它是后补的：
    //    `ITEM_PHASE_IDS` 早就定义好了（还配了灵敏度哨兵用例），
    //    可**生产代码里一次都没用过** —— 定义 ≠ 接线。`status` 有护栏、
    //    `tool` 流的 `phase` 也有护栏，唯独 `item` 的 `phase` 是裸奔的。
    //
    // ⚠️ 为什么值得防：判"结没结束"全靠 `data.phase === 'end'`（上面那行 `settled`）。
    //    运行时**若加一个表示"结束"的新相位**，`settled` 会是 `false` ⇒ 条目
    //    **永远停在"进行中"**（卡片一直转），而且一声不响。这不是假想：
    //    `tool` 流的 `phase` 就真从 4 个长到过 5 个（漏掉 `input_delta`）。
    //
    // ⚠️ **行为刻意不变**（同 `unknown_status`）：不知道就别改它的样子，只留痕迹。
    if (!data.phase || !ITEM_PHASE_IDS.includes(data.phase)) {
      debugEvent('renderer.agent.item.unknown_phase', {
        taskId,
        sessionKey,
        toolCallId: data.toolCallId,
        name: data.name,
        phase: data.phase ? data.phase : '(missing)',
        status: data.status,
        // 同 `unknown_status`：记下我们把它归成了什么，否则看不出影响面。
        classifiedAs: status,
        topLevelKeys: Object.keys(data),
      });
    }

    const toMs = (v: unknown): string | undefined =>
      typeof v === 'number' && v > 0 ? new Date(v).toISOString() : undefined;

    // F1：工具写入统一走 `upsertToolCallTracked`（写入 + 帧封）。
    upsertToolCallTracked(sessionKey, taskId, {
      id: data.toolCallId,
      name: data.name,
      status,
      // ⭐ `title` 就是用户要的"做了什么操作"：网关拼好的「工具名 + 参数摘要」。
      title: data.title,
      // 网关给的是**真实**起止时间（毫秒），比自己打点准。
      startedAt: toMs(data.startedAt) ?? (data.phase === 'start' ? new Date().toISOString() : ''),
      completedAt: settled ? (toMs(data.endedAt) ?? new Date().toISOString()) : undefined,
      result: data.error,
    });

    debugEvent('renderer.toolcall.upserted', {
      taskId,
      sessionKey,
      toolCallId: data.toolCallId,
      status,
      name: data.name,
      source: 'item',
    });
  }

  /**
   * 审批**确定没跑成**的 status（与 `pending` 相对）。
   *
   * `pending` 刻意不在里面：那时命令**还有可能跑**，报成失败是另一种撒谎。
   * 而"退回进行中"当前做不到 —— `mergeToolCallState` 的状态权重不许降级。
   */
  const APPROVAL_NOT_EXECUTED = new Set(['unavailable', 'denied', 'failed']);

  /**
   * 审批**知道但不接**的 status（与上面那个相对）。
   *
   * 运行时的闭集是
   * `"pending" | "unavailable" | "approved" | "denied" | "failed"`
   * （`~/git/openclaw` 2026-09-09，`AgentApprovalEventStatus`），除上面三个之外还剩两个：
   * - `pending` —— 那时命令**还有可能跑**，报成失败是另一种撒谎；
   * - `approved` —— 命令**会跑**（真结果随后由 `tool` 流给出），更不该当失败。
   *
   * ⚠️ 名单只放**验过会发、且我们决定不接**的。认不出的走 `unknown_status` ——
   *    运行时的类型里真要新增一个"没跑成"的 status，今天就会被这条**逮住**，
   *    而不是像从前那样静默 `return`（那会让卡片一直停在"进行中"）。
   */
  const APPROVAL_DELIBERATELY_IGNORED = new Set(['approved']);

  /**
   * 审批 status 里**表示"命令停在等人"**的那个。
   *
   * `pending`（`AgentApprovalEventStatus`）= 审批请求已经发出、还没结论。
   * ⚠️ A2（2026-09-19）起它从"知道但不接"改成**接**：用户得知道
   * **为什么没有进展**、以及**该谁动**。只动**显示**，审批语义一个字节没改。
   */
  const APPROVAL_WAITING_STATUS = 'pending';

  /**
   * `item` 的 **`kind`** 里"知道但不接"的那些。
   *
   * ⚠️ 会发的 kind 实测就四个（`~/git/openclaw`，2026-09-09）：
   * - `tool` / `preamble` —— **已接**（上面处理掉了）；
   * - `command` —— exec 专用；C2 已决定**不接实时输出**（实测 delta 只比 end 早 0.2 秒）；
   * - `patch` —— **只对 `apply_patch` 发**（我们的 agent 不用这个工具，实测工具清单里没有它）。
   *
   * ⚠️ 运行时**类型里**还声明了 `search` / `analysis`，但**一个发射点都没有** ——
   *    所以它们不在这份名单里：真冒出来就该按"认不出"记一条（那才是我们要看见的信号）。
   *    名单只放**验过会发、且我们决定不接**的。
   */
  const DELIBERATELY_IGNORED_ITEM_KINDS = new Set(['command', 'patch']);

  /**
   * 这条工具调用**已经有的**工具名。
   *
   * `approval` 帧**不带工具名**（只有 `kind:"exec"`），而 `ToolCall.name` 是必填 ⇒
   * 只能拿 `kind` 顶上。但那样会把真实工具名（`shell` / `bash` …）顶掉，
   * 而卡片标题正是靠它 —— 偏偏这批"被拦下的命令"最需要用户认得出是哪一个。
   * ⇒ 先找已有的，找不到才用 `kind` 兜底。
   */
  function existingToolName(taskId: string, sessionKey: string, toolCallId: string): string | undefined {
    const store = deps.getMessageStore();
    const inFlight = store.activeTurnBySession[sessionKey]?.toolCalls.find((t) => t.id === toolCallId);
    if (inFlight?.name) return inFlight.name;

    const msgs = store.messagesByTask[taskId] ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const found = msgs[i]?.toolCalls?.find((t) => t.id === toolCallId);
      if (found?.name) return found.name;
    }
    return undefined;
  }

  function handleAgentApprovalStream(taskId: string, sessionKey: string, data: AgentApprovalData): void {
    // 先留遥测：这条链从前**整条落到 default**，出事时只看到一条 unknown_stream，
    // 查不出是哪次审批、什么原因。
    debugEvent('renderer.agent.approval', {
      taskId,
      sessionKey,
      phase: data.phase,
      status: data.status,
      reason: data.reason,
    });

    if (!data.toolCallId) return;

    // ⭐ 下面只认"**确定没跑成**"的三个值，其余从前**一声不响地 return**。
    //    "我们不接它"是对的（见两处名单的说明），但"不接"本身必须留痕 ——
    //    否则下一个冒出来的 status 会以同样的方式消失。
    const approvalStatus = data.status ? data.status : '(missing)';

    // ⭐ A2：审批**还在等人** ⇒ 单独标出来（不是"进行中"，也不是"失败"）。
    //
    //    ⚠️ **只动显示**：谁批、怎么批、批完干嘛，一个字节没改。`awaitingApproval`
    //    与 `running` **同级**（见 message-store 的 `toolStatusRank`）⇒
    //    随后的真结果 / 拒绝照样压得过去，不会卡住收不了场。
    if (approvalStatus === APPROVAL_WAITING_STATUS) {
      const name = existingToolName(taskId, sessionKey, data.toolCallId) ?? data.kind ?? 'exec';
      upsertToolCallTracked(sessionKey, taskId, {
        id: data.toolCallId,
        name,
        status: 'awaitingApproval',
        // ⚠️ **不填 `completedAt`**：它没结束。
        // `result` 也**不写**：这张卡片要说的只是"在等人"，命令内容由 `title` 带出；
        // 真结果到了再写（合并器里 `incoming.result ?? existing.result` 会自然覆盖）。
        startedAt: new Date().toISOString(),
      });
      debugEvent('renderer.toolcall.awaiting_approval', {
        taskId,
        sessionKey,
        toolCallId: data.toolCallId,
        name,
      });
      return;
    }

    if (!APPROVAL_NOT_EXECUTED.has(approvalStatus)) {
      const statusPayload = {
        taskId,
        sessionKey,
        toolCallId: data.toolCallId,
        status: approvalStatus,
        phase: data.phase,
      };
      if (APPROVAL_DELIBERATELY_IGNORED.has(approvalStatus)) {
        debugEvent('renderer.agent.approval.ignored_status', statusPayload);
      } else {
        debugEvent('renderer.agent.approval.unknown_status', { ...statusPayload, reason: data.reason });
      }
      return;
    }

    // 用网关自己的话解释：`message` 是人话，`reason` 是机器码，`command` 让用户认出是哪条。
    const explanation = [
      data.title,
      data.message,
      data.reason && `(${data.reason})`,
      data.command && `$ ${data.command}`,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' ');

    const name = existingToolName(taskId, sessionKey, data.toolCallId) ?? data.kind ?? 'exec';

    upsertToolCallTracked(sessionKey, taskId, {
      id: data.toolCallId,
      name,
      // ⚠️ `error` 不是"命令失败"，是"**没跑成**" —— 这是当前唯一能表达的、且不撒谎的状态。
      //    `done` 是明确错的（命令没执行）；`running` 做不到（合并不许降级）。
      status: 'error',
      result: explanation || undefined,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    debugEvent('renderer.toolcall.upserted', {
      taskId,
      sessionKey,
      toolCallId: data.toolCallId,
      status: 'error',
      name,
      source: 'approval',
    });
  }

  /** 统一出口的依赖：⚠️ 传取值函数而不是快照（兜底在定时器回调里跑）。 */
  const compactionDeps = { getStore: () => deps.getMessageStore(), translate: deps.translate };

  function handleAgentLifecycleStream(
    taskId: string,
    sessionKey: string,
    data: AgentLifecycleData,
    ephemeral: boolean,
  ): void {
    const store = deps.getMessageStore();

    switch (data.phase) {
      case 'start':
        if (!ephemeral) deps.notifyAgentResponse?.(sessionKey);
        closedStreams.delete(sessionKey);
        store.setProcessing(sessionKey, true);
        // ⚠️ 这里**不**清 run phase：实测 `starting_model` 会在 lifecycle.start **之后**才到
        //（2026-09-11 实测：start 7.5s、starting_model 7.6s），清了会被立刻覆盖回去。
        // 相位统一在 end / error 清，既没有竞态，也如实反映「这一轮在干什么」。
        debugEvent('renderer.agent.lifecycle.start', { taskId, sessionKey });
        break;
      case 'end':
        store.setProcessing(sessionKey, false);
        closedStreams.add(sessionKey);
        store.setRunPhase(sessionKey, null);
        store.setSessionProgressText(sessionKey, null);
        debugEvent('renderer.agent.lifecycle.end', { taskId, sessionKey });
        break;
      case 'error': {
        // ⭐ BUG-050：证据快照取在**最前**。这一支自己没有 clearActiveTurn，但登记发生在
        //    2s 去重窗之后（见下）—— 期间任何清理路径（aborted 帧 / session 同步 / 新 run
        //    绑定）都可能把 activeTurn 清掉。到时候再读就恒判"什么都没做"
        //    ⇒ 跑过工具的轮次被整轮重发（副作用重复，不可逆）。
        const producedOutput = activeTurnProducedOutput(store.activeTurnBySession[sessionKey]);
        store.setProcessing(sessionKey, false);
        closedStreams.add(sessionKey);
        store.setRunPhase(sessionKey, null);
        store.setSessionProgressText(sessionKey, null);
        debugEvent('renderer.agent.lifecycle.error', { taskId, sessionKey, error: data.error });
        if (!data.error) break;

        // 去重缓冲的**键**：普通会话按任务（同一条错误在两处报只显示一次），
        // 临时会话按**会话**（每列各自要能看到自己的失败，不能被别的列顶掉）。
        const bufferKey = ephemeral ? sessionKey : taskId;
        const existing = lifecycleErrorBuffer.get(bufferKey);
        if (existing) clearTimeout(existing.timer);

        const timer = setTimeout(() => {
          lifecycleErrorBuffer.delete(bufferKey);
          const errorText = data.error!;
          const appError = buildAppError({ source: 'agent', stage: 'lifecycle', rawMessage: errorText });
          const correlation: ErrorCorrelation = {
            taskId,
            runId: undefined,
            source: 'agent',
            rawMessage: errorText,
            displayedAt: 0,
          };
          if (ephemeral) {
            store.setSessionError(sessionKey, formatErrorForUser(appError, deps.translate));
          } else if (shouldDisplayError(correlation)) {
            const shown = store.addMessage(taskId, 'system', formatErrorForUser(appError, deps.translate), undefined, {
              sessionKey,
            });
            // ⭐ 包 D：「整轮失败自动重发 1 次」的候选登记（真机事故走的正是这条）。
            //    这一支**没有结构化类别**（lifecycle 帧只有一句英文原文，`buildAppError`
            //    拿不到 code/kind ⇒ `retryable` 恒为 `'unknown'`），所以登记成"未分类"
            //    —— 未分类**不会被自动重发**（BUG-050 收紧：认不出来就不替用户再花钱）。
            //    `'no'` 的排除是给未来准备的：哪天这个帧带上了类别，确定性失败照样不登记。
            //    `producedOutput` 是 case 入口取的证据快照（BUG-050），随候选传给渲染层。
            if (appError.retryable !== 'no') {
              store.markAutoRetryFailure(sessionKey, {
                taskId,
                messageId: shown.id,
                kind: appError.retryable === 'yes' ? 'transient' : 'unclassified',
                producedOutput,
              });
            }
            const { title, description } = formatErrorForToast(appError, deps.translate);
            deps.onToast?.('error', title, { description });
            recordDisplayedError(correlation);
          }
        }, DEDUP_FALLBACK_WINDOW_MS);

        lifecycleErrorBuffer.set(bufferKey, { error: data.error, timer });
        break;
      }
      case 'fallback':
        debugEvent('renderer.agent.lifecycle.fallback', {
          taskId,
          sessionKey,
          from: `${data.selectedProvider}/${data.selectedModel}`,
          to: `${data.activeProvider}/${data.activeModel}`,
        });
        // 临时会话不写这条：用户看到的列标题就是他挑的模型，「已切换到 X」进时间线
        // 反而是在未采纳的列上改了对话内容（debug 事件照旧记录）。
        if (data.activeModel && !ephemeral) {
          const msg = deps.translate('agent.modelFallback', {
            model: data.activeModel,
            defaultValue: `Switched to model: ${data.activeModel}`,
          });
          store.addMessage(taskId, 'system', msg, undefined, { persist: false, sessionKey });
        }
        break;
      case 'fallback_cleared': {
        // ⚠️ **切回来了就得说一句**：`fallback` 那次我们已经往时间线插了「已切换至模型: X」，
        //    切回来却不说 ⇒ **时间线最后一句停在 X**，用户以为还在用 X 回答。
        //    （每条消息的模型徽章是对的 —— 那是网关逐条给的；偏偏用户刚被告知的那句是旧的。）
        //
        // ✅ 复用现成的 `agent.modelFallback`：切回来**本来就**是一次模型切换
        //    （切回用户挑的那个），"已切换至模型: Y" 字面为真 ⇒ 不需要新文案、不动 9 语言。
        //
        // ⚠️ 但**"降级结束"≠"模型换了"**（见下面的 `modelChanged`）。
        debugEvent('renderer.agent.lifecycle.fallback_cleared', {
          taskId,
          sessionKey,
          model: data.activeModel,
          previousActiveModel: data.previousActiveModel,
        });
        // ⚠️ **只在模型真的变了时才说**（用户 2026-09-19 的要求：避免噪音）。
        //    `fallback_cleared` 说的是"降级状态结束了"，**不一定**意味着模型换了 ——
        //    清标记时用的还是同一个模型的话，插一句「已切换至模型: 同一个」纯属噪音。
        //    判据用网关给的 `previousActiveModel`（"之前是哪个模型"）。
        //    ⚠️ 缺这个字段就**不说**：证不出"确实变了"时，宁可少一句也不要多一句噪音。
        const modelChanged =
          Boolean(data.activeModel && data.previousActiveModel) && data.previousActiveModel !== data.activeModel;

        // 临时会话照旧不写（同 `fallback` 那条纪律：列标题就是用户挑的模型）。
        if (modelChanged && !ephemeral) {
          const msg = deps.translate('agent.modelFallback', {
            model: data.activeModel,
            defaultValue: `Switched to model: ${data.activeModel}`,
          });
          store.addMessage(taskId, 'system', msg, undefined, { persist: false, sessionKey });
        }
        break;
      }
      case 'finishing':
        // ⚠️ **这一条是护栏，不是功能**。`finishing` 是 `lifecycle` 的一个**真相位**，
        //    但它**不是结束** —— 网关那边的原话：
        //      · `lifecycle.ts` 的终态联合是 `"finishing" | "end" | "error"`；
        //      · `attempt-stream-prepare.ts`：`terminalLifecyclePhase:
        //        attempt.deferTerminalLifecycle ? "finishing" : "end"` —— **它替代 `end`**；
        //      · 注释：`Finishing is an attempt fence, not the outer execution's final publication`。
        //
        //    ⇒ **还有后续尝试时**发它。所以这里**什么都不做**（不收 processing、不清 run phase）。
        //
        //    为什么明明"什么都不做"还要单写一个 case：它以前走 `default` ⇒ 记
        //    `lifecycle.unknown`。后人看到日志里一条"未知相位"，最自然的修复就是
        //    **照着 `end` 补一个 case** —— 那会在 agent 还在干活时把活动条收掉。
        //    写成显式 case = 把"我知道它、我故意不处理"摆在代码里，而不是留给下一个人猜。
        debugEvent('renderer.agent.lifecycle.finishing', { taskId, sessionKey });
        break;
      case 'fallback_step':
        // 逐个候选尝试的**过程**：只留遥测。
        // 每一步都往时间线插话会把对话刷爆，而它对用户没有增量信息。
        debugEvent('renderer.agent.lifecycle.fallback_step', { taskId, sessionKey });
        break;
      default:
        // ⚠️ 这个 switch 从前**没有 default** ⇒ 未知相位**连一条日志都没有**。
        //    上面两个 `fallback_*` 就是这么被静默吞掉很久的。
        //    与 `agent` 流那个 switch 的 `default`（`unknown_stream`）保持同一条纪律：
        //    **不认识的东西可以不理，但不能不留痕。**
        debugEvent('renderer.agent.lifecycle.unknown', { taskId, sessionKey, phase: data.phase });
        break;
    }
  }

  function handleAgentErrorStream(taskId: string, sessionKey: string, data: AgentErrorData): void {
    debugEvent('renderer.agent.stream_error', {
      taskId,
      sessionKey,
      reason: data.reason,
      expected: data.expected,
      received: data.received,
    });
  }

  function cancelCatalogRetry(gatewayId: string): void {
    const timer = catalogRetryTimers.get(gatewayId);
    if (timer !== undefined) {
      clearTimeout(timer);
      catalogRetryTimers.delete(gatewayId);
    }
  }

  function ownsCatalogRequest(gatewayId: string, request: CatalogRequest): boolean {
    return catalogRequests.get(gatewayId) === request && request.isCurrent?.() !== false;
  }

  function scheduleCatalogRetry(gatewayId: string, attempt: number, request: CatalogRequest): void {
    if (!ownsCatalogRequest(gatewayId, request)) return;
    cancelCatalogRetry(gatewayId);
    const timer = setTimeout(() => {
      catalogRetryTimers.delete(gatewayId);
      void refetchModelsCatalog(gatewayId, attempt + 1, request);
    }, CATALOG_RETRY_DELAYS_MS[attempt]);
    catalogRetryTimers.set(gatewayId, timer);
  }

  /**
   * 取失败（`ok:false` / 回包里没有 `models` / 直接抛异常）走**同一条**有界退避。
   *
   * ⚠️ 2026-09-20（用户报障「用着用着一直卡在加载模型」）：这三种形态原来**什么都不做**
   *    —— 只有一句 `console.warn`。退避链于是**根本不启动**，`applyModelsCatalog`
   *    也永远不会被调用，store 里那个网关的目录**永远是 `undefined`**；
   *    而界面把 `undefined` 读成"正在准备模型…" ⇒ **永远停在加载态**，重试按钮也不出现。
   *    修法：失败与"空目录"共用同一个预算（次数与延迟都一样，约 60 秒），
   *    退避用尽后落一个**显式失败态**（`setModelCatalogFailureForGateway`）——
   *    它既不是"没有模型"（那是替网关下结论），也不是"还在加载"（那会让人一直等）。
   */
  function handleCatalogFailure(gatewayId: string, attempt: number, request: CatalogRequest): void {
    if (!ownsCatalogRequest(gatewayId, request)) return;
    if (attempt >= CATALOG_RETRY_DELAYS_MS.length) {
      deps.setModelCatalogFailureForGateway(gatewayId, true);
      return;
    }
    scheduleCatalogRetry(gatewayId, attempt, request);
  }

  /**
   * 落目录。空目录先不当真 —— 理由见 CATALOG_RETRY_DELAYS_MS。
   *
   * ⚠️ 这里**不**自己清「取不到」标记（2026-09-20 复核拍板：那两处是冗余的）。
   *    清理由 store 的 `setModelCatalogForGateway` **原子**完成 —— 落下目录本身就是
   *    "取不到"被否证的证据，写两遍只是让同一个判断有两个可漂移的副本。
   *    该不变式由 `packages/core/test/ui-store-catalog-failure.test.ts` 直接钉住。
   *    （实测口径：变异验证里删掉 store 的清理，红的是**那条 store 单测**，
   *      不是跨层测试 —— 因为每次落目录之前都先有一次"起链归位"，所以那份清理今天
   *      在真实调用图里**不可达**，它是 store 层的兜底不变式，不是死代码。）
   *    ⚠️ 但**起链时**那次归位（`fetchCatalogs`，界面回到"正在准备"）要留着 ——
   *    它才是重连后不让用户看到上一轮失败结论的那一次。
   */
  function applyModelsCatalog(gatewayId: string, models: unknown[], attempt: number, request: CatalogRequest): void {
    if (!ownsCatalogRequest(gatewayId, request)) return;
    if (models.length > 0) {
      cancelCatalogRetry(gatewayId);
      deps.setModelCatalogForGateway(gatewayId, models);
      return;
    }
    if (attempt >= CATALOG_RETRY_DELAYS_MS.length) {
      // 退避用完还是空：当作真的没有模型，让界面如实显示「暂无可用模型」。
      deps.setModelCatalogForGateway(gatewayId, models);
      return;
    }
    scheduleCatalogRetry(gatewayId, attempt, request);
  }

  async function refetchModelsCatalog(gatewayId: string, attempt: number, request: CatalogRequest): Promise<void> {
    if (!request.agentId || !ownsCatalogRequest(gatewayId, request)) return;
    try {
      const res = await deps.gateway.listModels(gatewayId, request.agentId);
      if (!ownsCatalogRequest(gatewayId, request)) return;
      if (res.ok && res.result) {
        const data = res.result as unknown as ModelListResponse;
        if (data.models) {
          applyModelsCatalog(gatewayId, data.models, attempt, request);
          return;
        }
      }
      // `ok:false` / 没有 `models` 字段：都算**没问出来**，进同一条退避。
      handleCatalogFailure(gatewayId, attempt, request);
    } catch {
      console.warn('[catalogs] Failed to refetch models for gateway', gatewayId);
      handleCatalogFailure(gatewayId, attempt, request);
    }
  }

  async function fetchCatalogs(gatewayId: string, isCurrent?: () => boolean): Promise<void> {
    if (isCurrent?.() === false) return;
    cancelCatalogRetry(gatewayId);
    const request: CatalogRequest = { isCurrent };
    catalogRequests.set(gatewayId, request);
    // 起一条新链：先把「取不到」归位（界面回到"正在准备"），失败与为空都会自己再走退避。
    deps.setModelCatalogFailureForGateway(gatewayId, false);
    // 目录**单独**起步：它的失败必须进退避（见 handleCatalogFailure），
    // 不能因为同一批里别的目录抛错就被整体的 try/catch 吞掉。
    try {
      const agentsRes = await deps.gateway.listAgents(gatewayId);
      if (!ownsCatalogRequest(gatewayId, request)) return;
      if (agentsRes.ok && agentsRes.result) {
        const data = agentsRes.result as unknown as AgentListResponse;
        if (data.agents) deps.setAgentCatalogForGateway(gatewayId, data.agents, data.defaultId);
      }

      // ⚠️ 工具目录与斜杠命令**必须**带上 agentId。多 agent 配置下网关把"没有 owner"
      //    的请求整条拒掉 —— 内部错误类是 `AgentSelectionRequiredError`（`code` 字段为
      //    `AGENT_SELECTION_REQUIRED`），但 RPC 侧 `resolveAgentIdOrRespondError` 会把它
      //    接住后**重新回包**，所以**过界看到的 code 是 `INVALID_REQUEST`**
      //    （2026-09-20 全档普查：日志里 `AGENT_SELECTION_REQUIRED` 0 条 —— 别按它 grep 日志）。
      //    后果是 composer 的工具菜单与斜杠命令**永远是空的**，而且不报错（ok=false 被吞）。
      //    ⚠️ 这里原先写「2026-09-17 实机 431 次」，该数**当日无法复现**：2026-09-20 全档普查里
      //    这两条方法当天**各 3 次**，而当天**全量**错误帧是 **435**（431 与 435 只差 4，像当日
      //    某一时刻的快照）⇒ 原数很可能是"当日全量"被当成了这两条方法的证据。**原数保留**，
      //    只写明来路。本条的**真身证据**（同一普查）：09-15 16 发/15 错、09-16 16/15、
      //    09-17 10/3、09-18 3/2 → **09-19 105 发/0 错、09-20 63 发/0 错**（合计 168/168）。
      //    owner 取网关自己的默认 agent；只有一个 agent 时退回那一个。
      const agentCatalog = agentsRes.ok ? (agentsRes.result as unknown as AgentListResponse | undefined) : undefined;
      const agentId = resolveCatalogAgentId(agentCatalog?.agents ? agentCatalog : undefined);
      if (!agentId) {
        deps.setModelCatalogFailureForGateway(gatewayId, true);
        debugEvent('renderer.catalog.owner_missing', { gatewayId });
        return;
      }
      request.agentId = agentId;
      void refetchModelsCatalog(gatewayId, 0, request);

      const [toolsRes, commandsRes, skillsRes] = await Promise.all([
        deps.gateway.getToolsCatalog(gatewayId, agentId),
        deps.gateway.listCommands(gatewayId, {
          scope: 'text',
          includeArgs: true,
          ...(agentId ? { agentId } : {}),
        }),
        deps.gateway.getSkillsStatus(gatewayId, agentId),
      ]);
      if (!ownsCatalogRequest(gatewayId, request)) return;
      if (toolsRes.ok && toolsRes.result) {
        const data = toolsRes.result as unknown as ToolsCatalog;
        if (data.groups) deps.setToolsCatalogForGateway(gatewayId, data);
      }
      if (skillsRes.ok && skillsRes.result) {
        const data = skillsRes.result as unknown as SkillStatusReport;
        if (Array.isArray(data.skills) && (!data.agentId || data.agentId === agentId)) {
          deps.setSkillsStatusForGateway(gatewayId, { ...data, agentId });
        }
      }
      if (commandsRes.ok && commandsRes.result) {
        const data = commandsRes.result as unknown as CommandsListResponse;
        if (Array.isArray(data.commands)) {
          deps.setCommandCatalogForGateway(gatewayId, data.commands);
        }
      }
    } catch (err) {
      if (ownsCatalogRequest(gatewayId, request) && !request.agentId) {
        deps.setModelCatalogFailureForGateway(gatewayId, true);
      }
      console.warn('[catalogs] Failed to fetch catalogs for gateway', gatewayId, err);
    }
  }

  function refreshCatalogsForGateway(gatewayId: string, options: { isCurrent?: () => boolean } = {}): Promise<void> {
    return fetchCatalogs(gatewayId, () => connectedGateways.has(gatewayId) && options.isCurrent?.() !== false);
  }

  async function fetchEffectiveTools(gatewayId: string, sessionKey: string): Promise<void> {
    const requestKey = `${gatewayId}\u0000${sessionKey}`;
    const requestToken = Symbol(requestKey);
    effectiveToolsRequestTokens.set(requestKey, requestToken);
    deps.setEffectiveToolsState(gatewayId, sessionKey, { status: 'loading' });
    const settle = (state: EffectiveToolsLoadState): void => {
      if (effectiveToolsRequestTokens.get(requestKey) !== requestToken) return;
      effectiveToolsRequestTokens.delete(requestKey);
      deps.setEffectiveToolsState(gatewayId, sessionKey, state);
    };
    try {
      const response = await deps.gateway.getEffectiveTools(gatewayId, sessionKey);
      if (!response.ok) {
        // 2026-10-06（10-01 用户实测 #1 同族，报告 issue1-investigation-20261006.md）：
        // 打开任务时预取工具目录先于会话创建（会话在首条 sessions.patch 才懒建），
        // "unknown session key" 属预期内瞬态、秒级自愈（首条消息后 L1395 自愈路径重拉）。
        // 状态保持 fail-closed 的 error（不假装 ready、不回退 tools.catalog），
        // 仅把上屏文案产品化——ToolsCatalog 悬停 title 直接拼该值，不再裸露英文。
        const isSessionNotReady = /unknown session key/i.test(response.error ?? '');
        settle({
          status: 'error',
          error: isSessionNotReady
            ? '会话尚未就绪，发送第一条消息后会自动恢复'
            : response.error || 'tools.effective failed',
        });
        return;
      }
      const inventory = response.result;
      if (!isEffectiveToolsInventory(inventory)) {
        settle({
          status: 'error',
          error: 'tools.effective returned an invalid response',
        });
        return;
      }
      settle({ status: 'ready', inventory });
    } catch (error) {
      settle({
        status: 'error',
        error: error instanceof Error ? error.message : 'tools.effective failed',
      });
    }
  }

  function markAbortedByUser(taskId: string): void {
    abortedByUser.add(taskId);
  }

  async function fetchAgentsForGateway(
    gatewayId: string,
    agentCatalogByGateway: Record<string, unknown>,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (!options.force && agentCatalogByGateway[gatewayId]) return;
    try {
      const res = await deps.gateway.listAgents(gatewayId);
      if (!res.ok || !res.result) {
        if (options.force) throw new Error(res.error?.trim() || 'assistant catalog refresh failed');
        return;
      }
      const data = res.result as unknown as AgentListResponse;
      if (!data.agents) {
        if (options.force) throw new Error('assistant catalog refresh returned no agents');
        return;
      }
      deps.setAgentCatalogForGateway(gatewayId, data.agents, data.defaultId);
    } catch (error) {
      console.warn('[catalogs] Failed to fetch agents for gateway', gatewayId);
      if (options.force) throw error;
    }
  }

  function handleCanonicalMediaMessage(payload: Record<string, unknown>, gatewayId: string): void {
    const sessionKey = payload.sessionKey;
    if (typeof sessionKey !== 'string' || deps.isEphemeralSession?.(sessionKey)) return;
    const message = payload.message;
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) return;
    if (
      !message.content.some((block: unknown) => isRecord(block) && (block.type === 'video' || block.type === 'image'))
    )
      return;
    const task = deps
      .getTaskStore()
      .tasks.find((candidate) => candidate.gatewayId === gatewayId && candidate.sessionKey === sessionKey);
    if (!task) return;
    deps.syncSessionMessages(task.id, sessionKey).catch((error) => {
      debugEvent('renderer.sync.media-message.failed', {
        taskId: task.id,
        sessionKey,
        error: error instanceof Error ? error.message : 'unknown',
      });
    });
  }

  function start(): () => void {
    const removeGatewayEvent = deps.gateway.onGatewayEvent((data) => {
      debugEvent('renderer.gateway.event.received', {
        gatewayId: data.gatewayId,
        event: data.event,
        payloadKeys: Object.keys(data.payload ?? {}),
      });
      if (data.event === 'chat' || data.event === 'agent') {
        routeRunFrame(data);
      } else if (data.event === 'sessions.changed') {
        handleSessionChangedEvent(data.payload as SessionChangedEvent, data.gatewayId);
      } else if (data.event === 'session.message') {
        handleCanonicalMediaMessage(data.payload, data.gatewayId);
      } else if (data.event === 'exec.approval.requested') {
        deps.onApprovalRequested?.(data.gatewayId, data.payload);
        foldApprovalTopLevel(data, 'requested');
      } else if (data.event === 'exec.approval.resolved') {
        foldApprovalTopLevel(data, 'resolved');
        // V3：类型化结论 —— 渲染层（I）按 gatewayId+id 索引/移除审批；
        // 来源字段只透传帧里的原值，不猜。
        const payload = data.payload as Record<string, unknown>;
        const request = payload.request as Record<string, unknown> | null | undefined;
        const conclusion: ApprovalResolvedConclusion = {
          id: typeof payload.id === 'string' ? payload.id : '',
          gatewayId: data.gatewayId,
          ...(payload.decision !== undefined ? { decision: String(payload.decision) } : {}),
          ...(payload.resolvedBy !== undefined ? { resolvedBy: String(payload.resolvedBy) } : {}),
          ...(request
            ? {
                request: {
                  ...(typeof request.sessionKey === 'string' ? { sessionKey: request.sessionKey } : {}),
                  ...(typeof request.runId === 'string' ? { runId: request.runId } : {}),
                  ...(typeof request.toolCallId === 'string' ? { toolCallId: request.toolCallId } : {}),
                  ...(typeof request.command === 'string' ? { command: request.command } : {}),
                },
              }
            : {}),
        };
        deps.onApprovalResolved?.(conclusion);
      } else if (data.event === 'question.requested') {
        deps.onQuestionRequested?.(data.gatewayId, data.payload);
      } else if (data.event === 'question.resolved') {
        deps.onQuestionResolved?.((data.payload as { id: string }).id);
      } else if (UNWIRED_APPROVAL_EVENTS.has(data.event)) {
        // ⭐ **点名记一条**（`renderer.gateway.event.received` 其实每个事件都记，但它只给
        //    事件名 —— 排查的人得**知道要去找那个名字**才看得到）。这一条的意义是：
        //    用户报"插件功能用不了"时，我们能直接在日志里查到"那条审批请求**来过**"。
        //
        //    ⚠️ **不改行为**：不弹窗、不回复、不做任何事 —— 接不接是产品决定。
        debugEvent('renderer.gateway.approval_event.unwired', {
          gatewayId: data.gatewayId,
          event: data.event,
          payloadKeys: Object.keys(data.payload ?? {}),
        });
      }
    });

    return removeGatewayEvent;
  }

  async function initialize(): Promise<void> {
    deps.hydrateFromLocal();

    deps.gateway.gatewayStatus().then((statusMap) => {
      for (const [gwId, info] of Object.entries(statusMap)) {
        const status = info.connected
          ? ('connected' as const)
          : info.error
            ? ('disconnected' as const)
            : ('connecting' as const);
        deps.setGatewayStatusByGateway(gwId, status);
        if (info.serverVersion) deps.setGatewayVersion(gwId, info.serverVersion);
        if (info.maxPayloadBytes !== undefined) deps.setGatewayMaxPayloadByGateway?.(gwId, info.maxPayloadBytes);
        if (info.connected) connectedGateways.add(gwId);
      }
      if (connectedGateways.size > 0 && !synced) {
        synced = true;
        void deps.syncFromGateway().catch((error) => console.warn('[sync] Gateway session sync failed', error));
        for (const gwId of connectedGateways) fetchCatalogs(gwId);
      }
    });

    deps.gateway.listGateways().then((gateways) => {
      const defaultGw = gateways.find((g) => g.isDefault);
      if (defaultGw) deps.setDefaultGatewayId(defaultGw.id);
      else if (gateways.length > 0) deps.setDefaultGatewayId(gateways[0].id);
      const infoMap: Record<string, { id: string; name: string; color?: string }> = {};
      for (const gw of gateways) {
        infoMap[gw.id] = { id: gw.id, name: gw.name, color: gw.color };
      }
      deps.setGatewayInfoMap(infoMap);
      deps.setGatewaysLoaded(true);
    });
  }

  function handleGatewayStatus(s: GatewayStatusEvent): void {
    const wasConnected = connectedGateways.has(s.gatewayId);
    const next = s.connected ? ('connected' as const) : s.error ? ('disconnected' as const) : ('connecting' as const);
    deps.setGatewayStatusByGateway(s.gatewayId, next);
    deps.setGatewayVersion(s.gatewayId, s.serverVersion);
    // ⚠️ 与 version 同一口径（缺席即清）：单帧上限是**连接参数**，断线/旧网关即"没谈到"，
    //    发送预算随之回落默认值 —— 留着上一代的数字会让闸门按一个不再成立的值收紧。
    deps.setGatewayMaxPayloadByGateway?.(s.gatewayId, s.maxPayloadBytes);

    if (s.reconnectAttempt !== undefined && s.maxAttempts !== undefined) {
      deps.setGatewayReconnectInfo(s.gatewayId, {
        attempt: s.reconnectAttempt,
        max: s.maxAttempts,
        gaveUp: s.gaveUp ?? false,
        // ⚠️ 缺席就**别填**（`undefined` 与"没有结论"同义）：替它编一个 unknown
        //    会让界面把"还在重连"说成"出错了"。
        reason: s.reason,
      });
    } else if (s.connected) {
      deps.setGatewayReconnectInfo(s.gatewayId, null);
    }

    if (s.connected && !wasConnected) {
      connectedGateways.add(s.gatewayId);
      deps.onToast?.('success', deps.translate('connection.reconnected'));
      if (!synced) {
        synced = true;
        void deps.syncFromGateway().catch((error) => console.warn('[sync] Gateway session sync failed', error));
      }
      deps.retrySyncPending();
      fetchCatalogs(s.gatewayId);
      deps.syncPendingQuestions?.(s.gatewayId);
    } else if (!s.connected && wasConnected) {
      connectedGateways.delete(s.gatewayId);
      cancelCatalogRetry(s.gatewayId);
      catalogRequests.delete(s.gatewayId);
      deps.onToast?.('warning', deps.translate('connection.lostConnection'), {
        description: deps.translate('connection.reconnecting'),
      });
      const gwInfo = deps.getGatewayInfoMap()[s.gatewayId];
      maybeNotify('gatewayDisconnect', {
        title: deps.translate('notifications.gatewayDisconnected'),
        body: gwInfo?.name || s.gatewayId,
      });
    }
  }

  /**
   * 本机运行时起不来的**结论**（公开原因），只写那一个字段。
   *
   * ⚠️ **刻意不动**网关状态与重连信息：那是"连上了没有"这一层的事，
   *    而这条讲的是"我们自己的网关进程压根没起来"—— 两者可以各自独立地成立。
   *    混进同一格就会出现"连接正常却显示端口被占"这种自相矛盾的界面。
   */
  function handleRuntimeStatus(status: RuntimeStatusEvent): void {
    deps.setRuntimeBootstrapFailure?.(status.ok ? null : status.reason);
  }

  function startGatewayStatus(): () => void {
    const removeStatus = deps.gateway.onGatewayStatus(handleGatewayStatus);
    // ⚠️ 可选订阅，且**必须各订各的**：出厂形态 / pwa 没有"本机运行时"这条通道，
    //    缺了它不能让网关状态一起不订（那样连"连上了没有"都读不到了）。
    const removeRuntime = deps.gateway.onRuntimeStatus?.(handleRuntimeStatus);
    // ⭐ **初始读**：这条结论往往在窗口挂上来之前就产生了，那次推送没人收 ——
    //    少了这一次补读，界面就只会一直"正在准备模型"（与 relay 公开状态同一个理由，
    //    见 `main/ipc/commercial-handlers.ts`）。
    //    ⚠️ `null` = 还没有结论：**不写 store**（不许把"没结论"说成"出错了"）。
    void deps.gateway
      .runtimeStatus?.()
      .then((status) => {
        if (status) handleRuntimeStatus(status);
      })
      .catch(() => {
        // 读不到就当"没有结论"（界面照旧显示准备中），但**留一条遥测**：
        // 真机上"界面一直转圈"时，得能分清是"补读也读不到"还是"压根没有这条通道"。
        // ⚠️ 不带原始 message：它是 IPC 层来的，内容不受我们控制（同 `GatewayFailureReason`
        //    那条纪律），具体原因在主进程日志里。
        debugEvent('renderer.runtime_status.read_failed', {});
      });
    return () => {
      removeStatus();
      removeRuntime?.();
    };
  }

  function reset(): void {
    perTaskLastError.clear();
    for (const b of lifecycleErrorBuffer.values()) clearTimeout(b.timer);
    lifecycleErrorBuffer.clear();
    abortedByUser.clear();
    closedStreams.clear();
    currentRuns.clear();
    pendingDispatches.clear();
    connectedGateways.clear();
    for (const timer of catalogRetryTimers.values()) clearTimeout(timer);
    catalogRetryTimers.clear();
    catalogRequests.clear();
    effectiveToolsRequestTokens.clear();
    synced = false;
  }

  return {
    beginDispatch,
    settleDispatch,
    start,
    initialize,
    startGatewayStatus,
    markAbortedByUser,
    fetchAgentsForGateway,
    refreshCatalogsForGateway,
    fetchEffectiveTools,
    reset,
  };
}
