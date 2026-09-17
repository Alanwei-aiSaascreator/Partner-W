import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';

export const BETA_STORAGE_KEY = 'rongying:company-beta:v1';
export type BetaModule = 'bounty' | 'game' | 'operations' | 'updates' | 'analytics' | 'compliance';

export interface BetaStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BountyDemo {
  id: string;
  title: string;
  reward: number;
  status: 'open' | 'claimed' | 'submitted';
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

export type BetaAnalytics = Record<'launch' | 'login' | 'activation' | 'chat' | 'file' | 'artifact' | 'error', number>;

export interface BetaData {
  activeModule: BetaModule;
  bounties: BountyDemo[];
  game: { points: number; level: number; checkedInToday: boolean; badges: string[] };
  operations: {
    users: number;
    activeCodes: number;
    credits: number;
    modelEnabled: boolean;
    modelRate: number;
    announcement: string;
    errorCount: number;
  };
  analytics: BetaAnalytics;
  events: BetaEvent[];
  compliance: { agreed: boolean; exportRequested: boolean; deletionRequested: boolean };
}

export interface BetaActions {
  setActiveModule(module: BetaModule): void;
  publishBounty(title: string): boolean;
  claimBounty(id: string): void;
  submitBounty(id: string): void;
  checkIn(): boolean;
  adjustCredits(amount: number): void;
  toggleModel(): void;
  setModelRate(rate: number): void;
  setAnnouncement(text: string): void;
  analyticsSummary(): BetaAnalytics;
  agreeCompliance(): void;
  requestDataExport(): void;
  requestDeletion(): void;
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
 */
export const BETA_MODULES: Array<{ id: BetaModule; label: string; description: string; preview?: true }> = [
  { id: 'bounty', label: '悬赏', description: '发布与交付任务', preview: true },
  { id: 'game', label: '成长中心', description: '积分、等级与徽章', preview: true },
  { id: 'operations', label: '运营后台', description: '基础运营控制台', preview: true },
  { id: 'updates', label: '自动升级', description: '检查、下载与安装' },
  { id: 'analytics', label: '埋点分析', description: '核心事件概览', preview: true },
  { id: 'compliance', label: '隐私与合规', description: '协议和数据权利', preview: true },
];

function seed(): BetaData {
  return {
    activeModule: 'bounty',
    bounties: [
      { id: 'bounty-seed-1', title: '优化新品详情页标题', reward: 120, status: 'open' },
      { id: 'bounty-seed-2', title: '整理本周客户反馈', reward: 80, status: 'open' },
    ],
    game: { points: 260, level: 2, checkedInToday: false, badges: ['内测先锋'] },
    operations: {
      users: 128,
      activeCodes: 46,
      credits: 5000,
      modelEnabled: true,
      modelRate: 1,
      announcement: '欢迎参加公司内测 1.0',
      errorCount: 3,
    },
    analytics: { launch: 186, login: 152, activation: 89, chat: 438, file: 72, artifact: 41, error: 3 },
    events: [],
    compliance: { agreed: false, exportRequested: false, deletionRequested: false },
  };
}

function safeLoad(storage: BetaStorage): BetaData {
  try {
    const raw = storage.getItem(BETA_STORAGE_KEY);
    if (!raw) return seed();
    const parsed = JSON.parse(raw) as Partial<BetaData>;
    // ⚠️ 词表里保留已不再发出的五个事件名（`team_created` / `team_joined` /
    //    `post_published` / `template_installed` / `creator_template_created`）：
    //    P1、P2 把它们的模块搬到主界面后，老版本写进 localStorage 的事件
    //    不能被静默丢掉（那会凭空抹掉用户的历史）。留给 P4 的埋点分析用真数据重新发出。
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
    return {
      ...seed(),
      ...parsed,
      operations: { ...seed().operations, ...parsed.operations },
      compliance: { ...seed().compliance, ...parsed.compliance },
      events,
    };
  } catch {
    return seed();
  }
}

function serializable(state: BetaState): BetaData {
  const {
    setActiveModule: _a,
    publishBounty: _f,
    claimBounty: _g,
    submitBounty: _h,
    checkIn: _o,
    adjustCredits: _p,
    toggleModel: _q,
    setModelRate: _r,
    setAnnouncement: _s,
    analyticsSummary: _t,
    agreeCompliance: _u,
    requestDataExport: _v,
    requestDeletion: _w,
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

function deriveAnalytics(state: Pick<BetaData, 'analytics' | 'events'>): BetaAnalytics {
  const summary = { ...state.analytics };
  for (const event of state.events) {
    if (event.type === 'module_opened') summary.launch += 1;
  }
  return summary;
}

export function createBetaStore(storage: BetaStorage): StoreApi<BetaState> {
  const store = createStore<BetaState>((set, get) => ({
    ...safeLoad(storage),
    setActiveModule: (activeModule) =>
      set((state) => ({ activeModule, events: addEvent(state.events, 'module_opened', activeModule) })),
    publishBounty: (title) => {
      const trimmed = title.trim();
      if (!trimmed) return false;
      set((state) => ({
        bounties: [...state.bounties, { id: makeId('bounty'), title: trimmed, reward: 100, status: 'open' }],
        events: addEvent(state.events, 'bounty_published', 'bounty'),
      }));
      return true;
    },
    claimBounty: (id) =>
      set((state) => ({
        bounties: state.bounties.map((item) =>
          item.id === id && item.status === 'open' ? { ...item, status: 'claimed' } : item,
        ),
      })),
    submitBounty: (id) =>
      set((state) => ({
        bounties: state.bounties.map((item) =>
          item.id === id && item.status === 'claimed' ? { ...item, status: 'submitted' } : item,
        ),
      })),
    checkIn: () => {
      if (get().game.checkedInToday) return false;
      set((state) => ({
        game: {
          ...state.game,
          checkedInToday: true,
          points: state.game.points + 20,
          level: Math.max(state.game.level, Math.floor((state.game.points + 20) / 200) + 1),
        },
        events: addEvent(state.events, 'daily_check_in', 'game'),
      }));
      return true;
    },
    adjustCredits: (amount) =>
      set((state) => ({
        operations: { ...state.operations, credits: Math.max(0, state.operations.credits + amount) },
      })),
    toggleModel: () =>
      set((state) => ({ operations: { ...state.operations, modelEnabled: !state.operations.modelEnabled } })),
    setModelRate: (modelRate) =>
      set((state) => ({ operations: { ...state.operations, modelRate: Math.max(0.1, modelRate) } })),
    setAnnouncement: (announcement) => set((state) => ({ operations: { ...state.operations, announcement } })),
    analyticsSummary: () => deriveAnalytics(get()),
    agreeCompliance: () =>
      set((state) => ({
        compliance: { ...state.compliance, agreed: true },
        events: state.compliance.agreed ? state.events : addEvent(state.events, 'compliance_agreed', 'compliance'),
      })),
    requestDataExport: () =>
      set((state) => ({
        compliance: { ...state.compliance, exportRequested: true },
        events: state.compliance.exportRequested
          ? state.events
          : addEvent(state.events, 'data_export_requested', 'compliance'),
      })),
    requestDeletion: () =>
      set((state) => ({
        compliance: { ...state.compliance, deletionRequested: true },
        events: state.compliance.deletionRequested
          ? state.events
          : addEvent(state.events, 'data_deletion_requested', 'compliance'),
      })),
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
