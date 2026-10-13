import { useStore } from 'zustand';
import {
  createMessageStore,
  createTaskStore,
  createUiStore,
  createRoomStore,
  createTeamStore,
  createChatComposer,
  createSystemSessionStore,
  createSystemSessionService,
} from '@clawwork/core';
import type {
  MessageState,
  TaskState,
  UiState,
  RoomState,
  TeamState,
  PlatformPorts,
  ChatComposer,
  ChatComposerDeps,
  SystemSessionState,
  SystemSessionService,
} from '@clawwork/core';
import { sanitizeForLog } from '@clawwork/shared';
import { toast } from '@/lib/toast';
import { resolveTaskAgentName } from '@/lib/task-agent-name';
import { createElectronPorts } from './electron-adapter';
import i18n from '../i18n';
import { thinkingLevelsFor } from '../components/ChatInput/thinking-levels';
import { syncSettingsUpdate, useSettingsStore } from '../stores/settingsStore';
import { computerAccessApplied, createComputerAccessDep } from '../lib/computer-access-runtime';

let _ports: PlatformPorts | null = null;

function getPorts(): PlatformPorts {
  if (!_ports) _ports = createElectronPorts();
  return _ports;
}

export const ports = new Proxy({} as PlatformPorts, {
  get(_target, prop, receiver) {
    return Reflect.get(getPorts(), prop, receiver);
  },
});

const localStorageAdapter = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

const uiStoreApi = createUiStore({
  updateSettings: async (partial) => {
    const typedPartial = partial as Parameters<PlatformPorts['settings']['updateSettings']>[0];
    const result = await getPorts().settings.updateSettings(typedPartial);
    syncSettingsUpdate(typedPartial, result);
    return result;
  },
  changeLanguage: (lang) => i18n.changeLanguage(lang),
  onRebuildMenu: () => window.clawwork.rebuildMenu(),
  storage: localStorageAdapter,
  getViewportWidth: () => (typeof window !== 'undefined' ? window.innerWidth : 0),
});

const messageStoreApi = createMessageStore({
  persistMessage: (...args) => getPorts().persistence.persistMessage(...args),
  // ⭐ V4（I 接线）：被归约**接受**的执行状态边缘喂给有界历史 writer（fire-and-forget）；
  //    脱敏用公共规则（日志/导出的同一份 `sanitizeForLog`）。
  persistExecutionHistory: (sessionKey, records) => window.clawwork?.executionHistoryAppend?.(sessionKey, [...records]),
  sanitizeHistoryText: (text) => sanitizeForLog(text),
});

const taskStoreApi = createTaskStore({
  persistTask: (...args) => getPorts().persistence.persistTask(...args),
  persistTaskUpdate: (...args) => getPorts().persistence.persistTaskUpdate(...args),
  deleteTask: (...args) => getPorts().persistence.deleteTask(...args),
  loadTasks: () => getPorts().persistence.loadTasks(),
  patchSession: (...args) => getPorts().gateway.patchSession(...args),
  getDeviceId: () => window.clawwork.getDeviceId(),
  getDefaultGatewayId: () => uiStoreApi.getState().defaultGatewayId,
  getAgentCatalog: (gatewayId) => {
    const entry = uiStoreApi.getState().agentCatalogByGateway[gatewayId];
    // ⚠️ 没加载 ⇒ **`undefined`**，不是"空目录"：这两者 core 必须分得开（见 `TaskStoreDeps`）。
    return entry ? { agents: entry.agents, defaultId: entry.defaultId } : undefined;
  },
  // 任务删除 ⇒ 顺手清掉它的消息（区 3 问题 10；UI 那条路也会清，幂等）。
  clearTaskMessages: (taskId) => messageStoreApi.getState().clearMessages(taskId),
  onTaskCreated: () => uiStoreApi.getState().setMainView('chat'),
});

const teamStoreApi = createTeamStore({
  listTeams: () => window.clawwork.listTeams(),
  getTeam: (id) => window.clawwork.getTeam(id),
  persistTeam: (team) => window.clawwork.persistTeam(team),
  deleteTeam: (id) => window.clawwork.deleteTeam(id),
});

