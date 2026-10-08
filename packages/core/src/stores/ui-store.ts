import { createStore } from 'zustand/vanilla';
import type {
  AgentInfo,
  CommandEntry,
  EffectiveToolsLoadState,
  GatewayFailureReason,
  ModelCatalogEntry,
  SkillStatusReport,
  ToolsCatalog,
} from '@clawwork/shared';

/**
 * 一个网关的重连状况（`ui-store.gatewayReconnectInfo[gatewayId]`）。
 *
 * `reason` 缺席 = **还没有结论**（普通断线、还在重连）—— 不是"没问题"。
 */
export interface GatewayReconnectInfo {
  attempt: number;
  max: number;
  gaveUp: boolean;
  reason?: GatewayFailureReason | undefined;
}

export type MainView =
  | 'chat'
  /** 最近任务 —— 全量任务列表（搜索 / 状态筛选 / 跨助手）。
   *  2026-09-20 用户点名：原来它是**左列最下面那一块**（只 5 条、"显示也不全"），
   *  改成导航入口（放在「身份中心」上面）+ 这个右侧面板。 */
  | 'tasks'
  | 'files'
  | 'archived'
  | 'cron'
  | 'teams'
  | 'dashboard'
  | 'betaHub'
  | 'community'
  /** 需求悬赏 —— 与 `community` 同一个面板、不同初始 tab（导航里是两个独立入口）。 */
  | 'bounty'
  | 'market'
  /** 技能市场 —— **我们自己的**随包技能（T-a2）。与设置里的「技能」是两个面：
   *  设置那页列网关自带的技能（开发者向），这页只列我们挑过、写过中文说明的。 */
  | 'skills'
  /** 创作者中心 —— 与 `market` 同一个面板、不同初始 tab。 */
  | 'creator'
  | 'growth'
  /** 身份中心。⚠️ 本版**只有排版**，没有数据/逻辑（见 `layouts/IdentityCenter/index.tsx` 文件头）。 */
  | 'identity'
  /** 资料库（工作区本地库 + 本地嵌入检索，T6）。 */
  | 'kb';
export type Theme = 'dark' | 'light' | 'auto';
export type DensityMode = 'compact' | 'comfortable' | 'spacious';
export type SendShortcut = 'enter' | 'cmdEnter';
export type MessageLayout = 'centered' | 'wide';
export type PanelShortcutLeft = 'Comma' | 'BracketLeft';
export type PanelShortcutRight = 'Period' | 'BracketRight';
export interface GatewayInfo {
  id: string;
  name: string;
  color?: string;
}

export type GatewayConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export interface GatewayState {
  status: GatewayConnectionStatus;
  version?: string;
  reconnectInfo?: { attempt: number; max: number; gaveUp: boolean };
  info: GatewayInfo;
  models: ModelCatalogEntry[];
  agents: { agents: AgentInfo[]; defaultId: string };
  tools: ToolsCatalog | null;
  skills: SkillStatusReport | null;
}

export interface UiState {
  rightPanelOpen: boolean;
  toggleRightPanel: () => void;
  setRightPanelOpen: (open: boolean) => void;

  mainView: MainView;
  setMainView: (view: MainView) => void;

  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  /**
   * 「打开设置时先落在哪一页」（`null` = 用默认页）。
   * ⚠️ 类型刻意是 `string | null`：页面枚举住在 desktop 渲染层，core 不该反向依赖它；
   *    渲染层读的时候自己做合法性校验（不认识的值必须忽略，否则会渲染出空白页）。
   */
  settingsSection: string | null;
  setSettingsSection: (section: string | null) => void;

  theme: Theme;
  setTheme: (theme: Theme) => void;

  density: DensityMode;
  setDensity: (density: DensityMode) => void;

  language: string;
  setLanguage: (lang: string) => void;

  gatewayStatusMap: Record<string, GatewayConnectionStatus>;
  setGatewayStatusByGateway: (gatewayId: string, status: GatewayConnectionStatus) => void;

  /**
   * **这一次运行里**这个网关成功连上过（缺席 = 从没连上过）。
   *
   * 与 `gatewayStatusMap` 是两件事：那是"此刻"，这是"历史"。首启预热期里两者会分叉 ——
   * 当前状态已经是 `disconnected`（真有过一次连接错误），但历史是"从没连上过"，
   * 那正说明我们还在启动窗口里（说"已断开"就是假话）。见 `gateway-display-phase.ts`。
   */
  gatewayEverConnected: Record<string, true>;

