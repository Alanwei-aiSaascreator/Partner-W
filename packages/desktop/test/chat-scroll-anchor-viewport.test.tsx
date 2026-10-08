// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCROLL_ANCHOR_MARGIN_PX } from '../src/renderer/lib/chat-scroll-anchor';

/**
 * 用户反馈 #16（`USER-FEEDBACK-TRIAGE-20261006.md` 第 25 行）：「提问后答案要从下往上翻看，不方便」。
 *
 * 组件这一侧钉的是**接线**：`MainArea` 的自动滚动到底把视口滚到哪 ——
 * - 长回答：钉在该回答首行（顶部锚点），而不是底部；
 * - 短回答 / 没有进行中的回答：仍随底（不破坏原跟随体验）；
 * - 用户主动滚回底部：后续增量继续跟随尾部，不抢用户的跟随；
 * - 用户滚离底部：自动滚动让位（原行为不变）。
 *
 * ⚠️ jsdom 没有布局：视口尺寸与 rect 都在用例里显式桩掉；
 *    `ResizeObserver` 也没有 —— 用 `FakeResizeObserver` 捕获回调并按需手动触发
 *    （真实实现里每次内容变化都会触发它，这里等价于"内容又长高了一段"）。
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('framer-motion', () => {
  // 同 chat-send-stability：普通 props（data-testid 等）必须透传，否则查不到节点就是假红。
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

vi.mock('../src/renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

/**
 * ScrollArea 桩**必须把 `viewportRef` 接上**（别的聊天用例把它当纯 div，视口引用是 null，
 * 于是 MainArea 的自动滚动 effect 直接早退、这一格根本跑不到产品代码）。
 * 视口 = 内层 div；`onScrollCapture` 挂外层，与真身的 root/viewport 结构同形。
 */
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
vi.mock('../src/renderer/components/ChatMessage', () => ({
  default: ({ message }: { message: { content: string } }) => <div data-testid="chat-message">{message.content}</div>,
}));
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
    effectiveAgentId: 'rongying-content',
    setSelectedAgentId: vi.fn(),
  }),
}));

vi.mock('../src/renderer/features/goal-routing/useGoalAnalysis', () => ({
  useGoalAnalysis: () => ({ status: 'idle', result: null, error: null, retry: vi.fn() }),
}));

vi.mock('../src/renderer/hooks/useQuotaRefreshOnTurnEnd', () => ({ useQuotaRefreshOnTurnEnd: vi.fn() }));
vi.mock('../src/renderer/hooks/useGatewayBootstrap', () => ({ fetchAgentsForGateway: vi.fn(async () => undefined) }));

const taskState = {
  get activeTaskId() {
    return 'task-1';
  },
  get tasks() {
    return [activeTask()];
  },
  pendingNewTask: null,
  startNewTask: vi.fn(),
  updatePending: vi.fn(),
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

vi.mock('../src/renderer/stores/commercialStore', () => ({
  useCommercialStore: <T,>(selector: (state: { overview: null; load: () => Promise<void> }) => T) =>
    selector({ overview: null, load: vi.fn(async () => undefined) }),
}));

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
  return {
    ...actual,
    RUN_PHASE_IDS: [],
    EMPTY_MESSAGES: [],
    serializeIdentityMd: vi.fn(),
  };
});

import MainArea from '../src/renderer/layouts/MainArea';

const SESSION = 'agent:rongying-content:clawwork:abc:task:task-1';

const readiness = {
  gatewayId: 'gw-1',
  ai: { phase: 'ready' },
  assistants: { phase: 'ready', completed: 6, total: 6, missingIds: [] },
  workspaceAvailable: true,
  conversationReady: true,
  isReady: true,
  hasError: false,
} as unknown as Parameters<typeof MainArea>[0]['startupReadiness'];

function activeTask() {
  return {
    id: 'task-1',
    sessionKey: SESSION,
    sessionId: '',
    title: 'Task 1',
    status: 'active',
    createdAt: '2026-09-17T05:11:54.000Z',
    updatedAt: '2026-09-17T05:11:54.000Z',
    tags: [],
    artifactDir: '',
    gatewayId: 'gw-1',
    agentId: 'rongying-content',
  };
}

