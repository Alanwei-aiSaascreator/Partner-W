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
  extractText,
  extractThinking,
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
} from './protocol/normalize-history.js';

export {
  createMessageStore,
  mergeCanonicalMessageWithActiveTurn,
  activeTurnToMessage,
  EMPTY_MESSAGES,
} from './stores/message-store.js';
export type { MessageState, MessageStoreDeps, ActiveTurn } from './stores/message-store.js';

export { createTaskStore } from './stores/task-store.js';
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
export type { SessionSyncDeps } from './services/session-sync.js';

export { buildAppError, formatErrorForUser, formatErrorForToast } from './services/error-classify.js';
export type { TranslateFn } from './services/error-classify.js';

export { describeGatewayError, translateGatewayError } from './services/gateway-error-message.js';
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
export { describeTemplateError } from './services/agent-template-error-message.js';
export { normalizeGrowthSummary, normalizeGrowthHistory, normalizeBounties } from './services/growth-service.js';
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

export { deriveSessionActivity, getTaskSessionKeys } from './services/session-activity.js';
export type { SessionActivity } from './services/session-activity.js';

export { createGatewayDispatcher, RUN_PHASE_IDS } from './services/gateway-dispatcher.js';
export type { GatewayDispatcherDeps } from './services/gateway-dispatcher.js';

export { createChatComposer } from './services/chat-composer.js';
export type { ChatComposerDeps, ChatComposer, SendOptions } from './services/chat-composer.js';

export { createSystemSessionService } from './services/system-session-service.js';
export type { SystemSessionServiceDeps, SystemSessionService } from './services/system-session-service.js';

export {
  parseTeamMd,
  parseSkillsJson,
  extractSkillSlugs,
  parseIdentityMd,
  extractDescription,
  serializeIdentityMd,
} from './services/team-parser.js';
export { installTeam } from './services/team-installer.js';
export type { InstallerDeps } from './services/team-installer.js';