  gatewayRegistry: Record<string, GatewayState>;

  gatewayVersionMap: Record<string, string>;
  setGatewayVersion: (gatewayId: string, version: string | undefined) => void;

  /**
   * 网关**协商下来**的单帧字节上限（`hello-ok.policy.maxPayload`）。
   *
   * ⚠️ 缺席 = 没谈到（还在连接 / 旧网关）⇒ 发送字节预算回落默认值 —— 不是 0、不是无限。
   *    消费者是发送侧的预算推导（`deriveMaterialByteBudget`），**别拿它当展示字段**。
   * 语义与 `gatewayVersionMap` 对齐：`undefined` 清条目（连接参数跟着连接存亡）。
   */
  gatewayMaxPayloadByGateway: Record<string, number>;
  setGatewayMaxPayloadByGateway: (gatewayId: string, bytes: number | undefined) => void;

  /**
   * ⚠️ `reason`（有结论时的公开原因）**跟着重连信息一起存**：它描述的就是
   *    "这个网关连得怎么样"，与 `attempt` / `gaveUp` 是同一件事的不同侧面。
   *    缺席 = 还没有结论（普通断线、还在重连）—— 不是"没问题"。
   */
  gatewayReconnectInfo: Record<string, GatewayReconnectInfo>;
  setGatewayReconnectInfo: (gatewayId: string, info: GatewayReconnectInfo | null) => void;

  /**
   * 本机运行时（我们**自己**那个网关）起不来的公开原因（`null` = 没有这个结论）。
   *
   * ⚠️ 与 `gatewayReconnectInfo` 是两层事：那是"连上了没有"，这是"我们自己的网关
   *    进程压根没起来"。后者发生时往往连 WS 都没建起来，从连接层一个字都读不到 ——
   *    所以必须有这条独立的路，界面才说得出"18789 被别的程序占用"这类结论。
   */
  runtimeBootstrapFailure: GatewayFailureReason | null;
  setRuntimeBootstrapFailure: (reason: GatewayFailureReason | null) => void;

  gatewaysLoaded: boolean;
  setGatewaysLoaded: (loaded: boolean) => void;

  defaultGatewayId: string | null;
  setDefaultGatewayId: (id: string | null) => void;

  gatewayInfoMap: Record<string, GatewayInfo>;
  setGatewayInfoMap: (map: Record<string, GatewayInfo>) => void;

  unreadTaskIds: Set<string>;
  markUnread: (taskId: string) => void;
  clearUnread: (taskId: string) => void;

  hasUpdate: boolean;
  setHasUpdate: (has: boolean) => void;

  modelCatalogByGateway: Record<string, ModelCatalogEntry[]>;
  setModelCatalogForGateway: (gatewayId: string, models: ModelCatalogEntry[]) => void;

  /**
   * 模型目录**取不到**的标记（缺席 = 没失败）。与"目录为空"是两件事：
   * 空目录是**已解决**的结论（网关确实没给出可用模型），取不到是**没问出来**。
   * 界面把 `undefined` 目录读成"正在准备模型…"，所以取不到必须有自己的名字，
   * 否则用户会**永远**停在加载态（2026-09-20 用户报障）。
   */
  modelCatalogFailureByGateway: Record<string, true>;
  setModelCatalogFailureForGateway: (gatewayId: string, failed: boolean) => void;

  agentCatalogByGateway: Record<string, { agents: AgentInfo[]; defaultId: string }>;
  setAgentCatalogForGateway: (gatewayId: string, agents: AgentInfo[], defaultId: string) => void;

  toolsCatalogByGateway: Record<string, ToolsCatalog>;
  setToolsCatalogForGateway: (gatewayId: string, catalog: ToolsCatalog) => void;

  effectiveToolsByGateway: Record<string, Record<string, EffectiveToolsLoadState>>;
  setEffectiveToolsState: (gatewayId: string, sessionKey: string, state: EffectiveToolsLoadState) => void;

  skillsStatusByGateway: Record<string, SkillStatusReport>;
  setSkillsStatusForGateway: (gatewayId: string, report: SkillStatusReport) => void;

  commandCatalogByGateway: Record<string, CommandEntry[]>;
  setCommandCatalogForGateway: (gatewayId: string, commands: CommandEntry[]) => void;

  sendShortcut: SendShortcut;
  setSendShortcut: (shortcut: SendShortcut) => void;