function userMessage(id: string, content: string) {
  return {
    id,
    taskId: 'task-1',
    role: 'user',
    content,
    artifacts: [],
    toolCalls: [],
    timestamp: '2026-09-17T05:11:54.000Z',
  };
}

function assistantMessage(id: string, content: string) {
  return {
    id,
    taskId: 'task-1',
    role: 'assistant',
    content,
    artifacts: [],
    toolCalls: [],
    sessionKey: SESSION,
    agentId: 'rongying-content',
    timestamp: '2026-09-17T05:11:55.000Z',
  };
}

/** jsdom 没有 ResizeObserver：捕获 MainArea 注册的回调，用例里手动"内容变了"。 */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.all.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function rect(top: number): DOMRect {
  return {
    top,
    bottom: top,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 视口尺寸用可变的量：用例中途"内容又长高一段"就是改 `metrics.scrollHeight`。 */
function stubViewport(viewport: HTMLElement, metrics: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight });
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => metrics.clientHeight });
  Object.defineProperty(viewport, 'getBoundingClientRect', { configurable: true, value: () => rect(0) });
}

/**
 * 锚点（回答首行）在**内容坐标系**里的位置 = `contentTop`。
 * 真实浏览器里 rect.top 随滚动上移 ⇒ 这里照实模拟成 `contentTop - scrollTop`，
 * 免得"滚过之后读数漂移"的实现也能蒙混过关。
 */
function stubAnchor(anchor: HTMLElement, viewport: HTMLElement, contentTop: number): void {
  Object.defineProperty(anchor, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect(contentTop - viewport.scrollTop),
  });
}

