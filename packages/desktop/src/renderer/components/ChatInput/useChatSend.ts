import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { evaluateCommercialSendAccess } from '@/lib/quota';
import { useCommercialStore } from '@/stores/commercialStore';
import { isModelSelectable, modelFamilyLabel, relayModelsFrom } from './model-families.js';
import { deriveModelAvailability } from './model-availability.js';
import { isThinkingSupported, thinkingDefaultFor } from './thinking-levels.js';
import type {
  Task,
  AgentInfo,
  Artifact,
  MessageAttachment,
  ModelCatalogEntry,
  ToolEntry,
  FileReadResult,
} from '@clawwork/shared';
import type { PendingNewTask } from '@clawwork/core';
import { deriveSessionActivity, describeGatewayError, extractDescription, getTaskSessionKeys } from '@clawwork/core';
import { useTaskStore } from '../../stores/taskStore';
import { useMessageStore } from '../../stores/messageStore';
import { useUiStore } from '../../stores/uiStore';
import { useRoomStore } from '../../stores/roomStore';
import { useTeamStore } from '../../stores/teamStore';
import { composer } from '../../platform';
import type { PendingAttachment } from './types';
import type { ImportedMaterialFile, TaskContextFile } from './useTaskMaterials';
import type { ThinkingLevel } from './constants';
import {
  GATEWAY_INJECTED_MODEL,
  EMPTY_MODELS_CATALOG,
  MAX_SEND_MATERIAL_BYTES,
  MAX_SEND_MATERIAL_COUNT,
  MAX_TEXT_TOTAL,
  MENTION_ALL_AGENT_ID,
} from './constants';
import { getModelLabel, readAsBase64 } from './utils';
import { resolveCommercialDefaultModel } from '@/lib/commercial-default-model';

interface UseChatSendOpts {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  pendingAttachments: PendingAttachment[];
  setPendingAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  selectedTasks: Task[];
  setSelectedTasks: Dispatch<SetStateAction<Task[]>>;
  selectedArtifacts: Artifact[];
  setSelectedArtifacts: Dispatch<SetStateAction<Artifact[]>>;
  selectedLocalFiles: TaskContextFile[];
  setSelectedLocalFiles: Dispatch<SetStateAction<TaskContextFile[]>>;
  selectedImportedFiles: ImportedMaterialFile[];
  clearSelectedImportedFiles: (expectedTaskId?: string) => void;
  markImportedFileMissing: (localPath: string, expectedTaskId?: string) => void;
  selectedAgents: Array<{ agentId: string; agentName: string; emoji?: string; sessionKey: string }>;
  setSelectedAgents: Dispatch<
    SetStateAction<Array<{ agentId: string; agentName: string; emoji?: string; sessionKey: string }>>
  >;
  stopVoiceInput: () => void;
  onComposerCleared?: () => void;
}

