export type {
  PlatformPorts,
  PersistencePort,
  GatewayTransportPort,
  SettingsPort,
  NotificationsPort,
} from './ports/platform.js';

export type { PersistedTask, PersistedMessage, ListResult } from './ports/persistence.js';

export type {
  GatewayEvent,
  GatewayStatusEvent,
  GatewayStatusInfo,
  GatewayStatusMap,
  GatewayListItem,
  DiscoveredSession,
  SyncResult,
  ChatAttachment,
} from './ports/gateway-transport.js';

export type { AppSettings, NotificationSettings } from './ports/settings.js';

export type {
  ChatContentBlock,
  ChatMessage,
  ChatEventPayload,
  RawContentBlock,
  RawHistoryMessage,
  NormalizedAssistantTurn,
  DiscoveredMessageShape,
} from './protocol/types.js';

export {
  extractDeltaText,
  extractText,
  extractThinking,
  extractToolResultText,
  extractToolCalls,
  parseToolArgs,
  safeJsonParse,
} from './protocol/parse-content.js';

export {
  INTERNAL_ASSISTANT_MARKERS,
  sanitizeModel,
  isVisibleAssistantContent,
  normalizeContentBlocks,
  normalizeAssistantTurns,
  collapseDiscoveredMessages,
  toISOTimestamp,
} from './protocol/normalize-history.js';

// V2（2026-10-13 step 2）：执行事件协议 / 纯映射 / 纯归约。
export { mapNativeToExecution } from './protocol/map-execution-event.js';
export type { ExecutionMapContext } from './protocol/map-execution-event.js';
export type {
  ExecutionChannel,
  ExecutionEvent,
  ExecutionEventType,
  ExecutionEventSource,
  ExecutionEvidence,
} from './protocol/execution-events.js';
export { createExecutionProjection, reduceExecutionProjection, stepKeyOf } from './stores/execution-projection.js';
export type {
  ExecutionProjection,
  ExecutionStep,
  ExecutionStepState,
  ExecutionModelPhase,
} from './stores/execution-projection.js';
// R5（2026-10-14 集中修复）：完成资格的**唯一真源** —— dispatcher 与交付出口/通知共用；
// 别再各自写一份"任务完成"判据（renderer 接线由 I 做）。
export { evaluateRunCompletion, deliveryRequirementsOf } from './stores/execution-projection.js';
export type {
  RunCompletionStatus,
  RunCompletionVerdict,
  RunCompletionRequirementSet,
  TurnRegistrationStatus,
} from './stores/execution-projection.js';
// V4（2026-10-13 step 5）：执行历史的事件选择 + 预算常量（main 侧 writer 共用同一常量）。
export {
  selectHistoryEvents,
  executionEventPriority,
  EXECUTION_HISTORY_ENTRY_BUDGET_BYTES,
  EXECUTION_HISTORY_SUMMARY_LIMIT,
  EXECUTION_HISTORY_RUN_BUDGET_BYTES,
  EXECUTION_HISTORY_QUEUE_LIMIT_ENTRIES,
  EXECUTION_HISTORY_QUEUE_BUDGET_BYTES,
  EXECUTION_HISTORY_DIR_BUDGET_BYTES,
  EXECUTION_HISTORY_RETENTION_DAYS,
} from './stores/execution-history.js';
export type { HistorySelection, SelectHistoryOptions, ExecutionHistoryPriority } from './stores/execution-history.js';

export {
  createMessageStore,
  mergeCanonicalMessageWithActiveTurn,
  activeTurnToMessage,
  activeTurnProducedOutput,
  EMPTY_MESSAGES,
} from './stores/message-store.js';
export type {
  MessageState,
  MessageStoreDeps,
  ActiveTurn,
  ActiveTurnActivity,
  AutoRetryFailure,
} from './stores/message-store.js';

export { createTaskStore, UnknownAgentError } from './stores/task-store.js';
export type { TaskState, TaskStoreDeps, PendingNewTask } from './stores/task-store.js';

export { createRoomStore } from './stores/room-store.js';
export type { RoomState, RoomStoreDeps, PerformerAgent } from './stores/room-store.js';

export { createTeamStore } from './stores/team-store.js';
export type { TeamState, TeamStoreDeps } from './stores/team-store.js';

export { createSystemSessionStore } from './stores/system-session-store.js';
export type { SystemSessionState, SystemSessionMessage, SystemSessionStatus } from './stores/system-session-store.js';

