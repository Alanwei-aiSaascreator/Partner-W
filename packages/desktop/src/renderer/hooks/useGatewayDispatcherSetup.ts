import { createGatewayDispatcher } from '@clawwork/core';
import type { ExecApprovalRequest, ModelCatalogEntry, AgentInfo } from '@clawwork/shared';
import { parseAgentIdFromSessionKey, parseTaskIdFromSessionKey } from '@clawwork/shared';
import { toast } from '@/lib/toast';
import { hydrateFromLocal, retrySyncPending, syncFromGateway, syncSessionMessages } from '../lib/session-sync';
import i18n from '../i18n';
import { composer, composerBridge, ports, useMessageStore, useTaskStore, useUiStore, useRoomStore } from '../platform';
import { useApprovalStore } from '../stores/approvalStore';
import { useQuestionStore } from '../stores/questionStore';
import { compareStore } from '../features/compare/compare-store-instance';

export type GatewayDispatcher = ReturnType<typeof createGatewayDispatcher>;

let dispatcher: GatewayDispatcher | null = null;

function handlePerformerCandidate(taskId: string, sessionKey: string): void {
  if (useRoomStore.getState().lookupTaskIdBySubagentKey(sessionKey)) return;

  const room = useRoomStore.getState().rooms[taskId];
  if (!room || room.status === 'stopped') return;

  const agentId = parseAgentIdFromSessionKey(sessionKey);
  // ⚠️ 从前这里传的是 `agentId, agentId` —— 第二个参数就是 T-a7 那个 bug 的一半：
  // 快照里存的是裸 id，不是「爆款内容教练」。名字现在由 store 统一解析
  // （见 `createRoomStore` 的 `deps.resolveAgentName`），**写入方不再自己拼名字**。
  useRoomStore.getState().registerPerformerKey(taskId, sessionKey, agentId);
  void syncSessionMessages(taskId, sessionKey).catch((err) => {
    console.error('[performer] syncSessionMessages failed:', err);
  });
}

function handleSubagentCandidate(sessionKey: string, gatewayId: string): void {
  const tasks = useTaskStore.getState().tasks;
  const ensembleTasks = tasks.filter((task) => task.ensemble && task.gatewayId === gatewayId);
  if (ensembleTasks.length === 0) return;

  for (const task of ensembleTasks) {
    const room = useRoomStore.getState().rooms[task.id];
    if (!room || room.status === 'stopped') continue;

    void useRoomStore
      .getState()
      .verifyCandidates(task.id, task.gatewayId)
      .then(() => {
        if (useRoomStore.getState().lookupTaskIdBySubagentKey(sessionKey) === task.id) {
          return syncSessionMessages(task.id, sessionKey);
        }
        return undefined;
      })
      .catch((err) => {
        console.error('[subagent] verifyCandidates or syncSessionMessages failed:', err);
      });
  }
}

function handleApprovalRequested(gatewayId: string, payload: unknown): void {
  const approvalReq = payload as ExecApprovalRequest;
  useApprovalStore.getState().addApproval(gatewayId, approvalReq);
  toast.warning(i18n.t('approval.newRequest'));

  const approvalSessionKey = approvalReq.request?.sessionKey;
  const approvalTaskId = approvalSessionKey ? parseTaskIdFromSessionKey(approvalSessionKey) : null;
  if (approvalTaskId && (!document.hasFocus() || useTaskStore.getState().activeTaskId !== approvalTaskId)) {
    ports.settings
      .getSettings()
      .then((settings) => {
        if (settings?.notifications?.approvalRequest === false) return;
        ports.notifications.sendNotification({
          title: i18n.t('notifications.approvalRequired'),
          body: approvalReq.request?.commandPreview || approvalReq.request?.command || '',
          taskId: approvalTaskId,
        });
      })
      .catch((err) => {
        console.error('[approval] Failed to get settings or send notification:', err);
      });
  }
}

