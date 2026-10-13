import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import ConnectionBanner from '@/components/ConnectionBanner';
import RelayConnectionBanner from '@/components/RelayConnectionBanner';
import WorkspaceRecreatedNotice from '@/components/WorkspaceRecreatedNotice';
import {
  PanelRightOpen,
  PanelRightClose,
  Archive,
  ArchiveRestore,
  Search,
  MessageSquare,
  ArrowDown,
  RefreshCw,
  AlertTriangle,
  ArrowLeftRight,
  Wallet,
  Columns3,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { parseAgentIdFromSessionKey, type Message, type ToolCall } from '@clawwork/shared';
import type { AssistantIdentity } from './assistant-identity';
import { useAssistantIdentityIndex } from './useAssistantIdentityIndex';
import {
  deriveSessionActivity,
  getTaskSessionKeys,
  pickWaitingSessionKey,
  serializeIdentityMd,
  type ActiveTurn,
} from '@clawwork/core';
import { useTaskStore } from '@/stores/taskStore';
import { useMessageStore, EMPTY_MESSAGES, activeTurnToMessage } from '@/stores/messageStore';
import { useUiStore } from '@/stores/uiStore';
import { useFileStore } from '@/stores/fileStore';
import { useRoomStore } from '@/stores/roomStore';
import { useCommercialStore } from '@/stores/commercialStore';
import { cn, formatRelativeTime, formatCredits } from '@/lib/utils';
import { anchoredScrollTop, resolveChatScrollAnchor, type ChatScrollSlot } from '@/lib/chat-scroll-anchor';
import { deriveQuotaDisplay } from '@/lib/quota-display';
import { resolveModelLabel, shouldShowModelBadge } from '@/lib/model-display';
import WindowTitlebar from '@/components/semantic/WindowTitlebar';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import ChatMessage from '@/components/ChatMessage';
import AssistantBlock from '@/components/AssistantBlock';
import { useRetryLastTurn, useRetryableErrorMessageId } from '@/hooks/useRetryLastTurn';
import ChatInput from '@/components/ChatInput';
import QuestionPanel from '@/components/QuestionPanel';
import type { DraftPromptRequest, DraftPromptResolution } from '@/components/ChatInput/types';
import ImageLightbox from '@/components/ImageLightbox';
import FilePreviewModal from '@/components/FilePreviewModal';
import EnsembleAgentBar from '@/components/EnsembleAgentBar';
import TeamCollabBar from '@/features/team-meeting/TeamCollabBar';
import FileBrowser from '../FileBrowser';
import CronPanel from '@/layouts/CronPanel';
import TeamsPanel from '@/layouts/TeamsPanel';
import Dashboard from '@/layouts/Dashboard';
import InternalBetaHub from '@/features/internal-beta/InternalBetaHub';
import { isInternalBetaEnabled } from '@/features/internal-beta/beta-route';
import CommunityPanel from '@/layouts/CommunityPanel';
import MarketPanel from '@/layouts/MarketPanel';
import GrowthPanel from '@/layouts/GrowthPanel';
import IdentityCenter from '@/layouts/IdentityCenter';
import SkillMarket from '@/layouts/SkillMarket';
import TasksPanel from '@/layouts/TasksPanel';
import KnowledgeBase from '@/layouts/KnowledgeBase';
import { useUsageStore } from '@/stores/usageStore';
import { useQuotaRefreshOnTurnEnd } from '@/hooks/useQuotaRefreshOnTurnEnd';
import DataTable, { type DataTableColumn } from '@/components/data-display/DataTable';
import EmptyState from '@/components/semantic/EmptyState';
import StatusTag from '@/components/semantic/StatusTag';
import WelcomeScreen from './WelcomeScreen';
import FirstTaskCompletionFlow from './FirstTaskCompletionFlow';
import type { OnboardingProfile } from '@/lib/user-onboarding';
import { startupFailureText, type StartupReadiness, type StartupRetry } from '@/lib/startup-readiness';
import StartupReadinessPanel from './StartupReadinessPanel';
import GoalRecommendationPanel from '@/features/goal-routing/GoalRecommendationPanel';
import { useGoalAnalysis } from '@/features/goal-routing/useGoalAnalysis';
import type { CustomGoalAnalysis } from '@/features/goal-routing/goal-analysis';
import { createAgentWithRollback, deriveAgentCreationId } from '@/lib/agent-builder';
import { checkInstallWorkspace } from '@/lib/install-workspace';
import { fetchAgentsForGateway } from '@/hooks/useGatewayBootstrap';
import { useSelectRecommendedAssistant } from '@/hooks/useSelectRecommendedAssistant';
import { toast } from '@/lib/toast';
import { ASSISTANT_TASK_PRESETS, type AssistantTaskPreset } from '@/lib/assistant-task-presets';
import {
  encodeAssistantTaskPresetTag,
  resolveAssistantTaskPresetIdFromTags,
  upsertAssistantTaskPresetTag,
} from '@/lib/assistant-task-preset-tags';
import {
  loadRecentAssistantTasks,
  recordRecentAssistantTask,
  type RecentAssistantTask,
} from '@/lib/assistant-task-history';
import { selectableModelsFrom } from '@/components/ChatInput/model-families';
import ComparePanel from '@/features/compare/ComparePanel';
import CompareSetupBar from '@/features/compare/CompareSetupBar';
import { compareRuntimeForTask } from '@/features/compare/compare-plan';
import { useCompareStore } from '@/features/compare/compare-store-instance';

const EMPTY_TOOL_CALLS: ToolCall[] = [];

/**
 * 「正在等第一个字」那一项的排序哨兵。
 *
 * ⚠️ 必须是**常量**：写 `Date.now()` 的话每次渲染都变，排序结果会跟着抖
 *（排序用的是 `localeCompare` 比字符串，所以这里就是一个能排到最后的固定串）。
 */
const WAITING_ITEM_TIMESTAMP = '9999-12-31T23:59:59.999Z';

/** 时间线上的一项：已落库的消息，或一个进行中的回合（`turn` 为空 = 还没收到任何内容）。 */
type TimelineItem =
  | { key: string; timestamp: string; kind: 'message'; message: MessageRow }
  | { key: string; timestamp: string; kind: 'turn'; sessionKey: string; turn: ActiveTurn | undefined };

type MessageRow = (typeof EMPTY_MESSAGES)[number];

const STICK_TO_BOTTOM_THRESHOLD_PX = 60;
const MAX_HEADER_TITLE_LENGTH = 120;

/**
 * 时间线上"正在生成的那一格"（等待中或流式）。
 *
 * 渲染分支与滚动锚点**共用这一个判据** —— 两处各写一份（"有内容" / "轮到它等待"）
 * 迟早会漂，而漂的表现恰好是"锚点找不到新回答"这种静默失效。
 */
function isLiveAnswerItem(item: TimelineItem, waitingSessionKey: string | undefined): boolean {
  if (item.kind !== 'turn') return false;
  if (item.turn?.finalized) return false;
  const turnHasContent = Boolean(
    item.turn && (item.turn.streamingText || item.turn.streamingThinking || item.turn.toolCalls.length > 0),
  );
  return turnHasContent || item.sessionKey === waitingSessionKey;
}

/** 时间线项 → 滚动语义（`resolveChatScrollAnchor` 的输入）。 */
function scrollSlotFor(item: TimelineItem, waitingSessionKey: string | undefined): ChatScrollSlot {
  if (item.kind === 'message') return item.message.role === 'user' ? 'user' : 'assistant';
  return isLiveAnswerItem(item, waitingSessionKey) ? 'live-answer' : 'other';
}

function artifactCreatedAtTimestamp(createdAt: string | null | undefined): number {
  const timestamp = Date.parse(createdAt ?? '');
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

export function createDraftPromptRequest(
  sequence: number,
  prompt: string,
  source: DraftPromptRequest['source'],
  presetId?: string,
): DraftPromptRequest {
  return {
    id: `draft-request-${sequence}`,
    prompt,
    source,
    ...(presetId ? { presetId } : {}),
  };
}

interface MainAreaProps {
  onTogglePanel: () => void;
  onboardingProfile: OnboardingProfile;
  startupReadiness: StartupReadiness;
  onRetryStartup: StartupRetry;
  /**
   * 打开「编辑我的资料」引导（个性化中心那条入口，2026-10-06 由主 Agent 在 `App.tsx`
   * 注入 `setEditingOnboardingProfile`）。不给就不渲染那个入口（`IdentityCenter` 的契约）。
   */
  onEditOnboardingProfile?: () => void;
}

interface ArchivedTaskRow {
  id: string;
  title: string;
  gatewayName: string;
  updatedAt: string;
}

interface DraftRequestOwner {
  requestId: string;
  userId: string;
  gatewayId: string;
  agentId: string;
  taskId: string | null;
}

function ChatHeader({
  onTogglePanel,
  messageLayout,
  onToggleMessageLayout,
  compareMode,
  onToggleCompare,
}: {
  onTogglePanel: () => void;
  messageLayout: 'centered' | 'wide';
  onToggleMessageLayout: () => void;
  compareMode: boolean;
  onToggleCompare: () => void;
}) {
  const { t } = useTranslation();
  const activeTask = useTaskStore((s) => s.tasks.find((task) => task.id === s.activeTaskId));
  const updateTaskTitle = useTaskStore((s) => s.updateTaskTitle);
  const commercialOverview = useCommercialStore((s) => s.overview);
  const loadCommercial = useCommercialStore((s) => s.load);

  useEffect(() => {
    void loadCommercial();
  }, [loadCommercial]);

  const quotaMicros = commercialOverview?.license?.tokenQuotaMicros ?? 0;
  const usedMicros = commercialOverview?.license?.tokenUsedMicros ?? 0;
  // 剩余额度，单位微积分 → 显示成积分。
  const quotaDisplay = deriveQuotaDisplay(quotaMicros, usedMicros);
  const remainingCredits = formatCredits(quotaDisplay.remaining);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  const startTitleEdit = useCallback(() => {
    if (!activeTask) return;
    setTitleDraft(activeTask.title);
    setEditingTitle(true);
    requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    });
  }, [activeTask]);

  const commitTitleEdit = useCallback(() => {
    const trimmed = titleDraft.trim().slice(0, MAX_HEADER_TITLE_LENGTH);
    if (activeTask && trimmed && trimmed !== activeTask.title) {
      updateTaskTitle(activeTask.id, trimmed);
    }
    setEditingTitle(false);
  }, [titleDraft, activeTask, updateTaskTitle]);

  const cancelTitleEdit = useCallback(() => {
    setEditingTitle(false);
  }, []);

  const handleTitleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTitleEdit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelTitleEdit();
      }
    },
    [commitTitleEdit, cancelTitleEdit],
  );
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const usageStatus = useUsageStore((s) => s.status);
  const usageLoading = useUsageStore((s) => s.loading);
  const fetchUsage = useUsageStore((s) => s.fetchUsage);
  const startAutoRefresh = useUsageStore((s) => s.startAutoRefresh);
  const stopAutoRefresh = useUsageStore((s) => s.stopAutoRefresh);

  const costGatewayId = activeTask?.gatewayId ?? '';
  useEffect(() => {
    // 只要网关级用量：会话级两条（`usage.cost` / `sessions.usage`）已撤（T-a23/T-a25），
    // 所以这里**不再需要** sessionKey，切任务也不必重开计时器（`costGatewayId` 换了才重开）。
    if (costGatewayId) startAutoRefresh(costGatewayId);
    return () => stopAutoRefresh();
  }, [costGatewayId, startAutoRefresh, stopAutoRefresh]);

  const contextTokens = activeTask?.contextTokens ?? null;
  const contextUsagePercent =
    contextTokens != null && contextTokens > 0 ? Math.round((contextTokens / 200_000) * 100) : null;
  const hasContextSummary = contextUsagePercent != null;
  // ⚠️ 顶栏**只报上下文占用**（功能仪表），不再报 token 数与美元成本：
  //    用户账单单据只有积分（产品决定 2026-09-17），token/官方参考价/倍率/人民币
  //    属于运营口径，留在服务端账本与运营后台。回归测试见 test/dashboard-overview.test.tsx。
  const hasUsageData = hasContextSummary;

  return (
    <header className="titlebar-drag flex items-center justify-between px-5 h-[var(--density-toolbar-height)] border-b border-[var(--border)] flex-shrink-0">
      <div className="titlebar-no-drag flex items-center gap-2.5">
        {activeTask ? (
          <>
            {editingTitle ? (
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value.slice(0, MAX_HEADER_TITLE_LENGTH))}
                onBlur={commitTitleEdit}
                onKeyDown={handleTitleKeyDown}
                maxLength={MAX_HEADER_TITLE_LENGTH}
                className="type-label max-w-80 rounded border border-[var(--ring-accent)] bg-[var(--bg-primary)] px-1.5 py-0.5 text-[var(--text-primary)] outline-none"
              />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <h2
                    className="type-section-title max-w-xl cursor-pointer truncate text-[var(--text-primary)]"
                    onDoubleClick={startTitleEdit}
                  >
                    {activeTask.title || t('common.newTask')}
                  </h2>
                </TooltipTrigger>
                <TooltipContent>{t('contextMenu.rename')}</TooltipContent>
              </Tooltip>
            )}
          </>
        ) : (
          <h2 className="type-label text-[var(--text-muted)]">{t('common.appName')}</h2>
        )}
      </div>
      <div className="titlebar-no-drag flex items-center gap-1">
        {quotaMicros > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="type-meta inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-2 text-[var(--text-secondary)] hover:border-[var(--border)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                aria-label={t('usage.balance')}
              >
                <Wallet size={14} />
                <span className={usedMicros >= quotaMicros ? 'text-[var(--danger)]' : undefined}>
                  {remainingCredits} {t('usage.creditsUnit')}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72">
              <div className="space-y-2">
                <p className="type-label text-[var(--text-primary)]">{t('usage.balance')}</p>
                <div className="flex items-center justify-between type-support text-[var(--text-secondary)]">
                  <span>{t('usage.quotaTotal')}</span>
                  <span>
                    {formatCredits(quotaMicros)} {t('usage.creditsUnit')}
                  </span>
                </div>
                <div className="flex items-center justify-between type-support text-[var(--text-secondary)]">
                  <span>{t('usage.quotaUsed')}</span>
                  <span>
                    {formatCredits(usedMicros)} {t('usage.creditsUnit')}
                  </span>
                </div>
                <div
                  className="h-1.5 w-full rounded-full bg-[var(--bg-tertiary)]"
                  role="progressbar"
                  aria-label={t('dashboard.remainingCredits')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(quotaDisplay.remainingPercent)}
                >
                  <div
                    className="h-1.5 rounded-full bg-[var(--accent)] transition-all"
                    style={{ width: `${quotaDisplay.remainingPercent}%` }}
                  />
                </div>
              </div>
            </PopoverContent>
          </Popover>
        )}
        {hasUsageData && (
          <Popover>
            <PopoverTrigger asChild>
              <button className="type-meta inline-flex h-8 items-center gap-0 rounded-lg border border-[var(--border-subtle)] px-1 text-[var(--text-secondary)] hover:border-[var(--border)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer">
                {hasContextSummary && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-0.5 px-1.5',
                      contextUsagePercent >= 90
                        ? 'text-[var(--danger)]'
                        : contextUsagePercent >= 70
                          ? 'text-[var(--warning)]'
                          : 'text-[var(--accent)]',
                    )}
                  >
                    <span className="text-[var(--text-secondary)]">{t('rightPanel.contextUsage')}</span>
                    {contextUsagePercent}%
                  </span>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 max-h-screen overflow-y-auto">
              <div className="space-y-3">
                {usageStatus && usageStatus.providers.length > 0 && (
                  <div className="space-y-2 border-t border-[var(--border)] pt-3">
                    <div className="flex items-center justify-between">
                      <span className="type-label text-[var(--text-secondary)]">{t('usage.rateLimits')}</span>
                      <button
                        onClick={() => fetchUsage(costGatewayId)}
                        disabled={usageLoading}
                        aria-label={t('mainArea.refreshUsage')}
                        className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
                      >
                        <RefreshCw size={12} className={cn(usageLoading && 'animate-spin')} />
                      </button>
                    </div>
                    {usageStatus.providers.map((provider) => (
                      <div key={provider.provider} className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="type-support text-[var(--text-primary)]">{provider.displayName}</span>
                          {provider.plan ? <StatusTag tone="accent">{provider.plan}</StatusTag> : null}
                        </div>
                        {provider.error && (
                          <div className="type-meta flex items-center gap-1 text-[var(--danger)]">
                            <AlertTriangle size={10} />
                            {provider.error}
                          </div>
                        )}
                        {provider.windows.map((w, i) => (
                          <div key={i} className="space-y-0.5">
                            <div className="type-meta flex items-center justify-between text-[var(--text-muted)]">
                              <span>{w.label}</span>
                              <span className={cn(w.usedPercent >= 90 && 'text-[var(--danger)]')}>
                                {Math.round(w.usedPercent)}%
                              </span>
                            </div>
                            <div className="h-1 rounded-full bg-[var(--bg-secondary)] overflow-hidden">
                              <div
                                className={cn(
                                  'h-full rounded-full transition-all duration-300',
                                  w.usedPercent >= 90
                                    ? 'bg-[var(--danger)]'
                                    : w.usedPercent >= 70
                                      ? 'bg-[var(--warning)]'
                                      : 'bg-[var(--accent)]',
                                )}
                                style={{ width: `${Math.min(100, w.usedPercent)}%` }}
                              />
                            </div>
                            {w.resetAt && (
                              <div className="type-meta text-[var(--text-muted)]">
                                {t('usage.resetsAt', { time: new Date(w.resetAt).toLocaleTimeString() })}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={messageLayout === 'wide' ? 'secondary' : 'ghost'}
              size="icon"
              onClick={onToggleMessageLayout}
              aria-label={
                messageLayout === 'wide' ? t('mainArea.messageLayoutCentered') : t('mainArea.messageLayoutWide')
              }
            >
              <ArrowLeftRight size={18} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {messageLayout === 'wide' ? t('mainArea.messageLayoutCentered') : t('mainArea.messageLayoutWide')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={onTogglePanel}>
              {rightPanelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('mainArea.toggleContextPanel')}</TooltipContent>
        </Tooltip>
        {/* 多模型对比的**入口**：只在有任务时出现（对比必须挂在一个真实任务上，
            否则 N 路会话没有归属，采纳也无处可落）。 */}
        {activeTask && !activeTask.teamId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={compareMode ? 'secondary' : 'ghost'}
                size="icon"
                onClick={onToggleCompare}
                aria-pressed={compareMode}
                data-testid="compare-toggle"
                aria-label={t('compare.enter')}
              >
                <Columns3 size={18} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('compare.enter')}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}

// （2026-10-06 移除 MediaReadinessStatus 横幅——用户拍板：不需要该提示）

interface LiveTimelineScope {
  timelineItems: TimelineItem[];
  waitingSessionKey: string | undefined;
  showWelcome: boolean;
  activity: ReturnType<typeof deriveSessionActivity>;
  identityByMessageId: Map<string, AssistantIdentity & { modelLabel?: string; modelTitle?: string }>;
  identityFor: (sessionKey: string | undefined, agentId?: string) => AssistantIdentity;
  modelLabelFor: (message: Message) => string | undefined;
  retryableErrorMessageId: string | null;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  handleScroll: () => void;
  registerItemNode: (key: string, node: HTMLDivElement | null) => (() => void) | void;
  showScrollButton: boolean;
  scrollToBottom: () => void;
}

/**
 * ⭐ BUG-075 第二轮（2026-10-13）：**时间线视图是唯一订阅"回合活动"的边界组件**。
 *
 * 实测背景：思考流以 20–26 次/秒的全量快照涌入；原实现里 `ChatContent` 直接订阅
 * `activeTurnBySession` / `processingBySession` ⇒ **每来一个快照整棵对话区重渲**，
 * 连同 ChatInput 整棵子树（元素创建 + i18n 查询是风暴时的 JS 大头）。修法（与行业一致：
 * Hermes #45343 的"订阅下沉到边界组件"、Vercel AI 的 getSnapshot 教训）：把 per-tick 的
 * 订阅与派生全部收进本组件 —— 父级 `ChatContent` 只在消息/任务等**真实变化**时重渲；
 * 本组件重渲时，子树里 memo 过的条目（AssistantBlock/ChatMessage/ThinkingCollapse）
 * 照常跳过，只有真正在流的那一块更新。
 *
 * ⚠️ 渲染树（在 children 里）的 **DOM 形状/槽位/键必须逐字保持原样**：
 *    等待→流式→定稿→收编四步同节点，那些注释全是实测事故；这里只换"谁订阅"，不碰"怎么渲染"。
 *    children 用**渲染函数**形态是为了不搬 ChatContent 的几十个局部闭包 —— 捕获的值全都随
 *    ChatContent 自身订阅（messages/artifacts/props）更新；per-tick 值一律从 scope 显式传入。
 */
function LiveTimeline({ children }: { children: (scope: LiveTimelineScope) => ReactNode }) {
  const { t } = useTranslation();
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const activeTask = useTaskStore((s) => s.tasks.find((task) => task.id === s.activeTaskId));
  const activeRoom = useRoomStore((s) => (activeTaskId ? s.rooms[activeTaskId] : undefined));
  const messages = useMessageStore((s) =>
    activeTaskId ? (s.messagesByTask[activeTaskId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  // ⚠️ 这两个是**全仓仅存的 per-tick 订阅点**：思考流每来一个快照它们就换引用。
  //    除了这里，任何上层组件都不要再直接订阅它们（否则整棵子树又被拖着重渲）。
  const activeTurnBySession = useMessageStore((s) => s.activeTurnBySession);
  const processingBySession = useMessageStore((s) => s.processingBySession);
  // B10：错误消息上的「重试」入口。查得到 id 才给按钮（判据由网关的 `errorKind` 来）。
  const retryableErrorMessageId = useRetryableErrorMessageId(activeTaskId);

  const sessionKeys = useMemo(
    () => (activeTask ? getTaskSessionKeys(activeTask, activeRoom) : []),
    [activeRoom, activeTask],
  );
  const activeTurns = useMemo(
    () =>
      sessionKeys.reduce<Array<{ sessionKey: string; turn: (typeof activeTurnBySession)[string] }>>(
        (items, sessionKey) => {
          const turn = activeTurnBySession[sessionKey];
          if (turn) items.push({ sessionKey, turn });
          return items;
        },
        [],
      ),
    [activeTurnBySession, sessionKeys],
  );
  const activity = useMemo(
    () => deriveSessionActivity(sessionKeys, activeTurnBySession, processingBySession),
    [activeTurnBySession, processingBySession, sessionKeys],
  );
  // 「发出去了但第一个字还没到」的会话 —— 给它渲染**同一个**助手块（见下面渲染处的说明）。
  const waitingSessionKey = useMemo(
    () => pickWaitingSessionKey(sessionKeys, activeTurnBySession, processingBySession),
    [activeTurnBySession, processingBySession, sessionKeys],
  );
  const timelineItems = useMemo(() => {
    // 助手那一格用的是**会话内稳定的槽位号**：`assistant-<会话>#<第几条>`。
    //
    // 为什么要按"第几条"编，而不是用消息 id / `turn-<会话>`：
    //   同一个槽位要经历 **等待 → 流式 → 定稿 → 收编成正式消息**，四步都得是同一个 DOM 节点，
    //   而 React 只在"同一父节点 + 同一 key + 同一类型"时才复用节点。
    //   收编那一刻（现场日志：定稿后 **+95ms**）active turn 被删、答复作为正式消息追加进来 ⇒
    //   如果正式消息用的还是自己的 id，节点就会换一次（用户看到的第二次闪）。
    //   "第几条助手消息"这个号在**一进一出之间是不变的**：追加进来的是第 N+1 条，
    //   而刚才那个 turn 项算出来也是第 N+1 条 ⇒ 两者天然接得上。
    //   ⚠️ 它只在"往后追加"时不抖；历史被**前插**（换任务重新水合）时序号会整体挪一格，
    //      那一刻本来就在换屏，可以接受。
    const assistantCountBySession = new Map<string, number>();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const session = message.sessionKey ?? '';
      assistantCountBySession.set(session, (assistantCountBySession.get(session) ?? 0) + 1);
    }
    const liveAssistantKey = (sessionKey: string): string =>
      `assistant-${sessionKey}#${(assistantCountBySession.get(sessionKey) ?? 0) + 1}`;

    const seenAssistantBySession = new Map<string, number>();
    const messageItems = messages.map((message) => {
      let key: string = message.id;
      if (message.role === 'assistant') {
        const session = message.sessionKey ?? '';
        const ordinal = (seenAssistantBySession.get(session) ?? 0) + 1;
        seenAssistantBySession.set(session, ordinal);
        key = `assistant-${session}#${ordinal}`;
      }
      return { key, timestamp: message.timestamp, kind: 'message' as const, message };
    });
    const turnItems: TimelineItem[] = activeTurns.map(({ sessionKey, turn }) => ({
      // ⚠️ key 里**不带 `turn.id`**：等待态那一项（turn 还没建出来）要用**同一个 key**。
      //    同一个会话同时只可能有一个进行中的 turn ⇒ 不会撞。
      //    带上 id 的后果：等待态与流式态是两个节点 ⇒ 头像被卸载重建 ⇒ 闪一下（2026-09-20 报障）。
      key: liveAssistantKey(sessionKey),
      timestamp: turn.timestamp,
      kind: 'turn' as const,
      sessionKey,
      turn,
    }));

    // ⭐ 等待态是**同一个数组里的一项**，而不是列表外面的一块。
    //
    // ⚠️ 这一条是踩出来的：一开始把它写成 `{waitingSessionKey ? <AssistantBlock/> : null}` 放在
    //    `timelineItems.map()` **后面** —— 于是"等待 → 收到内容"时，这一块从**数组外**挪到了
    //    **数组内**。React 对"数组 vs 单个子元素"是两个不同的槽位，**key 一样也没用**：
    //    实测（`chat-send-stability.test.tsx`）父节点、key、类型全都相同，节点照样被重建。
    //    ⇒ 放进同一个数组，槽位才真的不变。
    const waitingKey = waitingSessionKey ? liveAssistantKey(waitingSessionKey) : null;
    if (waitingSessionKey && waitingKey && !turnItems.some((item) => item.key === waitingKey)) {
      turnItems.push({
        key: waitingKey,
        // 固定哨兵值：等待中的那一块永远排在最后（它确实是"此刻正在发生的事"）。
        // ⚠️ 不能写 `Date.now()` —— 每次渲染都会变，排序结果跟着抖。
        timestamp: WAITING_ITEM_TIMESTAMP,
        kind: 'turn',
        sessionKey: waitingSessionKey,
        turn: undefined,
      });
    }

    return [...messageItems, ...turnItems].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }, [activeTurns, messages, waitingSessionKey]);
  // ⚠️ 顺序敏感：自动滚动 effect 依赖 `showWelcome` ⇒ 它必须在滚动机制**之前**算出来。
  const hasRenderableActiveTurn = activeTurns.some(
    ({ turn }) => turn.finalized || turn.streamingText || turn.streamingThinking || turn.toolCalls.length > 0,
  );
  const showWelcome = !activeTask || (messages.length === 0 && !hasRenderableActiveTurn);

  // ── 滚动机制（原样搬自 ChatContent，只改归属） ──────────────────────────────
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /**
   * 自动滚动到底把视口放到哪（2026-10-06，#16「答案要从下往上翻看」）：
   * - `answerAnchorKey` —— 时间线里"新回答那一格"的 key。有它时**优先钉在回答首行**
   *   （长回答不再只露个结尾）；定稿→收编后 key 不变、DOM 节点不变，所以锚点会自然活过去。
   *   释放只有两种情形：那一格不在了（换任务等）、或用户又发了一条 —— 判据在
   *   `resolveChatScrollAnchor`，那里的注释写了为什么"新回答"必须是紧跟在提问之后的那格。
   * - `itemNodes` —— 上面那个 key → 那一格的包装节点（`ref` 回调登记）。
   * - `followBottom` —— 用户**主动**停到最底部（滚到底/点回到底部按钮）：此后跟随尾部，
   *   不再钉首行 —— 他明确在看最新那一截。
   */
  const itemNodes = useRef(new Map<string, HTMLDivElement>());
  const answerAnchorKey = useRef<string | null>(null);
  const followBottom = useRef(false);
  const isAutoScrolling = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  /**
   * 滚动锚点：视口要钉在**哪一个槽位**上（规则见 `resolveChatScrollAnchor` 的说明）。
   *
   * ⚠️ 在 render 里算（幂等；同 App/RightPanel 已有的 render 期 ref 写法）而不是放进 effect：
   *    "定稿 → 收编"是同一次 set 里的换血，晚一帧就错过。
   */
  const scrollSlots = useMemo(
    () => timelineItems.map((item) => ({ key: item.key, slot: scrollSlotFor(item, waitingSessionKey) })),
    [timelineItems, waitingSessionKey],
  );
  const nextAnchorKey = resolveChatScrollAnchor(scrollSlots, answerAnchorKey.current);
  if (nextAnchorKey !== answerAnchorKey.current) {
    answerAnchorKey.current = nextAnchorKey;
    // 新回答 = 从头读：上一轮"看尾部"的选择不继承（释放锚点则无所谓，反正随底）。
    if (nextAnchorKey !== null) followBottom.current = false;
  }

  const handleScroll = useCallback(() => {
    if (isAutoScrolling.current) return;
    const el = viewportRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_THRESHOLD_PX;
    stickToBottom.current = atBottom;
    // 用户**自己**回到最底部 = 他明确想看最新那一截：这一轮回答此后跟随尾部，
    // 不再被钉回首行（见 `chat-scroll-anchor.ts` 的 `followBottom`）。
    if (atBottom) followBottom.current = true;
    setShowScrollButton(!atBottom);
  }, []);

  useEffect(() => {
    if (showWelcome) return;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!stickToBottom.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        isAutoScrolling.current = true;
        // 目标位置不再无条件等于"底部"（2026-10-06，#16）：新回答长过视口时钉在它的首行，
        // 让用户从第一句读起；回答还装得下 / 用户主动停在底部时仍是随底（原行为）。
        // 目标计算在 `lib/chat-scroll-anchor.ts`，这里只负责量锚点。
        const anchorKey = answerAnchorKey.current;
        const anchorNode = anchorKey ? itemNodes.current.get(anchorKey) : undefined;
        const anchorTop = anchorNode
          ? anchorNode.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
          : null;
        viewport.scrollTop = anchoredScrollTop({
          contentHeight: viewport.scrollHeight,
          viewportHeight: viewport.clientHeight,
          anchorTop,
          followBottom: followBottom.current,
        });
        requestAnimationFrame(() => {
          isAutoScrolling.current = false;
        });
      });
    });
    ro.observe(content);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [showWelcome]);

  const scrollToBottom = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
    followBottom.current = true;
    setShowScrollButton(false);
  }, []);

  /**
   * 时间线每一项的包装节点登记（锚点靠它找"新回答那一格"）。
   *
   * ⚠️ 两条纪律：
   * 1. 同一个 key 若先后登记过两个节点，**保住先来且还挂在文档上的那个** —— 它才是用户
   *    真正在读的那一格（DOM 节点从流式一路活过来）。后来的同 key 节点不覆盖。
   * 2. 清理是**守卫式删除**（还登记着我这个节点才删）：React 19 的 ref cleanup 顺序下，
   *    后来者的清理不会把先来者的登记误删。
   */
  const registerItemNode = useCallback((key: string, node: HTMLDivElement | null): (() => void) | void => {
    if (!node) return;
    const registered = itemNodes.current.get(key);
    if (!registered || !registered.isConnected) itemNodes.current.set(key, node);
    return () => {
      if (itemNodes.current.get(key) === node) itemNodes.current.delete(key);
    };
  }, []);

  // ── 身份链（原样搬自 ChatContent） ─────────────────────────────────────────
  const performerBySessionKey = useMemo(
    () => new Map((activeRoom?.performers ?? []).map((performer) => [performer.sessionKey, performer])),
    [activeRoom?.performers],
  );
  const performerByAgentId = useMemo(
    () => new Map((activeRoom?.performers ?? []).map((performer) => [performer.agentId, performer])),
    [activeRoom?.performers],
  );
  const agentCatalog = useUiStore((s) =>
    activeTask?.gatewayId ? s.agentCatalogByGateway[activeTask.gatewayId] : undefined,
  );
  // 消息级模型的展示名要查目录；查不到就退回裸 id（见 `resolveModelLabel`）。
  // 与 agentCatalog 同款：只在 activeTask 的网关下取，避免跨网关串味。
  const modelCatalog = useUiStore((s) =>
    activeTask?.gatewayId ? s.modelCatalogByGateway[activeTask.gatewayId] : undefined,
  );
  const catalogAgentById = useMemo(
    () => new Map((agentCatalog?.agents ?? []).map((a) => [a.id, a])),
    [agentCatalog?.agents],
  );
  const conductorLabel = t('chatMessage.conductor');

  /**
   * ⭐ 身份对象**按会话缓存**（2026-09-29）—— 这是"思维链把界面拖死"的根因那一刀。
   *
   * 原来渲染循环里每次都调 `resolveAssistantIdentity()`，它返回**新的对象字面量** ⇒
   * `memo(AssistantBlock)` 的浅比较每次失败 ⇒ 每个 delta 重渲整棵子树（含 markdown 解析）。
   *
   * ⚠️ 依赖里**刻意只放**"会话内容无关"的东西：`messages`（流式期间不变）、
   *    `activeTask`、以及那个**签名字符串**。`activeTurns` 每来一个 delta 就换一个数组，
   *    放进依赖等于没缓存 —— 但它里面的**会话键集合**在流式期间是不变的，所以取签名。
   */
  /**
   * ⚠️⚠️ 这个数组**必须逐 delta 保持同一个引用**，否则 `useAssistantIdentityIndex`
   * 里的缓存每渲染都失效 —— 那就等于没改，`memo` 照样每个 delta 被击穿。
   *
   * 所以依赖里**不能放 `activeTurns` 本身**（它由 `activeTurnBySession` 推出来，
   * 每个 delta 都是新数组）；只放它里面那串**值稳定**的会话键。
   * 会话键不含逗号，用它做拼接/拆分是安全的。
   */
  const activeTurnSessionKeyList = activeTurns.map((item) => item.sessionKey).join(',');
  const identityEntries = useMemo(() => {
    const seen = new Set<string>();
    const out: { sessionKey: string; agentId?: string }[] = [];
    const push = (sessionKey: string | undefined, agentId: string | undefined): void => {
      const key = `${sessionKey ?? ''}||${agentId ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(agentId ? { sessionKey: sessionKey ?? '', agentId } : { sessionKey: sessionKey ?? '' });
    };
    // ⚠️ 消息那一支要带上 `message.agentId`（历史消息里它由网关给，**可能**与会话键不一致）
    for (const message of messages) push(message.sessionKey, message.agentId);
    // 另两支旧代码是从会话键解析助手，所以这里**不带** agentId
    for (const sessionKey of activeTurnSessionKeyList ? activeTurnSessionKeyList.split(',') : []) {
      push(sessionKey, undefined);
    }
    push(activeTask?.sessionKey, undefined);
    /**
     * ⭐ **"等待中"那个会话也要登记**（2026-09-29 独立复核抓到的 P1）。
     *
     * `pickWaitingSessionKey` 挑的正是"正在处理、但还没有可渲染回合"的会话 ——
     * 此刻 `activeTurnBySession[sk]` 可能**还不存在**，于是它不在 `activeTurns` 里、
     * 也没进 `messages` ⇒ 索引查不到 ⇒ 落到那个**全空**的兜底对象上。
     * 表现：worker 的等待气泡**没有名字、没有头像**（`MessageBlock` 只在有字段时才画头部），
     * 等第一个 delta 到了又**突然冒出来** —— 正是本仓一直在治的"身份闪一下"。
     */
    push(waitingSessionKey, undefined);
    return out;
  }, [activeTask?.sessionKey, activeTurnSessionKeyList, messages, waitingSessionKey]);

  const identityFor = useAssistantIdentityIndex({
    entries: identityEntries,
    task: activeTask,
    gatewayId: activeTask?.gatewayId,
    performerBySessionKey,
    performerByAgentId,
    catalogAgentById,
    conductorLabel,
  });

  /**
   * 定稿消息那一支还要叠一层「这条回复实际是哪个模型」（模型徽章）。
   * 同样要**按 message.id 缓存** —— 否则那条分支又变回"每渲染一个新对象"。
   */
  const identityByMessageId = useMemo(() => {
    const map = new Map<string, AssistantIdentity & { modelLabel?: string; modelTitle?: string }>();
    // 2026-10-11（用户拍板）：三档模式（快速/智能/深度）背后跑哪个模型是内部实现 ⇒ **不上屏**——
    // 模式驱动任务的助手消息不再渲染模型徽章；custom（高级：用户显式选过模型）照旧显示。
    // 与 composer chip 的两级口径同规则（见 `ChatInput` 的 `modeDriven`）。
    const showModelBadge = shouldShowModelBadge(activeTask?.mode);
    for (const message of messages) {
      map.set(message.id, {
        // ⚠️ 旧代码在这一支传的是 `agentId: message.agentId` —— 逐字对齐，别只剩会话键
        ...identityFor(message.sessionKey, message.agentId),
        modelLabel: showModelBadge ? resolveModelLabel(message.model, modelCatalog) : undefined,
        modelTitle: showModelBadge ? message.model : undefined,
      });
    }
    return map;
  }, [identityFor, messages, modelCatalog, activeTask?.mode]);

  const modelLabelFor = useCallback(
    (message: Message): string | undefined =>
      shouldShowModelBadge(activeTask?.mode) ? resolveModelLabel(message.model, modelCatalog) : undefined,
    [activeTask?.mode, modelCatalog],
  );

  return (
    <>
      {children({
        timelineItems,
        waitingSessionKey,
        showWelcome,
        activity,
        identityByMessageId,
        identityFor,
        modelLabelFor,
        retryableErrorMessageId,
        viewportRef,
        contentRef,
        handleScroll,
        registerItemNode,
        showScrollButton,
        scrollToBottom,
      })}
    </>
  );
}

export function ChatContent({
  onboardingProfile,
  startupReadiness,
  onRetryStartup,
}: {
  onboardingProfile: OnboardingProfile;
  startupReadiness: StartupReadiness;
  onRetryStartup: StartupRetry;
}) {
  const { t } = useTranslation();
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const activeTask = useTaskStore((s) => s.tasks.find((task) => task.id === s.activeTaskId));
  const activeTaskPreset = useMemo(() => {
    const presetId = resolveAssistantTaskPresetIdFromTags(activeTask?.tags ?? []);
    const preset = presetId ? ASSISTANT_TASK_PRESETS.find((item) => item.id === presetId) : undefined;
    const activeTaskAgentId =
      activeTask?.agentId ?? (activeTask?.sessionKey ? parseAgentIdFromSessionKey(activeTask.sessionKey) : undefined);
    return preset?.assistantId === activeTaskAgentId ? preset : undefined;
  }, [activeTask?.agentId, activeTask?.sessionKey, activeTask?.tags]);
  const artifacts = useFileStore((s) => s.artifacts);
  const setSelectedArtifact = useFileStore((s) => s.setSelectedArtifact);
  const pendingGatewayId = useTaskStore((s) => s.pendingNewTask?.gatewayId);
  const pendingAgentId = useTaskStore((s) => s.pendingNewTask?.agentId);
  const startNewTask = useTaskStore((s) => s.startNewTask);
  const messageLayout = useUiStore((s) => s.messageLayout);
  // ⚠️ BUG-075 第二轮：对比面板那条分支还用到它（原定义在时间线区、随订阅一起下沉过）；同款"只在 activeTask 的网关下取"。
  const modelCatalog = useUiStore((s) =>
    activeTask?.gatewayId ? s.modelCatalogByGateway[activeTask.gatewayId] : undefined,
  );
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setMainView = useUiStore((s) => s.setMainView);
  const setRightPanelOpen = useUiStore((s) => s.setRightPanelOpen);
  const defaultGatewayId = useUiStore((s) => s.defaultGatewayId ?? '');
  const goalAgentCatalog = useUiStore((s) =>
    s.defaultGatewayId ? s.agentCatalogByGateway[s.defaultGatewayId] : undefined,
  );
  const goalModelCatalog = useUiStore((s) =>
    s.defaultGatewayId ? s.modelCatalogByGateway[s.defaultGatewayId] : undefined,
  );
  const messages = useMessageStore((s) =>
    activeTaskId ? (s.messagesByTask[activeTaskId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const activeTaskArtifacts = useMemo(
    () => (activeTaskId ? artifacts.filter((artifact) => artifact.taskId === activeTaskId) : []),
    [activeTaskId, artifacts],
  );
  const newestActiveTaskArtifact = useMemo(
    () =>
      [...activeTaskArtifacts].sort((a, b) => {
        const aTimestamp = artifactCreatedAtTimestamp(a.createdAt);
        const bTimestamp = artifactCreatedAtTimestamp(b.createdAt);
        if (aTimestamp === bTimestamp) return 0;
        return bTimestamp > aTimestamp ? 1 : -1;
      })[0],
    [activeTaskArtifacts],
  );
  const highlightedId = useMessageStore((s) => s.highlightedMessageId);
  const setHighlightedMessage = useMessageStore((s) => s.setHighlightedMessage);
  const retryLastTurn = useRetryLastTurn(activeTask, messages);
  // 多模型对比：`active` 非空时对话区换成并排面板（时间线原样留在下面，采纳/取消后立刻回来）。
  // ⚠️ 只认**属于当前任务**的那一轮：`active` 是全局唯一的，用户跑到别的任务里看时
  //    这一屏不该还杵着别人的对比（判据收在 `compareRuntimeForTask` 一处）。
  const compareActive = useCompareStore((s) => compareRuntimeForTask(s.active, activeTaskId));
  const compareMode = useCompareStore((s) => s.mode);
  const setCompareMode = useCompareStore((s) => s.setMode);
  const seedCompareDraftModels = useCompareStore((s) => s.seedDraftModels);
  const compareGatewayId = activeTask?.gatewayId ?? defaultGatewayId;
  const rawCompareCatalog = useUiStore((s) =>
    compareGatewayId ? s.modelCatalogByGateway[compareGatewayId] : undefined,
  );
  const compareCatalog = useMemo(() => selectableModelsFrom(rawCompareCatalog), [rawCompareCatalog]);
  // 进入对比模式时给个能直接开跑的默认（目录里的前两个），省掉"还要先勾两个才能发"。
  // 「要不要回填」判在 store 里（`draftSeeded`）：用"现在是空的"当判据会在用户**主动清空**之后
  // 立刻填回去 —— 用户删一个、它补一个，永远清不干净。目录还没到时什么都不做（不置位），
  // 目录到了这个 effect 会再跑一次。
  useEffect(() => {
    if (!compareMode) return;
    seedCompareDraftModels(compareCatalog.map((m) => m.id));
  }, [compareMode, compareCatalog, seedCompareDraftModels]);
  const draftRequestSequence = useRef(0);
  const activeDraftRequest = useRef<DraftPromptRequest | null>(null);
  const activeDraftRequestOwner = useRef<DraftRequestOwner | null>(null);
  const [draftRequest, setDraftRequest] = useState<DraftPromptRequest | null>(null);
  const activeUserId = onboardingProfile.userId.trim();
  const [recentTaskHistory, setRecentTaskHistory] = useState<{
    userId: string;
    tasks: RecentAssistantTask[];
  }>(() => ({
    userId: activeUserId,
    tasks: activeUserId ? loadRecentAssistantTasks(activeUserId) : [],
  }));
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const closeLightbox = useCallback(() => setLightboxSrc(null), []);
  const handleNavigateToAccount = useCallback(() => setSettingsOpen(true), [setSettingsOpen]);
  const [previewFile, setPreviewFile] = useState<{ path: string; content: string } | null>(null);
  const goalModelIds = useMemo(() => (goalModelCatalog ?? []).map((model) => model.id), [goalModelCatalog]);
  const goalAnalysis = useGoalAnalysis({
    profile: onboardingProfile,
    enabled: false,
    gatewayId: defaultGatewayId,
    agentId: goalAgentCatalog?.defaultId ?? 'main',
    modelIds: goalModelIds,
  });

  const clearDraftRequest = useCallback(() => {
    activeDraftRequest.current = null;
    activeDraftRequestOwner.current = null;
    setDraftRequest(null);
  }, []);

  const readDraftRequestOwner = useCallback((): Omit<DraftRequestOwner, 'requestId'> => {
    const taskState = useTaskStore.getState();
    const currentTask = taskState.tasks.find((task) => task.id === taskState.activeTaskId);
    const currentPendingTask = taskState.pendingNewTask;
    return {
      userId: activeUserId,
      taskId: taskState.activeTaskId,
      gatewayId: currentTask?.gatewayId ?? currentPendingTask?.gatewayId ?? '',
      agentId:
        currentTask?.agentId ??
        (currentTask?.sessionKey ? parseAgentIdFromSessionKey(currentTask.sessionKey) : undefined) ??
        currentPendingTask?.agentId ??
        '',
    };
  }, [activeUserId]);

  const requestDraft = useCallback(
    (prompt: string, source: DraftPromptRequest['source'], presetId?: string) => {
      const request = createDraftPromptRequest(++draftRequestSequence.current, prompt, source, presetId);
      activeDraftRequest.current = request;
      activeDraftRequestOwner.current = { requestId: request.id, ...readDraftRequestOwner() };
      setDraftRequest(request);
    },
    [readDraftRequestOwner],
  );

  const handleGenerateFile = useCallback(() => {
    requestDraft(t('taskWorkbench.generateFilePrompt'), 'result-action');
  }, [requestDraft, t]);

  const handleViewArtifacts = useCallback(() => {
    if (!newestActiveTaskArtifact) return;
    setSelectedArtifact(newestActiveTaskArtifact.id);
    setRightPanelOpen(true);
  }, [newestActiveTaskArtifact, setRightPanelOpen, setSelectedArtifact]);

  const handleDraftResolved = useCallback(
    (request: DraftPromptRequest, resolution: DraftPromptResolution) => {
      if (activeDraftRequest.current?.id !== request.id) return;
      const owner = activeDraftRequestOwner.current;
      const currentOwner = readDraftRequestOwner();
      activeDraftRequest.current = null;
      activeDraftRequestOwner.current = null;
      setDraftRequest((current) => (current?.id === request.id ? null : current));
      const ownerMatchesCurrentScope =
        owner !== null &&
        owner.requestId === request.id &&
        owner.userId === currentOwner.userId &&
        owner.gatewayId === currentOwner.gatewayId &&
        owner.agentId === currentOwner.agentId &&
        owner.taskId === currentOwner.taskId;
      if (resolution === 'cancelled' || !ownerMatchesCurrentScope || !request.presetId || !activeUserId) {
        return;
      }
      if (!encodeAssistantTaskPresetTag(request.presetId)) return;
      const taskState = useTaskStore.getState();
      if (taskState.activeTaskId === null && taskState.pendingNewTask) {
        taskState.updatePending({
          tags: upsertAssistantTaskPresetTag(taskState.pendingNewTask.tags ?? [], request.presetId),
        });
      }
      const tasks = recordRecentAssistantTask(activeUserId, request.presetId);
      setRecentTaskHistory((current) => (current.userId === activeUserId ? { userId: activeUserId, tasks } : current));
    },
    [activeUserId, readDraftRequestOwner],
  );

  const currentDraftGatewayId = activeTask?.gatewayId ?? pendingGatewayId ?? '';
  const currentDraftAgentId =
    activeTask?.agentId ??
    (activeTask?.sessionKey ? parseAgentIdFromSessionKey(activeTask.sessionKey) : undefined) ??
    pendingAgentId ??
    '';

  useEffect(() => {
    const owner = activeDraftRequestOwner.current;
    if (
      !owner ||
      (owner.userId === activeUserId &&
        owner.gatewayId === currentDraftGatewayId &&
        owner.agentId === currentDraftAgentId &&
        owner.taskId === activeTaskId)
    ) {
      return;
    }
    clearDraftRequest();
  }, [activeTaskId, activeUserId, clearDraftRequest, currentDraftAgentId, currentDraftGatewayId]);

  useEffect(() => {
    setRecentTaskHistory({
      userId: activeUserId,
      tasks: activeUserId ? loadRecentAssistantTasks(activeUserId) : [],
    });
  }, [activeUserId]);

  const recentPresetIds =
    recentTaskHistory.userId === activeUserId ? recentTaskHistory.tasks.map((item) => item.presetId) : [];

  const handleSelectTaskPreset = useCallback(
    (preset: AssistantTaskPreset, prompt: string) => requestDraft(prompt, 'assistant-template', preset.id),
    [requestDraft],
  );

  /**
   * ⚠️ 这段判断搬到 `hooks/useSelectRecommendedAssistant.ts` 了（2026-09-29）——
   * 它在这里**测不到**（渲染整个 `MainArea` 要网关/启动自检/引导画像一大串状态）。
   * 搬走之后它才接上了同族入口都有的那条判据：推荐的助手不在本机时**如实说明、不切**。
   */
  const selectRecommendedAssistant = useSelectRecommendedAssistant(clearDraftRequest);
  const handleSelectRecommendedAssistant = useCallback(
    (agentId: string) => void selectRecommendedAssistant(agentId, defaultGatewayId),
    [defaultGatewayId, selectRecommendedAssistant],
  );

  const handleCreateCustomAssistant = useCallback(
    async (analysis: CustomGoalAnalysis) => {
      // 从用户点下创建起就固定网关。中途切换默认网关不得让后续刷新/选择串线。
      const actionGatewayId = defaultGatewayId;
      if (!actionGatewayId) return;
      const existingAgents = useUiStore.getState().agentCatalogByGateway[actionGatewayId]?.agents;
      const slug = deriveAgentCreationId(analysis.draft.name, existingAgents);
      // ⚠️ 不许再用 `workspaceRoot ? ... : slug`（2026-09-20，T-a28 同族）：拿不到工作区时
      //    发出去的是**相对路径**，而 `agents.create` 由另一个进程按自己的 cwd 解析 ⇒
      //    助手文件落在谁也没预期的地方，界面还不报错。判据与模板/团队安装、创建向导同一份。
      const wsCheck = checkInstallWorkspace(await window.clawwork.getWorkspacePath());
      if (!wsCheck.ok) {
        toast.error(wsCheck.message);
        return;
      }
      const workspace = `${wsCheck.path}/${slug}`;
      const identityContent = serializeIdentityMd(
        analysis.draft.description,
        `${analysis.draft.identity}\n\n## Boundaries\n\n${analysis.draft.boundaries}`,
      );
      const response = await createAgentWithRollback(window.clawwork, {
        gatewayId: actionGatewayId,
        name: analysis.draft.name,
        workspace,
        model: analysis.model,
        identityContent,
        existingAgents,
      });
      if (!response.ok) {
        toast.error(response.error ?? t('errors.failed'));
        throw new Error(response.error ?? 'agent_create_failed');
      }
      await fetchAgentsForGateway(actionGatewayId, { force: true });
      const agentId = typeof response.result?.agentId === 'string' ? response.result.agentId : '';
      if (agentId && !(await selectRecommendedAssistant(agentId, actionGatewayId))) return;
      requestDraft(analysis.starters[0] ?? '', 'goal-routing');
      toast.success(t('goalRouting.created'));
    },
    [defaultGatewayId, requestDraft, selectRecommendedAssistant, t],
  );

  const closeFilePreview = useCallback(() => setPreviewFile(null), []);
  const handleHighlightDone = useCallback(() => setHighlightedMessage(null), [setHighlightedMessage]);
  // ⚠️ 这里**不能**给聊天列挂 `key={activeTaskId}`：新任务的第一条消息会先把 pending
  //    任务 commit 成真任务，key 一变整列（含用户刚打字的输入框）就被卸载重建 ——
  //    实机表现就是「发送后内容区空白约 1 秒」。两棵分支树也必须保持同样的子节点
  //    数量，否则 React 只能整块重建（见 test/chat-send-stability.test.tsx）。
  //    切任务需要重置的东西由下面的 effect 负责，不靠重挂载。
  return (
    <>
      {/* 对比面板与对话区**互斥**：一轮对比在跑时，这一屏就是那几列。
          不叠在时间线上（两套滚动会互相打架），也不缩在角落（用户会以为没反应）。
          采纳/取消后 `compareActive` 归 null，对话区原样回来 —— 注意这里没有换 `key`，
          输入框那个节点自始至终没被卸载（见 test/chat-send-stability.test.tsx）。 */}
      <LiveTimeline>
        {(scope) =>
          compareActive ? (
            <ComparePanel modelCatalog={modelCatalog ?? []} taskId={activeTaskId} />
          ) : scope.showWelcome ? (
            <div className="flex-1 px-5 pt-4 pb-0 overflow-y-auto">
              {!startupReadiness.isReady && (
                <StartupReadinessPanel readiness={startupReadiness} onRetry={onRetryStartup} />
              )}
              <WorkspaceRecreatedNotice />
              {goalAnalysis.result && (
                <GoalRecommendationPanel
                  status={goalAnalysis.status}
                  result={goalAnalysis.result}
                  error={goalAnalysis.error}
                  onRetry={goalAnalysis.retry}
                  onSelectAssistant={handleSelectRecommendedAssistant}
                  onSelectStarter={(prompt) => requestDraft(prompt, 'goal-routing')}
                  onCreateCustom={handleCreateCustomAssistant}
                />
              )}
              <div
                className={cn(
                  messageLayout === 'centered' ? 'max-w-[var(--content-max-width)] mx-auto' : 'w-full max-w-none',
                )}
              >
                <WelcomeScreen
                  key={pendingAgentId ?? '__new'}
                  onboardingProfile={onboardingProfile}
                  recentPresetIds={recentPresetIds}
                  onSelectPreset={handleSelectTaskPreset}
                  onCustomTask={() => requestDraft('', 'assistant-template')}
                  onAssistantChange={clearDraftRequest}
                  conversationReady={startupReadiness.conversationReady}
                  // ⚠️ 已知失败要一路穿到欢迎屏的工作台：否则"已经有结论"的那一屏上，
                  //    正下方还在转圈 + 说"正在启动 AI 服务"（2026-09-21 第二台机器实机）。
                  failureText={startupFailureText(startupReadiness, t)}
                />
              </div>
            </div>
          ) : (
            <div className="relative flex-1 min-h-0">
              <ScrollArea
                viewportRef={scope.viewportRef}
                className="h-full px-5 pt-4 pb-0"
                onScrollCapture={scope.handleScroll}
              >
                <div
                  ref={scope.contentRef}
                  className={cn(
                    'space-y-3',
                    messageLayout === 'centered' ? 'max-w-[var(--content-max-width)] mx-auto' : 'w-full max-w-none',
                  )}
                >
                  {scope.timelineItems.map((item, index) => {
                    const previous = index > 0 ? scope.timelineItems[index - 1] : null;
                    const previousRole = previous?.kind === 'message' ? previous.message.role : 'assistant';
                    // ⚠️ **每一项都包在同一个 `div` 里**（连"进行中"那一项也是）：
                    //    助手那一格要从"等待 → 流式 → 定稿 → 收编成正式消息"一路是同一个 DOM 节点，
                    //    而"收编"那次是 turn 项被删、消息项被加 —— 只要其中一个不带这层 wrapper，
                    //    React 看到的父节点就变了 ⇒ 整个助手块照样被卸载重建（实测抓到 `移除[BLOCK]`）。
                    const wrapperClass = cn(
                      index > 0 &&
                        item.kind === 'message' &&
                        item.message.role === 'user' &&
                        previousRole !== 'user' &&
                        'pt-3',
                    );

                    const renderTile = () => {
                      if (item.kind === 'message') {
                        const message = item.message;
                        if (message.role === 'assistant') {
                          return (
                            <AssistantBlock
                              state="finalized"
                              message={message}
                              identity={
                                scope.identityByMessageId.get(message.id) ??
                                scope.identityFor(message.sessionKey, message.agentId)
                              }
                              highlighted={message.id === highlightedId}
                              onHighlightDone={handleHighlightDone}
                              onImageClick={setLightboxSrc}
                              onRetry={retryLastTurn}
                            />
                          );
                        }
                        return (
                          <ChatMessage
                            message={message}
                            // 本人头像立绘：从 App 下发的档案直接给（账号级真值），
                            // 不让每条消息自己去扫 localStorage（2026-10-07 体检 5/12b）。
                            // 16 型形象（2026-10-08）：四字码 + 性别同源下发，两件都有才走 MBTI 头像。
                            portraitRole={onboardingProfile.portrait?.role ?? null}
                            portraitLetters={onboardingProfile.portrait?.letters ?? null}
                            portraitGender={onboardingProfile.portrait?.gender ?? null}
                            // 2026-10-11（用户拍板）：与助手消息同一口径——模式驱动任务不上屏模型名。
                            modelLabel={scope.modelLabelFor(message)}
                            highlighted={message.id === highlightedId}
                            onHighlightDone={handleHighlightDone}
                            onImageClick={setLightboxSrc}
                            onFileClick={setPreviewFile}
                            retryable={message.id === scope.retryableErrorMessageId}
                            onRetry={retryLastTurn}
                          />
                        );
                      }

                      if (item.turn?.finalized) {
                        return (
                          <AssistantBlock
                            state="finalized"
                            message={activeTurnToMessage(item.turn, activeTaskId!, item.sessionKey)}
                            identity={scope.identityFor(item.sessionKey)}
                            onImageClick={setLightboxSrc}
                          />
                        );
                      }

                      // 剩下两种情形**共用这一个分支**（这才是"头像不闪"的关键）：
                      //   ① 已经有内容 —— 流式正文/推理/工具；
                      //   ② 轮到它"等待中"（`pickWaitingSessionKey` 选中的会话）—— 可能 `turn`
                      //      还没建出来（`item.turn === undefined`），也可能建了但什么都还没到。
                      //
                      // ⚠️ 它们必须落在**同一个数组槽位 + 同一个 key + 同一个组件**上，React 才复用
                      //    同一个 DOM 节点。拆成"数组内 / 数组外"两处渲染时，key 一样也照样重建
                      //    —— 2026-09-20 实测：父节点、key、组件类型全都相同，节点还是被换掉（测试里
                      //    那两条 `expect(after).toBe(waiting)`）。
                      if (isLiveAnswerItem(item, scope.waitingSessionKey)) {
                        return (
                          <AssistantBlock
                            state="streaming"
                            content={item.turn?.streamingText ?? ''}
                            thinkingContent={item.turn?.streamingThinking || undefined}
                            toolCalls={item.turn?.toolCalls ?? EMPTY_TOOL_CALLS}
                            activity={item.turn?.activity}
                            identity={scope.identityFor(item.sessionKey)}
                            // ⭐ 2026-10-03：等待期显示富活动行（跳动条+正在干什么+已等待）。
                            //    它就是**回复位**上的活动指示 —— 与输入框上方的 ComposerActivity
                            //    共用同一份推导（useTurnActivity），文案不会漂。
                            activitySessionKey={item.sessionKey}
                          />
                        );
                      }

                      return null;
                    };

                    return (
                      <div
                        key={item.key}
                        // 滚动锚点要能按 key 找回这一格的包装节点（见 `registerItemNode` 与自动滚动 effect）。
                        ref={(node) => scope.registerItemNode(item.key, node)}
                        className={wrapperClass}
                      >
                        {renderTile()}
                      </div>
                    );
                  })}
                  {/*
                ⚠️ 这里**原来还有一块**等待指示器（`AnimatePresence` + `ThinkingIndicator`），
                2026-09-20 删掉了：它和流式块是**两个组件、两个头像**，内容一到
                占位淡出、流式块淡入 ⇒ **同一帧里两个头像并存**（MutationObserver 实测抓到
                `头像=2` + 跳动点=3）= 用户说的「我发完要求，那个对话头像会消失一下」。

                现在等待态由**上面列表里那一项**渲染（同一个 key、同一个组件），这里的
                `AnimatePresence` 也就没有需要退场的节点了。
              */}
                  <FirstTaskCompletionFlow
                    userId={onboardingProfile.userId}
                    onboardingCompletedAt={onboardingProfile.completedAt}
                    taskId={activeTaskId}
                    messages={messages}
                    activity={scope.activity}
                    artifactCount={activeTaskArtifacts.length}
                    onContinue={() => {
                      if (activeTaskPreset) {
                        const preset = activeTaskPreset;
                        requestDraft(t(preset.followUpPromptKey), 'first-task-follow-up');
                        return;
                      }
                      requestDraft(t('firstTaskCompletion.continuePrompt'), 'first-task-follow-up');
                    }}
                    onNewTask={startNewTask}
                    onViewUsage={() => setMainView('dashboard')}
                    onGenerateFile={handleGenerateFile}
                    onViewArtifacts={handleViewArtifacts}
                  />
                </div>
              </ScrollArea>
              {scope.showScrollButton && (
                <button
                  onClick={scope.scrollToBottom}
                  aria-label={t('mainArea.scrollToBottom')}
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border-primary)] bg-[var(--bg-primary)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                  style={{ boxShadow: 'var(--shadow-elevated)' }}
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
              )}
            </div>
          )
        }
      </LiveTimeline>
      {/* 结构化提问（ask_user）作答面板：挂在输入框上方，与 openclaw Control UI 一致。
          必须在输入框**之前**渲染，用户才会先看到「还要选什么」再去打字 ——
          漏答时网关会把用户的下一条消息当成答案吞掉。 */}
      <QuestionPanel />
      {/* 选择条挂在输入框**上方**、与输入框同一段：模型选完照常按发送（发送键的语义
          在 useChatSend 里整条换成"并发问 N 个模型"，见那边的注释）。
          `active` 非空时不显示 —— 那一轮已经带着模型跑起来了，这时候换选择只会误导。 */}
      {compareMode && !activeTask?.teamId && !compareActive && (
        <CompareSetupBar modelCatalog={compareCatalog} onClose={() => setCompareMode(false)} />
      )}
      <ChatInput
        onNavigateToAccount={handleNavigateToAccount}
        draftRequest={draftRequest}
        onDraftResolved={handleDraftResolved}
        readinessBlocked={startupReadiness.composerBlocked}
        // 已知的中转失败要送到输入框：否则模型那一格会继续说"正在准备…"（猜的那句），
        // 而它承诺的那一步永远不会发生（2026-09-21 第二台机器实机）。
        relayFailure={startupReadiness.relayFailure}
      />
      <ImageLightbox src={lightboxSrc} onClose={closeLightbox} />
      <FilePreviewModal file={previewFile} onClose={closeFilePreview} />
    </>
  );
}

function ArchivedTasks() {
  const { t } = useTranslation();
  const tasks = useTaskStore((s) => s.tasks);
  const setActiveTask = useTaskStore((s) => s.setActiveTask);
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const setMainView = useUiStore((s) => s.setMainView);
  const gwInfoMap = useUiStore((s) => s.gatewayInfoMap);
  const [searchQuery, setSearchQuery] = useState('');

  const archivedTasks = useMemo(() => {
    const archived = tasks.filter((task) => task.status === 'archived');
    if (!searchQuery.trim()) return archived;
    const q = searchQuery.toLowerCase();
    return archived.filter((task) => {
      const title = (task.title || '').toLowerCase();
      const gwName = (gwInfoMap[task.gatewayId]?.name || '').toLowerCase();
      return title.includes(q) || gwName.includes(q);
    });
  }, [tasks, searchQuery, gwInfoMap]);

  const totalArchived = tasks.filter((task) => task.status === 'archived').length;

  const handleReactivate = (taskId: string): void => {
    updateTaskStatus(taskId, 'active');
  };

  const handleOpenTask = (taskId: string): void => {
    setActiveTask(taskId);
    setMainView('chat');
  };
  const rows: ArchivedTaskRow[] = archivedTasks.map((task) => ({
    id: task.id,
    title: task.title || t('common.noTitle'),
    gatewayName: gwInfoMap[task.gatewayId]?.name ?? '-',
    updatedAt: task.updatedAt,
  }));
  const columns: DataTableColumn<ArchivedTaskRow>[] = [
    {
      key: 'task',
      header: t('common.task'),
      kind: 'text',
      width: '50%',
      render: (row) => (
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare size={14} className="shrink-0 text-[var(--text-muted)] opacity-50" />
          <span className="truncate text-[var(--text-primary)]">{row.title}</span>
        </div>
      ),
    },
    {
      key: 'gateway',
      header: t('common.gateway'),
      kind: 'text',
      width: '24%',
      render: (row) => <span className="block truncate">{row.gatewayName}</span>,
    },
    {
      key: 'time',
      header: t('common.time'),
      kind: 'time',
      width: '18%',
      render: (row) => <span className="whitespace-nowrap">{formatRelativeTime(new Date(row.updatedAt))}</span>,
    },
    {
      key: 'action',
      header: '',
      kind: 'action',
      width: '8%',
      render: (row) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(event) => {
                event.stopPropagation();
                handleReactivate(row.id);
              }}
              aria-label={t('contextMenu.reactivate')}
            >
              <ArchiveRestore size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('contextMenu.reactivate')}</TooltipContent>
        </Tooltip>
      ),
    },
  ];

  return (
    <div className="flex flex-col h-full">
      <WindowTitlebar
        left={
          <div className="flex items-center gap-2.5">
            <Archive size={18} className="text-[var(--text-muted)]" />
            <h2 className="type-section-title text-[var(--text-primary)]">{t('leftNav.archivedChats')}</h2>
            <span className="type-support text-[var(--text-muted)]">({totalArchived})</span>
          </div>
        }
      />
      {totalArchived > 0 && (
        <div className="px-5 py-3 flex-shrink-0">
          <div className="relative max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('leftNav.searchTasks')}
              className="w-full h-[var(--density-control-height)] pl-9 pr-3 rounded-md bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] glow-focus focus:border-transparent transition-all"
            />
          </div>
        </div>
      )}
      <ScrollArea className="flex-1 px-5">
        <div className="max-w-[var(--content-max-width)]">
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            onRowClick={(row) => handleOpenTask(row.id)}
            empty={
              <EmptyState
                icon={<Archive size={24} className="text-[var(--text-muted)]" />}
                title={searchQuery.trim() ? t('search.noResults') : t('archived.empty')}
              />
            }
          />
        </div>
      </ScrollArea>
    </div>
  );
}

export default function MainArea({
  onTogglePanel,
  onboardingProfile,
  startupReadiness,
  onRetryStartup,
  onEditOnboardingProfile,
}: MainAreaProps) {
  const mainView = useUiStore((s) => s.mainView);
  const messageLayout = useUiStore((s) => s.messageLayout);
  const toggleMessageLayout = useUiStore((s) => s.toggleMessageLayout);
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  // 「对比」是顶栏那个开关（有任务才出现）；选择条与并排面板都读同一个 store。
  const compareMode = useCompareStore((s) => s.mode);
  const setCompareMode = useCompareStore((s) => s.setMode);

  // 一轮对话结束后把额度拉新（否则发完消息顶栏数字不动，看着像没扣费）。
  // 挂在 MainArea 而不是 ChatHeader：后者带 key、切任务会重挂，会多触发。
  useQuotaRefreshOnTurnEnd();

  // ⚠️ 「网关消失」那条说明**不挂在这里**（我一开始挂这儿，错了）：打开设置会**卸载 MainArea**
  //    （`App.tsx` 是 `settingsOpen ? <Settings/> : <MainArea/>`）⇒ 那期间的消失会被漏掉，
  //    回来时 hook 重挂、基准重置 ⇒ 一句都不会报。它挂在 `App.tsx`（全程在挂）。

  return (
    <div className="flex flex-col h-full">
      <ConnectionBanner />
      <RelayConnectionBanner />
      {mainView === 'tasks' ? (
        <div className="flex-1 min-h-0">
          <TasksPanel />
        </div>
      ) : mainView === 'files' ? (
        <div className="flex-1 min-h-0">
          <FileBrowser />
        </div>
      ) : mainView === 'archived' ? (
        <div className="flex-1 min-h-0">
          <ArchivedTasks />
        </div>
      ) : mainView === 'cron' ? (
        <div className="flex-1 min-h-0">
          <CronPanel />
        </div>
      ) : mainView === 'teams' ? (
        <div className="flex-1 min-h-0">
          <TeamsPanel />
        </div>
      ) : mainView === 'dashboard' ? (
        <div className="flex-1 min-h-0">
          <Dashboard />
        </div>
      ) : mainView === 'betaHub' && isInternalBetaEnabled() ? (
        <div className="flex-1 min-h-0">
          <InternalBetaHub />
        </div>
      ) : mainView === 'kb' ? (
        <div className="flex-1 min-h-0">
          <KnowledgeBase />
        </div>
      ) : mainView === 'community' ? (
        <div className="flex-1 min-h-0">
          <CommunityPanel key="feed" initialTab="feed" />
        </div>
      ) : mainView === 'bounty' ? (
        // ⚠️ 与 community 是同一个面板、不同初始 tab ⇒ **必须给不同的 `key`**，
        //    否则 React 复用实例，tab 不会跟着导航重置（2026-09-19）。
        <div className="flex-1 min-h-0">
          <CommunityPanel key="bounties" initialTab="bounties" />
        </div>
      ) : mainView === 'market' ? (
        <div className="flex-1 min-h-0">
          <MarketPanel key="market" initialTab="market" />
        </div>
      ) : mainView === 'creator' ? (
        // 同上：与 market 同面板不同 tab，靠 key 区分。
        <div className="flex-1 min-h-0">
          <MarketPanel key="mine" initialTab="mine" />
        </div>
      ) : mainView === 'skills' ? (
        <SkillMarket />
      ) : mainView === 'identity' ? (
        <div className="flex-1 min-h-0">
          <IdentityCenter profile={onboardingProfile} onEditProfile={onEditOnboardingProfile} />
        </div>
      ) : mainView === 'growth' ? (
        <div className="flex-1 min-h-0">
          <GrowthPanel />
        </div>
      ) : (
        // ⚠️ 这里**不能**再挂 `key={activeTaskId}`（2026-09-17 移除）：发第一条消息时
        //    `commitPendingTask()` 会让 activeTaskId 从 null 变成 id，key 一变整列被卸载重建，
        //    用户看到的就是「发送后内容区空白约 1 秒」，输入框也跟着重建（丢焦点/草稿）。
        //    切任务要重置的东西由 ChatContent 里监听 activeTaskId 的 effect 负责。
        //    回归测试：test/chat-send-stability.test.tsx
        <div className="relative flex flex-col flex-1 min-h-0">
          <ChatHeader
            onTogglePanel={onTogglePanel}
            messageLayout={messageLayout}
            onToggleMessageLayout={toggleMessageLayout}
            compareMode={compareMode}
            onToggleCompare={() => setCompareMode(!compareMode)}
          />
          {activeTaskId && <EnsembleAgentBar taskId={activeTaskId} />}
          {/* ⭐ 2026-10-06（V1 收口 · 任务 10/11）：聊天页的「团队协作」条（可折叠，默认收起）。
              状态只来自真实信号（团队开会 turns / 团队花名册）；没有真实信号就显「未启用」，
              不做假进度。非团队任务也渲染 —— 展开会如实说明"不属于任何团队"。 */}
          {activeTaskId && <TeamCollabBar taskId={activeTaskId} />}
          <ChatContent
            onboardingProfile={onboardingProfile}
            startupReadiness={startupReadiness}
            onRetryStartup={onRetryStartup}
          />
        </div>
      )}
    </div>
  );
}