export { createUiStore } from './stores/ui-store.js';
export type {
  UiState,
  UiStoreDeps,
  MainView,
  Theme,
  DensityMode,
  SendShortcut,
  MessageLayout,
  PanelShortcutLeft,
  PanelShortcutRight,
  GatewayConnectionStatus,
  GatewayInfo,
} from './stores/ui-store.js';

export { createSessionSync } from './services/session-sync.js';
export type { SessionSyncDeps, RunSyncResult, LateToolUpdate } from './services/session-sync.js';
export { observeChatRun } from './services/run-observer.js';
export type { ChatRunTerminal } from './services/run-observer.js';

export { buildAppError, formatErrorForUser, formatErrorForToast } from './services/error-classify.js';
export {
  COMPACTION_FALLBACK_MS,
  COMPACTION_NOTICE_KEY,
  announceCompaction,
  currentCompactionEpisode,
  noteManualCompactionResult,
  runManualCompaction,
  type CompactionDeps,
} from './services/compaction-announce.js';
export type { TranslateFn } from './services/error-classify.js';
export { findRetryTarget } from './services/retry-turn.js';
export type { RetryTarget } from './services/retry-turn.js';

export { describeGatewayError, translateGatewayError } from './services/gateway-error-message.js';
export { describeSendRefusal } from './services/send-refusal-message.js';
export { describeCommunityError } from './services/community-error-message.js';
export { normalizeFeed, normalizeTeamInfo, nextFeedCursor } from './services/community-service.js';
export {
  normalizeMyTemplates,
  normalizeTemplateDetail,
  normalizeTemplateList,
  templateSlug,
  templateToInstallDefinition,
} from './services/agent-template-service.js';
export type { AgentInstallDefinition } from './services/agent-template-service.js';
export { describeTemplateError, describeTemplateErrorKey } from './services/agent-template-error-message.js';
export {
  normalizeGrowthSummary,
  normalizeGrowthHistory,
  normalizeBounties,
  normalizeDailyTasks,
  computeCheckInStreak,
  shanghaiDate,
} from './services/growth-service.js';
export { describeGrowthError } from './services/growth-error-message.js';
export { normalizePrivacyState, DELETION_REQUEST_NOTE } from './services/privacy-service.js';
export type {
  PrivacyState,
  PrivacyExportState,
  PrivacyDeletionState,
  PrivacyRequestStatus,
} from './services/privacy-service.js';
export { describePrivacyError } from './services/privacy-error-message.js';

export {
  autofillSelection,
  buildQuestionCancelParams,
  buildQuestionResolveParams,
  describeQuestionFailure,
  isQuestionExpired,
  parseQuestionRequest,
  resolveQuestionSelection,
} from './services/question-flow.js';
export type {
  PendingQuestion,
  QuestionOption,
  QuestionRequest,
  QuestionSelection,
  QuestionSelectionResult,
} from './services/question-flow.js';

export { autoTitleIfNeeded } from './services/auto-title.js';

export { deriveSessionActivity, getTaskSessionKeys, pickWaitingSessionKey } from './services/session-activity.js';
export type { SessionActivity } from './services/session-activity.js';

export { createGatewayDispatcher, RETRY_RUN_PHASE, RUN_PHASE_IDS } from './services/gateway-dispatcher.js';
export type { GatewayDispatcherDeps } from './services/gateway-dispatcher.js';

export { createChatComposer } from './services/chat-composer.js';
export type { ChatComposerDeps, ChatComposer, SendOptions } from './services/chat-composer.js';
export { DEFAULT_COMPUTER_ACCESS_TIER, decidePermissionPatch } from './services/computer-access.js';
export type {
  AppliedPermissionMap,
  AppliedPermissionMode,
  AppliedPermissionRecord,
  ComputerAccessTier,
} from './services/computer-access.js';

export { createSystemSessionService, SYSTEM_SESSION_BUSY } from './services/system-session-service.js';
export type { SystemSessionServiceDeps, SystemSessionService } from './services/system-session-service.js';

export {
  parseTeamMd,
  parseSkillsJson,
  extractSkillSlugs,
  parseIdentityMd,
  extractDescription,
  serializeIdentityMd,
  withIdentityName,
} from './services/team-parser.js';
export { installTeam } from './services/team-installer.js';
export { resolveCatalogAgentId } from './services/catalog-owner.js';
export type { InstallerDeps } from './services/team-installer.js';

// 资料库（T6a：切片 / 状态机 / 向量 / 混合排序）。纯逻辑，无 IO。
export { KB_CHUNK_STATES, isKbChunkState } from './services/kb/types.js';
export type {
  KbSourceKind,
  KbChunkState,
  KbChunkDraft,
  KbEmbeddableChunk,
  KbChunkingOptions,
} from './services/kb/types.js';