  messageLayout: MessageLayout;
  setMessageLayout: (layout: MessageLayout) => void;
  toggleMessageLayout: () => void;

  searchFocusTrigger: number;
  focusSearch: () => void;

  getAgentsForGateway: (gatewayId: string) => { agents: AgentInfo[]; defaultId: string };

  selectedAgentByGateway: Record<string, string>;
  setSelectedAgent: (gatewayId: string, agentId: string) => void;
  getSelectedAgent: (gatewayId: string) => string | null;
  getSelectedAgentOrDefault: (gatewayId: string) => string;

  leftNavCollapsed: boolean;
  toggleLeftNavCollapsed: () => void;

  leftNavWidth: number;
  setLeftNavWidth: (w: number) => void;

  rightPanelWidth: number;
  setRightPanelWidth: (w: number) => void;

  leftNavShortcut: PanelShortcutLeft;
  setLeftNavShortcut: (s: PanelShortcutLeft) => void;

  rightPanelShortcut: PanelShortcutRight;
  setRightPanelShortcut: (s: PanelShortcutRight) => void;

  devMode: boolean;
  setDevMode: (enabled: boolean) => void;

  commandPaletteOpen: boolean;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleCommandPalette: () => void;
}

export interface UiStoreDeps {
  updateSettings: (partial: Record<string, unknown>) => Promise<unknown>;
  changeLanguage: (lang: string) => void;
  onRebuildMenu?: () => void;
  storage: {
    get: (key: string) => string | null;
    set: (key: string, value: string) => void;
  };
  getViewportWidth?: () => number;
}

const EMPTY_AGENT_CATALOG = { agents: [] as AgentInfo[], defaultId: '' };
const AGENT_SELECTION_KEY = 'cw:selectedAgentByGateway';

