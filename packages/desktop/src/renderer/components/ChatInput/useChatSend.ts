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
import { evaluateCommercialSendAccess, type CommercialBlockReason } from '@/lib/quota';
import { useCommercialStore } from '@/stores/commercialStore';
import { isModelSelectable, modelFamilyLabel, relayModelsFrom, selectableModelsFrom } from './model-families.js';
import { deriveModelAvailability } from './model-availability.js';
import { deriveGatewayDisplayPhase } from '../../lib/gateway-display-phase.js';
import { isThinkingSupported, thinkingDefaultFor } from './thinking-levels.js';
import type {
  Task,
  AgentInfo,
  Artifact,
  MessageAttachment,
  ModelCatalogEntry,
  EffectiveToolEntry,
  FileReadResult,
  TaskMode,
  TaskModeSetting,
} from '@clawwork/shared';
import {
  DEFAULT_TASK_MODE,
  MODE_POLICY,
  modelIdMatches,
  normalizeTaskModeSetting,
  resolveEffectiveTaskMode,
  resolveModeModelId,
} from '@clawwork/shared';
import type { PendingNewTask } from '@clawwork/core';
import {
  deriveSessionActivity,
  describeGatewayError,
  describeSendRefusal,
  extractDescription,
  getTaskSessionKeys,
} from '@clawwork/core';
import {
  buildAttachmentDirective,
  classifyAttachmentFile,
  detectEditIntent,
  resolveImageInputSupport,
} from '../../lib/attachment-actions';
import { planVisionRouting, visionCatalogWithConfiguredInputs } from '../../lib/vision-routing';
import { planDeckRouting } from '../../lib/deck-intent';
import { markModePolicyNotified, shouldNotifyModePolicyChange } from '../../lib/mode-policy-notice';
import { userMdContentFromReadResult } from '../../lib/identity-persona';
import { artifactFailureContext } from '../../lib/artifact-delivery-feedback';
import { buildResponseLanguageContext } from '../../lib/response-language';
import { useTaskStore } from '../../stores/taskStore';
import { useMessageStore } from '../../stores/messageStore';
import { useUiStore } from '../../stores/uiStore';
import { useRoomStore } from '../../stores/roomStore';
import { useTeamStore } from '../../stores/teamStore';
import { composer } from '../../platform';
import { compareStore } from '@/features/compare/compare-store-instance';
import { compareRuntimeForTask } from '@/features/compare/compare-plan';
import { isMeetingTaskBusy } from '@/features/team-meeting/send-guard';
import type { PendingAttachment } from './types';
import type { ImportedMaterialFile, TaskContextFile } from './useTaskMaterials';
import type { ThinkingLevel } from './constants';
import {
  GATEWAY_INJECTED_MODEL,
  EMPTY_MODELS_CATALOG,
  MAX_SEND_MATERIAL_COUNT,
  MAX_TEXT_TOTAL,
  MENTION_ALL_AGENT_ID,
  deriveMaterialByteBudget,
  materialBudgetMb,
} from './constants';
import { getModelLabel, readAsBase64 } from './utils';
import { resolveCommercialDefaultModel } from '@/lib/commercial-default-model';
import { mergeTeamWorkflowContext } from '@/lib/team-workflow';
import { normalizePosition } from '@/lib/team-roundtable';

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

  const { t, i18n } = useTranslation();

  const activeTask = useTaskStore((s) => s.tasks.find((tt) => tt.id === s.activeTaskId));
  const commitPendingTask = useTaskStore((s) => s.commitPendingTask);
  const updateTaskMetadata = useTaskStore((s) => s.updateTaskMetadata);
  const pendingNewTask = useTaskStore((s) => s.pendingNewTask);
  const addMessage = useMessageStore((s) => s.addMessage);
  const setProcessing = useMessageStore((s) => s.setProcessing);

  const activeRoom = useRoomStore((s) =>
    activeTask?.ensemble && !activeTask.teamId ? s.rooms[activeTask.id] : undefined,
  );
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
  // 「这一格该说哪句话」的判据是纯函数（`lib/gateway-display-phase.ts`）：预热期（这次运行
  // 从没连上过）与真断开必须说两套话 —— 否则首启那 50 秒里输入框会说「离线模式 — 只读」，
  // 而它其实只是在启动（2026-09-20 实机截图）。`?.` 照顾手写 store 桩缺字段。
  const gatewayReconnect = useUiStore((s) => (taskGwId ? s.gatewayReconnectInfo?.[taskGwId] : undefined));
  const gatewayEverConnected = useUiStore((s) => (taskGwId ? s.gatewayEverConnected?.[taskGwId] === true : false));
  const gatewayDisplayPhase = deriveGatewayDisplayPhase({
    status: gatewayStatus,
    everConnected: gatewayEverConnected,
    reconnect: gatewayReconnect,
  });
  // ⭐ 单帧上限以**网关协商值**为准（`hello-ok.policy.maxPayload`，连接建立时经
  //    gateway-status 落进 `gatewayMaxPayloadByGateway`）；拿不到就回落默认 25MiB。
  //    `?.` 照顾手写 store 桩（同 `gatewayReconnectInfo` 那两行）。
  const gatewayMaxPayloadBytes = useUiStore((s) => (taskGwId ? s.gatewayMaxPayloadByGateway?.[taskGwId] : undefined));
  // 字节预算 = 单帧 × 3/4 − 余量（base64 折算；推导见 constants.ts 的同名函数）。
  const materialByteBudget = useMemo(() => deriveMaterialByteBudget(gatewayMaxPayloadBytes), [gatewayMaxPayloadBytes]);
  // ⚠️ 先过 relayModelsFrom 再往下走 —— 网关返回的是**全量**目录（含 claude-cli / deepseek
  // 等我们没配的 provider）。下面的「当前模型」标签和下拉列表**必须同源**，
  // 否则标签会解析到我们服务不了的模型：新任务时显示的 `Claude Opus 5 (Claude CLI)`
  // 就是全量目录的第一条，用户会以为默认模型是它。
  const rawModelCatalog = taskGwId ? modelCatalogByGateway[taskGwId] : undefined;
  const modelCatalogFailureByGateway = useUiStore((s) => s.modelCatalogFailureByGateway);
  const catalogFailed = taskGwId ? modelCatalogFailureByGateway[taskGwId] === true : false;
  const modelCatalog = useMemo(() => relayModelsFrom(rawModelCatalog ?? EMPTY_MODELS_CATALOG), [rawModelCatalog]);
  const modelAvailability = deriveModelAvailability({
    gatewayId: taskGwId,
    gatewayStatus,
    rawCatalog: rawModelCatalog,
    catalogFailed,
    modelCount: modelCatalog.length,
  });
  const effectiveToolsState = useUiStore((s) =>
    activeTask ? s.effectiveToolsByGateway?.[activeTask.gatewayId]?.[activeTask.sessionKey] : undefined,
  );
  const toolsCatalog = effectiveToolsState?.status === 'ready' ? effectiveToolsState.inventory : undefined;
  const defaultModel = useMemo(() => resolveCommercialDefaultModel(modelCatalog), [modelCatalog]);
  const currentModel = activeTask
    ? activeTask.model === GATEWAY_INJECTED_MODEL
      ? undefined
      : activeTask.model
    : (pendingNewTask?.model ?? defaultModel?.id);
  const currentThinking = (activeTask?.thinkingLevel ?? pendingNewTask?.thinkingLevel ?? 'off') as ThinkingLevel;
  /**
   * 当前生效的任务模式（**发送判据与界面显示同一把尺**，规则住在
   * `@clawwork/shared` 的 `task-modes.ts`）：
   *   · 有任务 ⇒ 看任务（旧行 mode 为空 ⇒ `custom`，不劫持它的 `model`）；
   *   · 待发态 ⇒ 看待发配置，没选过 ⇒ 默认档（与 `createTask` 写入的默认档一致）。
   */
  const currentMode: TaskModeSetting = activeTask
    ? resolveEffectiveTaskMode(activeTask)
    : (normalizeTaskModeSetting(pendingNewTask?.mode) ?? DEFAULT_TASK_MODE);

  const currentModelEntry = currentModel ? modelCatalog.find((m) => m.id === currentModel) : undefined;
  const modelLabel = currentModelEntry?.name ?? getModelLabel(currentModel, modelCatalog[0]?.name);
  // 「当前模型看不看图」的判据（与输入框那行建议/入口**同源**，见 lib/attachment-actions.ts）。
  // 发送路径要它来触发自动路由：带图 × 不是 supported ⇒ 先切到能看图的目录模型再发。
  const imageInputSupport = resolveImageInputSupport(currentModelEntry);

  // 切模型后当前档位可能不再被支持（实测：deepseek-v4-flash 支持 5 档，deepseek-r1 只支持 off）。
  // 自动回落到新模型的默认档位。**只改状态、不插系统消息** —— 用户可能正在打字，插消息会打断。
  //
  // ⚠️ 2026-10-12：**模式档（快速/智能/深度）不走这段**。模式任务的思考档由 `MODE_POLICY`
  //    在发送时现算（`task.thinkingLevel` 在模式档下不参与发送，只是留痕）；而"真档位集不含 off"
  //    是目录真值（glm-5.3-flash = [low,high,max]）——修复思考档接线后，任务默认档 `off`
  //    会让这段**每次切模式都误触发**「已切换到 glm-5.3-flash，思考档位已重置为默认」的提示：
  //    模型名不该露（用户拍板），"重置为默认"的语义也不对（档位由模式决定，不存在重置）。
  //    custom（含旧任务）保持原行为：换模型导致档位不受支持时，回落 + 告知。
  const modeDrivenThinking = currentMode !== 'custom';
  useEffect(() => {
    if (modeDrivenThinking) return;
    if (!currentModelEntry) return; // 目录没加载完时不动（isThinkingSupported 也会一律放行）
    if (isThinkingSupported(currentModelEntry, currentThinking)) return;
    const fallback = thinkingDefaultFor(currentModelEntry);
    if (activeTask) updateTaskMetadata(activeTask.id, { thinkingLevel: fallback });
    else useTaskStore.getState().updatePending({ thinkingLevel: fallback });
    toast.info(t('chatInput.thinkingResetByModel', { model: currentModelEntry.name ?? currentModelEntry.id }));
  }, [modeDrivenThinking, currentModelEntry, currentThinking, activeTask, updateTaskMetadata, t]);

  const modelsByProvider = useMemo(() => {
    const groups: Record<string, ModelCatalogEntry[]> = {};
    // 先过**唯一一把尺**（relay 渠道 / 可用性 / 模式别名 / 被新渠道接管的旧渠道条目
    // ——BUG-076；2026-10-14 起 composer「高级：指定模型」并入同一把尺，
    // 此前这里自己只挡别名，是 10-12 统一时漏掉的一处），再按**模型家族**分组
    // （deepseek / qwen / glm 各一类，而不是全部堆在「clawrouter」一个组里）。
    for (const m of selectableModelsFrom(modelCatalog)) {
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

  // ⚠️ 存的是**原因**而不是布尔：原来四种原因共用一个 true，界面只能弹同一句话
  //    （「额度已用尽，充值…」），于是"读不到额度"被说成了"额度用尽"。
  const [quotaBlock, setQuotaBlock] = useState<CommercialBlockReason | null>(null);
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

  /**
   * 把**某个任务会话**的模型钉到 `modelId`（网关 `patchSession` 通道），返回成功与否。
   * 说什么话由调用方决定：额度降级那条路弹「已切换」，图片路由那条路**只在真切了才提示**
   *（切不动就静默照发 —— 模型会按附件纪律如实说看不到）。
   *
   * ⚠️ 必须定义在 `handleSend` **之前**：handleSend 的依赖数组在渲染期就会读它，
   *    声明在后面 = TDZ（渲染即炸）。
   */
  const patchSessionModel = useCallback(async (task: Task, modelId: string): Promise<boolean> => {
    const res = await window.clawwork.patchSession(task.gatewayId, task.sessionKey, { model: modelId });
    return res.ok;
  }, []);

  const handleSend = useCallback(async () => {
    if (isMeetingTaskBusy(activeTask?.id)) {
      toast.error(t('meeting.taskBusy'));
      return;
    }
    // ⚠️ DOCX-205 合同（2026-10-10）B 块：**普通新请求按会话单飞**。
    //    上一轮「真实执行终态」未到之前不发第二条 —— 键盘 Enter 也走这里
    //    （按钮变"停止"并不意味着 Enter 被拦）。判据与托盘/任务行同源
    //    （`deriveSessionActivity`：activeTurn + processingBySession）。
    //    审批回应 / 工具提问 / 显式停止走各自路径，不受此门影响；
    //    不同 session（不同任务）各自独立。主进程 `ws:send-message` 还有第二道门
    //    （执行终态 + 交付 settled 的 run 锁），兜住不经此门的调用方。
    if (activeTask) {
      const liveState = useMessageStore.getState();
      const liveActivity = deriveSessionActivity(
        getTaskSessionKeys(activeTask, activeRoom),
        liveState.activeTurnBySession,
        liveState.processingBySession,
      );
      if (liveActivity !== 'idle') {
        toast.error(t('chatInput.turnInFlight'));
        return;
      }
    }
    const sendLockKey = activeTask?.id ?? '__pending_task__';
    if (sendInFlightTaskIdsRef.current.has(sendLockKey)) return;
    sendInFlightTaskIdsRef.current.add(sendLockKey);
    const ownedSendLockKeys = new Set([sendLockKey]);
    try {
      // 对比模式：这次「发送」不是发一条消息，而是同一句话**并发**问 N 个模型
      //（见下面「多模型对比」那一段）。先取一份快照 —— 后面几道闸门要让路。
      const compare = compareStore().getState();

      // 发送前校验：任务记着的模型可能已经不在目录里了（下架 / 上游调整）。
      // 不拦的话体验是「能选中 → 发出去 → 报错」，而且报错发生在会话就绪之后，
      // 看着像网络问题。详见 isModelSelectable 的注释。
      // ⚠️ 对比模式**跳过这一关**：对比用的是各列自己钉的模型，任务级模型下架
      //    不该把对比一起拦住（拦住的话用户会以为"对比坏了"）。
      // ⚠️ 模式任务（快速/智能/深度）**同样跳过**：`task.model` 对它们只是"上一轮跑过的
      //    那个模型"的留痕，这一轮跑什么由目录现解析（`resolveModeModelId`）——
      //    拿一个留痕去拦住用户，等于"模型下架后连智能模式都发不出去"。
      if (!compare.mode && currentMode === 'custom' && !isModelSelectable(modelCatalog, currentModel)) {
        toast.error(t('chatInput.modelGone', { model: currentModel ?? '' }));
        return;
      }

      const commercial = useCommercialStore.getState();
      const access = evaluateCommercialSendAccess(commercial.status, commercial.overview);
      if (!access.allowed) {
        setQuotaBlock(access.reason);
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
      // ⭐ 2026-10-07（质量战役区 3）：判据补「存在任一 @ 选择」——
      //    只有 @ 提及、没有文字时也要能发（此前 `stripAtQuery` 会把 @ 查询串从输入框
      //    抹掉（不触发 onInput），于是"只剩提及选中"的输入框被判空、发送键形同虚设）。
      if (
        !content &&
        !pendingAttachments.length &&
        !selectedImportedFiles.length &&
        !selectedLocalFiles.length &&
        !selectedTasks.length &&
        !selectedArtifacts.length &&
        !selectedAgents.length
      )
        return;

      let task = activeTask;
      if (!task) {
        try {
          task = commitPendingTask();
        } catch (error) {
          // ⭐ 2026-09-24：**点名要的助手不在本机**与「助手无响应」是两回事 ——
          //    前者有确定的下一步（换一个助手），后者只能重试。压成同一句会误导用户。
          //    规则收在 core 的 `describeSendRefusal` 一处（三条调用方共用）。
          toast.error(describeSendRefusal(error, t));
          return;
        }
      }
      if (sendLockKey === '__pending_task__' && task.id !== sendLockKey) {
        if (sendInFlightTaskIdsRef.current.has(task.id)) return;
        sendInFlightTaskIdsRef.current.add(task.id);
        ownedSendLockKeys.add(task.id);
      }

      if (isMeetingTaskBusy(task.id)) {
        toast.error(t('meeting.taskBusy'));
        return;
      }

      // ── 多模型对比 ────────────────────────────────────────────────────────
      // 对比模式下的「发送」= 同一句话并发问 N 个模型，走对比自己的编排
      //（每路一条会话、各自独立结算）。不能落进下面的 composer.send —— 那只会
      // 发成"一个模型的一条"，用户以为在对比、其实只有一个答案。
      //
      // 放在这个位置是有意的：离线/空内容/额度/**任务已就绪**四关都已经过了，
      // 而「任务级模型可用」那一关刻意跳过（对比用的是各列自己的模型）。
      if (compare.mode && !task.teamId) {
        // ⚠️ 闸门带**任务身份**：`active` 是全局唯一的，而用户可以切任务 ——
        // 用 `compare.active` 直接拦的话，前一个任务里跑着的一轮会让**这个任务**
        // 一个字都发不出去（提示"上一轮对比还在跑"，可用户眼前这一屏根本没有对比面板）。
        // 别的任务里的那一轮不该管这里；本任务里的才拦（界面只有一组列）。
        if (compareRuntimeForTask(compare.active, task.id)) {
          toast.error(t('compare.roundRunning'));
          return;
        }
        // 对比只发一句话：附件/引用要先落盘、要按任务拼上下文，而 N 路并行时
        // 这些"前置打包"会各自重复一遍且难以解释给用户。**如实拦住**，不静默丢弃。
        const compareMaterials =
          pendingAttachments.length +
          selectedImportedFiles.length +
          selectedLocalFiles.length +
          selectedTasks.length +
          selectedArtifacts.length +
          selectedAgents.length;
        if (compareMaterials > 0) {
          toast.error(t('compare.materialsUnsupported'));
          return;
        }

        const started = compare.start({
          taskId: task.id,
          gatewayId: task.gatewayId,
          agentId: task.agentId ?? 'main',
          prompt: content,
        });
        if (!started) {
          // 没发起来 = 选中的模型数量不对（库里已置 compare.error，选择条上会显示原因）
          toast.error(t('compare.sendBlocked'));
          return;
        }
        if (activeTaskIdRef.current === task.id) {
          textarea.value = '';
          textarea.style.height = 'auto';
          onComposerCleared?.();
        }
        return;
      }

      if (
        selectedImportedFiles.some((file) => file.taskId !== task.id) ||
        selectedLocalFiles.some((file) => file.taskId !== task.id)
      ) {
        toast.error(t('chatInput.materialUnavailable', { fileName: '' }));
        return;
      }
      // ⭐ 分桶计数（2026-10-07 · 方案 A）：**只算二进制附件**（暂存附件 + 已选导入材料）。
      //    `selectedLocalFiles`（@ 授权文件夹）是 tier='text' 内联内容，只受 500KB 文本
      //    总约束（下面 localFileMentions 一段逐块拦），**不占个数** —— 11 个小文本文件
      //    塞满的载荷才几 KB，按个数拒发是纯粹的功能损失（P1-2）。
      const binaryMaterialCount = pendingAttachments.length + selectedImportedFiles.length;
      let materialBytes = pendingAttachments.reduce((sum, item) => sum + item.file.size, 0);
      if (binaryMaterialCount > MAX_SEND_MATERIAL_COUNT) {
        toast.error(t('chatInput.materialLimitCount', { count: MAX_SEND_MATERIAL_COUNT }));
        return;
      }
      if (materialBytes > materialByteBudget) {
        toast.error(t('chatInput.materialLimitBytes', { size: materialBudgetMb(materialByteBudget) }));
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
            materialBytes += read.result.byteLength;
            if (materialBytes > materialByteBudget) {
              toast.error(t('chatInput.materialLimitBytes', { size: materialBudgetMb(materialByteBudget) }));
              return;
            }
            importedAttachmentRecords.push({
              fileName: file.fileName,
              mimeType: file.mimeType || 'application/octet-stream',
              base64: read.result.content,
              localPath: file.localPath,
              size: read.result.byteLength,
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
        /**
         * ⭐ **只给模型看的背景**，与 `finalContent` 分开（store/落库只收 `finalContent`）。
         * 拼进 `finalContent` 的话，它会**存进用户消息并显示在气泡里** ——
         * 2026-09-27 真机反馈正是这个：每轮消息顶着一大块 `<artifacts-index>…`。
         * 见 `SendOptions.contextPrefix`。
         */
        let contextPrefix = '';
        const extraAttachments: { mimeType: string; fileName: string; content: string }[] = [];

        /*
         * ⭐ 2026-10-07（质量战役区 3 · 用户授权代决）：**首轮产物索引已切断**。
         *
         * 原实现（2026-09-26 起）：新会话首轮自动把"全库产物索引"（≤20 条其它会话的
         * 文件名 + 来源会话标题）作为隐藏上下文发给模型。问题是 `listArtifacts()` 是
         * **全库**读取，仅排除当前会话 —— 等于每个新会话首轮默认把别人会话的标题与
         * 文件名披露给模型，是会话隔离叙事里唯一的默认越界。
         * 现在：模型**只在用户 `@` 产物时**看见它（那条路照旧，见下面 artifactMentions）；
         * "发现性"由右侧「历史产物」面板承担。会议路径同步去掉了该注入（instance.ts）。
         */

        // 团队任务不再依赖 conductor。合同作为隐藏上下文发送，既不污染用户气泡/落库正文，
        // 又在每一轮都守住“策略 → 创作 → 质检/修订 → 交付”的可靠模式。
        if (task.teamId) {
          // 冷启动直接从任务列表续聊时，用户可能从未打开过团队页，因而 store 还是空的。
          // 按 id 补读一次持久化团队，不能把真实花名册降级成只有四阶段合同。
          const teamState = useTeamStore.getState();
          const team = teamState.teams[task.teamId] ?? (await teamState.loadTeam(task.teamId));
          const catalog = useUiStore.getState().agentCatalogByGateway[task.gatewayId]?.agents ?? [];
          const namesById = new Map(catalog.map((agent) => [agent.id, agent.name ?? agent.id]));
          contextPrefix = mergeTeamWorkflowContext(
            contextPrefix,
            team
              ? {
                  name: team.name,
                  activeAgentId:
                    task.agentId ??
                    team.agents.find((agent) => agent.isManager)?.agentId ??
                    team.agents[0]?.agentId ??
                    'main',
                  members: team.agents.map((agent) => ({
                    agentId: agent.agentId,
                    name: namesById.get(agent.agentId) ?? agent.agentId,
                    role: agent.role,
                    position: normalizePosition(agent.position),
                    isManager: agent.isManager,
                  })),
                }
              : undefined,
          );
        }

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
              window.clawwork.readArtifactFile(a.id, a.taskId).then((res) => ({ artifact: a, res })),
            ),
          );

          const textBlocks: string[] = [];
          let totalTextSize = 0;

          for (const { artifact: a, res } of readResults) {
            if (!res.ok || !res.result) continue;
            const read = res.result;
            // ⚠️ 太大的产物**没有 `content`**：不判这一支的话，它会当成"空文件"
            //    被塞进 `<file>` 块发出去（模型收到一个空的 path=… 标签，
            //    用户以为自己把这份文件带上去了）。这里如实说一句，别静默丢。
            if ('tooLarge' in read) {
              toast.error(t('chatInput.artifactTooLarge', { name: a.name }));
              continue;
            }
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
            const res = await window.clawwork.readTaskContextFileForSend(task.id, file.sourceId, file.relativePath);
            if (res.ok && res.result) {
              // ⚠️ tier='text' 的 byteLength 是**实际内联字节**（主进程按
              //    min(size, 100KB) 回报，2026-10-07 · P2-1）：30MB 的 .log 在这里
              //    记 ~100KB，不再按整份体积虚耗预算；tier≠text（base64 发送）仍按整份
              //    保守计（content 至多 10MB，字节闸门按 size 计只会更早拦，不会漏）。
              materialBytes += res.result.byteLength;
              if (materialBytes > materialByteBudget) {
                toast.error(t('chatInput.materialLimitBytes', { size: materialBudgetMb(materialByteBudget) }));
                return;
              }
            }
            readResults.push({ file, res });
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
        const useEnsembleDelivery = Boolean(task.ensemble && !task.teamId);
        const deferUserMessageUntilSent = useEnsembleDelivery;

        if (useEnsembleDelivery) {
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
                // ⭐ 2026-10-07（质量战役区 3）：字段错位修复 —— `agents.files.get` 的真机载荷是
                //    `{ agentId, workspace, file: { name, content, missing } }`，旧代码读 `result.content`
                //    恒为 undefined ⇒ **给模型的助手描述一直是空的**（conductor 花名册只剩 id/name/role）。
                //    统一走 `userMdContentFromReadResult`（区 6 同一把尺：`file.content`；形状不认识
                //    返回 null 按读失败处理，不把"读不到"说成"空"）。
                const rawContent = userMdContentFromReadResult(r.value.result);
                if (rawContent) {
                  const desc = extractDescription(rawContent);
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
          if (isMeetingTaskBusy(task.id)) {
            toast.error(t('meeting.taskBusy'));
            return;
          }
          const command = slashMatch[1] as 'model' | 'think';
          const result = await composer.applySlashCommand(task.id, command, slashMatch[2].trim());
          if (!result.ok) {
            // 已知错误给中文，未知错误给网关原文 —— 只报「发送失败」等于没报。
            toast.error(describeGatewayError(result.error, t('errors.sendFailed')));
            return;
          }
          // `/model <id>` = 用户**显式指定了一个模型** ⇒ 与高级列表里选模型同一个语义：
          // 模式落 `custom`。不改的话下一次普通发送会把模式模型重新钉回会话上 ——
          // 用户刚敲的命令等于被静静revert掉（模式覆盖一切是有意设计，但不能覆盖"我刚说了用哪个"）。
          if (command === 'model') updateTaskMetadata(task.id, { mode: 'custom' });
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

        /**
         * ⭐ F 组（BUG-030）：带文件的这一轮，**默认只读**（读了就总结、给结论、给建议操作），
         * 只有用户**明说**要改才走写。纪律写进 `contextPrefix`（只发模型，不进气泡/不落库），
         * 判据在 `lib/attachment-actions.ts`（纯函数，单独钉）。
         *
         * ⚠️ 判"要不要改"只看**用户自己敲的话**（`content`），不看 `finalContent` ——
         *    后者前面拼进了被 @ 的**文件正文**，一份讲"如何修改合同"的文档会让每一轮都被判成改动。
         */
        const attachedFilesForIntent = [
          ...pendingAttachments.map((att) => ({ fileName: att.file.name, mimeType: att.file.type || undefined })),
          ...importedAttachmentRecords.map((record) => ({
            fileName: record.fileName,
            mimeType: record.mimeType || undefined,
          })),
          ...localFileMentions.map((file) => ({ fileName: file.fileName, mimeType: file.mimeType || undefined })),
        ];
        const attachmentDirective = buildAttachmentDirective({
          files: attachedFilesForIntent.map((file) => ({
            fileName: file.fileName,
            kind: classifyAttachmentFile(file.fileName, file.mimeType),
          })),
          intent: detectEditIntent(content) ? 'edit' : 'read',
        });

        const isMentionAll = agentMentions.some((a) => a.agentId === MENTION_ALL_AGENT_ID);
        const failureContext = artifactFailureContext(
          useMessageStore.getState().messagesByTask[task.id] ?? [],
          task.sessionKey,
        );
        contextPrefix = [
          buildResponseLanguageContext(i18n?.resolvedLanguage ?? i18n?.language ?? 'zh-CN'),
          contextPrefix,
          failureContext,
          attachmentDirective,
        ]
          .filter(Boolean)
          .join('\n\n');
        if (isMeetingTaskBusy(task.id)) {
          toast.error(t('meeting.taskBusy'));
          return;
        }

        // 先计算模式与PPT路由，再对最终执行模型做视觉门禁。
        const sendMode = resolveEffectiveTaskMode(task);
        let effectiveModel = currentModel;
        let effectiveThinking: string = currentThinking;
        let preservesDeckModel = false;
        /**
         * 存量模式任务的一次性"已切换"提示内容（BUG-067 复验整改）：
         * 发送前只**存下**目标 `{modelId, modelName}`；是否真的"已采用"在 composer
         * 返回／抛错后按**任务行最新 model**（core 在模型 patch 成功后立即更新它）判定。
         * `result.ok` 只代表整轮派发结果——"pin 成功但后续派发失败"同样返回 `ok:false`，
         * 不能拿它当采用判据（会把这次告知静默吞掉）。
         */
        let modePolicyNotice: { modelId: string; modelName: string } | undefined;
        if (sendMode !== 'custom') {
          const policy = MODE_POLICY[sendMode];
          const catalogModelIds = modelCatalog.map((entry) => entry.id);
          const modeModelId = resolveModeModelId(sendMode, catalogModelIds);
          // 两档候选都不在目录（目录没拉到 / 模型下架）⇒ **保持现状、不拦截**：
          // 拿"目录里暂时没有"当"不支持"去拦住用户，是更坏的失败。
          if (modeModelId) {
            effectiveModel = modeModelId;
            effectiveThinking = policy.thinkingLevel;
          }

          // ── Deck 意图路由（2026-10-08 产品拍板）：演示类任务内部钉 DeepSeek ──
          // 真机实证：PPT 生成/改稿链在 qwen 上 20 分钟修稿循环不收敛；同一模式换成
          // DeepSeek 后 2.6 分钟出 9 页合格成品。瓶颈是输出稳定性、与速度档无关 ⇒
          // **三档（快速/智能/深度）都路由**；模式芯片照旧显示用户选的那一档
          //（这是内部路由，不是用户可见的模式），所以**不给提示、不弹 toast**。
          //
          // 粘性：第一条命中就把任务标记成 deck 路由（`deckRouted`）—— 后续消息
          //（"把标题改一下"这类不含演示名词的改稿）继续走 DeepSeek；`custom`
          //（用户显式选过模型）是唯一出口：那时整段路由都不介入（判据在纯函数里）。
          //
          // 判据只吃**用户手打的字**（`content`），不吃 @ 进来的文件正文/附件名 ——
          // 与附件 read/edit 纪律同一条（见上面 `attachedFilesForIntent` 的说明）。
          const deckPlan = planDeckRouting({
            sendMode,
            task,
            text: content,
            catalogModelIds,
          });
          if (deckPlan.markTask) updateTaskMetadata(task.id, { deckRouted: true });
          // 目录里没有 DeepSeek（没拉到 / 下架）⇒ `route: false`：**保持现状、不拦截**。
          if (deckPlan.route && deckPlan.modelId) {
            effectiveModel = deckPlan.modelId;
            preservesDeckModel = true;
          }

          // 存量模式任务首次采用新策略 ⇒ 一次性模型/价格提示（判据与标记见 lib/mode-policy-notice.ts）。
          // 判据用 deck 路由后的**最终**模型：老 PPT 粘性任务换的是渠道（新平台 ID），
          // 提示要报实际会跑的那个模型，不能报模式档模型。
          // ⚠️ 只存内容，不弹不记 —— 采用判定与提示都在发送结算后（见下 .finally，BUG-067）。
          const policyModelId = deckPlan.route && deckPlan.modelId ? deckPlan.modelId : modeModelId;
          if (policyModelId && shouldNotifyModePolicyChange({ sendMode, task, effectiveModelId: policyModelId })) {
            modePolicyNotice = {
              modelId: policyModelId,
              modelName: modelCatalog.find((entry) => entry.id === policyModelId)?.name ?? policyModelId,
            };
          }
        }
        const hasImageAttachment =
          attachedFilesForIntent.some((file) => classifyAttachmentFile(file.fileName, file.mimeType) === 'image') ||
          // ⚠️ MM-A 加固（2026-10-15 独立核验缺口）：@ 提及的**产物**（二进制读取）
          // 走 `extraAttachments`，此前不在 attachedFilesForIntent 里 ⇒ 图片产物
          // **绕过视觉门禁** —— 文本模型收下后被 runtime 静默丢图（用户还以为发上去了）。
          // 图片判定必须覆盖这一路（它们随后经 `allAttachments` 真的进入这轮请求）。
          extraAttachments.some((att) => classifyAttachmentFile(att.fileName, att.mimeType) === 'image');
        let visionCatalog: readonly ModelCatalogEntry[] = modelCatalog;
        if (hasImageAttachment) {
          // models.list可能来自动态目录，最终override仍以静态config为准；每次带图都回读。
          try {
            const snapshot = await window.clawwork.getConfig(task.gatewayId);
            const configuredCatalog = snapshot.ok
              ? visionCatalogWithConfiguredInputs(modelCatalog, snapshot.result)
              : null;
            if (!configuredCatalog) {
              toast.error(t('chatInput.visionUnavailable'));
              return;
            }
            visionCatalog = configuredCatalog;
          } catch {
            toast.error(t('chatInput.visionUnavailable'));
            return;
          }
        }
        const routedModel = effectiveModel;
        const finalModelEntry = routedModel
          ? visionCatalog.find((entry) => modelIdMatches(entry.id, routedModel))
          : undefined;
        const visionPlan = planVisionRouting({
          hasImageAttachment,
          imageInputSupport: resolveImageInputSupport(finalModelEntry),
          currentModelId: finalModelEntry?.id ?? effectiveModel,
          catalog: visionCatalog,
          allowFallback: sendMode !== 'custom' && !preservesDeckModel,
        });
        if (visionPlan.kind === 'unavailable') {
          // 保留草稿与附件；不给不能识图的模型发送这轮请求。
          toast.error(t('chatInput.visionUnavailable'));
          return;
        }
        if (visionPlan.kind === 'switch') {
          const visionFallback = visionPlan.model;
          let switched = false;
          try {
            switched = await patchSessionModel(task, visionFallback.id);
          } catch {
            // 图片请求不可继续，原始传输错误不进入用户消息。
          }
          if (!switched) {
            toast.error(t('chatInput.visionUnavailable'));
            return;
          }
          effectiveModel = visionFallback.id;
          effectiveThinking = thinkingDefaultFor(visionFallback);
          modePolicyNotice = undefined;
          updateTaskMetadata(task.id, { model: visionFallback.id, modelProvider: visionFallback.provider });
          toast.info(t('chatInput.visionFallbackSwitched', { model: visionFallback.name ?? visionFallback.id }));
        }

        const result = await composer
          .send(task.id, {
            content: finalContent,
            // 首轮产物索引：发给模型，但**不进** store / 落库 / 气泡。
            contextPrefix: contextPrefix || undefined,
            attachments: allAttachments.length > 0 ? allAttachments : undefined,
            messageAttachments: allMessageAttachments,
            deferUserMessageUntilSent,
            presetModel: effectiveModel,
            // 模式任务：思考档由 `MODE_POLICY` 决定（composer 会对着模型的真实能力再校验一次，
            // 不支持时回落到该模型自己的默认档）；custom / 旧会话：用户自己那一档。
            presetThinking: effectiveThinking,
            titleHint: task.title ? undefined : titleHint,
            mentionAll: isMentionAll || undefined,
            mentions: agentMentions.length > 0 && !isMentionAll ? agentMentions.map((a) => a.agentId) : undefined,
          })
          .finally(() => {
            // 三档/采用结算：**按任务行最新 model 判定是否真的"已采用"**（core 在模型 patch
            // 成功后立即更新它）——`ok` 只控派发结果，pin 成功但派发失败同样 ok:false，
            // 不能拿 ok 当采用判据；此时模型已切换，用户必须收到这一条告知。
            // finally 在 resolve／reject 时都执行；可选提示自带容错，
            // 绝不改变发送结果或覆盖原始发送异常。
            const notice = modePolicyNotice;
            if (!notice) return;
            try {
              const adopted = useTaskStore.getState().tasks.find((item) => item.id === task.id);
              if (typeof adopted?.model !== 'string') return;
              if (!modelIdMatches(adopted.model, notice.modelId)) return;
              toast.info(t('chatInput.modePolicyUpdated', { model: notice.modelName }));
              markModePolicyNotified(task.id);
            } catch {
              /* 可选提示失败不得改变发送结果或覆盖原始发送异常 */
            }
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
    // B 块单飞门用（`getTaskSessionKeys(activeTask, activeRoom)`；判据与托盘同源）。
    activeRoom,
    // ⚠️ `pendingNewTask` **不在这个依赖数组里**：首轮产物索引切断后（2026-10-07 · 区 3），
    //    handleSend 体内已不再读它（离线判定/当前模型/思考档位那几处在 hook 顶层，各自成依赖）。
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
    i18n,
    onComposerCleared,
    modelCatalog,
    currentModel,
    currentThinking,
    currentMode,
    imageInputSupport,
    patchSessionModel,
    updateTaskMetadata,
    materialByteBudget,
  ]);

  /**
   * 选了一个**具体模型**（高级：指定模型）⇒ 模式落到 `custom`。
   *
   * 这是"三档 ↔ 高级"两个层级之间唯一的耦合点：选了具体模型就不再是三档任务
   *（否则发送时会被 MODE_POLICY 顶掉，用户刚点的模型等于没说）。
   */
  const handleModelQuickSend = useCallback(
    (modelId: string) => {
      if (!activeTask) {
        useTaskStore.getState().updatePending({ mode: 'custom', model: modelId });
        return;
      }
      const ta = textareaRef.current;
      if (!ta) return;
      updateTaskMetadata(activeTask.id, {
        mode: 'custom',
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

  /**
   * 选了快速 / 智能 / 深度 ⇒ 只写模式，**不立刻发消息**。
   *
   * 与选模型那条路的关键差别：模式在**下一轮发送**由 `presetModel`/`presetThinking`
   * 生效（composer 每轮都会把模型钉到会话上），不需要像 `/model` 那样当场打一次网关。
   * 三档之间切换也不需要在任务上留 `model` 覆盖 —— 发送路径按模式现解析（单一真源）。
   */
  const handleModeQuickSend = useCallback(
    (mode: TaskMode) => {
      if (!activeTask) {
        useTaskStore.getState().updatePending({ mode });
        return;
      }
      updateTaskMetadata(activeTask.id, { mode });
    },
    [activeTask, updateTaskMetadata],
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
    const target = defaultModel?.id ?? currentModel;
    // 两个都取不到 = 目录空且任务没钉模型，没有可切的目标 —— 与旧行为一致：直接报失败。
    const ok = target ? await patchSessionModel(task, target) : false;
    if (ok) {
      toast.success(t('usage.degradeDone'));
    } else {
      toast.error(t('errors.requestFailed'));
    }
  }, [currentModel, defaultModel?.id, patchSessionModel, t]);

  const handleToolSelect = useCallback(
    (tool: EffectiveToolEntry) => {
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
    gatewayDisplayPhase,
    activeTask,
    currentModel,
    currentThinking,
    modelCatalog,
    modelAvailability,
    toolsCatalog,
    effectiveToolsState,
    modelLabel,
    currentModelEntry,
    modelsByProvider,
    currentMode,
    pendingNewTask: pendingNewTask as PendingNewTask | null,
    taskGwId,
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
  };
}