function getDispatcher(): GatewayDispatcher {
  if (!dispatcher) {
    dispatcher = createGatewayDispatcher({
      gateway: ports.gateway,
      getSettings: ports.settings.getSettings,
      sendNotification: (params) => ports.notifications.sendNotification(params),

      getTaskStore: () => useTaskStore.getState(),
      getMessageStore: () => useMessageStore.getState(),

      getActiveTaskId: () => useTaskStore.getState().activeTaskId,
      markUnread: (taskId) => useUiStore.getState().markUnread(taskId),

      setGatewayStatusByGateway: (gatewayId, status) =>
        useUiStore.getState().setGatewayStatusByGateway(gatewayId, status),
      setGatewayVersion: (gatewayId, version) => useUiStore.getState().setGatewayVersion(gatewayId, version),
      setGatewayReconnectInfo: (gatewayId, info) => useUiStore.getState().setGatewayReconnectInfo(gatewayId, info),
      setRuntimeBootstrapFailure: (reason) => useUiStore.getState().setRuntimeBootstrapFailure(reason),
      setDefaultGatewayId: (id) => useUiStore.getState().setDefaultGatewayId(id),
      setGatewayInfoMap: (map) => useUiStore.getState().setGatewayInfoMap(map),
      setGatewaysLoaded: (loaded) => useUiStore.getState().setGatewaysLoaded(loaded),
      getGatewayInfoMap: () => useUiStore.getState().gatewayInfoMap,

      setModelCatalogForGateway: (gatewayId, models) =>
        useUiStore.getState().setModelCatalogForGateway(gatewayId, models as ModelCatalogEntry[]),
      setModelCatalogFailureForGateway: (gatewayId, failed) =>
        useUiStore.getState().setModelCatalogFailureForGateway(gatewayId, failed),
      setAgentCatalogForGateway: (gatewayId, agents, defaultId) =>
        useUiStore.getState().setAgentCatalogForGateway(gatewayId, agents as AgentInfo[], defaultId),
      setToolsCatalogForGateway: (gatewayId, catalog) =>
        useUiStore.getState().setToolsCatalogForGateway(gatewayId, catalog),
      setEffectiveToolsState: (gatewayId, sessionKey, state) =>
        useUiStore.getState().setEffectiveToolsState(gatewayId, sessionKey, state),
      setSkillsStatusForGateway: (gatewayId, report) =>
        useUiStore.getState().setSkillsStatusForGateway(gatewayId, report),
      setCommandCatalogForGateway: (gatewayId, commands) =>
        useUiStore.getState().setCommandCatalogForGateway(gatewayId, commands),

      lookupTaskIdBySubagentKey: (key) => useRoomStore.getState().lookupTaskIdBySubagentKey(key),
      onPerformerCandidate: (taskId, sessionKey) => handlePerformerCandidate(taskId, sessionKey),
      onSubagentCandidate: (sessionKey, gatewayId) => handleSubagentCandidate(sessionKey, gatewayId),
      onApprovalRequested: handleApprovalRequested,
      onApprovalResolved: (id) => {
        useApprovalStore.getState().removeApproval(id);
      },
      onQuestionRequested: (gatewayId, request) => useQuestionStore.getState().addQuestion(gatewayId, request),
      onQuestionResolved: (id) => useQuestionStore.getState().removeQuestion(id),
      syncPendingQuestions: (gatewayId) => {
        // 断线 / 重启用期间挂起的问题不会补发事件，必须主动对账（见 store.reconcileQuestions）
        void window.clawwork
          .listQuestions(gatewayId)
          .then((res) => {
            if (!res.ok || !res.result) return;
            const list = (res.result as { questions?: unknown[] }).questions;
            useQuestionStore.getState().reconcileQuestions(gatewayId, Array.isArray(list) ? list : []);
          })
          .catch(() => {});
      },
      notifyAgentResponse: (sessionKey) => composer.notifyResponse(sessionKey),
      // 多模型对比的临时列：事件照常收、照样流式，但**不写进对话时间线**（不要标题、
      // 不要未读、不要系统提示、不要通知），失败也只落在那一列自己身上。
      // 动态判 —— 采纳之后赢家转正，就不再是临时会话了。
      isEphemeralSession: (sessionKey) => compareStore().getState().isEphemeral(sessionKey),
      // 「这一轮是用户自己中断的吗」——按**会话**判。对比的列走的是 compare-store 自己的
      // abort 动作，打不到 task 级的 `abortedByUser`；而它的登记表在 `deleteSession` 成功那一刻
      // 就摘键了（那之后这一帧看着像普通会话），所以标记必须在 compare-store 里按会话记。
      // 少这一条的表现：用户点「取消对比 / 采纳」之后，迟到的 aborted 帧会把一句话写进对话时间线、
      // 还把任务标未读、弹通知。
      isSessionAbortedByUser: (sessionKey) => compareStore().getState().wasAbortedByUser(sessionKey),
      onToast: (type, title, opts) => {
        if (type === 'error') toast.error(title, opts);
        else if (type === 'warning') toast.warning(title, opts);
        else if (type === 'success') toast.success(title);
      },
      translate: (key, opts) => i18n.t(key, opts),
      isWindowFocused: () => document.hasFocus(),
      reportDebugEvent: (event) => window.clawwork.reportDebugEvent(event),

      hydrateFromLocal,
      syncFromGateway,
      syncSessionMessages,
      retrySyncPending,
    });
    composerBridge.markAbortedByUser = (taskId) => dispatcher!.markAbortedByUser(taskId);
  }

  return dispatcher;
}

export function useGatewayDispatcherSetup(): GatewayDispatcher {
  return getDispatcher();
}

export async function fetchAgentsForGateway(gatewayId: string, options: { force?: boolean } = {}): Promise<void> {
  const agentCatalog = useUiStore.getState().agentCatalogByGateway;
  return getDispatcher().fetchAgentsForGateway(gatewayId, agentCatalog, options);
}

export async function reinitializeGatewayBootstrap(): Promise<void> {
  const d = getDispatcher();
  d.reset();
  await d.initialize();
}