export { hashText, hashBytes } from './services/kb/hashing.js';

export {
  KbVectorError,
  isKbVectorError,
  encodeVector,
  decodeVector,
  toVectorArray,
  cosineSimilarity,
} from './services/kb/vectors.js';

export {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_MIN_CHUNK_SIZE,
  HEADING_PREFIX_LABEL,
  headingPrefix,
  splitText,
  estimateTokens,
} from './services/kb/chunking.js';
export type { TextChunk } from './services/kb/chunking.js';

export { isEmbeddingEngineReady } from './services/kb/embedding.js';
export type { EmbeddingEngine } from './services/kb/embedding.js';

export {
  DEFAULT_EMBED_BATCH_SIZE,
  buildChunkDrafts,
  chunkNeedsEmbedding,
  markStaleChunks,
  embedPendingChunks,
} from './services/kb/pipeline.js';
export type { EmbedPendingOptions, EmbedPendingResult } from './services/kb/pipeline.js';

export {
  DEFAULT_KB_LIMIT,
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_VECTOR_WEIGHT,
  rankKbCandidates,
} from './services/kb/retrieval.js';
export type { KbSearchCandidate, KbSearchHit, KbRankOptions, KbRankResult } from './services/kb/retrieval.js';

// ── 生产能力注册表（BUG-043）：能力三态 + 验证账本 + Planner 边界 ──────────────
export {
  CAPABILITY_VERIFICATION_LEDGER,
  PLANNER_UNAVAILABLE_TOOL_IDS,
  RELAY_SEARCH_ENABLED_MODEL_IDS,
  availableChatModelIds,
  buildCapabilityRegistry,
  findCapabilityEntry,
  plannerDeniedToolIds,
} from './capability/capability-registry.js';
export type {
  CapabilityAvailability,
  CapabilityEntry,
  CapabilityEvidence,
  CapabilityKind,
  CapabilityLedgerRecord,
  CapabilityModelSource,
  CapabilityRegistryInput,
} from './capability/capability-registry.js';

export {
  CAPABILITY_BOUNDARY_PROMPT_VERSION,
  UNSUPPORTED_CAPABILITY_COPY_KEY,
  UNSUPPORTED_MODEL_COPY_KEY,
  buildCapabilityBoundaryPrompt,
  capabilityBoundaryEndMarker,
  capabilityBoundaryStartMarker,
  mergeCapabilityBoundaryBlock,
  recognizeUnsupportedCapabilityRequest,
} from './capability/capability-boundary.js';
export type {
  CapabilityBoundaryMergeResult,
  RecognizeUnsupportedOptions,
  UnsupportedRequestHit,
  UnsupportedRequestReason,
} from './capability/capability-boundary.js';

export {
  MEMORY_BLOCK_MAX_CHARS,
  MEMORY_DRAFT_MAX_PER_MESSAGE,
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_MAX_CONFIRMED_ENTRIES,
  checkMemoryBudget,
  checkMemoryText,
  confirmedBlockChars,
  isPresentableDraft,
  memoryDedupeKey,
  normalizeMemoryText,
} from './memory/memory-entry.js';
export type {
  MemoryBudgetCheck,
  MemoryEntry,
  MemoryEntrySource,
  MemoryEntryStatus,
  MemoryTextCheck,
  MemoryTextRejection,
} from './memory/memory-entry.js';

export {
  MEMORY_BLOCK_MARKER_PREFIX,
  MEMORY_BLOCK_VERSION,
  memoryBlockEntryLines,
  mergeMemoryBlock,
  readMemoryBlock,
  renderMemoryBlock,
} from './memory/memory-block.js';

export {
  MEMORY_CONTRACT_MARKER_PREFIX,
  MEMORY_CONTRACT_VERSION,
  MEMORY_DRAFT_FENCE,
  memoryContractBulletLines,
  mergeMemoryContractBlock,
  renderMemoryContractPrompt,
  scanMemoryDraftFences,
} from './memory/memory-contract.js';
export type { MemoryDraftProposal, MemoryDraftScan } from './memory/memory-contract.js';

export {
  markedBlockBulletLines,
  markedBlockEndMarker,
  markedBlockStartMarker,
  mergeMarkedBlock,
  readMarkedBlock,
} from './memory/marked-block.js';
export type { MarkedBlockMerge } from './memory/marked-block.js';

export {
  MEMORY_RECALL_TOP_N,
  memoryQueryTokens,
  scoreMemoryEntry,
  selectMemoriesForQuery,
} from './memory/recall.js';
