import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ChevronDown,
  File,
  FileCode,
  FolderOpen,
  Image as ImageIcon,
  ListTodo,
  Loader2,
  Mic,
  Volume2,
  Plus,
  Send,
  Square,
  TerminalSquare,
  Users,
  X,
} from 'lucide-react';
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import AgentIcon from '@/components/AgentIcon';
import ConfirmDialog from '@/components/semantic/ConfirmDialog';
import ToolbarButton from '@/components/semantic/ToolbarButton';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { useVoicePlayback } from '@/hooks/useVoicePlayback';
import { speechBillingUnits } from '@/lib/voice/speech-playback';
import { cn } from '@/lib/utils';
import { getArtifactLabel } from '@/lib/artifact-labels';
import { createWhisperSttSession } from '@/lib/voice/whisper-stt';
import { RUN_PHASE_IDS } from '@clawwork/core';
import { MODE_POLICY, TASK_MODES, resolveModeModelId, type ModelCatalogEntry, type TaskMode } from '@clawwork/shared';
import ComposerActivity from '@/components/ComposerActivity';
import { useMessageStore } from '@/stores/messageStore';
import { useRoomStore } from '@/stores/roomStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { motionDuration, motion as motionPresets } from '@/styles/design-tokens';
import { useTaskStore } from '../../stores/taskStore';
import { useUiStore } from '../../stores/uiStore';
import MentionPicker, { type AgentMentionEntry, type MentionTab } from '../MentionPicker';
import SlashArgPicker from '../SlashArgPicker';
import SlashCommandDashboard from '../SlashCommandDashboard';
import SlashCommandMenu from '../SlashCommandMenu';
import ToolsCatalog from '../ToolsCatalog';
import VoiceIntroDialog from '../VoiceIntroDialog';
import { MAX_SEND_MATERIAL_COUNT, MENTION_ALL_AGENT_ID, deriveMaterialByteBudget, materialBudgetMb } from './constants';
import DraftConflictDialog from './DraftConflictDialog';
import { modelStatusCopy } from './model-availability';
import { relayModelStatusCopy, type StartupRelayFailure } from '@/lib/startup-readiness';
import { composerPlaceholderKey } from '@/lib/gateway-display-phase';
import { thinkingAlwaysOnKey, thinkingLabelKey, thinkingMenuFor } from './thinking-levels.js';
import type { DraftPromptRequest, DraftPromptResolution } from './types';
import { useChatSend } from './useChatSend';
import { quotaBlockCopy } from '@/lib/quota';
import { useCommercialStore } from '@/stores/commercialStore';
import { useAttachments } from './useAttachments';
import { useMentionPicker } from './useMentionPicker';
import { useSlashAutocomplete } from './useSlashAutocomplete';
import TaskMaterials from './TaskMaterials';
import AttachmentSuggestions from './AttachmentSuggestions';
import { resolveImageInputSupport, type AttachmentAction } from '@/lib/attachment-actions';
import ComputerAccessBadge from '@/components/ComputerAccessBadge';
import { buildMentionAgents } from './mention-agents';
import { useTaskMaterials } from './useTaskMaterials';
import { useConversationLeaveReset } from './conversation-scope';
import { formatContextWindow } from './utils';

/**
 * 三档模式的人话（i18n key）。**字面量常量**：键必须在源码里可被扫描到
 *（`check:i18n` 的"代码 → 词表"方向），不能拼字符串。
 */
const MODE_LABEL_KEYS: Record<TaskMode, string> = {
  fast: 'chatInput.mode.fast',
  smart: 'chatInput.mode.smart',
  deep: 'chatInput.mode.deep',
};
const MODE_DESC_KEYS: Record<TaskMode, string> = {
  fast: 'chatInput.mode.fastDesc',
  smart: 'chatInput.mode.smartDesc',
  deep: 'chatInput.mode.deepDesc',
};

function SelectionTag({
  icon,
  label,
  onRemove,
  variant = 'accent',
}: {
  icon: ReactNode;
  label: string;
  onRemove: () => void;
  variant?: 'accent' | 'muted';
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'type-support inline-flex items-center gap-1 rounded-lg px-2 py-1',
        variant === 'accent'
          ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
          : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
      )}
    >
      <span className="flex-shrink-0">{icon}</span>
      {label}
      <button onClick={onRemove} aria-label={t('common.remove')} className="ml-0.5 opacity-50 hover:opacity-100">
        <X size={12} />
      </button>
    </span>
  );
}

interface ChatInputProps {
  onNavigateToAccount?: () => void;
  draftRequest?: DraftPromptRequest | null;
  onDraftResolved?: (request: DraftPromptRequest, resolution: DraftPromptResolution) => void;
  readinessBlocked?: boolean;
  /**
   * **已知的**中转失败（`null` / 缺省 = 还没有结论）。
   * 它覆盖模型那一格按目录推断出来的"正在准备…" —— 那句是**猜**的，而且在失败已经
   * 确定时它是一句永远不会兑现的承诺（见 `relayModelStatusCopy`）。
   */
  relayFailure?: StartupRelayFailure | null;
}

interface TextSelection {
  start: number;
  end: number;
}

function findFirstFillablePlaceholder(value: string, searchStart = 0): TextSelection | null {
  let first: TextSelection | null = null;

  for (const [open, close] of [
    ['[', ']'],
    ['【', '】'],
  ] as const) {
    let start = value.indexOf(open, searchStart);
    while (start >= 0) {
      const end = value.indexOf(close, start + open.length);
      if (end < 0) break;
      const content = value.slice(start + open.length, end);
      if (content.length > 0 && !content.includes('\n') && !content.includes('\r')) {
        const candidate = { start, end: end + close.length };
        if (!first || candidate.start < first.start) first = candidate;
        break;
      }
      start = value.indexOf(open, start + open.length);
    }
  }

  return first;
}

