import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';

export const BETA_STORAGE_KEY = 'partner-w:company-beta:v1';
/**
 * ⚠️ P4 毕业清单：`analytics`（埋点分析）搬进了运营看板，`compliance`（隐私与合规）
 *    搬进了设置页「隐私与数据」—— 两个都**只许有一份真实现**，内测中心里那份
 *    Zustand + localStorage 的模拟版必须整块删掉，否则界面上会同时挂着真入口和假入口。
 */
export type BetaModule = 'operations' | 'updates';

export interface BetaStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type BetaEventType =
  | 'module_opened'
  | 'team_created'
  | 'team_joined'
  | 'template_installed'
  | 'bounty_published'
  | 'post_published'
  | 'creator_template_created'
  | 'daily_check_in'
  | 'compliance_agreed'
  | 'data_export_requested'
  | 'data_deletion_requested';

export interface BetaEvent {
  id: string;
  type: BetaEventType;
  timestamp: string;
  module?: BetaModule;
}

export interface BetaData {
  activeModule: BetaModule;
  operations: {
    users: number;
    activeCodes: number;
    credits: number;
    modelEnabled: boolean;
    modelRate: number;
    announcement: string;
    errorCount: number;
  };
  events: BetaEvent[];
}

export interface BetaActions {
  setActiveModule(module: BetaModule): void;
  adjustCredits(amount: number): void;
  toggleModel(): void;
  setModelRate(rate: number): void;
  setAnnouncement(text: string): void;
  resetDemo(): void;
}

export type BetaState = BetaData & BetaActions;

/**
 * 内测中心的功能清单。
 *
 * ⚠️ `preview: true` = **本机模拟**（Zustand + localStorage）：数据只存在这台电脑上，
 *    不影响真实系统，别人也看不到。交接单（2026-09-16）明确要求内测 1.0
 *    **不许**把这些当成「已完成」对外讲 —— 界面上必须标出来（见 InternalBetaHub 的表头）。
 *
 * 唯一 `preview` 为假的是「自动升级」：它调的是**真的**更新接口
 *（`window.clawwork.checkForUpdates` → electron-updater），失败也会如实说明原因。
 *
 * P4：`analytics` 与 `compliance` 两项**已毕业**（真实现分别在运营看板与设置页
 * 「隐私与数据」），这里的列表里不再有它们。
 */
export const BETA_MODULES: Array<{ id: BetaModule; label: string; description: string; preview?: true }> = [
  { id: 'operations', label: '运营后台', description: '基础运营控制台', preview: true },
  { id: 'updates', label: '自动升级', description: '检查、下载与安装' },
];

function seed(): BetaData {
  return {
    activeModule: 'operations',
    operations: {
      users: 128,
      activeCodes: 46,
      credits: 5000,
      modelEnabled: true,
      modelRate: 1,
      announcement: '欢迎参加公司内测 1.0',
      errorCount: 3,
    },
    events: [],
  };
}