export function useChatSend(opts: UseChatSendOpts) {
  const {
    textareaRef,
    pendingAttachments,
    setPendingAttachments,
    selectedTasks,
    setSelectedTasks,
    selectedArtifacts,
    setSelectedArtifacts,
    selectedLocalFiles,
    setSelectedLocalFiles,
    selectedImportedFiles,
    clearSelectedImportedFiles,
    markImportedFileMissing,
    selectedAgents,
    setSelectedAgents,
    stopVoiceInput,
    onComposerCleared,
  } = opts;

  const { t } = useTranslation();

  const activeTask = useTaskStore((s) => s.tasks.find((tt) => tt.id === s.activeTaskId));
  const commitPendingTask = useTaskStore((s) => s.commitPendingTask);
  const updateTaskMetadata = useTaskStore((s) => s.updateTaskMetadata);
  const pendingNewTask = useTaskStore((s) => s.pendingNewTask);
  const addMessage = useMessageStore((s) => s.addMessage);
  const setProcessing = useMessageStore((s) => s.setProcessing);

  const activeRoom = useRoomStore((s) => (activeTask?.ensemble ? s.rooms[activeTask.id] : undefined));
  const activity = useMessageStore((s) =>
    activeTask
      ? deriveSessionActivity(getTaskSessionKeys(activeTask, activeRoom), s.activeTurnBySession, s.processingBySession)
      : 'idle',
  );
  const isGenerating = activity !== 'idle';

  const isOffline = useUiStore((s) => {
    const gwId = activeTask?.gatewayId ?? pendingNewTask?.gatewayId;
    if (gwId) {
      const st = s.gatewayStatusMap[gwId];
      return st === 'disconnected' || st === undefined;
    }
    const values = Object.values(s.gatewayStatusMap);
    return values.length > 0 && !values.some((v) => v === 'connected');
  });

  const taskGwId = activeTask?.gatewayId ?? pendingNewTask?.gatewayId;
  const modelCatalogByGateway = useUiStore((s) => s.modelCatalogByGateway);
  const gatewayStatus = useUiStore((s) => (taskGwId ? s.gatewayStatusMap[taskGwId] : undefined));
  // ⚠️ 先过 relayModelsFrom 再往下走 —— 网关返回的是**全量**目录（含 claude-cli / deepseek
  // 等我们没配的 provider）。下面的「当前模型」标签和下拉列表**必须同源**，
  // 否则标签会解析到我们服务不了的模型：新任务时显示的 `Claude Opus 5 (Claude CLI)`
  // 就是全量目录的第一条，用户会以为默认模型是它。
  const rawModelCatalog = taskGwId ? modelCatalogByGateway[taskGwId] : undefined;
  const modelCatalog = useMemo(() => relayModelsFrom(rawModelCatalog ?? EMPTY_MODELS_CATALOG), [rawModelCatalog]);
  const modelAvailability = deriveModelAvailability({
    gatewayId: taskGwId,
    gatewayStatus,
    rawCatalog: rawModelCatalog,
    modelCount: modelCatalog.length,
  });
  const toolsCatalogByGateway = useUiStore((s) => s.toolsCatalogByGateway);
  const toolsCatalog = taskGwId ? toolsCatalogByGateway[taskGwId] : undefined;
  const defaultModel = useMemo(() => resolveCommercialDefaultModel(modelCatalog), [modelCatalog]);
  const currentModel = activeTask
    ? activeTask.model === GATEWAY_INJECTED_MODEL
      ? undefined
      : activeTask.model
    : (pendingNewTask?.model ?? defaultModel?.id);
  const currentThinking = (activeTask?.thinkingLevel ?? pendingNewTask?.thinkingLevel ?? 'off') as ThinkingLevel;

  const currentModelEntry = currentModel ? modelCatalog.find((m) => m.id === currentModel) : undefined;
  const modelLabel = currentModelEntry?.name ?? getModelLabel(currentModel, modelCatalog[0]?.name);

  // 切模型后当前档位可能不再被支持（实测：deepseek-v4-flash 支持 5 档，deepseek-r1 只支持 off）。
  // 自动回落到新模型的默认档位。**只改状态、不插系统消息** —— 用户可能正在打字，插消息会打断。
  useEffect(() => {
    if (!currentModelEntry) return; // 目录没加载完时不动（isThinkingSupported 也会一律放行）
    if (isThinkingSupported(currentModelEntry, currentThinking)) return;
    const fallback = thinkingDefaultFor(currentModelEntry);
    if (activeTask) updateTaskMetadata(activeTask.id, { thinkingLevel: fallback });
    else useTaskStore.getState().updatePending({ thinkingLevel: fallback });
    toast.info(t('chatInput.thinkingResetByModel', { model: currentModelEntry.name ?? currentModelEntry.id }));
  }, [currentModelEntry, currentThinking, activeTask, updateTaskMetadata, t]);

  const modelsByProvider = useMemo(() => {
    const groups: Record<string, ModelCatalogEntry[]> = {};
    // modelCatalog 已经过 relayModelsFrom —— 这里不用再筛一遍 provider，
    // 只负责按**模型家族**分组（deepseek / qwen / glm 各一类，
    // 而不是全部堆在「clawrouter」一个组里）。
    for (const m of modelCatalog) {
      const family = modelFamilyLabel(m.id);
      if (!groups[family]) groups[family] = [];
      groups[family].push(m);
    }
    return groups;
  }, [modelCatalog]);

  const responseTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const abortResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendInFlightTaskIdsRef = useRef(new Set<string>());
  const activeTaskIdRef = useRef(activeTask?.id ?? null);
  activeTaskIdRef.current = activeTask?.id ?? null;

  const [quotaBlocked, setQuotaBlocked] = useState(false);
  const [quotaDegrade, setQuotaDegrade] = useState(false);
  const warnedThisWindowRef = useRef(false);
  const degradePromptedRef = useRef(false);

  useEffect(() => {
    if (!activeTask) return;
    if (activity === 'responding' || activity === 'tooling') {
      const timer = responseTimers.current.get(activeTask.id);
      if (timer) {
        clearTimeout(timer);
        responseTimers.current.delete(activeTask.id);
      }
    }
  }, [activity, activeTask]);

  useEffect(() => {
    const timers = responseTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (abortResetTimerRef.current) {
        clearTimeout(abortResetTimerRef.current);
        abortResetTimerRef.current = null;
      }
    };
  }, []);

  const handleSend = useCallback(async () => {
    const sendLockKey = activeTask?.id ?? '__pending_task__';
    if (sendInFlightTaskIdsRef.current.has(sendLockKey)) return;
    sendInFlightTaskIdsRef.current.add(sendLockKey);
    const ownedSendLockKeys = new Set([sendLockKey]);
    try {
      // 发送前校验：任务记着的模型可能已经不在目录里了（下架 / 上游调整）。
      // 不拦的话体验是「能选中 → 发出去 → 报错」，而且报错发生在会话就绪之后，
      // 看着像网络问题。详见 isModelSelectable 的注释。
      if (!isModelSelectable(modelCatalog, currentModel)) {
        toast.error(t('chatInput.modelGone', { model: currentModel ?? '' }));
        return;
      }

      const commercial = useCommercialStore.getState();
      const access = evaluateCommercialSendAccess(commercial.status, commercial.overview);
      if (!access.allowed) {
        setQuotaBlocked(true);
        return;
      }
      const verdict = access.verdict;

      if (verdict.level === 'warn' && !warnedThisWindowRef.current) {
        warnedThisWindowRef.current = true;
        toast.warning(t('usage.warnToast', { percent: Math.round(verdict.usedPercent) }));
      }

      if (verdict.level === 'degrade' && !degradePromptedRef.current) {
        degradePromptedRef.current = true;
        setQuotaDegrade(true);
        return;
      }

      const textarea = textareaRef.current;
      if (!textarea || isOffline) return;
      stopVoiceInput();

      const content = textarea.value.trim();
      if (!content && !pendingAttachments.length && !selectedImportedFiles.length && !selectedLocalFiles.length) return;

      let task = activeTask;
      if (!task) {
        try {
          task = commitPendingTask();
        } catch {
          toast.error(t('errors.agentNotResponding'));
          return;
        }
      }
      if (sendLockKey === '__pending_task__' && task.id !== sendLockKey) {
        if (sendInFlightTaskIdsRef.current.has(task.id)) return;
        sendInFlightTaskIdsRef.current.add(task.id);
        ownedSendLockKeys.add(task.id);
      }

      if (
        selectedImportedFiles.some((file) => file.taskId !== task.id) ||
        selectedLocalFiles.some((file) => file.taskId !== task.id)
      ) {
        toast.error(t('chatInput.materialUnavailable', { fileName: '' }));
        return;
      }
      const materialCount = pendingAttachments.length + selectedImportedFiles.length + selectedLocalFiles.length;
      const materialBytes = [
        ...pendingAttachments.map((item) => item.file.size),
        ...selectedImportedFiles.map((item) => item.size),
        ...selectedLocalFiles.map((item) => item.size),
      ].reduce((sum, size) => sum + size, 0);
      if (materialCount > MAX_SEND_MATERIAL_COUNT || materialBytes > MAX_SEND_MATERIAL_BYTES) {
        toast.error(t('chatInput.materialLimitExceeded', { count: MAX_SEND_MATERIAL_COUNT, size: 25 }));
        return;
      }

      const attachmentRecords: Array<{
        fileName: string;
        mimeType: string;
        base64: string;
        previewUrl: string;
        localPath?: string;
        size: number;
      }> = [];
      for (const att of pendingAttachments) {
        const mimeType = att.file.type || 'application/octet-stream';
        const base64 = await readAsBase64(att.file);
        const save = await window.clawwork.saveInboxAttachment({
          taskId: task.id,
          fileName: att.file.name,
          base64,
        });
        if (!save.ok) toast.error(t('chatInput.attachmentSaveFailed', { fileName: att.file.name }));
        attachmentRecords.push({
          fileName: att.file.name,
          mimeType,
          base64,
          previewUrl: att.previewUrl,
          localPath: save.result?.localPath,
          size: att.file.size,
        });
      }

      let importedReadFailed = false;
      const importedAttachmentRecords: Array<{
        fileName: string;
        mimeType: string;
        base64: string;
        localPath: string;
        size: number;
      }> = [];
      for (const file of selectedImportedFiles) {
        try {
          const read = await window.clawwork.readInboxFileForSend(file.localPath);
          if (read.ok && read.result) {
            importedAttachmentRecords.push({
              fileName: file.fileName,
              mimeType: file.mimeType || 'application/octet-stream',
              base64: read.result.content,
              localPath: file.localPath,
              size: file.size,
            });
            continue;
          }
        } catch {
          // The file can disappear between listing and dispatch. Handle it as unavailable below.
        }
        importedReadFailed = true;
        markImportedFileMissing(file.localPath, task.id);
        toast.error(t('chatInput.materialUnavailable', { fileName: file.fileName }));
        break;
      }
      if (importedReadFailed) return;

      const allMessageAttachments: MessageAttachment[] | undefined =
        attachmentRecords.length || importedAttachmentRecords.length
          ? [
              ...attachmentRecords.map((record) => ({
                fileName: record.fileName,
                dataUrl: record.previewUrl,
                mimeType: record.mimeType,
                localPath: record.localPath,
                size: record.size,
              })),
              ...importedAttachmentRecords.map((record) => ({
                fileName: record.fileName,
                dataUrl: record.mimeType.startsWith('image/') ? `data:${record.mimeType};base64,${record.base64}` : '',
                mimeType: record.mimeType,
                localPath: record.localPath,
                size: record.size,
              })),
            ]
          : undefined;

      const taskMentions = [...selectedTasks];
      const artifactMentions = [...selectedArtifacts];
      const localFileMentions = [...selectedLocalFiles];
      const agentMentions = [...selectedAgents];
      try {
        let finalContent = content || '';
        const extraAttachments: { mimeType: string; fileName: string; content: string }[] = [];

        if (taskMentions.length > 0) {
          let taskContextSize = 0;
          const blocks = await Promise.all(
            taskMentions.map(async (mt) => {
              const res = await window.clawwork.loadMessages(mt.id);
              if (!res.ok || !res.rows) return '';
              const msgs = res.rows.filter((m) => m.role === 'user' || m.role === 'assistant');
              const lines: string[] = [];
              for (const m of msgs) {
                const line = `[${m.role}]\n${m.content}`;
                taskContextSize += new TextEncoder().encode(line).length;
                if (taskContextSize > MAX_TEXT_TOTAL) {
                  toast.error(t('chatInput.taskContextLimitExceeded'));
                  break;
                }
                lines.push(line);
              }
              if (lines.length === 0) return '';
              return `<task-context name="${mt.title}" id="${mt.id}">\n${lines.join('\n\n')}\n</task-context>`;
            }),
          );
          const combined = blocks.filter(Boolean).join('\n\n');
          if (combined) {
            finalContent = combined + '\n\n' + finalContent;
          }
        }

        if (artifactMentions.length > 0) {
          const readResults = await Promise.all(
            artifactMentions.map((a) =>
              window.clawwork.readArtifactFile(a.localPath).then((res) => ({ artifact: a, res })),
            ),
          );

          const textBlocks: string[] = [];
          let totalTextSize = 0;

          for (const { artifact: a, res } of readResults) {
            if (!res.ok || !res.result) continue;
            const read = res.result as { content: string; encoding: string };

            if (read.encoding === 'utf-8') {
              const blockSize = new TextEncoder().encode(read.content).length;
              totalTextSize += blockSize;
              if (totalTextSize > MAX_TEXT_TOTAL) {
                toast.error(t('chatInput.fileContextLimitExceeded'));
                break;
              }
              textBlocks.push(`<file path="${a.name}">\n${read.content}\n</file>`);
            } else {
              extraAttachments.push({
                mimeType: a.mimeType || 'application/octet-stream',
                fileName: a.name,
                content: read.content,
              });
            }
          }

          if (textBlocks.length > 0) {
            finalContent = textBlocks.join('\n\n') + '\n\n' + finalContent;
          }
        }

        if (localFileMentions.length > 0) {
          const readResults: Array<{
            file: TaskContextFile;
            res: Awaited<ReturnType<typeof window.clawwork.readTaskContextFileForSend>>;
          }> = [];
          for (const file of localFileMentions) {
            readResults.push({
              file,
              res: await window.clawwork.readTaskContextFileForSend(task.id, file.sourceId, file.relativePath),
            });
          }

          const unavailable = readResults.find(({ res }) => !res.ok || !res.result);
          if (unavailable) {
            toast.error(t('chatInput.materialUnavailable', { fileName: unavailable.file.fileName }));
            return;
          }

          const localBlocks: string[] = [];
          let totalLocalSize = 0;

          for (const { file: f, res } of readResults) {
            if (!res.result) continue;
            const read = res.result as unknown as FileReadResult;

            if (read.tier === 'text') {
              const blockSize = new TextEncoder().encode(read.content).length;
              totalLocalSize += blockSize;
              if (totalLocalSize > MAX_TEXT_TOTAL) {
                toast.error(t('chatInput.fileContextLimitExceeded'));
                break;
              }
              localBlocks.push(`<file path="${f.relativePath}">\n${read.content}\n</file>`);
            } else {
              extraAttachments.push({
                mimeType: read.mimeType || f.mimeType || 'application/octet-stream',
                fileName: f.fileName,
                content: read.content,
              });
            }
          }

          if (localBlocks.length > 0) {
            finalContent = localBlocks.join('\n\n') + '\n\n' + finalContent;
          }
        }

        const gatewayAttachments = attachmentRecords.map((a) => ({
          mimeType: a.mimeType,
          fileName: a.fileName,
          content: a.base64,
        }));
        const importedGatewayAttachments = importedAttachmentRecords.map((record) => ({
          mimeType: record.mimeType,
          fileName: record.fileName,
          content: record.base64,
        }));
        const allAttachments = [...gatewayAttachments, ...importedGatewayAttachments, ...extraAttachments];
        const deferUserMessageUntilSent = Boolean(task.ensemble);

        if (task.ensemble) {
          const room = useRoomStore.getState().rooms[task.id];
          if (!room || !room.conductorReady) {
            const catalogEntryAll = useUiStore.getState().agentCatalogByGateway[task.gatewayId];
            const allAgents = catalogEntryAll?.agents ?? [];
            let agents: AgentInfo[];
            let teamAgentMap: Map<string, { role?: string }> | null = null;
            if (task.teamId) {
              const team = useTeamStore.getState().teams[task.teamId];
              const teamAgentIds = new Set(team?.agents.map((a) => a.agentId) ?? []);
              teamAgentMap = new Map(team?.agents.map((a) => [a.agentId, a]));
              agents = allAgents.filter((a) => teamAgentIds.has(a.id) && a.id !== task.agentId);
              // Fallback: if gateway agent catalog has not been fetched yet,
              // build minimal AgentInfo objects from the team definition itself.
              if (agents.length === 0 && !catalogEntryAll && team) {
                agents = team.agents
                  .filter((ta) => ta.agentId !== task.agentId)
                  .map((ta) => ({ id: ta.agentId }) satisfies AgentInfo);
              }
            } else {
              agents = allAgents.filter((a) => a.id !== 'main');
            }
            if (agents.length === 0) {
              toast.error(t('errors.conductorInitFailed'));
              return;
            }

            const descResults = await Promise.allSettled(
              agents.map((a) => window.clawwork.getAgentFile(task.gatewayId, a.id, 'IDENTITY.md')),
            );
            const descMap = new Map<string, string>();
            agents.forEach((a, i) => {
              const r = descResults[i];
              if (r.status === 'fulfilled' && r.value.ok && r.value.result) {
                const data = r.value.result as Record<string, unknown>;
                if (typeof data.content === 'string') {
                  const desc = extractDescription(data.content);
                  if (desc) descMap.set(a.id, desc);
                }
              }
            });

            const agentCatalogStr = agents
              .map((a) => {
                const name = (a.name ?? a.id).replaceAll('"', '\\"');
                const emojiPart = a.identity?.emoji ? `, emoji: ${a.identity.emoji}` : '';
                const ta = teamAgentMap?.get(a.id);
                const rolePart = ta?.role ? `, role: "${ta.role.replaceAll('"', '\\"')}"` : '';
                const desc = descMap.get(a.id);
                const descPart = desc ? `, description: "${desc.replaceAll('"', '\\"')}"` : '';
                return `- id: ${a.id}, name: "${name}"${emojiPart}${rolePart}${descPart}`;
              })
              .join('\n');
            const ok = await useRoomStore
              .getState()
              .initConductor(task.id, task.gatewayId, task.sessionKey, agentCatalogStr);
            if (!ok) {
              toast.error(t('errors.conductorInitFailed'));
              setProcessing(task.sessionKey, false);
              return;
            }
          }
        }

        const slashMatch = finalContent.trim().match(/^\/(model|think)\s+(.+)$/);
        if (slashMatch && allAttachments.length === 0 && !allMessageAttachments?.length) {
          const command = slashMatch[1] as 'model' | 'think';
          const result = await composer.applySlashCommand(task.id, command, slashMatch[2].trim());
          if (!result.ok) {
            // 已知错误给中文，未知错误给网关原文 —— 只报「发送失败」等于没报。
            toast.error(describeGatewayError(result.error, t('errors.sendFailed')));
            return;
          }
          if (activeTaskIdRef.current === task.id) {
            textarea.value = '';
            textarea.style.height = 'auto';
            onComposerCleared?.();
          }
          return;
        }

        const titleHint =
          content ||
          (localFileMentions.length ? `[@${localFileMentions[0].fileName}]` : '') ||
          (taskMentions.length ? `[@${taskMentions[0].title}]` : '') ||
          (artifactMentions.length ? `[@${artifactMentions[0].name}]` : '') ||
          (importedAttachmentRecords.length ? `[${importedAttachmentRecords[0].fileName}]` : '') ||
          (attachmentRecords.length ? `[${attachmentRecords[0].fileName}]` : '');

        const isMentionAll = agentMentions.some((a) => a.agentId === MENTION_ALL_AGENT_ID);
        const result = await composer.send(task.id, {
          content: finalContent,
          attachments: allAttachments.length > 0 ? allAttachments : undefined,
          messageAttachments: allMessageAttachments,
          deferUserMessageUntilSent,
          presetModel: currentModel,
          presetThinking: currentThinking,
          titleHint: task.title ? undefined : titleHint,
          mentionAll: isMentionAll || undefined,
          mentions: agentMentions.length > 0 && !isMentionAll ? agentMentions.map((a) => a.agentId) : undefined,
        });
        if (!result.ok) return;
        if (result.partialFailure) {
          toast.warning(t('chatInput.partialSendFailed'), { description: result.partialFailure });
        }
        if (activeTaskIdRef.current === task.id) {
          textarea.value = '';
          textarea.style.height = 'auto';
          onComposerCleared?.();
          setPendingAttachments([]);
          setSelectedAgents([]);
          setSelectedTasks([]);
          setSelectedArtifacts([]);
          setSelectedLocalFiles([]);
          clearSelectedImportedFiles(task.id);
        }
      } catch (err) {
        setProcessing(task.id, false);
        const msg = err instanceof Error ? err.message : String(err);
        addMessage(task.id, 'system', msg);
        toast.error(msg);
      }
    } finally {
      for (const key of ownedSendLockKeys) sendInFlightTaskIdsRef.current.delete(key);
    }
  }, [
    activeTask,
    commitPendingTask,
    addMessage,
    setProcessing,
    isOffline,
    pendingAttachments,
    selectedTasks,
    selectedArtifacts,
    selectedLocalFiles,
    selectedImportedFiles,
    selectedAgents,
    stopVoiceInput,
    setPendingAttachments,
    setSelectedTasks,
    setSelectedArtifacts,
    setSelectedLocalFiles,
    clearSelectedImportedFiles,
    markImportedFileMissing,
    setSelectedAgents,
    textareaRef,
    t,
    onComposerCleared,
    modelCatalog,
    currentModel,
    currentThinking,
  ]);

  const handleModelQuickSend = useCallback(
    (modelId: string) => {
      if (!activeTask) {
        useTaskStore.getState().updatePending({ model: modelId });
        return;
      }
      const ta = textareaRef.current;
      if (!ta) return;
      updateTaskMetadata(activeTask.id, {
        model: modelId,
        modelProvider: modelCatalog.find((m) => m.id === modelId)?.provider,
      });
      ta.value = `/model ${modelId}`;
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
      void handleSend();
    },
    [activeTask, handleSend, modelCatalog, updateTaskMetadata, textareaRef],
  );

  const handleThinkingQuickSend = useCallback(
    // 档位 id 来自目录（可能是我们没见过的 `xhigh`/`max`），不写成联合类型；
    // 不支持的值由网关拒绝，而 P0-2 之后拒绝原因会如实显示给用户。
    (level: string) => {
      if (!activeTask) {
        useTaskStore.getState().updatePending({ thinkingLevel: level });
        return;
      }
      const ta = textareaRef.current;
      if (!ta) return;
      ta.value = `/think ${level}`;
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
      void handleSend();
    },
    [activeTask, handleSend, textareaRef],
  );

  const [aborting, setAborting] = useState(false);
  const handleAbort = useCallback(async () => {
    if (!activeTask || aborting) return;
    setAborting(true);
    try {
      await composer.abort(activeTask.id);
    } catch {
      toast.error(t('chatInput.abortFailed'));
    } finally {
      if (abortResetTimerRef.current) clearTimeout(abortResetTimerRef.current);
      abortResetTimerRef.current = setTimeout(() => {
        setAborting(false);
        abortResetTimerRef.current = null;
      }, 500);
    }
  }, [activeTask, aborting, t]);

  const switchToFallbackModel = useCallback(async () => {
    const store = useTaskStore.getState();
    const task = store.tasks.find((item) => item.id === store.activeTaskId);
    if (!task) return;
    const res = await window.clawwork.patchSession(task.gatewayId, task.sessionKey, {
      model: defaultModel?.id ?? currentModel,
    });
    if (res.ok) {
      toast.success(t('usage.degradeDone'));
    } else {
      toast.error(t('errors.requestFailed'));
    }
  }, [currentModel, defaultModel?.id, t]);

  const handleToolSelect = useCallback(
    (tool: ToolEntry) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const insert = `${tool.label} `;
      const pos = ta.selectionStart ?? ta.value.length;
      const before = ta.value.slice(0, pos);
      const after = ta.value.slice(pos);
      const needSpace = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n');
      ta.value = before + (needSpace ? ' ' : '') + insert + after;
      const newPos = pos + (needSpace ? 1 : 0) + insert.length;
      ta.setSelectionRange(newPos, newPos);
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
      ta.focus();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [textareaRef],
  );

  return {
    isGenerating,
    aborting,
    isOffline,
    activeTask,
    currentModel,
    currentThinking,
    modelCatalog,
    modelAvailability,
    toolsCatalog,
    modelLabel,
    currentModelEntry,
    modelsByProvider,
    pendingNewTask: pendingNewTask as PendingNewTask | null,
    taskGwId,
    quotaBlocked,
    setQuotaBlocked,
    quotaDegrade,
    setQuotaDegrade,
    switchToFallbackModel,
    handleSend,
    handleModelQuickSend,
    handleThinkingQuickSend,
    handleAbort,
    handleToolSelect,
  };
}
