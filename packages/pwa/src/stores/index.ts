import {
  createMessageStore,
  createTaskStore,
  createUiStore,
  createChatComposer,
  createSessionSync,
  createGatewayDispatcher,
} from '@clawwork/core';
import type { PlatformPorts, ChatComposer } from '@clawwork/core';
import type { ModelCatalogEntry, AgentInfo, DebugEvent, ExecApprovalRequest } from '@clawwork/shared';
import { ports } from '../platform/index.js';
import { getIdentity } from '../persistence/db.js';
import { getClient } from '../gateway/client-registry.js';
import { reportDebugEvent } from '../lib/debug.js';
import { useQuestionStore, bindQuestionTaskLookup } from './questionStore.js';
import { useApprovalStore, bindApprovalTaskLookup, bindApprovalUi } from './approvalStore.js';
import { THEME_STORAGE_KEY } from '../lib/constants.js';
import i18next from 'i18next';
import { toast } from 'sonner';

function getPorts(): PlatformPorts {
  return ports;
}

const localStorageAdapter = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      reportDebugEvent({
        level: 'warn',
        domain: 'renderer',
        event: 'settings.storage.get.failed',
        data: { key },
        error: { message: err instanceof Error ? err.message : 'storage get failed' },
      });
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      reportDebugEvent({
        level: 'warn',
        domain: 'renderer',
        event: 'settings.storage.set.failed',
        data: { key },
        error: { message: err instanceof Error ? err.message : 'storage set failed' },
      });
    }
  },
};

const uiStoreApi = createUiStore({
  updateSettings: (partial) =>
    getPorts().settings.updateSettings(partial as Parameters<PlatformPorts['settings']['updateSettings']>[0]),
  changeLanguage: (lang) => {
    i18next.changeLanguage(lang);
  },
  storage: localStorageAdapter,
  getViewportWidth: () => (typeof window !== 'undefined' ? window.innerWidth : 0),
});

const storedTheme = localStorageAdapter.get(THEME_STORAGE_KEY);
if (storedTheme === 'dark' || storedTheme === 'light') {
  uiStoreApi.setState({ theme: storedTheme });
}

const messageStoreApi = createMessageStore({
  persistMessage: (...args) => getPorts().persistence.persistMessage(...args),
});

const taskStoreApi = createTaskStore({
  persistTask: (...args) => getPorts().persistence.persistTask(...args),
  persistTaskUpdate: (...args) => getPorts().persistence.persistTaskUpdate(...args),
  deleteTask: (...args) => getPorts().persistence.deleteTask(...args),
  loadTasks: () => getPorts().persistence.loadTasks(),
  patchSession: (...args) => getPorts().gateway.patchSession(...args),
  getDeviceId: async () => {
    const identity = await getIdentity();
    if (!identity) throw new Error('Device identity not found');
    return identity.id;
  },
  getDefaultGatewayId: () => uiStoreApi.getState().defaultGatewayId,
  getAgentCatalog: (gatewayId) => {
    const entry = uiStoreApi.getState().agentCatalogByGateway[gatewayId];
    // ⚠️ 没加载 ⇒ **`undefined`**，不是"空目录"：这两者 core 必须分得开（见 `TaskStoreDeps`）。
    return entry ? { agents: entry.agents, defaultId: entry.defaultId } : undefined;
  },
  // 任务删除 ⇒ 顺手清掉它的消息（区 3 问题 10；与 desktop 宿主同一接线）。
  clearTaskMessages: (taskId) => messageStoreApi.getState().clearMessages(taskId),
  onTaskCreated: () => uiStoreApi.getState().setMainView('chat'),
});

// 询问面板要靠 sessionKey 反查任务：能力从这里注入，避免 questionStore ⇄ index 成环
bindQuestionTaskLookup(
  (sessionKey) => taskStoreApi.getState().tasks.find((task) => task.sessionKey === sessionKey)?.id ?? null,
);