function parseStoredAgentSelection(storage: UiStoreDeps['storage']): Record<string, string> {
  const raw = storage.get(AGENT_SELECTION_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function lsWidth(
  storage: UiStoreDeps['storage'],
  key: string,
  min: number,
  max: number,
  vwFraction: number,
  getViewportWidth?: () => number,
): number {
  const stored = storage.get(key);
  if (stored) {
    const n = Number(stored);
    if (!isNaN(n) && n >= min && n <= max) return n;
  }
  const vw = getViewportWidth?.() ?? 0;
  return vw > 0 ? Math.min(max, Math.max(min, vw * vwFraction)) : min;
}

function fixedPanelWidth(
  storage: UiStoreDeps['storage'],
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = Number(storage.get(key));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function createUiStore(deps: UiStoreDeps) {
  const defaultLeftNavWidth = fixedPanelWidth(deps.storage, 'cw:leftNavWidth', 200, 260, 224);
  const defaultRightPanelWidth = lsWidth(deps.storage, 'cw:rightPanelWidth', 240, 500, 0.2, deps.getViewportWidth);

  return createStore<UiState>((set, get) => ({
    rightPanelOpen: false,
    toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
    setRightPanelOpen: (open) => set({ rightPanelOpen: open }),

    mainView: 'chat',
    setMainView: (view) => set({ mainView: view, settingsOpen: false }),

    settingsOpen: false,
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    settingsSection: null,
    setSettingsSection: (section) => set({ settingsSection: section }),

    theme: 'light',
    setTheme: (theme) => set({ theme }),

    density: 'comfortable',
    setDensity: (density) => set({ density }),

    language: 'en',
    setLanguage: (lang) => {
      deps.changeLanguage(lang);
      set({ language: lang });
      deps.updateSettings({ language: lang });
    },

    gatewayStatusMap: {},
    setGatewayStatusByGateway: (gatewayId, status) =>
      set((s) => ({
        gatewayStatusMap: { ...s.gatewayStatusMap, [gatewayId]: status },
        // ⭐ "这一次运行里连上过"只能在这里落账：它是**历史**，不是当前状态，
        //    而状态事件是唯一知道"真的握上手了"的地方（`gateway-display-phase.ts` 用它
        //    把"还在启动窗口里"和"连上过又掉了"分开 —— 只看当前状态分不开这两件事）。
        ...(status === 'connected' && s.gatewayEverConnected[gatewayId] !== true
          ? { gatewayEverConnected: { ...s.gatewayEverConnected, [gatewayId]: true as const } }
          : {}),
      })),

    gatewayEverConnected: {},

    gatewayRegistry: {},

    gatewayVersionMap: {},
    setGatewayVersion: (gatewayId, version) =>
      set((s) => {
        const current = s.gatewayVersionMap[gatewayId];
        if (!version) {
          if (current === undefined) return s;
          const next = { ...s.gatewayVersionMap };
          delete next[gatewayId];
          return { gatewayVersionMap: next };
        }
        if (current === version) return s;
        return { gatewayVersionMap: { ...s.gatewayVersionMap, [gatewayId]: version } };
      }),

    gatewayMaxPayloadByGateway: {},
    setGatewayMaxPayloadByGateway: (gatewayId, bytes) =>
      set((s) => {
        const current = s.gatewayMaxPayloadByGateway[gatewayId];
        // 非法值（None/0/NaN）与缺席同义：清掉条目 ⇒ 消费侧回落默认预算。
        if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
          if (current === undefined) return s;
          const next = { ...s.gatewayMaxPayloadByGateway };
          delete next[gatewayId];
          return { gatewayMaxPayloadByGateway: next };
        }
        if (current === bytes) return s;
        return { gatewayMaxPayloadByGateway: { ...s.gatewayMaxPayloadByGateway, [gatewayId]: bytes } };
      }),

    gatewayReconnectInfo: {},
    setGatewayReconnectInfo: (gatewayId, info) =>
      set((s) => {
        if (info === null) {
          const next = { ...s.gatewayReconnectInfo };
          delete next[gatewayId];
          return { gatewayReconnectInfo: next };
        }
        return { gatewayReconnectInfo: { ...s.gatewayReconnectInfo, [gatewayId]: info } };
      }),

    runtimeBootstrapFailure: null,
    setRuntimeBootstrapFailure: (reason) => set({ runtimeBootstrapFailure: reason }),

    gatewaysLoaded: false,
    setGatewaysLoaded: (loaded) => set({ gatewaysLoaded: loaded }),

    defaultGatewayId: null,
    setDefaultGatewayId: (id) => set({ defaultGatewayId: id }),

    gatewayInfoMap: {},
    setGatewayInfoMap: (map) => set({ gatewayInfoMap: map }),

    unreadTaskIds: new Set(),
    markUnread: (taskId) =>
      set((s) => {
        const next = new Set(s.unreadTaskIds);
        next.add(taskId);
        return { unreadTaskIds: next };
      }),
    clearUnread: (taskId) =>
      set((s) => {
        const next = new Set(s.unreadTaskIds);
        next.delete(taskId);
        return { unreadTaskIds: next };
      }),

    hasUpdate: false,
    setHasUpdate: (has) => set({ hasUpdate: has }),

    modelCatalogByGateway: {},
    modelCatalogFailureByGateway: {},
    setModelCatalogForGateway: (gatewayId, models) =>
      set((s) => {
        const modelCatalogByGateway = { ...s.modelCatalogByGateway, [gatewayId]: models };
        // 落目录本身就作废「取不到」的标记：空目录是**已解决**的结论，不是失败。
        if (s.modelCatalogFailureByGateway[gatewayId] === undefined) return { modelCatalogByGateway };
        const modelCatalogFailureByGateway = { ...s.modelCatalogFailureByGateway };
        delete modelCatalogFailureByGateway[gatewayId];
        return { modelCatalogByGateway, modelCatalogFailureByGateway };
      }),
    setModelCatalogFailureForGateway: (gatewayId, failed) =>
      set((s) => {
        const marked = s.modelCatalogFailureByGateway[gatewayId] === true;
        // 没变化就不写：否则每次重连都会换一次对象引用 ⇒ 订阅者整片重渲染。
        if (marked === failed) return s;
        const modelCatalogFailureByGateway = { ...s.modelCatalogFailureByGateway };
        if (failed) modelCatalogFailureByGateway[gatewayId] = true;
        else delete modelCatalogFailureByGateway[gatewayId];
        return { modelCatalogFailureByGateway };
      }),

    agentCatalogByGateway: {},
    setAgentCatalogForGateway: (gatewayId, agents, defaultId) =>
      set((s) => ({
        agentCatalogByGateway: {
          ...s.agentCatalogByGateway,
          [gatewayId]: { agents, defaultId },
        },
      })),

    toolsCatalogByGateway: {},
    setToolsCatalogForGateway: (gatewayId, catalog) =>
      set((s) => ({
        toolsCatalogByGateway: {
          ...s.toolsCatalogByGateway,
          [gatewayId]: catalog,
        },
      })),

    effectiveToolsByGateway: {},
    setEffectiveToolsState: (gatewayId, sessionKey, state) =>
      set((s) => ({
        effectiveToolsByGateway: {
          ...s.effectiveToolsByGateway,
          [gatewayId]: {
            ...s.effectiveToolsByGateway[gatewayId],
            [sessionKey]: state,
          },
        },
      })),

    skillsStatusByGateway: {},
    setSkillsStatusForGateway: (gatewayId, report) =>
      set((s) => ({
        skillsStatusByGateway: {
          ...s.skillsStatusByGateway,
          [gatewayId]: report,
        },
      })),

    commandCatalogByGateway: {},
    setCommandCatalogForGateway: (gatewayId, commands) =>
      set((s) => ({
        commandCatalogByGateway: {
          ...s.commandCatalogByGateway,
          [gatewayId]: commands,
        },
      })),

    sendShortcut: 'enter',
    setSendShortcut: (shortcut) => {
      set({ sendShortcut: shortcut });
      deps.updateSettings({ sendShortcut: shortcut });
    },

    messageLayout: deps.storage.get('cw:messageLayout') === 'wide' ? 'wide' : 'centered',
    setMessageLayout: (layout) => {
      deps.storage.set('cw:messageLayout', layout);
      set({ messageLayout: layout });
    },
    toggleMessageLayout: () =>
      set((s) => {
        const next = s.messageLayout === 'centered' ? 'wide' : 'centered';
        deps.storage.set('cw:messageLayout', next);
        return { messageLayout: next };
      }),

    searchFocusTrigger: 0,
    focusSearch: () => set((s) => ({ searchFocusTrigger: s.searchFocusTrigger + 1 })),

    getAgentsForGateway: (gatewayId: string) => {
      const entry = get().agentCatalogByGateway[gatewayId];
      return entry ?? EMPTY_AGENT_CATALOG;
    },

    selectedAgentByGateway: parseStoredAgentSelection(deps.storage),
    setSelectedAgent: (gatewayId, agentId) =>
      set((s) => {
        const next = { ...s.selectedAgentByGateway, [gatewayId]: agentId };
        deps.storage.set(AGENT_SELECTION_KEY, JSON.stringify(next));
        return { selectedAgentByGateway: next };
      }),
    getSelectedAgent: (gatewayId: string) => get().selectedAgentByGateway[gatewayId] || null,
    getSelectedAgentOrDefault: (gatewayId: string) => {
      const selected = get().selectedAgentByGateway[gatewayId];
      if (selected) return selected;
      return get().agentCatalogByGateway[gatewayId]?.defaultId ?? '';
    },

    leftNavCollapsed: deps.storage.get('cw:leftNavCollapsed') === 'true',
    toggleLeftNavCollapsed: () =>
      set((s) => {
        const next = !s.leftNavCollapsed;
        deps.storage.set('cw:leftNavCollapsed', String(next));
        return { leftNavCollapsed: next };
      }),

    leftNavWidth: defaultLeftNavWidth,
    setLeftNavWidth: (w) => {
      const clamped = Math.min(260, Math.max(200, w));
      deps.storage.set('cw:leftNavWidth', String(clamped));
      set({ leftNavWidth: clamped });
    },

    rightPanelWidth: defaultRightPanelWidth,
    setRightPanelWidth: (w) => {
      const clamped = Math.min(500, Math.max(240, w));
      deps.storage.set('cw:rightPanelWidth', String(clamped));
      set({ rightPanelWidth: clamped });
    },

    leftNavShortcut: 'Comma',
    setLeftNavShortcut: (s) => {
      set({ leftNavShortcut: s });
      deps.updateSettings({ leftNavShortcut: s });
    },

    rightPanelShortcut: 'Period',
    setRightPanelShortcut: (s) => {
      set({ rightPanelShortcut: s });
      deps.updateSettings({ rightPanelShortcut: s });
    },

    devMode: false,
    setDevMode: (enabled) => {
      set({ devMode: enabled });
      deps.updateSettings({ devMode: enabled });
      deps.onRebuildMenu?.();
    },

    commandPaletteOpen: false,
    openCommandPalette: () => set({ commandPaletteOpen: true }),
    closeCommandPalette: () => set({ commandPaletteOpen: false }),
    toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  }));
}
