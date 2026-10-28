// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * r14 返工（BUG-082 二阶）——**顶栏钱包**与账户页 / Dashboard 同口径。
 *
 * 症状：账户页说"在途预占暂不可用"时，顶栏照样给一个确定的剩余积分数 —— 同一块屏自相矛盾。
 * 判据唯一来源是 `@/lib/quota-display` 的 `readHeldView()`（三处共用），本文件钉的是
 * **顶栏这一处的接线**：读数不可判定 ⇒ 不出确定数字、出现 `[data-quota-held-unknown]`、
 * 浮层里不出进度条；读到读数 ⇒ 照常显示数字 + 进度条。
 *
 * ⚠️ 真渲染 `MainArea`（default export），只桩掉有副作用的外围依赖。
 *    与 `chat-scroll-anchor-viewport.test.tsx` 的差别只有一处：那边把 commercialStore
 *    桩成**恒 `overview: null`**（顶栏钱包根本渲染不出来），这里用**可写**桩喂快照。
 *
 * ⚠️ 真实 relay / 真实账单 = NOT RUN：这里只锁"读数 → 上屏"的接线与三态。
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('framer-motion', () => {
  const MOTION_ONLY = new Set(['initial', 'animate', 'exit', 'transition', 'variants', 'whileHover', 'whileTap']);
  const div = ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...Object.fromEntries(Object.entries(rest).filter(([key]) => !MOTION_ONLY.has(key)))}>{children}</div>
  );
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: { div },
    useReducedMotion: () => true,
  };
});

vi.mock('../src/renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock('../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// 浮层内容**常驻 DOM**（真 Popover 要点开才挂载）—— 本文件要断言的就是浮层里的进度条。
vi.mock('../src/renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({
    children,
    viewportRef,
    onScrollCapture,
    className,
  }: {
    children: ReactNode;
    viewportRef?: React.Ref<HTMLDivElement>;
    onScrollCapture?: React.UIEventHandler<HTMLDivElement>;
    className?: string;
  }) => (
    <div className={className} onScrollCapture={onScrollCapture}>
      <div data-testid="chat-viewport" ref={viewportRef}>
        {children}
      </div>
    </div>
  ),
}));