/**
 * `agentId` → 展示名（**目录优先**，查不到返回 `undefined`）。
 *
 * T-a7 家族每一个"要显示 worker 名字"的面都走这一份：写快照、给 conductor 那句
 * 「用户 @ 了谁」。规则本体在 `lib/task-agent-name.ts`（两步查找：taskId → 网关 → 目录），
 * 这里只是把"当前状态"喂给它 —— **不在调用点上重写一遍优先级**。
 */
function lookupAgentName(taskId: string, agentId: string): string | undefined {
  return resolveTaskAgentName({
    tasks: taskStoreApi.getState().tasks,
    agentsForGateway: (gwId) => uiStoreApi.getState().agentCatalogByGateway[gwId]?.agents,
    taskId,
    agentId,
  });
}

const roomStoreApi = createRoomStore({
  createSession: (gwId, params) => window.clawwork.createSession(gwId, params),
  abortChat: (gwId, sk) => getPorts().gateway.abortChat(gwId, sk),
  listSessionsBySpawner: (gwId, spawnerKey) => getPorts().gateway.listSessionsBySpawner(gwId, spawnerKey),
  persistRoom: (params) => window.clawwork.persistRoom(params),
  persistPerformer: (params) => window.clawwork.persistPerformer(params),
  loadRoom: (taskId) => window.clawwork.loadRoom(taskId),
  // 写 `RoomPerformer.agentName` 快照时问一次目录（T-a7 的写入方那一半）：
  // 问不到就返回 undefined，core 那边降级成裸 agentId。
  resolveAgentName: lookupAgentName,
});

export const composerBridge = {
  markAbortedByUser: (_taskId: string): void => {},
  beginDispatch: ((_gatewayId, _sessionKey) => {
    throw new Error('Gateway dispatcher is not initialized');
  }) as NonNullable<ChatComposerDeps['beginDispatch']>,
  settleDispatch: ((_ticket, _receipt, _accepted) => {
    throw new Error('Gateway dispatcher is not initialized');
  }) as NonNullable<ChatComposerDeps['settleDispatch']>,
};

let _composer: ChatComposer | null = null;

function getComposer(): ChatComposer {
  if (!_composer) {
    _composer = createChatComposer({
      gateway: getPorts().gateway,
      getTaskStore: () => taskStoreApi.getState(),
      getMessageStore: () => messageStoreApi.getState(),
      persistMessage: (...args) => getPorts().persistence.persistMessage(...args),
      markAbortedByUser: (taskId) => composerBridge.markAbortedByUser(taskId),
      beginDispatch: (gatewayId, sessionKey) => composerBridge.beginDispatch(gatewayId, sessionKey),
      settleDispatch: (ticket, receipt, accepted) => composerBridge.settleDispatch(ticket, receipt, accepted),
      compactSession: (gwId, sk) => window.clawwork.compactSession(gwId, sk),
      resetSession: (gwId, sk, mode) => window.clawwork.resetSession(gwId, sk, mode as 'new' | 'reset'),
      getModelProvider: (gwId, modelId) => {
        const catalog = uiStoreApi.getState().modelCatalogByGateway[gwId];
        return catalog?.find((m) => m.id === modelId)?.provider;
      },
      // 档位是逐模型的（目录里每行带 `thinkingLevels`）。**目录里找不到这个模型
      // 就返回 undefined** —— 对 composer 而言那是「还不知道」，它会照发不误；
      // 若返回空数组就变成「确定一个都不支持」，会把用户选的档位悄悄抹掉。
      getSupportedThinkingLevels: (gwId, modelId) => {
        const entry = uiStoreApi.getState().modelCatalogByGateway[gwId]?.find((m) => m.id === modelId);
        if (!entry) return undefined;
        return thinkingLevelsFor(entry as never);
      },
      getRoomState: (taskId) => roomStoreApi.getState().rooms[taskId],
      setRoomStatus: (taskId, status) => roomStoreApi.getState().setRoomStatus(taskId, status),
      // 给 conductor 那句「用户 @ 了谁」用的名字（T-a7 第四个面）：同一份目录优先规则。
      resolveAgentName: lookupAgentName,
      // 「电脑操控权限」两档（spec §2.5）。**现读设置**、不缓存快照：
      // 用户在设置里一关，下一条消息就该按新档位走。
      computerAccess: createComputerAccessDep({
        readTier: () => useSettingsStore.getState().settings?.computerAccess,
        applied: computerAccessApplied,
      }),
      translate: (key, opts) => i18n.t(key, opts),
      onError: (toastMsg) => toast.error(toastMsg.title, { description: toastMsg.description }),
    });
  }
  return _composer;
}

