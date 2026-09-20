import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ChevronDown,
  File,
  FileCode,
  FolderOpen,
  ListTodo,
  Loader2,
  Mic,
  Plus,
  Send,
  Square,
  TerminalSquare,
  Users,
  X,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { cn } from '@/lib/utils';
import { getArtifactLabel } from '@/lib/artifact-labels';
import { createWhisperSttSession } from '@/lib/voice/whisper-stt';
import { RUN_PHASE_IDS } from '@clawwork/core';
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
import { MENTION_ALL_AGENT_ID } from './constants';
import DraftConflictDialog from './DraftConflictDialog';
import { thinkingAlwaysOnKey, thinkingLabelKey, thinkingMenuFor } from './thinking-levels.js';
import type { DraftPromptRequest, DraftPromptResolution } from './types';
import { useChatSend } from './useChatSend';
import { quotaBlockCopy } from '@/lib/quota';
import { useCommercialStore } from '@/stores/commercialStore';
import { useAttachments } from './useAttachments';
import { useMentionPicker } from './useMentionPicker';
import { useSlashAutocomplete } from './useSlashAutocomplete';
import TaskMaterials from './TaskMaterials';
import { buildMentionAgents } from './mention-agents';
import { useTaskMaterials } from './useTaskMaterials';
import { formatContextWindow } from './utils';

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
}: ChatInputProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handledDraftRequestIdsRef = useRef(new Set<string>());
  const [canSend, setCanSend] = useState(false);
  const [draftConflict, setDraftConflict] = useState<DraftPromptRequest | null>(null);

  const sendShortcut = useUiStore((s) => s.sendShortcut);
  const mainView = useUiStore((s) => s.mainView);
  const settingsOpen = useUiStore((s) => s.settingsOpen);

  const { pendingAttachments, setPendingAttachments, removeAttachment, handlePaste } = useAttachments();

  const materials = useTaskMaterials();

  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const activeTaskGatewayId = useTaskStore((s) => s.tasks.find((task) => task.id === s.activeTaskId)?.gatewayId);
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

  const [whisperAvailable, setWhisperAvailable] = useState(false);
  const loadSettings = useSettingsStore((s) => s.load);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  useEffect(() => {
    if (typeof window.clawwork.checkWhisper !== 'function') {
      setWhisperAvailable(false);
      return;
    }
    window.clawwork
      .checkWhisper()
      .then((r) => setWhisperAvailable(r.available))
      .catch((err: unknown) => {
        console.error('[ChatInput] checkWhisper failed:', err);
        setWhisperAvailable(false);
      });
  }, []);

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
    activeTask,
    currentModel,
    currentThinking,
    modelAvailability,
    toolsCatalog,
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
    stopVoiceInput: () => stopVoiceInput(),
    onComposerCleared: () => setCanSend(false),
  });

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
  } = useVoiceInput({
    textareaRef,
    hasActiveTask: !isOffline,
    activeTaskKey: activeTask?.id ?? null,
    mainView,
    settingsOpen,
    loadIntroSeen: loadVoiceIntroSeen,
    markIntroSeen: markVoiceIntroSeen,
    requestPermission: requestVoicePermission,
    createSession: createWhisperSttSession,
    isSupported: whisperAvailable,
  });

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
        selectedLocalFiles.length > 0,
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
  const placeholder = isOffline
    ? t('chatInput.offlineReadOnly')
    : readinessBlocked
      ? t('chatInput.aiServiceStartingDetail')
      : t('chatInput.describeTask');
  const voiceTooltip = !isVoiceSupported ? t('voiceInput.unsupportedTooltip') : t('voiceInput.tooltip');
  const modelIsPreparing = modelAvailability === 'service-starting' || modelAvailability === 'models-loading';
  const modelStatusLabel =
    modelAvailability === 'service-starting'
      ? t('chatInput.aiServiceStarting')
      : modelAvailability === 'models-loading'
        ? t('chatInput.modelsLoading')
        : modelAvailability === 'empty'
          ? t('chatInput.noModelsAvailable')
          : null;
  const modelStatusDetail =
    modelAvailability === 'service-starting'
      ? t('chatInput.aiServiceStartingDetail')
      : modelAvailability === 'models-loading'
        ? t('chatInput.modelsLoadingDetail')
        : modelAvailability === 'empty'
          ? t('chatInput.noModelsAvailableDetail')
          : null;
  const composerModelLabel = modelStatusLabel ?? (currentModelEntry?.name ?? modelLabel).replace(/^[^/]+\//, '');

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
    toast.error(t('voiceInput.recognitionFailed'));
  }, [voiceErrorCode, t]);

  useEffect(() => {
    const textarea = textareaRef.current;
    setCanSend(
      Boolean(textarea?.value.trim()) ||
        pendingAttachments.length > 0 ||
        materials.selectedImportedFiles.length > 0 ||
        selectedLocalFiles.length > 0,
    );
  }, [pendingAttachments.length, materials.selectedImportedFiles.length, selectedLocalFiles.length]);

  return (
    <div className="flex-shrink-0 px-6 pb-5">
      <div className="max-w-[var(--content-max-width)] mx-auto">
        <TaskMaterials
          importedFiles={materials.importedFiles}
          selectedImportedPaths={materials.selectedImportedPaths}
          sources={materials.sources}
          onToggleImported={materials.toggleImportedFile}
          onRevokeSource={(sourceId) => void materials.revokeSource(sourceId)}
        />
        {/*
          等待期的活动条：秒数 + "正在做什么" + 俏皮话 + 取消。
          放在这一行的位置是有意的 —— 它在**输入框正上方**，用户发完消息视线就停在这儿。
        */}
        <ComposerActivity sessionKey={activeTask?.sessionKey ?? null} onCancel={handleAbort} />
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
            className={cn(
              'glass-heavy rounded-3xl border border-[var(--border)] shadow-[var(--shadow-floating-layered)]',
              'ring-accent-focus transition-all duration-200 hover:border-[var(--border-accent)] focus-within:border-[var(--border-accent)]',
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
                        <DropdownMenuItem onClick={() => void materials.grantFolder()}>
                          <FolderOpen size={15} />
                          {t('chatInput.addFolder')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <div className="flex items-center">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <ToolbarButton
                            variant="ghost"
                            size="sm"
                            className="rounded-lg border-none px-2 text-[var(--text-secondary)] shadow-none"
                            title={modelStatusLabel ?? currentModelEntry?.name ?? modelLabel}
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
                            {modelAvailability === 'ready' && currentModelEntry?.reasoning && (
                              <span className="type-badge rounded bg-[var(--accent)]/15 px-1 py-px text-[var(--accent)]">
                                R
                              </span>
                            )}
                            {modelAvailability === 'ready' && currentModelEntry?.contextWindow && (
                              <span className="type-badge rounded bg-[var(--info)]/15 px-1 py-px text-[var(--info)]">
                                {formatContextWindow(currentModelEntry.contextWindow)}
                              </span>
                            )}
                            <ChevronDown size={14} className="opacity-50" />
                          </ToolbarButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="max-h-96 overflow-y-auto">
                          {Object.entries(modelsByProvider).map(([provider, models]) => (
                            <DropdownMenuSub key={provider}>
                              <DropdownMenuSubTrigger>
                                <span>{provider}</span>
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="max-h-96 overflow-y-auto">
                                {models.map((m) => (
                                  <DropdownMenuItem
                                    key={m.id}
                                    onClick={() => handleModelQuickSend(m.id)}
                                    className={cn(m.id === currentModel && 'font-medium text-[var(--accent)]')}
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
                          ) : modelAvailability === 'empty' ? (
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
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <div className="flex items-center">
                      {/* 只支持一档的模型（实测 11 个里有 8 个）不弹菜单，置灰并说明原因 ——
                          隐藏会让用户以为界面坏了，所以是置灰不是隐藏。 */}
                      {thinkingMenu.locked ? (
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
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div>
                          <Button
                            variant={isVoiceListening ? 'soft' : 'ghost'}
                            size="icon"
                            onClick={() => {
                              if (isVoiceListening) {
                                stopVoiceInput();
                                return;
                              }
                              void startVoiceInput();
                            }}
                            disabled={disabled}
                            aria-label={voiceTooltip}
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
                          <Button
                            variant={canSend ? 'default' : 'secondary'}
                            size="icon"
                            onClick={handleSend}
                            disabled={disabled || !canSend}
                            aria-label={t('chatInput.send')}
                            className={cn(
                              'rounded-2xl',
                              canSend
                                ? 'bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)]'
                                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-muted)]',
                            )}
                          >
                            <Send size={18} />
                          </Button>
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

                {toolsCatalog?.groups && toolsCatalog.groups.length > 0 && (
                  <ToolsCatalog groups={toolsCatalog.groups} onToolSelect={handleToolSelect} />
                )}
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