vi.mock('../src/renderer/components/ChatInput', () => ({ default: () => <div data-testid="chat-input" /> }));
vi.mock('../src/renderer/components/ChatMessage', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ThinkingIndicator', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ImageLightbox', () => ({ default: () => null }));
vi.mock('../src/renderer/components/FilePreviewModal', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ConnectionBanner', () => ({ default: () => null }));
vi.mock('../src/renderer/components/RelayConnectionBanner', () => ({ default: () => null }));
vi.mock('../src/renderer/components/WorkspaceRecreatedNotice', () => ({ default: () => null }));
vi.mock('../src/renderer/components/EnsembleAgentBar', () => ({ default: () => null }));
vi.mock('../src/renderer/features/team-meeting/TeamCollabBar', () => ({ default: () => null }));
vi.mock('../src/renderer/components/data-display/DataTable', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/EmptyState', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/StatusTag', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/WindowTitlebar', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/ConfirmDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/ToolbarButton', () => ({
  default: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));
vi.mock('../src/renderer/layouts/FileBrowser', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/CronPanel', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/TeamsPanel', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/Dashboard', () => ({ default: () => null }));
vi.mock('../src/renderer/features/internal-beta/InternalBetaHub', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/MainArea/StartupReadinessPanel', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/MainArea/FirstTaskCompletionFlow', () => ({ default: () => null }));

vi.mock('../src/renderer/hooks/useGatewaySelector', () => ({
  useGatewaySelector: () => ({
    gateways: [],
    selectedGwId: 'gw-1',
    setSelectedGwId: vi.fn(),
    agentCatalog: [],
    effectiveAgentId: 'main',
    setSelectedAgentId: vi.fn(),
  }),
}));

vi.mock('../src/renderer/features/goal-routing/useGoalAnalysis', () => ({
  useGoalAnalysis: () => ({ status: 'idle', result: null, error: null, retry: vi.fn() }),
}));

vi.mock('../src/renderer/hooks/useQuotaRefreshOnTurnEnd', () => ({ useQuotaRefreshOnTurnEnd: vi.fn() }));
vi.mock('../src/renderer/hooks/useGatewayBootstrap', () => ({ fetchAgentsForGateway: vi.fn(async () => undefined) }));

const taskState = {
  activeTaskId: null as string | null,
  tasks: [] as Array<Record<string, unknown>>,
  pendingNewTask: null,
  startNewTask: vi.fn(),
  updatePending: vi.fn(),
  // 没有活动任务 ⇒ 会渲染真实 `WelcomeScreen`，它的 effect 会调 `setPending`
  // （见 `MainArea/WelcomeScreen.tsx:157`）。
  setPending: vi.fn(),
};

const uiState = {
  sendShortcut: 'enter',
  mainView: 'chat',
  settingsOpen: false,
  messageLayout: 'centered',
  defaultGatewayId: 'gw-1',
  rightPanelOpen: false,
  agentCatalogByGateway: {} as Record<string, { defaultId: string; agents: Array<{ id: string; name: string }> }>,
  modelCatalogByGateway: {
    'gw-1': [{ id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' }],
  } as Record<string, Array<{ id: string; provider: string; name?: string }>>,
  modelCatalogFailureByGateway: {} as Record<string, true>,
  gatewayStatusMap: { 'gw-1': 'connected' } as Record<string, string>,
  gatewayReconnectInfo: {} as Record<string, unknown>,
  gatewayEverConnected: {} as Record<string, true>,
  setSettingsOpen: vi.fn(),
  setMainView: vi.fn(),
  setRightPanelOpen: vi.fn(),
  setSelectedAgent: vi.fn(),
  toggleMessageLayout: vi.fn(),
};

const messageState = {
  messagesByTask: {} as Record<string, Array<Record<string, unknown>>>,
  activeTurnBySession: {} as Record<string, unknown>,
  processingBySession: new Set<string>(),
  highlightedMessageId: null,
  setHighlightedMessage: vi.fn(),
  runPhaseBySession: {},
  retryableErrorBySession: {},
  turnStartedAtBySession: {} as Record<string, number>,
  runRetryBySession: {} as Record<string, { attempt: number; maxAttempts: number }>,
  progressTextBySession: {} as Record<string, string | null>,
  compactingBySession: {} as Record<string, boolean>,
};

const roomState = { rooms: {} };

vi.mock('../src/renderer/platform', () => {
  const useTaskStore = Object.assign(<T,>(selector: (state: typeof taskState) => T) => selector(taskState), {
    getState: () => taskState,
  });
  return {
    useTaskStore,
    useUiStore: <T,>(selector: (state: typeof uiState) => T) => selector(uiState),
    useMessageStore: <T,>(selector: (state: typeof messageState) => T) => selector(messageState),
    useRoomStore: <T,>(selector: (state: typeof roomState) => T) => selector(roomState),
  };
});

/**
 * commercialStore 的**可写**桩：默认仍是 `overview: null`（与其它挂具一致，顶栏不渲染钱包），
 * 用例里用 `setCommercialState()` 喂一张卡的快照。
 */
const commercial = vi.hoisted(() => ({
  state: {
    overview: null as unknown,
    status: 'ready' as string,
    errorMessage: '',
    load: vi.fn(async () => undefined),
    // 2026-10-17：本轮消耗（`useQuotaRefreshOnTurnEnd` 写、聊天区底部读）。
    turnSpend: null as unknown,
  },
}));

vi.mock('../src/renderer/stores/commercialStore', () => {
  const useCommercialStore = <T,>(selector: (state: typeof commercial.state) => T) => selector(commercial.state);
  return {
    useCommercialStore: Object.assign(useCommercialStore, {
      getState: () => commercial.state,
      setState: (patch: Record<string, unknown>) => Object.assign(commercial.state, patch),
    }),
  };
});

vi.mock('../src/renderer/stores/usageStore', () => ({
  useUsageStore: <T,>(selector: (state: Record<string, unknown>) => T) =>
    selector({
      status: null,
      loading: false,
      fetchUsage: vi.fn(),
      startAutoRefresh: vi.fn(),
      stopAutoRefresh: vi.fn(),
    }),
}));

const settingsState = { load: vi.fn(), updateSettings: vi.fn(), settings: null };
vi.mock('../src/renderer/stores/settingsStore', () => {
  const useSettingsStore = <T,>(selector: (state: typeof settingsState) => T) => selector(settingsState);
  useSettingsStore.getState = () => settingsState;
  return { useSettingsStore };
});

vi.mock('@clawwork/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clawwork/core')>();
  return { ...actual, RUN_PHASE_IDS: [], EMPTY_MESSAGES: [], serializeIdentityMd: vi.fn() };
});

import MainArea from '../src/renderer/layouts/MainArea';

const CREDIT = 1_000_000;

const readiness = {
  gatewayId: 'gw-1',
  ai: { phase: 'ready' },
  assistants: { phase: 'ready', completed: 6, total: 6, missingIds: [] },
  workspaceAvailable: true,
  conversationReady: true,
  isReady: true,
  hasError: false,
} as unknown as Parameters<typeof MainArea>[0]['startupReadiness'];

/** 2000 总额 − 已用 999.6 ⇒ 剩余 1000.40（读数确定时顶栏必须显示它）。 */
function overviewWith(extraLicense: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account: { userId: 'user-1', phone: null, nickname: null, email: null, avatar: null },
    org: null,
    license: {
      activated: true,
      licenseId: 'l1',
      orgId: 'o1',
      licenseKey: 'RY-1',
      sku: 'USB-内测版',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: 2000 * CREDIT,
      tokenUsedMicros: (2000 - 1000.4) * CREDIT,
      ...extraLicense,
    },
    device: { fingerprint: 'fp', shortFingerprint: 'DEV-1234' },
    fetchedAt: '2026-10-15T10:00:00.000Z',
  };
}

function renderMainArea(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <MainArea
        onTogglePanel={vi.fn()}
        onboardingProfile={
          {
            version: 1,
            userId: 'user-1',
            nickname: '',
            useCases: ['content'],
            customGoal: '',
            completedAt: '2026-09-14T00:00:00.000Z',
          } as unknown as Parameters<typeof MainArea>[0]['onboardingProfile']
        }
        startupReadiness={readiness}
        onRetryStartup={vi.fn(async () => undefined)}
      />,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function setCommercialOverview(overview: Record<string, unknown> | null): void {
  commercial.state.overview = overview;
  commercial.state.status = 'ready';
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
  setCommercialOverview(null);
  commercial.state.turnSpend = null;
  taskState.activeTaskId = null;
  taskState.tasks = [];
  messageState.messagesByTask = {};
  messageState.processingBySession = new Set<string>();
  messageState.activeTurnBySession = {};
  Object.assign(window, { clawwork: {} });
  // 渲染**真实对话区**（不是 WelcomeScreen）时会用到 ResizeObserver；jsdom 没有。
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('顶栏钱包：在途预占三态（r14 返工）', () => {
  it('读数不可判定（缺 held 读数）⇒ 顶栏不给确定余额，浮层不出进度条', () => {
    setCommercialOverview(overviewWith());
    const view = renderMainArea();

    console.log(
      'WALLET_HELD_UNKNOWN',
      JSON.stringify({
        walletLabel: view.container.querySelector('button[aria-label]')?.getAttribute('aria-label') ?? null,
        unknownMarker: view.container.querySelector('[data-quota-held-unknown]')?.textContent ?? null,
        showsKnownBalance: view.container.textContent?.includes('1,000.40') ?? null,
        progressbars: view.container.querySelectorAll('[role="progressbar"]').length,
      }),
    );

    // 不许出现具体积分数（1000.40 = quota − used 的本地推算）。
    expect(view.container.textContent).not.toContain('1,000.40');
    expect(view.container.querySelector('[data-quota-held-unknown]')).not.toBeNull();
    // 按钮的可达名也要说清是"不能算"，不是"余额 0"。
    expect(view.container.querySelector('button[aria-label="account.quotaHeldUnknown"]')).not.toBeNull();
    // 浮层里的进度条同样是"还剩这么多"的确定读法 ⇒ 一并撤掉。
    expect(view.container.querySelector('[role="progressbar"]')).toBeNull();
    view.unmount();
  });

  it('heldComplete=false（后端明说不可判定）⇒ 同样不给确定余额', () => {
    setCommercialOverview(overviewWith({ heldComplete: false }));
    const view = renderMainArea();

    expect(view.container.textContent).not.toContain('1,000.40');
    expect(view.container.querySelector('[data-quota-held-unknown]')).not.toBeNull();
    expect(view.container.querySelector('[role="progressbar"]')).toBeNull();
    view.unmount();
  });

  it('读到读数（明确没有预占 = 0）⇒ 顶栏照常显示数字 + 进度条（对照）', () => {
    setCommercialOverview(overviewWith({ tokenHeldMicros: 0, heldComplete: true }));
    const view = renderMainArea();

    console.log(
      'WALLET_HELD_KNOWN',
      JSON.stringify({
        showsKnownBalance: view.container.textContent?.includes('1,000.40') ?? null,
        unknownMarker: view.container.querySelector('[data-quota-held-unknown]') !== null,
        progressbars: view.container.querySelectorAll('[role="progressbar"]').length,
      }),
    );

    expect(view.container.textContent).toContain('1,000.40');
    expect(view.container.querySelector('[data-quota-held-unknown]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="usage.balance"]')).not.toBeNull();
    expect(view.container.querySelector('[role="progressbar"]')).not.toBeNull();
    view.unmount();
  });

  /**
   * 读数贯通：**可用额 = 额度 − 已用 − 预占**，顶栏必须与账户页 / 额度门同一个数。
   * 旧实现顶栏只算 `quota − used`（预占没扣）⇒ 同一块屏显示两个可用额（1000.40 vs 950.40）。
   */
  it('读到读数且预占 > 0 ⇒ 顶栏显示 quota − used − held（与账户页同一个数）', () => {
    // 2000 − 999.6 − 50 = 950.40
    setCommercialOverview(overviewWith({ tokenHeldMicros: 50 * CREDIT, heldComplete: true }));
    const view = renderMainArea();

    console.log(
      'WALLET_HELD_POSITIVE',
      JSON.stringify({
        showsAvailable: view.container.textContent?.includes('950.40') ?? null,
        showsUnsubtracted: view.container.textContent?.includes('1,000.40') ?? null,
      }),
    );

    expect(view.container.textContent).toContain('950.40');
    // 没扣预占的那个数**不许**出现（否则就是第二个可用额口径）。
    expect(view.container.textContent).not.toContain('1,000.40');
    expect(view.container.querySelector('[data-quota-held-unknown]')).toBeNull();
    view.unmount();
  });
});

/**
 * 2026-10-17 用户要求：「每个任务结束显示消耗多少积分」。
 *
 * 金额由 `useQuotaRefreshOnTurnEnd` 在**结算前后余额差**里算出并写进 store
 * （断言在 `quota-refresh-on-turn-end.test.tsx`）；本文件钉的是**上屏接线**：
 * 只有"最后一条助手消息所在的会话"才显示 —— 换会话不许把上一轮的花费挂过来。
 *
 * ⚠️ i18n 在本文件被桩成 `t(key) => key`，所以这里断言的是
 *    **出现/不出现这个节点**，不是插值后的数字。
 */
describe('本轮消耗：上屏接线', () => {
  function withConversation(sessionKey: string) {
    taskState.activeTaskId = 't1';
    taskState.tasks = [{ id: 't1', name: 'task', sessionKey }];
    messageState.messagesByTask = {
      t1: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'hello',
          sessionKey,
          taskId: 't1',
          timestamp: 1,
          toolCalls: [],
          thinkingContent: '',
        },
      ],
    };
  }

  it('结算后：最后一条回复下方出现「本轮消耗」', () => {
    withConversation('sess-1');
    commercial.state.turnSpend = { sessionKeys: ['sess-1'], micros: 2_500_000, at: Date.now() };
    const view = renderMainArea();

    expect(view.container.querySelector('[data-testid="turn-cost"]')).not.toBeNull();
    view.unmount();
  });

  it('消耗属于别的会话 ⇒ 不显示（不把上一轮的花费挂到当前对话）', () => {
    withConversation('sess-2');
    commercial.state.turnSpend = { sessionKeys: ['sess-1'], micros: 2_500_000, at: Date.now() };
    const view = renderMainArea();

    expect(view.container.querySelector('[data-testid="turn-cost"]')).toBeNull();
    view.unmount();
  });

  it('零消耗不显示（不编一个「消耗 0」）', () => {
    withConversation('sess-1');
    commercial.state.turnSpend = { sessionKeys: ['sess-1'], micros: 0, at: Date.now() };
    const view = renderMainArea();

    expect(view.container.querySelector('[data-testid="turn-cost"]')).toBeNull();
    view.unmount();
  });
});