// 审批面板同款注入（审批到达时任务可能还没同步，认不出任务也要照常显示）
bindApprovalTaskLookup(
  (sessionKey) => taskStoreApi.getState().tasks.find((task) => task.sessionKey === sessionKey)?.id ?? null,
);
bindApprovalUi({
  activeTaskId: () => taskStoreApi.getState().activeTaskId,
  markUnread: (taskId) => uiStoreApi.getState().markUnread(taskId),
  clearUnread: (taskId) => uiStoreApi.getState().clearUnread(taskId),
});

uiStoreApi.subscribe((state, prevState) => {
  if (state.defaultGatewayId === prevState.defaultGatewayId) return;
  const gatewayId = state.defaultGatewayId;
  if (!gatewayId) return;
  const entry = state.agentCatalogByGateway[gatewayId];
  const agentId = entry?.defaultId;
  if (!agentId) return;
  const pending = taskStoreApi.getState().pendingNewTask;
  if (!pending) return;
  if (pending.gatewayId !== gatewayId) return;
  if (pending.agentId === agentId) return;
  taskStoreApi.setState({ pendingNewTask: { gatewayId, agentId } });
});

export const sessionSync = createSessionSync({
  persistence: {
    loadMessages: (taskId) => getPorts().persistence.loadMessages(taskId),
    persistMessage: (...args) => getPorts().persistence.persistMessage(...args),
  },
  gateway: {
    chatHistory: (...args) => getPorts().gateway.chatHistory(...args),
    syncSessions: () => getPorts().gateway.syncSessions(),
  },
  getTaskStore: () => taskStoreApi.getState(),
  getMessageStore: () => ({
    ...messageStoreApi.getState(),
    setState: messageStoreApi.setState,
  }),
});

let _dispatcher: ReturnType<typeof createGatewayDispatcher> | null = null;
let hydrationReady: Promise<void> | null = null;

function ensureHydrationReady(): Promise<void> {
  if (!hydrationReady) {
    hydrationReady = sessionSync.hydrateFromLocal();
  }
  return hydrationReady;
}

function getDispatcher() {
  if (!_dispatcher) {
    _dispatcher = createGatewayDispatcher({
      gateway: getPorts().gateway,
      getSettings: () => getPorts().settings.getSettings(),
      sendNotification: (params) => getPorts().notifications.sendNotification(params),
      getTaskStore: () => taskStoreApi.getState(),
      getMessageStore: () => messageStoreApi.getState(),
      getActiveTaskId: () => taskStoreApi.getState().activeTaskId,
      markUnread: (taskId) => uiStoreApi.getState().markUnread(taskId),
      setGatewayStatusByGateway: (gwId, status) => uiStoreApi.getState().setGatewayStatusByGateway(gwId, status),
      setGatewayVersion: (gwId, version) => uiStoreApi.getState().setGatewayVersion(gwId, version),
      setGatewayReconnectInfo: (gwId, info) => uiStoreApi.getState().setGatewayReconnectInfo(gwId, info),
      setDefaultGatewayId: (id) => uiStoreApi.getState().setDefaultGatewayId(id),
      setGatewayInfoMap: (map) => uiStoreApi.getState().setGatewayInfoMap(map),
      setGatewaysLoaded: (loaded) => uiStoreApi.getState().setGatewaysLoaded(loaded),
      getGatewayInfoMap: () => uiStoreApi.getState().gatewayInfoMap,
      setModelCatalogForGateway: (gwId, models) =>
        uiStoreApi.getState().setModelCatalogForGateway(gwId, models as ModelCatalogEntry[]),
      setModelCatalogFailureForGateway: (gwId, failed) =>
        uiStoreApi.getState().setModelCatalogFailureForGateway(gwId, failed),
      setAgentCatalogForGateway: (gwId, agents, defaultId) =>
        uiStoreApi.getState().setAgentCatalogForGateway(gwId, agents as AgentInfo[], defaultId),
      setToolsCatalogForGateway: (gwId, catalog) => uiStoreApi.getState().setToolsCatalogForGateway(gwId, catalog),
      setEffectiveToolsState: (gwId, sessionKey, state) =>
        uiStoreApi.getState().setEffectiveToolsState(gwId, sessionKey, state),
      setSkillsStatusForGateway: (gwId, report) => uiStoreApi.getState().setSkillsStatusForGateway(gwId, report),
      setCommandCatalogForGateway: (gwId, commands) =>
        uiStoreApi.getState().setCommandCatalogForGateway(gwId, commands),
      notifyAgentResponse: (sessionKey) => getComposer().notifyResponse(sessionKey),
      onQuestionRequested: (gatewayId, payload) => useQuestionStore.getState().addQuestion(gatewayId, payload),
      onQuestionResolved: (id) => useQuestionStore.getState().removeQuestion(id),
      // exec 审批：事件经审批副连接（caps=['exec-approvals']）到达，这里接进 store。
      // 副连接只放行 exec.approval.requested/resolved（client.ts 过滤），不会与主连接重复。
      onApprovalRequested: (gatewayId, payload) =>
        useApprovalStore.getState().addApproval(gatewayId, payload as ExecApprovalRequest),
      onApprovalResolved: (conclusion) =>
        useApprovalStore.getState().removeApproval(conclusion.gatewayId, conclusion.id),
      translate: (key, opts) => i18next.t(key, opts),
      isWindowFocused: () => typeof document !== 'undefined' && document.hasFocus(),
      reportDebugEvent: (event) => reportDebugEvent(event as Partial<DebugEvent>),
      hydrateFromLocal: () => ensureHydrationReady(),
      syncFromGateway: () => sessionSync.syncFromGateway(),
      syncSessionMessages: (taskId, sessionKey, lateTool) =>
        sessionSync.syncSessionMessages(taskId, sessionKey, lateTool),
      retrySyncPending: () => sessionSync.retrySyncPending(),
    });
  }
  return _dispatcher;
}