function safeLoad(storage: BetaStorage): BetaData {
  try {
    const raw = storage.getItem(BETA_STORAGE_KEY);
    if (!raw) return seed();
    const parsed = JSON.parse(raw) as Partial<BetaData>;
    // ⚠️ `activeModule` 必须 clamp：升级前点过「埋点分析 / 隐私与合规」的用户，
    //    localStorage 里留着 `'analytics' | 'compliance'` —— 盲信它会让内测中心
    //    整页抛 TypeError 并被根 ErrorBoundary 接成整应用错误页，重载后照样崩。
    //    而且**界面自愈不了**：整页崩的时候连「重置内测数据」按钮都渲染不出来。
    //    不认识的模块一律回落到清单里的第一个。
    const activeModule = BETA_MODULES.some((item) => item.id === parsed.activeModule)
      ? (parsed.activeModule as BetaModule)
      : BETA_MODULES[0].id;
    // ⚠️ 词表里保留已不再发出的十个事件名（`team_created` / `team_joined` /
    //    `post_published` / `template_installed` / `creator_template_created` /
    //    `bounty_published` / `daily_check_in`，以及随 P4 毕业的合规三件
    //    `compliance_agreed` / `data_export_requested` / `data_deletion_requested`）：
    //    P1/P2/P3 把它们的模块搬到主界面、P4 把隐私与合规搬进设置页之后，
    //    老版本写进 localStorage 的事件不能被静默丢掉（那会凭空抹掉用户的历史）。
    //    ⚠️ 这张词表**只为兼容旧 localStorage 而留**：真埋点已由 P4 的 reporter
    //    走服务端 `/analytics` 重发，本机这份不再上服务端，也不再有界面展示。
    const validEventTypes = new Set<BetaEventType>([
      'module_opened',
      'team_created',
      'team_joined',
      'template_installed',
      'bounty_published',
      'post_published',
      'creator_template_created',
      'daily_check_in',
      'compliance_agreed',
      'data_export_requested',
      'data_deletion_requested',
    ]);
    const events = Array.isArray(parsed.events)
      ? parsed.events
          .filter((event): event is BetaEvent => {
            if (!event || typeof event !== 'object') return false;
            const candidate = event as Partial<BetaEvent>;
            return (
              typeof candidate.id === 'string' &&
              typeof candidate.timestamp === 'string' &&
              validEventTypes.has(candidate.type as BetaEventType)
            );
          })
          .slice(-100)
          .map((event) => ({ id: event.id, type: event.type, timestamp: event.timestamp, module: event.module }))
      : [];
    // ⚠️ 老 blob 里 `analytics` / `compliance` 两个残块**刻意原样保留**（下面的
    //    `...parsed`）：它们是老版本内测中心的模拟 UI 数据（计数器 + 三个布尔
    //    开关，没有用户正文），现在既没有类型也没有界面消费 —— 但"清用户本机
    //    已有的数据"属于**单独的数据迁移决策**，不是一次审阅修正能顺手做的
    //    （Task 15 遗留清单里记着这笔）。原样回写 = 不改动用户本机数据。
    //    ⚠️ 与上面 `activeModule` 的区别：那个**必须** clamp，因为盲信它会让
    //    内测中心整页崩；这两块没有任何界面消费，留着不会崩。
    //    ⚠️ `activeModule` 放在 `...parsed` **之后**：否则又被旧 blob 覆盖回去了。
    return {
      ...seed(),
      ...parsed,
      activeModule,
      operations: { ...seed().operations, ...parsed.operations },
      events,
    };
  } catch {
    return seed();
  }
}

function serializable(state: BetaState): BetaData {
  const {
    setActiveModule: _a,
    adjustCredits: _p,
    toggleModel: _q,
    setModelRate: _r,
    setAnnouncement: _s,
    resetDemo: _x,
    ...data
  } = state;
  return data;
}

let sequence = 0;
const makeId = (prefix: string) => `${prefix}-${Date.now()}-${++sequence}`;

function addEvent(events: BetaEvent[], type: BetaEventType, module?: BetaModule): BetaEvent[] {
  return [
    ...events,
    {
      id: makeId('event'),
      type,
      timestamp: new Date().toISOString(),
      ...(module ? { module } : {}),
    },
  ].slice(-100);
}

export function createBetaStore(storage: BetaStorage): StoreApi<BetaState> {
  const store = createStore<BetaState>((set) => ({
    ...safeLoad(storage),
    setActiveModule: (activeModule) =>
      set((state) => ({ activeModule, events: addEvent(state.events, 'module_opened', activeModule) })),
    adjustCredits: (amount) =>
      set((state) => ({
        operations: { ...state.operations, credits: Math.max(0, state.operations.credits + amount) },
      })),
    toggleModel: () =>
      set((state) => ({ operations: { ...state.operations, modelEnabled: !state.operations.modelEnabled } })),
    setModelRate: (modelRate) =>
      set((state) => ({ operations: { ...state.operations, modelRate: Math.max(0.1, modelRate) } })),
    setAnnouncement: (announcement) => set((state) => ({ operations: { ...state.operations, announcement } })),
    resetDemo: () => set(seed()),
  }));
  store.subscribe((state) => storage.setItem(BETA_STORAGE_KEY, JSON.stringify(serializable(state))));
  return store;
}

const fallbackStorage: BetaStorage = {
  getItem: (key) => (typeof localStorage === 'undefined' ? null : localStorage.getItem(key)),
  setItem: (key, value) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  },
  removeItem: (key) => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  },
};

export const betaStore = createBetaStore(fallbackStorage);
export function useBetaStore<T>(selector: (state: BetaState) => T): T {
  return useStore(betaStore, selector);
}
useBetaStore.getState = betaStore.getState;