export default function ChatInput({
  onNavigateToAccount,
  draftRequest,
  onDraftResolved,
  readinessBlocked = false,
  relayFailure = null,
}: ChatInputProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handledDraftRequestIdsRef = useRef(new Set<string>());
  const [canSend, setCanSend] = useState(false);
  const [draftConflict, setDraftConflict] = useState<DraftPromptRequest | null>(null);
  /** 文件正拖在输入卡片上方（只影响描边提示；真正的导入在 onDrop）。 */
  const [isFileDragging, setIsFileDragging] = useState(false);

  const sendShortcut = useUiStore((s) => s.sendShortcut);
  const mainView = useUiStore((s) => s.mainView);
  const settingsOpen = useUiStore((s) => s.settingsOpen);

  const {
    pendingAttachments,
    setPendingAttachments,
    removeAttachment,
    clearAttachments,
    trimAttachments,
    handlePaste,
  } = useAttachments();

  const materials = useTaskMaterials();

  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const activeTaskGatewayId = useTaskStore((s) => s.tasks.find((task) => task.id === s.activeTaskId)?.gatewayId);

  // ── 材料的发送前限额（2026-10-07 · 方案 A+B+D）────────────────────────────────
  // 口径与 `useChatSend` 逐条同源（那边是最终闸门，这里是**提前可见**）：
  //   · 计数 = **二进制附件**（暂存附件 + 已选导入材料）；@ 文件夹文本类不计数；
  //   · 字节 = 暂存附件 size + 已选导入材料 size（列表元数据；发送侧还会用主进程
  //     实读的 byteLength 复核 —— UI 这一份是"预告"，不是裁决）；
  //   · 上限 = 网关协商的单帧值按 base64 折算（拿不到协商值回落默认 25MiB→18MiB）。
  const gatewayMaxPayloadBytes = useUiStore((s) =>
    activeTaskGatewayId ? s.gatewayMaxPayloadByGateway?.[activeTaskGatewayId] : undefined,
  );
  const materialByteBudget = useMemo(() => deriveMaterialByteBudget(gatewayMaxPayloadBytes), [gatewayMaxPayloadBytes]);
  const binaryMaterialCount = pendingAttachments.length + materials.selectedImportedFiles.length;
  const materialBytesEstimate = useMemo(
    () =>
      pendingAttachments.reduce((sum, att) => sum + att.file.size, 0) +
      materials.selectedImportedFiles.reduce((sum, file) => sum + file.size, 0),
    [pendingAttachments, materials.selectedImportedFiles],
  );
  const materialLimit: 'count' | 'bytes' | null =
    binaryMaterialCount > MAX_SEND_MATERIAL_COUNT
      ? 'count'
      : materialBytesEstimate > materialByteBudget
        ? 'bytes'
        : null;
  /** 「只保留前 N 个」：前 N 的次序 = 材料条次序（暂存附件在前、导入材料在后）。 */
  const trimSelectedImportedFiles = materials.trimSelectedImportedFiles;
  const handleTrimMaterials = useCallback(() => {
    const keepPending = Math.min(pendingAttachments.length, MAX_SEND_MATERIAL_COUNT);
    trimAttachments(keepPending);
    trimSelectedImportedFiles(MAX_SEND_MATERIAL_COUNT - keepPending);
  }, [pendingAttachments.length, trimAttachments, trimSelectedImportedFiles]);
  const performers = useRoomStore((s) => (activeTaskId ? s.rooms[activeTaskId]?.performers : undefined));
  const agentCatalog = useUiStore((s) =>
    activeTaskGatewayId ? s.agentCatalogByGateway[activeTaskGatewayId] : undefined,
  );
  // ⚠️ 名字走**目录优先**那条唯一规则（`resolvePerformerAgentName`）—— 从前这里直接写
  // `agentName: p.agentName`，于是存量脏快照（存的是裸 agentId）在 `@` 选择器里直接露出来。
  // 规则与拼装都在 `./mention-agents`，这里有测试守着接线（`test/mention-agents-wiring.test.tsx`）。
  const mentionAgents = useMemo<AgentMentionEntry[]>(
    () =>
      buildMentionAgents({
        performers,
        catalogAgents: agentCatalog?.agents,
        gatewayId: activeTaskGatewayId,
      }),
    [performers, agentCatalog, activeTaskGatewayId],
  );

  const {
    slashMenuVisible,
    setSlashMenuVisible,
    slashCommands,
    slashIndex,
    setSlashIndex,
    dashboardOpen,
    setDashboardOpen,
    argPickerVisible,
    argPickerCommand,
    argPickerOptions,
    argPickerIndex,
    setArgPickerIndex,
    updateSlashMenu,
    commitSlashCommand,
    commitArgOption,
    closeArgPicker,
  } = useSlashAutocomplete({ textareaRef });

  const {
    mentionVisible,
    mentionQuery,
    mentionIndex,
    setMentionIndex,
    mentionTab,
    setMentionTab,
    selectedTasks,
    setSelectedTasks,
    selectedArtifacts,
    setSelectedArtifacts,
    selectedLocalFiles,
    setSelectedLocalFiles,
    mentionItemsRef,
    updateMentionPicker,
    closeMentionPicker,
    commitMention,
    removeSelectedTask,
    removeSelectedArtifact,
    removeSelectedLocalFile,
    handleMentionItemsChange,
    selectedAgents,
    setSelectedAgents,
    removeSelectedAgent,
  } = useMentionPicker({
    textareaRef,
    hasContextSources: materials.sources.length > 0,
    loadLocalFiles: materials.loadSourceFiles,
    hasAgents: mentionAgents.length > 0,
  });

  /**
   * ⭐ BUG-028（2026-10-06 真机反馈 D 组：新建对话带入了上一段对话的文件/引用/状态）：
   * **离开一段对话时，把这段对话的临时状态清干净**。
   *
   * 输入框不随会话重挂载（见 `MainArea` 那条注释），所以它里面的组件内 state 会一直活着：
   *   - `useAttachments` 的暂存附件 —— 不清的话，A 里贴的截图会被 `handleSend` 存进 B 的第一条消息；
   *   - 不存在的、受控的 textarea —— 不清的话，A 里打了一半的话直接出现在 B 的输入框里；
   *   - @ 选择器 / 斜杠菜单 / 仪表盘 / 草稿冲突弹窗 —— 都是"上一段对话的现场"，不该跟过来。
   *
   * 判据（哪些算"离开"、为什么发送时那次 `pending→真任务` 不算）在 `./conversation-scope`，
   * 那里有完整的理由与边界用例；这里只负责"清哪几样"。**加新的会话级 state 时记得加进来。**
   *
   * 不在这里清的：材料/引用集合（`useTaskMaterials` 自己按 taskId 重载）、@ 提到的任务与产物
   * （`useMentionPicker` 自己按 activeTaskId 重置）—— 它们已经有归属，重复清反而多一条口径。
   */
  useConversationLeaveReset(activeTaskId, () => {
    const textarea = textareaRef.current;
    if (textarea && textarea.value.length > 0) {
      textarea.value = '';
      textarea.style.height = 'auto';
    }
    setCanSend(false);
    clearAttachments();
    closeMentionPicker();
    setSlashMenuVisible(false);
    setDashboardOpen(false);
    closeArgPicker();
    setDraftConflict(null);
  });

  const [voiceCapabilityReply, setVoiceCapabilityReply] = useState<{
    owner: string;
    value: NonNullable<Awaited<ReturnType<typeof window.clawwork.voiceCapabilities>>['result']>;
  } | null>(null);
  const voiceAccountKey = useCommercialStore((state) => state.overview?.account.userId ?? '');
  const voiceCapabilities = voiceCapabilityReply?.owner === voiceAccountKey ? voiceCapabilityReply.value : null;
  const voiceScopeKey = `${voiceAccountKey}:${activeTaskId ?? ''}:${mainView}:${settingsOpen}`;
  const {
    phase: speechPhase,
    error: speechError,
    start: startSpeech,
    stop: stopSpeech,
  } = useVoicePlayback(voiceScopeKey);
  const whisperAvailable = voiceCapabilities?.asr === true;
  const loadSettings = useSettingsStore((state) => state.load);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const loadVoiceIntroSeen = useCallback(async () => {
    const settings = useSettingsStore.getState().settings ?? (await loadSettings());
    return Boolean(settings?.voiceInput?.introSeen);
  }, [loadSettings]);

  const markVoiceIntroSeen = useCallback(async () => {
    await updateSettings({
      voiceInput: {
        introSeen: true,
      },
    });
  }, [updateSettings]);

  const requestVoicePermission = useCallback(async () => {
    const result = await window.clawwork.requestMicrophonePermission();
    return result.status;
  }, []);

  const {
    isGenerating,
    aborting,
    isOffline,
    gatewayDisplayPhase,
    activeTask,
    currentModel,
    currentThinking,
    currentMode,
    modelAvailability,
    modelCatalog,
    effectiveToolsState,
    modelLabel,
    currentModelEntry,
    modelsByProvider,
    taskGwId: _taskGwId,
    quotaBlock,
    setQuotaBlock,
    quotaDegrade,
    setQuotaDegrade,
    switchToFallbackModel,
    handleSend,
    handleModeQuickSend,
    handleModelQuickSend,
    handleThinkingQuickSend,
    handleAbort,
    handleToolSelect,
  } = useChatSend({
    textareaRef,
    pendingAttachments,
    setPendingAttachments,
    selectedTasks,
    setSelectedTasks,
    selectedArtifacts,
    setSelectedArtifacts,
    selectedLocalFiles,
    setSelectedLocalFiles,
    selectedImportedFiles: materials.selectedImportedFiles,
    clearSelectedImportedFiles: materials.clearSelectedImportedFiles,
    markImportedFileMissing: materials.markImportedFileMissing,
    selectedAgents,
    setSelectedAgents,
    stopVoiceInput: () => {
      cancelVoiceInput();
      stopSpeech();
    },
    onComposerCleared: () => setCanSend(false),
  });

  useEffect(() => {
    let current = true;
    setVoiceCapabilityReply(null);
    if (isOffline || typeof window.clawwork.voiceCapabilities !== 'function') return;
    const refresh = (): void => {
      void window.clawwork
        .voiceCapabilities()
        .then((reply) => {
          if (current)
            setVoiceCapabilityReply(reply.ok && reply.result ? { owner: voiceAccountKey, value: reply.result } : null);
        })
        .catch(() => {
          if (current) setVoiceCapabilityReply(null);
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      current = false;
      window.removeEventListener('focus', refresh);
    };
  }, [voiceAccountKey, isOffline]);
  // 拦截文案跟着**原因**走（quotaBlock 为 null 时对话框根本没打开，取哪个都不影响）
  const quotaCopy = quotaBlockCopy(quotaBlock ?? 'unavailable');

  const {
    isSupported: isVoiceSupported,
    isListening: isVoiceListening,
    isTranscribing: isVoiceTranscribing,
    isIntroOpen: isVoiceIntroOpen,
    errorCode: voiceErrorCode,
    handleKeyDown: handleVoiceKeyDown,
    handleKeyUp: handleVoiceKeyUp,
    confirmIntro: confirmVoiceIntro,
    dismissIntro: dismissVoiceIntro,
    startFromTrigger: startVoiceInput,
    stopListening: stopVoiceInput,
    cancelInput: cancelVoiceInput,
  } = useVoiceInput({
    textareaRef,
    hasActiveTask: !isOffline,
    activeTaskKey: voiceScopeKey,
    mainView,
    settingsOpen,
    loadIntroSeen: loadVoiceIntroSeen,
    markIntroSeen: markVoiceIntroSeen,
    requestPermission: requestVoicePermission,
    createSession: createWhisperSttSession,
    isSupported: whisperAvailable,
    onRecordingStarted: stopSpeech,
  });

  const completedVoiceAnswer = useMessageStore((state) => {
    if (!activeTask || isGenerating) return '';
    const turn = state.activeTurnBySession[activeTask.sessionKey];
    if (turn?.finalized && turn.content.trim()) return turn.content;
    const messages = state.messagesByTask[activeTask.id] ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].content.trim()) return messages[i].content;
    }
    return '';
  });
  const spokenCharacterCount = speechBillingUnits(completedVoiceAnswer);
  const speechFeeEstimate =
    voiceCapabilities?.ttsMicrosPerCharacter !== undefined
      ? ((spokenCharacterCount * voiceCapabilities.ttsMicrosPerCharacter) / 1_000_000).toLocaleString(undefined, {
          maximumFractionDigits: 4,
        })
      : null;
  useEffect(() => {
    if (isGenerating) stopSpeech();
  }, [isGenerating, stopSpeech]);
  useEffect(() => {
    if (!speechError || speechError === 'voice-cancelled') return;
    toast.error(t(speechError === 'voice-answer-too-long' ? 'voiceInput.answerTooLong' : 'voiceInput.playbackFailed'));
  }, [speechError, t]);
  const allTasks = useTaskStore((s) => s.tasks);
  const mentionTasks = allTasks.filter((tt) => tt.id !== activeTask?.id && tt.title);

  const mentionTabs = useMemo<MentionTab[]>(
    () => [
      ...(mentionAgents.length > 0 ? (['agents'] as const) : []),
      ...(materials.sources.length > 0 ? (['local'] as const) : []),
      'tasks',
      'files',
    ],
    [mentionAgents.length, materials.sources.length],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      handleVoiceKeyDown(e);
      if (e.defaultPrevented) return;

      if (mentionVisible) {
        if (e.key === 'Tab' || e.key === 'ArrowRight') {
          e.preventDefault();
          setMentionTab((cur) => mentionTabs[(mentionTabs.indexOf(cur) + 1) % mentionTabs.length]);
          setMentionIndex(0);
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setMentionTab((cur) => mentionTabs[(mentionTabs.indexOf(cur) - 1 + mentionTabs.length) % mentionTabs.length]);
          setMentionIndex(0);
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setMentionIndex((i) => Math.min(i + 1, mentionItemsRef.current.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setMentionIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const item = mentionItemsRef.current[mentionIndex];
          if (item) commitMention(item);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeMentionPicker();
          return;
        }
      }

      if (argPickerVisible && argPickerOptions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setArgPickerIndex((i) => (i + 1) % argPickerOptions.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setArgPickerIndex((i) => (i - 1 + argPickerOptions.length) % argPickerOptions.length);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          const opt = argPickerOptions[argPickerIndex];
          if (opt) commitArgOption(opt);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeArgPicker();
          return;
        }
      }

      if (slashMenuVisible && slashCommands.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSlashIndex((i) => (i + 1) % slashCommands.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSlashIndex((i) => (i - 1 + slashCommands.length) % slashCommands.length);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          const cmd = slashCommands[slashIndex];
          if (cmd) commitSlashCommand(cmd);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setSlashMenuVisible(false);
          return;
        }
      }

      if (e.key === 'Escape' && isGenerating) {
        e.preventDefault();
        handleAbort();
        return;
      }

      if (e.key === 'Enter') {
        const isCmdEnterMode = sendShortcut === 'cmdEnter';
        const meta = e.metaKey || e.ctrlKey;
        const shouldSend = isCmdEnterMode ? meta && !e.shiftKey : !e.shiftKey && !meta;
        if (shouldSend) {
          e.preventDefault();
          handleSend();
        }
      }
    },
    [
      mentionVisible,
      mentionIndex,
      commitMention,
      closeMentionPicker,
      mentionTabs,
      argPickerVisible,
      argPickerOptions,
      argPickerIndex,
      commitArgOption,
      closeArgPicker,
      slashMenuVisible,
      slashCommands,
      slashIndex,
      commitSlashCommand,
      handleSend,
      handleAbort,
      isGenerating,
      handleVoiceKeyDown,
      sendShortcut,
      mentionItemsRef,
      setMentionTab,
      setMentionIndex,
      setArgPickerIndex,
      setSlashIndex,
      setSlashMenuVisible,
    ],
  );

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    setCanSend(
      Boolean(textarea.value.trim()) ||
        pendingAttachments.length > 0 ||
        materials.selectedImportedFiles.length > 0 ||
        selectedLocalFiles.length > 0 ||
        // ⭐ 2026-10-07（质量战役区 3）：存在任一 @ 选择也算"有内容可发"——
        //    `stripAtQuery` 抹掉 @ 查询后输入框看起来是空的，但选择还在（否则死按钮）。
        selectedTasks.length > 0 ||
        selectedArtifacts.length > 0 ||
        selectedAgents.length > 0,
    );
    if (argPickerVisible) closeArgPicker();
    updateSlashMenu();
    updateMentionPicker();
  }, [
    updateSlashMenu,
    argPickerVisible,
    closeArgPicker,
    updateMentionPicker,
    pendingAttachments.length,
    materials.selectedImportedFiles.length,
    selectedLocalFiles.length,
    selectedTasks.length,
    selectedArtifacts.length,
    selectedAgents.length,
  ]);

  const setComposerDraft = useCallback(
    (value: string, placeholderSearchStart = 0) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.value = value;
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
      setCanSend(
        Boolean(value.trim()) ||
          pendingAttachments.length > 0 ||
          materials.selectedImportedFiles.length > 0 ||
          selectedLocalFiles.length > 0,
      );
      textarea.focus();
      const selection = findFirstFillablePlaceholder(value, placeholderSearchStart);
      textarea.setSelectionRange(selection?.start ?? value.length, selection?.end ?? value.length);
    },
    [pendingAttachments.length, materials.selectedImportedFiles.length, selectedLocalFiles.length],
  );

  /** 建议行只认"这一轮真的要带的文件"（选中的导入材料 + 待发附件）。 */
  const suggestionFiles = useMemo(
    () => [
      ...pendingAttachments.map((att) => ({ fileName: att.file.name, mimeType: att.file.type || undefined })),
      ...materials.selectedImportedFiles.map((file) => ({
        fileName: file.fileName,
        mimeType: file.mimeType || undefined,
      })),
    ],
    [pendingAttachments, materials.selectedImportedFiles],
  );
  const imageInputSupport = useMemo(() => resolveImageInputSupport(currentModelEntry), [currentModelEntry]);

  useEffect(() => {
    if (!draftConflict || draftConflict.id === draftRequest?.id) return;
    setDraftConflict(null);
  }, [draftConflict, draftRequest?.id]);

  useEffect(() => {
    if (!draftRequest || draftConflict || handledDraftRequestIdsRef.current.has(draftRequest.id)) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    handledDraftRequestIdsRef.current.add(draftRequest.id);
    if (draftRequest.prompt.length === 0) {
      textarea.focus();
      onDraftResolved?.(draftRequest, 'applied');
      return;
    }
    if (textarea.value.length === 0) {
      setComposerDraft(draftRequest.prompt);
      onDraftResolved?.(draftRequest, 'applied');
      return;
    }
    setDraftConflict(draftRequest);
  }, [draftConflict, draftRequest, onDraftResolved, setComposerDraft]);

  const resolveDraftConflict = useCallback(
    (resolution: Extract<DraftPromptResolution, 'appended' | 'replaced' | 'cancelled'>) => {
      if (!draftConflict) return;
      const request = draftConflict;
      if (resolution === 'appended') {
        const existingDraft = textareaRef.current?.value ?? '';
        const appendedPromptStart = existingDraft.length + 2;
        setComposerDraft(`${existingDraft}\n\n${request.prompt}`, appendedPromptStart);
      } else if (resolution === 'replaced') {
        setComposerDraft(request.prompt);
      }
      setDraftConflict(null);
      onDraftResolved?.(request, resolution);
    },
    [draftConflict, onDraftResolved, setComposerDraft],
  );

  const voiceActive = isVoiceListening || isVoiceTranscribing;
  const disabled = isOffline || readinessBlocked;

  /**
   * 建议操作行（F 组 BUG-030 / C 组 BUG-027）：
   *   - 读类动作（提取文字 / 读取总结 / 分析数据）**点击即发** —— 用户已经把意图说得很明确，
   *     再多问一步只会让人以为没反应；输入框里已经有草稿时不抢发（草稿是用户自己的话）。
   *   - 改 / 生成类动作缺具体诉求，**只把提示词填进输入框**（`【…】` 占位选中，直接可打字），
   *     发不发由用户定 —— 写入口只从明确意图开。
   */
  const handleAttachmentAction = useCallback(
    (action: AttachmentAction) => {
      if (disabled) return;
      const prompt = t(action.promptKey);
      const textarea = textareaRef.current;
      const existing = textarea?.value.trim() ?? '';
      if (action.autoSend && !existing) {
        setComposerDraft(prompt);
        void handleSend();
        return;
      }
      setComposerDraft(existing ? `${existing}\n${prompt}` : prompt);
    },
    [disabled, t, setComposerDraft, handleSend, textareaRef],
  );
  // ⚠️ 顺序在 `composerPlaceholderKey` 里定（纯函数 + 单测）：**预热期不许说"离线模式 — 只读"**。
  //    老写法把"还不知道"（网关状态还没有这一条）也算成离线，于是首启那 50 秒里
  //    输入框在说一件不是事实的话（2026-09-20 实机截图）。
  const placeholder = t(composerPlaceholderKey({ phase: gatewayDisplayPhase, isOffline, readinessBlocked }));
  const voiceTooltip = !isVoiceSupported ? t('voiceInput.unsupportedTooltip') : t('voiceInput.tooltip');
  // 文案分档全部住在 `modelStatusCopy` 里（可单测）：哪一档转圈、哪一档说什么话，
  // 一个地方定；尤其「无需重复操作」**只许**在真加载那一档出现（2026-09-20 报障）。
  // ⚠️ 已知的中转失败**压过**目录推断：这时"正在准备模型，准备完会自动显示"是句谎
  //    （那一步永远不会发生），换成非准备态的文案 + 出口（2026-09-21 第二台机器实机）。
  const modelStatus = relayFailure ? relayModelStatusCopy(relayFailure, t) : modelStatusCopy(modelAvailability, t);
  const modelIsPreparing = modelStatus?.preparing ?? false;
  const modelStatusLabel = modelStatus?.label ?? null;
  const modelStatusDetail = modelStatus?.detail ?? null;

  /**
   * 任务模式（快速 / 智能 / 深度）与高级（指定模型）——**同一个 chip 的两个层级**。
   *
   * · 三档：chip 显示**模式名**，这轮跑哪个模型由 `MODE_POLICY` 对着目录现解析
   *  （别名缺席回退基础模型；两个都没有 ⇒ 不显示模型徽章、发送侧保持现状）；
   * · `custom`（高级 / 旧任务）：chip 显示**模型名**，一切照旧。
   *
   * ⚠️ 这里显示的是**将要跑的东西**，不是 `task.model` 那个可能已经过期的留痕 ——
   *    模式任务的 `task.model` 只在运行时被 composer 覆写，不能拿来当"当前模型"。
   */
  const modeDriven = currentMode !== 'custom';
  const modeModelId = useMemo(
    () =>
      modeDriven
        ? resolveModeModelId(
            currentMode,
            modelCatalog.map((entry) => entry.id),
          )
        : undefined,
    [modeDriven, currentMode, modelCatalog],
  );
  const modeModelEntry = modeModelId ? modelCatalog.find((entry) => entry.id === modeModelId) : undefined;
  const displayModelEntry = modeDriven ? modeModelEntry : currentModelEntry;
  const composerModelLabel =
    modelStatusLabel ??
    (modeDriven ? t(MODE_LABEL_KEYS[currentMode]) : (currentModelEntry?.name ?? modelLabel).replace(/^[^/]+\//, ''));

  /**
   * 高级：指定模型 —— 现有模型列表。
   *
   * 来源（useChatSend 的 `modelsByProvider`）已统一过**唯一一把尺**
   * （relay 渠道 / 可用性 / 模式别名〔`qwen3.7-flash-fast` 这类实现细节不上台面〕/
   * 被新渠道接管的旧渠道条目——BUG-076）；这里只做"空家族不渲染"。
   * 2026-10-14 并入同一把尺前，这里是自挡别名的第二份过滤 —— 双条目漏网即出于此。
   */
  const advancedModelsByProvider = useMemo(() => {
    const groups: Record<string, ModelCatalogEntry[]> = {};
    for (const [family, models] of Object.entries(modelsByProvider)) {
      if (models.length > 0) groups[family] = models;
    }
    return groups;
  }, [modelsByProvider]);

  // 网关侧准备进度（run_status）。**不能在 `isGenerating` 里才显示** ——
  // 实测那 9 秒发生在 lifecycle.start **之前**，正是最需要提示的时候。
  const runPhase = useMessageStore((s) => (activeTask ? s.runPhaseBySession[activeTask.sessionKey] : null));
  const runPhaseLabel = runPhase
    ? t(`chatInput.runPhase.${RUN_PHASE_IDS.includes(runPhase) ? runPhase : 'unknown'}`)
    : null;

  // 档位逐模型（见 thinking-levels.ts）：只列当前模型真支持的，只支持一档就置灰。
  const thinkingMenu = useMemo(() => thinkingMenuFor(currentModelEntry), [currentModelEntry]);
  // 「关不掉思考」的模型（菜单无 off 档）要挂说明文案 —— 见 thinkingAlwaysOnKey 的注释。
  const alwaysOnKey = useMemo(() => thinkingAlwaysOnKey(currentModelEntry), [currentModelEntry]);
  /**
   * 模式任务（快速/智能/深度）：思考档由 `MODE_POLICY` 决定，**不许在这里改**。
   * 菜单置灰 + 一句原因（同「这个模型只有一档」的既有形态）——
   * 让用户改而不生效，才是真的骗人。
   */
  const modeThinkingLevel: string | null = modeDriven ? MODE_POLICY[currentMode].thinkingLevel : null;
  const thinkingLabel = useCallback(
    (level: string) => {
      const key = thinkingLabelKey(level);
      return key ? t(key) : level; // 没见过的档位 id 直接显示，不猜也不留空
    },
    [t],
  );

  const prevTranscribingRef = useRef(false);
  useEffect(() => {
    if (prevTranscribingRef.current && !isVoiceTranscribing) {
      textareaRef.current?.focus();
    }
    prevTranscribingRef.current = isVoiceTranscribing;
  }, [isVoiceTranscribing]);

  useEffect(() => {
    if (!voiceErrorCode) return;
    if (voiceErrorCode === 'permission-denied') {
      toast.error(t('voiceInput.permissionDenied'));
      return;
    }
    if (voiceErrorCode === 'unsupported') {
      toast.error(t('voiceInput.unsupported'));
      return;
    }
    if (voiceErrorCode === 'microphone-not-found') {
      toast.error(t('voiceInput.microphoneNotFound'));
      return;
    }
    if (voiceErrorCode === 'voice-cancelled') return;
    toast.error(t('voiceInput.recognitionFailed'));
  }, [voiceErrorCode, t]);

  useEffect(() => {
    const textarea = textareaRef.current;
    setCanSend(
      Boolean(textarea?.value.trim()) ||
        pendingAttachments.length > 0 ||
        materials.selectedImportedFiles.length > 0 ||
        selectedLocalFiles.length > 0 ||
        // ⭐ 同 `handleInput`：@ 选择本身就是"可发送内容"（质量战役区 3）
        selectedTasks.length > 0 ||
        selectedArtifacts.length > 0 ||
        selectedAgents.length > 0,
    );
  }, [
    pendingAttachments.length,
    materials.selectedImportedFiles.length,
    selectedLocalFiles.length,
    selectedTasks.length,
    selectedArtifacts.length,
    selectedAgents.length,
  ]);

  /**
   * 拖入（T05）：桌面文件拖到输入卡片上 → 任务材料导入。
   *
   * 纪律（逐条对应测试口径）：
   *   - **复用**现有导入管线：只把路径交给 `materials.importFilesFromPaths`，
   *     类型/大小/目录/重名/失败原因的拒绝全部沿用对话框那条路；
   *   - 只认**带文件**的拖动：文本/选区拖进 textarea 的原生行为不受影响；
   *   - `preventDefault` 只在"是文件拖动"时打 —— 顺带挡住 Chromium 的默认导航；
   *     （窗口级的兜底在 `usePreventFileDropNavigation`，覆盖非输入区）
   *   - **绝不等同发送**：只入材料，发送仍要用户自己按。
   */
  const hasFileDrag = (dataTransfer: DataTransfer | null): boolean =>
    Boolean(dataTransfer && Array.from(dataTransfer.types ?? []).includes('Files'));

  const handleFileDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsFileDragging(true);
  };

  const handleFileDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    // 只有真正离开卡片才熄描边：在卡片内部从子元素间移动也会触发 dragleave。
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsFileDragging(false);
  };

  const handleFileDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsFileDragging(false);
    if (disabled) return;
    const filePaths = Array.from(event.dataTransfer.files)
      .map((file) => window.clawwork.getPathForFile(file))
      .filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
    if (filePaths.length > 0) void materials.importFilesFromPaths(filePaths);
  };

  return (
    <div className="flex-shrink-0 px-6 pb-5">
      <div className="max-w-[var(--content-max-width)] mx-auto">
        {/* 拖入 / 选入文件后就地给"接下来能做什么"：读类点击即发，写类只预填（BUG-030/027）。 */}
        <AttachmentSuggestions
          files={suggestionFiles}
          imageInput={imageInputSupport}
          disabled={disabled}
          onAction={handleAttachmentAction}
        />
        <TaskMaterials
          importedFiles={materials.importedFiles}
          selectedImportedPaths={materials.selectedImportedPaths}
          sources={materials.sources}
          binaryCount={binaryMaterialCount}
          countLimit={MAX_SEND_MATERIAL_COUNT}
          onTrimToLimit={handleTrimMaterials}
          onToggleImported={materials.toggleImportedFile}
          // 「从当前对话移除」（BUG-029）：只动引用集合，材料与 inbox 原文件都不动。
          onRemoveReference={materials.removeImportedFileReference}
          onRevokeSource={(sourceId) => void materials.revokeSource(sourceId)}
        />
        {/*
          等待期的活动条：秒数 + "正在做什么" + 俏皮话 + 取消。
          放在这一行的位置是有意的 —— 它在**输入框正上方**，用户发完消息视线就停在这儿。
        */}
        <ComposerActivity
          sessionKey={activeTask?.sessionKey ?? null}
          // 区1 体检 P2-6：主会话没在跑时，活动条盯正在跑的 performer（候选 = 主会话 + 全部 performers）。
          sessionKeys={[activeTask?.sessionKey ?? '', ...(performers ?? []).map((performer) => performer.sessionKey)]}
          onCancel={handleAbort}
        />
        <AnimatePresence>
          {pendingAttachments.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-2 inline-flex max-w-full gap-2 overflow-x-auto overflow-y-visible px-1 pt-2 pb-1"
            >
              {pendingAttachments.map((att, i) => (
                <motion.div
                  key={`${att.file.name}-${i}`}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="group relative flex-shrink-0 pt-1 pr-1"
                >
                  <div className="relative overflow-hidden rounded-lg border border-[var(--border-subtle)] shadow-[var(--shadow-card)]">
                    {att.file.type.startsWith('image/') ? (
                      <img src={att.previewUrl} alt={att.file.name} className="h-16 w-16 object-cover" />
                    ) : (
                      <div className="flex h-16 w-16 flex-col items-center justify-center gap-1 bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        <File size={22} />
                        <span className="type-support text-[var(--text-muted)]">
                          {(att.file.size / 1024).toFixed(0)}KB
                        </span>
                      </div>
                    )}
                    <span className="type-support absolute bottom-0 left-0 right-0 bg-[var(--overlay-scrim)] px-1 text-center truncate text-[var(--text-muted)]">
                      {att.file.name}
                    </span>
                  </div>
                  <button
                    onClick={() => removeAttachment(i)}
                    aria-label={t('common.remove')}
                    className={cn(
                      'absolute top-0 right-0 h-5 w-5 rounded-full',
                      'bg-[var(--bg-elevated)] border border-[var(--border-subtle)]',
                      'flex items-center justify-center',
                      'opacity-0 group-hover:opacity-100 transition-opacity',
                      'text-[var(--text-muted)] hover:text-[var(--danger)]',
                    )}
                  >
                    <X size={12} />
                  </button>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <p
          role="note"
          data-testid="ai-content-disclaimer"
          className="type-support mb-2 px-1 text-center text-[var(--text-muted)]"
        >
          {t('chatInput.aiDisclaimer')}
        </p>

        <div className="relative">
          {slashMenuVisible && (
            <SlashCommandMenu
              commands={slashCommands}
              selectedIndex={slashIndex}
              onSelect={commitSlashCommand}
              onHoverIndex={setSlashIndex}
              onClose={() => setSlashMenuVisible(false)}
            />
          )}

          <MentionPicker
            visible={mentionVisible}
            query={mentionQuery}
            tasks={mentionTasks}
            localFiles={materials.contextFiles}
            agents={mentionAgents}
            hasContextFolders={materials.sources.length > 0}
            activeTab={mentionTab}
            selectedIndex={mentionIndex}
            onSelectTask={(task) => commitMention({ kind: 'task', task })}
            onSelectArtifact={(a) => commitMention({ kind: 'file', artifact: a })}
            onSelectLocalFile={(f) => commitMention({ kind: 'local', file: f })}
            onSelectAgent={(a) => commitMention({ kind: 'agent', agent: a })}
            onTabChange={(tab) => {
              setMentionTab(tab);
              setMentionIndex(0);
            }}
            onHoverIndex={setMentionIndex}
            onItemsChange={handleMentionItemsChange}
          />

          {argPickerVisible && argPickerCommand && (
            <SlashArgPicker
              commandName={argPickerCommand.name}
              options={argPickerOptions}
              selectedIndex={argPickerIndex}
              onSelect={commitArgOption}
              onHoverIndex={setArgPickerIndex}
              onClose={closeArgPicker}
            />
          )}

          <div
            data-testid="composer-drop-zone"
            data-file-dragging={isFileDragging || undefined}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
            className={cn(
              'glass-heavy rounded-3xl border border-[var(--border)] shadow-[var(--shadow-floating-layered)]',
              'ring-accent-focus transition-all duration-200 hover:border-[var(--border-accent)] focus-within:border-[var(--border-accent)]',
              isFileDragging && 'border-[var(--border-accent)] ring-2 ring-[var(--accent)]',
              isOffline && 'opacity-60',
            )}
          >
            <div className="px-4 pt-3 pb-3">
              <div className="relative">
                {(selectedTasks.length > 0 ||
                  selectedArtifacts.length > 0 ||
                  selectedLocalFiles.length > 0 ||
                  selectedAgents.length > 0) && (
                  <div className="flex flex-wrap gap-1.5 pb-2">
                    {selectedAgents.map((a) => (
                      <SelectionTag
                        key={`agent-${a.agentId}`}
                        icon={
                          a.agentId === MENTION_ALL_AGENT_ID ? (
                            <Users size={14} />
                          ) : (
                            <AgentIcon
                              gatewayId={a.gatewayId}
                              agentId={a.agentId}
                              gatewayAvatarUrl={a.avatarUrl}
                              emoji={a.emoji}
                              imgClass="w-3.5 h-3.5 rounded-full object-cover"
                            />
                          )
                        }
                        label={a.agentName}
                        onRemove={() => removeSelectedAgent(a.agentId)}
                      />
                    ))}
                    {selectedLocalFiles.map((f) => (
                      <SelectionTag
                        key={`${f.sourceId}:${f.relativePath}`}
                        icon={<FileCode size={14} />}
                        label={f.relativePath}
                        onRemove={() => removeSelectedLocalFile(f.sourceId, f.relativePath)}
                      />
                    ))}
                    {selectedTasks.map((task) => (
                      <SelectionTag
                        key={`task-${task.id}`}
                        icon={<ListTodo size={14} />}
                        label={task.title}
                        onRemove={() => removeSelectedTask(task.id)}
                      />
                    ))}
                    {selectedArtifacts.map((a) => (
                      <SelectionTag
                        key={a.id}
                        icon={<File size={14} />}
                        label={getArtifactLabel(a, t)}
                        variant="muted"
                        onRemove={() => removeSelectedArtifact(a.id)}
                      />
                    ))}
                  </div>
                )}
                <textarea
                  ref={textareaRef}
                  rows={2}
                  placeholder={placeholder}
                  disabled={disabled || isVoiceTranscribing}
                  onKeyDown={handleKeyDown}
                  onKeyUp={handleVoiceKeyUp}
                  onInput={handleInput}
                  onPaste={handlePaste}
                  onClick={updateSlashMenu}
                  className={cn(
                    'w-full resize-none bg-transparent',
                    'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                    'min-h-11 outline-none max-h-48 leading-6 disabled:opacity-50',
                    voiceActive && 'invisible',
                  )}
                />
                <AnimatePresence>
                  {voiceActive && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: motionDuration.normal }}
                      className="absolute inset-0 flex items-center gap-2.5"
                    >
                      {isVoiceListening && (
                        <>
                          <span className="relative flex h-2.5 w-2.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
                            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--accent)]" />
                          </span>
                          <span className="type-body text-[var(--text-secondary)]">
                            {t('voiceInput.listeningStatus')}
                          </span>
                        </>
                      )}
                      {isVoiceTranscribing && (
                        <>
                          <Loader2 size={14} className="animate-spin text-[var(--accent)]" />
                          <span className="type-body text-[var(--text-secondary)]">{t('voiceInput.transcribing')}</span>
                        </>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {!isOffline && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={disabled}
                          aria-label={t('chatInput.addMaterials')}
                          className="rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >
                          <Plus size={18} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem onClick={() => void materials.importFiles()}>
                          <File size={15} />
                          {t('chatInput.addFiles')}
                        </DropdownMenuItem>
                        {/* C 组（BUG-027）：能力入口要**找得到** —— 统一挂名「识别图片」，
                            选中后建议行给出「提取文字 / 总结图片 / 分析内容」。
                            ⚠️ 2026-10-07（vision 入口降级 · 用户拍板）：只在模型**明确自述**支持
                            image（目录 `input` 含 'image'）时露出 —— 当前全部中转模型都没这条声明，
                            露出即"一句兑现不了的承诺"（拖图后模型读不到）。
                            等 relay 加 vision 模型（目录自述 image 能力）后此处**自动出现**，无需改代码；
                            runtime 侧补丁 `rongying-provider-capability-v1` 已入包。 */}
                        {imageInputSupport === 'supported' && (
                          <DropdownMenuItem onClick={() => void materials.importFiles('images')}>
                            <ImageIcon size={15} />
                            {t('chatInput.recognizeImage')}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => void materials.grantFolder()}>
                          <FolderOpen size={15} />
                          {t('chatInput.addFolder')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <div className="flex items-center">
                      {/* 「全权」徽章：读的是**网关回来的真值**（见 ComputerAccessBadge 的注释）。 */}
                      <ComputerAccessBadge gatewayId={activeTaskGatewayId} sessionKey={activeTask?.sessionKey} />
                      {/*
                        模型 chip 的**两级结构**（2026-10-08 · 任务模式）：
                          一级 = 快速 / 智能 / 深度（用户选模式，不选模型）；
                          分隔线；
                          二级 = 高级：指定模型 —— 展开**既有的**模型下拉（家族分组 + R / 上下文徽章）。
                        选具体模型 ⇒ 模式落 `custom`；选三档 ⇒ 模式覆盖一切。
                        别名（`qwen3.7-flash-fast`）不在高级列表里露出（模式内部条目）。
                      */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <ToolbarButton
                            variant="ghost"
                            size="sm"
                            className="rounded-lg border-none px-2 text-[var(--text-secondary)] shadow-none"
                            title={
                              modelStatusLabel ??
                              (modeDriven
                                ? // 2026-10-11（用户拍板）：三档下悬浮标题也不带模型名——内部路由不上屏。
                                  t(MODE_LABEL_KEYS[currentMode])
                                : (currentModelEntry?.name ?? modelLabel))
                            }
                            aria-busy={modelIsPreparing}
                            aria-live="polite"
                          >
                            {modelIsPreparing && (
                              <Loader2
                                size={14}
                                aria-hidden="true"
                                className="shrink-0 animate-spin text-[var(--accent)] motion-reduce:animate-none"
                              />
                            )}
                            <span className="max-w-36 truncate">{composerModelLabel}</span>
                            {modelAvailability === 'ready' && displayModelEntry?.reasoning && (
                              <span className="type-badge rounded bg-[var(--accent)]/15 px-1 py-px text-[var(--accent)]">
                                R
                              </span>
                            )}
                            {modelAvailability === 'ready' && displayModelEntry?.contextWindow && (
                              <span className="type-badge rounded bg-[var(--info)]/15 px-1 py-px text-[var(--info)]">
                                {formatContextWindow(displayModelEntry.contextWindow)}
                              </span>
                            )}
                            <ChevronDown size={14} className="opacity-50" />
                          </ToolbarButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="max-h-96 overflow-y-auto">
                          {/* 一级：三档模式。选中态用既有口径（accent 加粗），不引入新样式。 */}
                          {TASK_MODES.map((mode) => (
                            <DropdownMenuItem
                              key={mode}
                              onClick={() => handleModeQuickSend(mode)}
                              className={cn(currentMode === mode && 'font-medium text-[var(--accent)]')}
                            >
                              <span className="flex flex-col items-start gap-0.5">
                                <span className="flex items-center gap-1.5">
                                  {t(MODE_LABEL_KEYS[mode])}
                                  {mode === 'smart' && (
                                    <span className="type-badge rounded bg-[var(--accent)]/15 px-1 py-px text-[var(--accent)]">
                                      {t('chatInput.mode.recommended')}
                                    </span>
                                  )}
                                </span>
                                <span className="type-support whitespace-normal text-[var(--text-muted)]">
                                  {t(MODE_DESC_KEYS[mode])}
                                </span>
                              </span>
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuSeparator />
                          {/* 二级：高级 —— 展开既有模型下拉（别名不出现在这里）。 */}
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <span>{t('chatInput.mode.advanced')}</span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="max-h-96 overflow-y-auto">
                              {Object.entries(advancedModelsByProvider).map(([family, models]) => (
                                <DropdownMenuSub key={family}>
                                  <DropdownMenuSubTrigger>
                                    <span>{family}</span>
                                  </DropdownMenuSubTrigger>
                                  <DropdownMenuSubContent className="max-h-96 overflow-y-auto">
                                    {models.map((m) => (
                                      <DropdownMenuItem
                                        key={m.id}
                                        onClick={() => handleModelQuickSend(m.id)}
                                        // 选中态 = **这一轮真正会跑的模型**：custom 看任务记着的，
                                        // 模式任务看模式解析出来的（快速档用别名时列表里没有它 ⇒ 不高亮，
                                        // 那是诚实：跑的不是这张表里的任何一条）。
                                        className={cn(
                                          m.id === (modeDriven ? displayModelEntry?.id : currentModel) &&
                                            'font-medium text-[var(--accent)]',
                                        )}
                                      >
                                        <span className="truncate">{m.name ?? m.id}</span>
                                        {m.reasoning && (
                                          <span className="type-badge rounded bg-[var(--accent)]/15 px-1 py-px text-[var(--accent)]">
                                            R
                                          </span>
                                        )}
                                        {m.contextWindow && (
                                          <span className="ml-auto pl-2 type-badge rounded bg-[var(--info)]/15 px-1 py-px text-[var(--info)]">
                                            {formatContextWindow(m.contextWindow)}
                                          </span>
                                        )}
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuSubContent>
                                </DropdownMenuSub>
                              ))}
                              {/*
                                ⚠️ 判据是"**有明细就渲染** + 不是准备态"，不是"目录恰好是 empty"。
                                原来 gate 在 `modelAvailability === 'empty'` 上：已知中转失败时
                                `preparing` 变 false、而目录还在取（实机观察到的形态）⇒ **整块不渲染**，
                                用户只剩 chip 上一个被截断的标签，看不到"为什么"和"怎么办"
                                （2026-09-21 复核）。取不到那一档（catalog-failed）也一样漏。
                              */}
                              {modelIsPreparing ? (
                                <DropdownMenuItem
                                  disabled
                                  className="max-w-80 items-start gap-2 py-3 opacity-100"
                                  aria-live="polite"
                                >
                                  <Loader2
                                    size={16}
                                    aria-hidden="true"
                                    className="mt-0.5 shrink-0 animate-spin text-[var(--accent)] motion-reduce:animate-none"
                                  />
                                  <span className="flex flex-col gap-1">
                                    <span className="type-body font-medium text-[var(--text-primary)]">
                                      {modelStatusLabel}
                                    </span>
                                    <span className="type-support whitespace-normal text-[var(--text-muted)]">
                                      {modelStatusDetail}
                                    </span>
                                  </span>
                                </DropdownMenuItem>
                              ) : modelStatusDetail ? (
                                <DropdownMenuItem disabled className="max-w-80 items-start py-3 opacity-100">
                                  <span className="flex flex-col gap-1">
                                    <span className="type-body font-medium text-[var(--text-primary)]">
                                      {modelStatusLabel}
                                    </span>
                                    <span className="type-support whitespace-normal text-[var(--text-muted)]">
                                      {modelStatusDetail}
                                    </span>
                                  </span>
                                </DropdownMenuItem>
                              ) : null}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <div className="flex items-center">
                      {/* 只支持一档的模型（实测 11 个里有 8 个）不弹菜单，置灰并说明原因 ——
                          隐藏会让用户以为界面坏了，所以是置灰不是隐藏。 */}
                      {modeThinkingLevel ? (
                        /* 模式任务（快速/智能/深度）：档位由模式决定，改了也不会生效 ⇒ 置灰 + 说明。
                           与"这个模型只有一档"同一形态（都是"能力/规则如此，不是界面坏了"）。 */
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <ToolbarButton
                              variant="ghost"
                              size="sm"
                              disabled
                              className="rounded-lg border-none px-2 text-[var(--text-secondary)] shadow-none"
                            >
                              <span>{thinkingLabel(modeThinkingLevel)}</span>
                              <ChevronDown size={14} className="opacity-50" />
                            </ToolbarButton>
                          </TooltipTrigger>
                          <TooltipContent>{t('chatInput.thinkingLockedByMode')}</TooltipContent>
                        </Tooltip>
                      ) : thinkingMenu.locked ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <ToolbarButton
                              variant="ghost"
                              size="sm"
                              disabled
                              className="rounded-lg border-none px-2 text-[var(--text-secondary)] shadow-none"
                            >
                              <span>{thinkingLabel(currentThinking)}</span>
                              <ChevronDown size={14} className="opacity-50" />
                            </ToolbarButton>
                          </TooltipTrigger>
                          <TooltipContent>{t('chatInput.thinkingLockedByModel')}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <DropdownMenu>
                          {/* 「关不掉思考」的模型（菜单里没有 off 档）额外挂一句说明。
                              没有它，用户看到旗舰模型的菜单里居然没「关闭」会以为界面坏了 ——
                              而那是**上游的真实能力**：deepseek-v4-pro / MiniMax-M2.5
                              都不收 reasoning_effort: none。
                              ⚠️ 用原生 title 而不是嵌一层 Tooltip：这是 DropdownMenuTrigger 的
                              子节点，再嵌 Radix Tooltip 是两层 asChild 组合，容易出交互问题；
                              而这个按钮本来就用 title。 */}
                          <DropdownMenuTrigger asChild>
                            <ToolbarButton
                              variant="ghost"
                              size="sm"
                              className={cn(
                                'rounded-lg border-none px-2 text-[var(--text-secondary)] shadow-none',
                                currentThinking !== 'off' && 'text-[var(--accent)]',
                              )}
                              title={
                                alwaysOnKey
                                  ? `${thinkingLabel(currentThinking)} · ${t(alwaysOnKey)}`
                                  : thinkingLabel(currentThinking)
                              }
                            >
                              <span>{thinkingLabel(currentThinking)}</span>
                              <ChevronDown size={14} className="opacity-50" />
                            </ToolbarButton>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start">
                            {/* 档位逐模型 —— 只列这个模型真支持的，别给必然失败的选项 */}
                            {thinkingMenu.levels.map((level) => (
                              <DropdownMenuItem
                                key={level}
                                onClick={() => handleThinkingQuickSend(level)}
                                className={cn(level === currentThinking && 'font-medium text-[var(--accent)]')}
                              >
                                {thinkingLabel(level)}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {whisperAvailable && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div>
                            <Button
                              variant={isVoiceListening ? 'soft' : 'ghost'}
                              size="icon"
                              onClick={() => {
                                stopSpeech();
                                if (isVoiceTranscribing) {
                                  cancelVoiceInput();
                                  return;
                                }
                                if (isVoiceListening) {
                                  stopVoiceInput();
                                  return;
                                }
                                void startVoiceInput();
                              }}
                              disabled={(!voiceActive && disabled) || !isVoiceSupported}
                              aria-label={voiceActive ? t('voiceInput.stop') : voiceTooltip}
                              className={cn(
                                'rounded-xl',
                                isVoiceListening && 'text-[var(--accent)]',
                                !isVoiceListening && 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                              )}
                            >
                              <Mic size={18} />
                            </Button>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>{voiceTooltip}</TooltipContent>
                      </Tooltip>
                    )}
                    {voiceCapabilities?.tts && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant={speechPhase !== 'idle' ? 'soft' : 'ghost'}
                            size="icon"
                            disabled={speechPhase === 'idle' && (!completedVoiceAnswer || voiceActive || disabled)}
                            aria-label={t(speechPhase !== 'idle' ? 'voiceInput.stop' : 'voiceInput.readAnswer')}
                            onClick={() => {
                              if (speechPhase !== 'idle') {
                                stopSpeech();
                                return;
                              }
                              cancelVoiceInput();
                              void startSpeech(completedVoiceAnswer);
                            }}
                          >
                            {speechPhase !== 'idle' ? <Square size={18} /> : <Volume2 size={18} />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {t(speechPhase !== 'idle' ? 'voiceInput.stop' : 'voiceInput.readAnswerFee', {
                            fee: speechFeeEstimate,
                          })}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {(voiceCapabilities?.asr || voiceCapabilities?.tts) && (
                      <span className="type-meta text-[var(--text-muted)]" aria-live="polite">
                        {speechPhase !== 'idle'
                          ? t(speechPhase === 'playing' ? 'voiceInput.playing' : 'voiceInput.preparingSpeech')
                          : [
                              voiceCapabilities.asr && voiceCapabilities.asrMicrosPerSecond !== undefined
                                ? t('voiceInput.serviceFeeAsr', {
                                    fee: ((voiceCapabilities.asrMicrosPerSecond * 60) / 1_000_000).toLocaleString(
                                      undefined,
                                      { maximumFractionDigits: 4 },
                                    ),
                                  })
                                : '',
                              voiceCapabilities.tts && voiceCapabilities.ttsMicrosPerCharacter !== undefined
                                ? t('voiceInput.serviceFeeTts', {
                                    fee: ((voiceCapabilities.ttsMicrosPerCharacter * 100) / 1_000_000).toLocaleString(
                                      undefined,
                                      { maximumFractionDigits: 4 },
                                    ),
                                  })
                                : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                      </span>
                    )}
                    {voiceErrorCode === 'permission-denied' && (
                      <Button variant="ghost" size="sm" onClick={() => void window.clawwork.openMicrophoneSettings()}>
                        {t('voiceInput.openMicrophoneSettings')}
                      </Button>
                    )}{' '}
                    {runPhaseLabel && (
                      <span className="type-meta pr-1 text-[var(--text-muted)]" aria-live="polite">
                        {runPhaseLabel}
                      </span>
                    )}
                    <AnimatePresence mode="wait">
                      {isGenerating ? (
                        <motion.div
                          key="stop"
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          transition={{ duration: motionDuration.normal }}
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="danger"
                                size="icon"
                                onClick={handleAbort}
                                disabled={aborting}
                                aria-label={t('chatInput.stopGenerating')}
                                className="rounded-xl"
                              >
                                <Square size={16} fill="currentColor" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('chatInput.stopGenerating')}</TooltipContent>
                          </Tooltip>
                        </motion.div>
                      ) : (
                        <motion.div
                          key="send"
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          transition={{ duration: motionDuration.normal }}
                          whileHover={reduced ? undefined : motionPresets.scale.whileHover}
                          whileTap={reduced ? undefined : motionPresets.scale.whileTap}
                        >
                          {/*
                            超限置灰 + hover 原因（2026-10-07 · 方案 D）：以前限流只在点发送
                            那刻弹 toast（P2-4"用户挨个取消"的体感来源）；现在按钮先灰、悬停
                            直接说哪条超了。注意外层包一层 `<div>`（同麦克风按钮的写法）——
                            disabled 的 button 收不到 hover 事件，Tooltip 触发要落在壳上。
                          */}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div>
                                <Button
                                  variant={canSend && materialLimit === null ? 'default' : 'secondary'}
                                  size="icon"
                                  onClick={handleSend}
                                  disabled={disabled || !canSend || materialLimit !== null}
                                  aria-label={t('chatInput.send')}
                                  className={cn(
                                    'rounded-2xl',
                                    canSend && materialLimit === null
                                      ? 'bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)]'
                                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-muted)]',
                                  )}
                                >
                                  <Send size={18} />
                                </Button>
                              </div>
                            </TooltipTrigger>
                            {materialLimit !== null && (
                              <TooltipContent>
                                {materialLimit === 'count'
                                  ? t('chatInput.materialLimitCount', { count: MAX_SEND_MATERIAL_COUNT })
                                  : t('chatInput.materialLimitBytes', { size: materialBudgetMb(materialByteBudget) })}
                              </TooltipContent>
                            )}
                          </Tooltip>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {(!isOffline || materials.sources.length > 0 || activeTask) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!isOffline && (
              <div className="flex items-center gap-1.5 px-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <ToolbarButton
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setDashboardOpen(true)}
                      aria-label={t('slashDashboard.tooltip')}
                      icon={<TerminalSquare size={14} className="flex-shrink-0" />}
                      className="rounded-lg text-[var(--text-secondary)]"
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top">{t('slashDashboard.tooltip')}</TooltipContent>
                </Tooltip>

                {effectiveToolsState && <ToolsCatalog state={effectiveToolsState} onToolSelect={handleToolSelect} />}
              </div>
            )}
          </div>
        )}
      </div>
      {/* ⚠️ 文案按**原因**给：四种情况共用「额度已用尽，请充值」正是实机 bug 的成因
          （读不到额度被说成用尽）。见 lib/quota.ts 的 quotaBlockCopy。 */}
      <ConfirmDialog
        open={quotaBlock !== null}
        title={t(quotaCopy.titleKey)}
        description={t(quotaCopy.descKey)}
        confirmLabel={t(quotaCopy.confirmKey)}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          const action = quotaCopy.action;
          setQuotaBlock(null);
          if (action === 'retry') {
            // 重试：重新拉一次额度快照（拉到了闸门自然放行，拉不到下次仍会说明原因）
            // ⚠️ 用 load() 而不是 refresh()：refresh() 在没有已登录账号时**直接返回**，
            //    而那正是最需要重试的场景（从未成功读到过快照）。
            void useCommercialStore.getState().load();
            return;
          }
          onNavigateToAccount?.();
        }}
        onCancel={() => setQuotaBlock(null)}
      />
      <ConfirmDialog
        open={quotaDegrade}
        title={t('usage.degradeTitle')}
        description={t('usage.degradeDesc')}
        confirmLabel={t('usage.degradeConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          setQuotaDegrade(false);
          void switchToFallbackModel();
        }}
        onCancel={() => setQuotaDegrade(false)}
      />
      <VoiceIntroDialog open={isVoiceIntroOpen} onConfirm={confirmVoiceIntro} onCancel={dismissVoiceIntro} />
      <SlashCommandDashboard
        open={dashboardOpen}
        onOpenChange={setDashboardOpen}
        onSelectCommand={commitSlashCommand}
      />
      <DraftConflictDialog
        open={draftConflict !== null}
        onCancel={() => resolveDraftConflict('cancelled')}
        onAppend={() => resolveDraftConflict('appended')}
        onReplace={() => resolveDraftConflict('replaced')}
      />
    </div>
  );
}
