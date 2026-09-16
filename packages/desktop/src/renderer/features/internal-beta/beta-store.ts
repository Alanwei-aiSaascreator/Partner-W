import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';

export const BETA_STORAGE_KEY = 'rongying:company-beta:v1';
export type BetaModule =
  | 'team'
  | 'market'
  | 'bounty'
  | 'square'
  | 'creator'
  | 'game'
  | 'operations'
  | 'updates'
  | 'analytics'
  | 'compliance';

export interface BetaStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TeamDemo {
  name: string;
  inviteCode: string;
  members: Array<{ id: string; name: string; role: string }>;
}

export interface MarketTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  installs: number;
}

export interface BountyDemo {
  id: string;
  title: string;
  reward: number;
  status: 'open' | 'claimed' | 'submitted';
}

export interface FeedPost {
  id: string;
  author: string;
  content: string;
  likes: number;
  comments: string[];
  createdAt: string;
}

export interface CreatorTemplate {
  id: string;
  name: string;
  status: 'draft' | 'published';
  views: number;
  installs: number;
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
  team: TeamDemo | null;
  installedTemplateIds: string[];
  bounties: BountyDemo[];
  feed: FeedPost[];
  creatorTemplates: CreatorTemplate[];
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
  createTeam(name: string): void;
  joinTeam(code: string): void;
  leaveTeam(): void;
  installTemplate(id: string): boolean;
  publishBounty(title: string): boolean;
  claimBounty(id: string): void;
  submitBounty(id: string): void;
  publishPost(content: string): boolean;
  likePost(id: string): void;
  commentPost(id: string, content: string): void;
  createCreatorTemplate(name: string): boolean;
  renameCreatorTemplate(id: string, name: string): void;
  toggleCreatorPublished(id: string): void;
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

export const BETA_MODULES: Array<{ id: BetaModule; label: string; description: string }> = [
  { id: 'team', label: '团队', description: '邀请成员并协作' },
  { id: 'market', label: '助手市场', description: '发现并安装模板' },
  { id: 'bounty', label: '悬赏', description: '发布与交付任务' },
  { id: 'square', label: '广场', description: '分享团队动态' },
  { id: 'creator', label: '创作者中心', description: '发布助手模板' },
  { id: 'game', label: '成长中心', description: '积分、等级与徽章' },
  { id: 'operations', label: '运营后台', description: '基础运营控制台' },
  { id: 'updates', label: '自动升级', description: '检查、下载与安装' },
  { id: 'analytics', label: '埋点分析', description: '核心事件概览' },
  { id: 'compliance', label: '隐私与合规', description: '协议和数据权利' },
];

export const MARKET_TEMPLATES: MarketTemplate[] = [
  {
    id: 'tpl-content',
    name: '爆款内容教练',
    category: '内容创作',
    description: '从选题到成稿的内容工作流',
    installs: 1286,
  },
  {
    id: 'tpl-ecommerce',
    name: '电商增长参谋',
    category: '电商运营',
    description: '商品诊断、活动与复盘',
    installs: 936,
  },
  { id: 'tpl-research', name: '深度研究助手', category: '学习研究', description: '资料梳理与观点比较', installs: 704 },
];

function seed(): BetaData {
  return {
    activeModule: 'team',
    team: null,
    installedTemplateIds: [],
    bounties: [
      { id: 'bounty-seed-1', title: '优化新品详情页标题', reward: 120, status: 'open' },
      { id: 'bounty-seed-2', title: '整理本周客户反馈', reward: 80, status: 'open' },
    ],
    feed: [
      {
        id: 'post-seed-1',
        author: '荣盈产品组',
        content: '公司内测 1.0 框架已开启，请把真实问题留在广场。',
        likes: 12,
        comments: ['收到，开始体验'],
        createdAt: '今天 09:30',
      },
    ],
    creatorTemplates: [{ id: 'creator-seed-1', name: '门店日报助手', status: 'draft', views: 36, installs: 0 }],
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
    createTeam: _b,
    joinTeam: _c,
    leaveTeam: _d,
    installTemplate: _e,
    publishBounty: _f,
    claimBounty: _g,
    submitBounty: _h,
    publishPost: _i,
    likePost: _j,
    commentPost: _k,
    createCreatorTemplate: _l,
    renameCreatorTemplate: _m,
    toggleCreatorPublished: _n,
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
    if (event.type === 'post_published') summary.chat += 1;
    if (event.type === 'template_installed') summary.activation += 1;
    if (event.type === 'creator_template_created') summary.artifact += 1;
    if (event.type === 'team_created' || event.type === 'team_joined') summary.login += 1;
    if (event.type === 'module_opened') summary.launch += 1;
  }
  return summary;
}

export function createBetaStore(storage: BetaStorage): StoreApi<BetaState> {
  const store = createStore<BetaState>((set, get) => ({
    ...safeLoad(storage),
    setActiveModule: (activeModule) =>
      set((state) => ({ activeModule, events: addEvent(state.events, 'module_opened', activeModule) })),
    createTeam: (name) =>
      set((state) => ({
        team: {
          name: name.trim() || '我的团队',
          inviteCode: `RY${String(Date.now()).slice(-6)}`,
          members: [{ id: 'me', name: '我', role: '管理员' }],
        },
        events: addEvent(state.events, 'team_created', 'team'),
      })),
    joinTeam: (code) =>
      set((state) => ({
        team: {
          name: `内测协作组 ${code.trim().toUpperCase().slice(-4) || '0001'}`,
          inviteCode: code.trim().toUpperCase() || 'RY000001',
          members: [
            { id: 'owner', name: '团队管理员', role: '管理员' },
            { id: 'me', name: '我', role: '成员' },
          ],
        },
        events: addEvent(state.events, 'team_joined', 'team'),
      })),
    leaveTeam: () => set({ team: null }),
    installTemplate: (id) => {
      if (get().installedTemplateIds.includes(id)) return false;
      set((state) => ({
        installedTemplateIds: [...state.installedTemplateIds, id],
        events: addEvent(state.events, 'template_installed', 'market'),
      }));
      return true;
    },
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
    publishPost: (content) => {
      const trimmed = content.trim();
      if (!trimmed) return false;
      set((state) => ({
        feed: [
          {
            id: makeId('post'),
            author: '我',
            content: trimmed,
            likes: 0,
            comments: [],
            createdAt: '刚刚',
          },
          ...state.feed,
        ],
        events: addEvent(state.events, 'post_published', 'square'),
      }));
      return true;
    },
    likePost: (id) =>
      set((state) => ({
        feed: state.feed.map((post) => (post.id === id ? { ...post, likes: post.likes + 1 } : post)),
      })),
    commentPost: (id, content) =>
      set((state) => ({
        feed: state.feed.map((post) =>
          post.id === id && content.trim() ? { ...post, comments: [...post.comments, content.trim()] } : post,
        ),
      })),
    createCreatorTemplate: (name) => {
      const trimmed = name.trim();
      if (!trimmed) return false;
      set((state) => ({
        creatorTemplates: [
          ...state.creatorTemplates,
          { id: makeId('creator'), name: trimmed, status: 'draft', views: 0, installs: 0 },
        ],
        events: addEvent(state.events, 'creator_template_created', 'creator'),
      }));
      return true;
    },
    renameCreatorTemplate: (id, name) =>
      set((state) => ({
        creatorTemplates: state.creatorTemplates.map((item) =>
          item.id === id && name.trim() ? { ...item, name: name.trim() } : item,
        ),
      })),
    toggleCreatorPublished: (id) =>
      set((state) => ({
        creatorTemplates: state.creatorTemplates.map((item) =>
          item.id === id ? { ...item, status: item.status === 'draft' ? 'published' : 'draft' } : item,
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