export const dispatcher = new Proxy({} as ReturnType<typeof createGatewayDispatcher>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDispatcher(), prop, receiver);
  },
});

let _composer: ChatComposer | null = null;

function getComposer(): ChatComposer {
  if (!_composer) {
    _composer = createChatComposer({
      gateway: getPorts().gateway,
      getTaskStore: () => taskStoreApi.getState(),
      getMessageStore: () => messageStoreApi.getState(),
      persistMessage: (...args) => getPorts().persistence.persistMessage(...args),
      markAbortedByUser: (taskId) => getDispatcher().markAbortedByUser(taskId),
      beginDispatch: (gatewayId, sessionKey) => getDispatcher().beginDispatch(gatewayId, sessionKey),
      settleDispatch: (ticket, receipt, accepted) => getDispatcher().settleDispatch(ticket, receipt, accepted),
      compactSession: (gwId, sk) => {
        const c = getClient(gwId);
        if (!c) return Promise.resolve({ ok: false, error: 'Gateway not found' });
        return c
          .compactSession(sk)
          .then(() => ({ ok: true as const }))
          .catch((err: Error) => ({ ok: false as const, error: err.message }));
      },
      resetSession: (gwId, sk, mode) => {
        const c = getClient(gwId);
        if (!c) return Promise.resolve({ ok: false, error: 'Gateway not found' });
        return c
          .resetSession(sk, mode)
          .then(() => ({ ok: true as const }))
          .catch((err: Error) => ({ ok: false as const, error: err.message }));
      },
      getModelProvider: (gwId, modelId) => {
        const catalog = uiStoreApi.getState().modelCatalogByGateway[gwId];
        return catalog?.find((m) => m.id === modelId)?.provider;
      },
      translate: (key, opts) => i18next.t(key, opts),
      onError: (payload) => {
        toast.error(payload.title, { description: payload.description });
      },
    });
  }
  return _composer;
}

export const composer = new Proxy({} as ChatComposer, {
  get(_target, prop, receiver) {
    return Reflect.get(getComposer(), prop, receiver);
  },
});

export { uiStoreApi, messageStoreApi, taskStoreApi, ensureHydrationReady };