export const composer = new Proxy({} as ChatComposer, {
  get(_target, prop, receiver) {
    return Reflect.get(getComposer(), prop, receiver);
  },
});

/**
 * 裸 store 实例（非 hook）。
 *
 * 给「需要在事件处理器里同步读一份状态快照」的场景用 —— 例如多模型对比要在
 * 点击「发送」那一刻就拿到当前消息/任务状态。React 组件里请用 `useMessageStore` /
 * `useTaskStore`（会订阅更新）。
 */
export const messageStore = messageStoreApi;
export const taskStore = taskStoreApi;

export function useMessageStore(): MessageState;
export function useMessageStore<T>(selector: (state: MessageState) => T): T;
export function useMessageStore<T>(selector?: (state: MessageState) => T) {
  return useStore(messageStoreApi, selector!);
}
useMessageStore.getState = messageStoreApi.getState;
useMessageStore.setState = messageStoreApi.setState;
useMessageStore.subscribe = messageStoreApi.subscribe;

export function useTaskStore(): TaskState;
export function useTaskStore<T>(selector: (state: TaskState) => T): T;
export function useTaskStore<T>(selector?: (state: TaskState) => T) {
  return useStore(taskStoreApi, selector!);
}
useTaskStore.getState = taskStoreApi.getState;
useTaskStore.setState = taskStoreApi.setState;
useTaskStore.subscribe = taskStoreApi.subscribe;

export function useUiStore(): UiState;
export function useUiStore<T>(selector: (state: UiState) => T): T;
export function useUiStore<T>(selector?: (state: UiState) => T) {
  return useStore(uiStoreApi, selector!);
}
useUiStore.getState = uiStoreApi.getState;
useUiStore.setState = uiStoreApi.setState;
useUiStore.subscribe = uiStoreApi.subscribe;

export function useRoomStore(): RoomState;
export function useRoomStore<T>(selector: (state: RoomState) => T): T;
export function useRoomStore<T>(selector?: (state: RoomState) => T) {
  return useStore(roomStoreApi, selector!);
}
useRoomStore.getState = roomStoreApi.getState;
useRoomStore.setState = roomStoreApi.setState;
useRoomStore.subscribe = roomStoreApi.subscribe;

export function useTeamStore(): TeamState;
export function useTeamStore<T>(selector: (state: TeamState) => T): T;
export function useTeamStore<T>(selector?: (state: TeamState) => T) {
  return useStore(teamStoreApi, selector!);
}
useTeamStore.getState = teamStoreApi.getState;
useTeamStore.setState = teamStoreApi.setState;
useTeamStore.subscribe = teamStoreApi.subscribe;

const systemSessionStoreApi = createSystemSessionStore();

let _systemSessionService: SystemSessionService | null = null;

function getSystemSessionService(): SystemSessionService {
  if (!_systemSessionService) {
    _systemSessionService = createSystemSessionService({
      gateway: getPorts().gateway,
      getStore: () => systemSessionStoreApi.getState(),
    });
  }
  return _systemSessionService;
}

export const systemSessionService = new Proxy({} as SystemSessionService, {
  get(_target, prop, receiver) {
    return Reflect.get(getSystemSessionService(), prop, receiver);
  },
});

export function useSystemSessionStore(): SystemSessionState;
export function useSystemSessionStore<T>(selector: (state: SystemSessionState) => T): T;
export function useSystemSessionStore<T>(selector?: (state: SystemSessionState) => T) {
  return useStore(systemSessionStoreApi, selector!);
}