async function fireContentResize(): Promise<void> {
  const observer = FakeResizeObserver.all.at(-1);
  if (!observer) throw new Error('ResizeObserver 没有被创建：MainArea 的自动滚动 effect 没跑到真身');
  await act(async () => {
    observer.fire();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function userScrolls(viewport: HTMLElement, scrollTop: number): Promise<void> {
  await act(async () => {
    viewport.scrollTop = scrollTop;
    viewport.dispatchEvent(new Event('scroll', { bubbles: false }));
  });
}

function setLiveTurn(streamingText: string): void {
  messageState.processingBySession = new Set([SESSION]);
  messageState.activeTurnBySession = {
    [SESSION]: {
      id: 'turn-1',
      streamingText,
      streamingThinking: '',
      toolCalls: [],
      finalized: false,
      content: '',
      timestamp: '2026-09-17T05:11:56.000Z',
    },
  };
}

function renderMainArea(): {
  container: HTMLDivElement;
  viewport: () => HTMLElement;
  answerAnchor: () => HTMLElement | null;
  rerender: () => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const render = () =>
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
  act(() => render());
  return {
    container,
    viewport: () => {
      const viewport = container.querySelector<HTMLElement>('[data-testid="chat-viewport"]');
      if (!viewport) throw new Error('聊天视口没有渲染');
      return viewport;
    },
    /** 时间线里"正在生成/刚生成的那一格"的包装节点 —— 自动滚动的锚点就该是它。 */
    answerAnchor: () => container.querySelector<HTMLElement>('[data-testid="assistant-block"]')?.parentElement ?? null,
    rerender: () => act(() => render()),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('聊天滚动定位：新回答收在首行（用户反馈 #16）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
    FakeResizeObserver.all = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    messageState.messagesByTask = { 'task-1': [userMessage('msg-1', '帮我做一份方案')] };
    messageState.processingBySession = new Set<string>();
    messageState.activeTurnBySession = {};
    Object.assign(window, { clawwork: {} });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('长回答流式：视口钉在该回答首行，不再停在底部（用户得往上翻）', async () => {
    setLiveTurn('很长很长的一段回答');
    const view = renderMainArea();
    const viewport = view.viewport();
    const anchor = view.answerAnchor();
    expect(anchor, '流式那一格的包装节点必须存在（锚点要靠它定位）').not.toBeNull();
    stubViewport(viewport, { scrollHeight: 2000, clientHeight: 400 });
    stubAnchor(anchor!, viewport, 588);

    await fireContentResize();

    expect(viewport.scrollTop, '应钉在回答首行（588 − 余量）').toBe(588 - SCROLL_ANCHOR_MARGIN_PX);
    expect(viewport.scrollTop, '不许停在底部（2000 − 400 = 1600）').not.toBe(1600);
    view.unmount();
  });

  it('短回答流式：整段还装得下 ⇒ 仍跟随到底（跟随体验不变）', async () => {
    setLiveTurn('短');
    const view = renderMainArea();
    const viewport = view.viewport();
    stubViewport(viewport, { scrollHeight: 500, clientHeight: 400 });
    stubAnchor(view.answerAnchor()!, viewport, 300);

    await fireContentResize();

    expect(viewport.scrollTop, '底部 = 500 − 400 = 100').toBe(100);
    view.unmount();
  });

  it('没有正在生成的回答（历史消息）：保持原行为，滚到底', async () => {
    const view = renderMainArea();
    const viewport = view.viewport();
    stubViewport(viewport, { scrollHeight: 900, clientHeight: 400 });

    await fireContentResize();

    expect(viewport.scrollTop).toBe(500);
    view.unmount();
  });

  it('定稿收编后锚点不退场：后续重排不把刚读完的回答甩到底部', async () => {
    setLiveTurn('很长很长的一段回答');
    const view = renderMainArea();
    const viewport = view.viewport();
    stubViewport(viewport, { scrollHeight: 2000, clientHeight: 400 });
    const before = view.answerAnchor()!;
    stubAnchor(before, viewport, 588);
    await fireContentResize();
    expect(viewport.scrollTop).toBe(588 - SCROLL_ANCHOR_MARGIN_PX);

    // `promoteActiveTurn`：定稿 → 收编成正式消息（同一个 DOM 节点、同一个 key）。
    // ⚠️ `processingBySession` **刻意不清**（真身 `promoteActiveTurn` 不动它，turn 收编与
    //    `setProcessing(false)` 是两次 store 写入）：这一刻时间线上会短暂出现**两个同 key 的格**
    //    —— 正式消息 + "等待中"那个尾巴。锚点必须停在**先来的那个**（用户正读的回答），
    //    不能被下面的等待格顶掉，否则长回答会瞬间被甩到底部（本用例就是钉这一条）。
    messageState.activeTurnBySession = {};
    messageState.messagesByTask = {
      'task-1': [userMessage('msg-1', '帮我做一份方案'), assistantMessage('msg-2', '很长很长的一段回答')],
    };
    view.rerender();
    const anchor = view.answerAnchor();
    expect(anchor, '收编后那一格还在').not.toBeNull();
    expect(anchor, '收编前后必须是同一个包装节点').toBe(before);

    await fireContentResize();

    expect(viewport.scrollTop, '重排后仍钉在回答首行').toBe(588 - SCROLL_ANCHOR_MARGIN_PX);
    view.unmount();
  });

  it('用户主动滚回底部：后续增量继续跟随尾部（不抢用户的跟随）', async () => {
    setLiveTurn('很长很长的一段回答');
    const view = renderMainArea();
    const viewport = view.viewport();
    const metrics = { scrollHeight: 2000, clientHeight: 400 };
    stubViewport(viewport, metrics);
    stubAnchor(view.answerAnchor()!, viewport, 588);
    await fireContentResize();
    expect(viewport.scrollTop).toBe(588 - SCROLL_ANCHOR_MARGIN_PX);

    // 用户自己滚到了最底部 —— 之后他也想看着尾部继续长
    await userScrolls(viewport, 1600);
    metrics.scrollHeight = 2100;
    await fireContentResize();

    expect(viewport.scrollTop, '跟随尾部：2100 − 400 = 1700').toBe(1700);
    view.unmount();
  });

  it('用户滚离底部：自动滚动让位，原行为不变', async () => {
    setLiveTurn('很长很长的一段回答');
    const view = renderMainArea();
    const viewport = view.viewport();
    const metrics = { scrollHeight: 2000, clientHeight: 400 };
    stubViewport(viewport, metrics);
    stubAnchor(view.answerAnchor()!, viewport, 588);
    await fireContentResize();

    await userScrolls(viewport, 100);
    metrics.scrollHeight = 2400;
    await fireContentResize();

    expect(viewport.scrollTop, '用户已经滚开 ⇒ 自动滚动不许再动他').toBe(100);
    view.unmount();
  });
});
