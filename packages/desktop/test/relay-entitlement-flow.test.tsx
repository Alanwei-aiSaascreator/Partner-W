// @vitest-environment jsdom

/**
 * 中转 bootstrap 的**公开状态** → 启动就绪 / 重试 → 这一条接线（Task 4）。
 *
 * 为什么单开一个文件：这条链路横跨三层（主进程的公开状态 → `useStartupReadiness` →
 * 网关/目录/助手的刷新），而它最容易坏的地方**不在断言里能看见的语义**，在两件时序的事：
 *
 *   1. **订阅必须先于初始读**。反过来的话，"订阅之前那一瞬"发生的事件没人收，
 *      而初始读又把更旧的结论盖回去 —— 界面于是把已经确定的失败重新显示成"正在准备"。
 *   2. **晚到的初始读不许覆盖更新的事件**。主进程那条 `updatedAt` 严格单调
 *      （见 `@clawwork/shared` 的事件契约），所以取舍永远判得出来。
 *
 * ⚠️ 判据一律是 **`errorCode` 与相位的配对**，不是"有没有出错"：可重试的才排队重跑，
 *    确定性的（卡绑在别的组织、卡过期…）连重试都不发 —— 那只是让用户做无用功。
 */

import { act, useEffect, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResult, RelayBootstrapPublicState } from '@clawwork/shared';

const gatewayMocks = vi.hoisted(() => ({
  fetchAgentsForGateway: vi.fn(async () => undefined),
  refreshCatalogsForGateway: vi.fn(async (_gatewayId: string, _options?: { isCurrent?: () => boolean }) => undefined),
  reinitializeGatewayBootstrap: vi.fn(async () => undefined),
}));

const coordinatorMocks = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  run: vi.fn(async () => undefined),
  reset: vi.fn(),
}));

// 走真实的网关接线会去碰 electron 侧的东西；这里只关心**有没有被调到**。
vi.mock('../src/renderer/hooks/useGatewayDispatcherSetup', () => gatewayMocks);
// 助手这几轮由另一个文件的用例守着（`startup-preset-agent-lifecycle.test.ts`）：
// 这里把它换成哑的，免得 6 个预设助手的安装过程把这几条时序用例淹掉。
vi.mock('../src/renderer/lib/preset-agent-bootstrap', () => ({
  presetAgentBootstrapCoordinator: coordinatorMocks,
}));

// ── 输入框（ChatInput）渲染级：只留"模型那一格 + 下拉"这条线，其余全换成哑的 ──────
// 📏 与 `chat-input-draft-request.test.tsx` 同一套哑件（那份是既有基线，照抄最稳）：
//    真渲染整个 ChatInput 会拖进语音、附件、@提及、斜杠命令与一堆 Radix 组件，
//    而这几个用例只关心**模型那一格说不说谎**。
const sendMocks = vi.hoisted(() => ({
  modelAvailability: 'models-loading' as 'models-loading' | 'catalog-failed' | 'empty' | 'ready',
  modelLabel: '',
  currentModelEntry: undefined as { id: string; name?: string } | undefined,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// ⚠️ 只把 `div` 需要的两三个 prop 转发下去：`<div {...framerProps}>` 会让 React 对
//    `whileHover` / `whileTap` 这类非 DOM 属性刷一堆警告（同款哑件见
//    `chat-input-draft-request.test.tsx`）。
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  motion: {
    div: ({ children, className }: { children?: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
  useReducedMotion: () => true,
}));

vi.mock('../src/renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) => <button {...props}>{children}</button>,
}));
vi.mock('../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));
// ⚠️ 下拉内容必须**内联渲染**：Radix 只在展开时才挂载内容，而这里要看的就是里面那一块。
vi.mock('../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('../src/renderer/components/semantic/ConfirmDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/ToolbarButton', () => ({
  default: ({ children, ...props }: { children?: ReactNode }) => <button {...props}>{children}</button>,
}));
vi.mock('../src/renderer/components/AgentIcon', () => ({ default: () => null }));
vi.mock('../src/renderer/components/MentionPicker', () => ({ default: () => null }));
vi.mock('../src/renderer/components/SlashArgPicker', () => ({ default: () => null }));
vi.mock('../src/renderer/components/SlashCommandDashboard', () => ({ default: () => null }));
vi.mock('../src/renderer/components/SlashCommandMenu', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ToolsCatalog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/VoiceIntroDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ChatInput/TaskMaterials', () => ({ default: () => null }));
vi.mock('../src/renderer/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    isSupported: false,
    isListening: false,
    isTranscribing: false,
    isIntroOpen: false,
    errorCode: null,
    handleKeyDown: vi.fn(),
    handleKeyUp: vi.fn(),
    confirmIntro: vi.fn(),
    dismissIntro: vi.fn(),
    startFromTrigger: vi.fn(),
    stopListening: vi.fn(),
  }),
}));
vi.mock('../src/renderer/components/ChatInput/useAttachments', () => ({
  useAttachments: () => ({
    pendingAttachments: [],
    setPendingAttachments: vi.fn(),
    removeAttachment: vi.fn(),
    // BUG-028：离开一段对话时输入框会调它清暂存附件（桩必须跟着长）。
    clearAttachments: vi.fn(),
    handlePaste: vi.fn(),
  }),
}));
vi.mock('../src/renderer/components/ChatInput/useTaskMaterials', () => ({
  useTaskMaterials: () => ({
    sources: [],
    selectedImportedFiles: [],
    selectedImportedPaths: new Set<string>(),
    importedFiles: [],
    loadSourceFiles: vi.fn(),
    clearSelectedImportedFiles: vi.fn(),
    markImportedFileMissing: vi.fn(),
    toggleImportedFile: vi.fn(),
    removeImportedFileReference: vi.fn(),
    revokeSource: vi.fn(),
    importFiles: vi.fn(),
    grantFolder: vi.fn(),
  }),
}));
vi.mock('../src/renderer/components/ChatInput/useMentionPicker', () => ({
  useMentionPicker: () => ({
    mentionVisible: false,
    mentionQuery: '',
    mentionIndex: 0,
    setMentionIndex: vi.fn(),
    mentionTab: 'tasks',
    setMentionTab: vi.fn(),
    selectedTasks: [],
    setSelectedTasks: vi.fn(),
    selectedArtifacts: [],
    setSelectedArtifacts: vi.fn(),
    selectedLocalFiles: [],
    setSelectedLocalFiles: vi.fn(),
    mentionItemsRef: { current: [] },
    updateMentionPicker: vi.fn(),
    closeMentionPicker: vi.fn(),
    commitMention: vi.fn(),
    removeSelectedTask: vi.fn(),
    removeSelectedArtifact: vi.fn(),
    removeSelectedLocalFile: vi.fn(),
    handleMentionItemsChange: vi.fn(),
    selectedAgents: [],
    setSelectedAgents: vi.fn(),
    removeSelectedAgent: vi.fn(),
  }),
}));
vi.mock('../src/renderer/components/ChatInput/useSlashAutocomplete', () => ({
  useSlashAutocomplete: () => ({
    slashMenuVisible: false,
    setSlashMenuVisible: vi.fn(),
    slashCommands: [],
    slashIndex: 0,
    setSlashIndex: vi.fn(),
    dashboardOpen: false,
    setDashboardOpen: vi.fn(),
    argPickerVisible: false,
    argPickerCommand: null,
    argPickerOptions: [],
    argPickerIndex: 0,
    setArgPickerIndex: vi.fn(),
    updateSlashMenu: vi.fn(),
    commitSlashCommand: vi.fn(),
    commitArgOption: vi.fn(),
    closeArgPicker: vi.fn(),
  }),
}));
vi.mock('../src/renderer/components/ChatInput/useChatSend', () => ({
  useChatSend: () => ({
    isGenerating: false,
    aborting: false,
    isOffline: false,
    activeTask: null,
    currentModel: 'deepseek-v4-flash',
    currentThinking: 'off',
    modelAvailability: sendMocks.modelAvailability,
    toolsCatalog: null,
    modelLabel: sendMocks.modelLabel,
    currentModelEntry: sendMocks.currentModelEntry,
    currentMode: 'custom',
    modelCatalog: [],
    modelsByProvider: {},
    taskGwId: 'gw-1',
    quotaBlock: null,
    setQuotaBlocked: vi.fn(),
    quotaDegrade: false,
    setQuotaDegrade: vi.fn(),
    switchToFallbackModel: vi.fn(),
    handleSend: vi.fn(),
    handleModelQuickSend: vi.fn(),
    handleThinkingQuickSend: vi.fn(),
    handleAbort: vi.fn(),
    handleToolSelect: vi.fn(),
  }),
}));

import { useStartupReadiness } from '../src/renderer/hooks/useStartupReadiness';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import ChatInput from '../src/renderer/components/ChatInput';
import {
  relayFailureText,
  relayModelStatusCopy,
  startupFailureText,
  type StartupReadiness,
  type StartupRelayFailure,
} from '../src/renderer/lib/startup-readiness';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookState = ReturnType<typeof useStartupReadiness>;
const mountedHarnesses = new Set<() => void>();

afterEach(() => {
  for (const unmount of mountedHarnesses) unmount();
});

function mountHarness(enabled = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let latest: HookState | null = null;

  function Harness() {
    const state = useStartupReadiness(enabled);
    useEffect(() => {
      latest = state;
    }, [state]);
    return null;
  }

  const unmount = () => {
    act(() => root.unmount());
    container.remove();
    mountedHarnesses.delete(unmount);
  };
  mountedHarnesses.add(unmount);

  return {
    get state(): HookState {
      if (!latest) throw new Error('harness 还没渲染出第一帧');
      return latest;
    },
    render: (nextEnabled = enabled) => {
      enabled = nextEnabled;
      act(() => root.render(<Harness />));
    },
    /** 让挂起的 promise / effect 全部落地（`act` 里等一轮微任务）。 */
    flush: async () => {
      await act(async () => undefined);
    },
    unmount,
  };
}

let listeners: Array<(state: RelayBootstrapPublicState) => void> = [];
let order: string[] = [];
let resolveRead: ((value: IpcResult<RelayBootstrapPublicState>) => void) | null = null;
let rejectRead: ((reason: unknown) => void) | null = null;

const relayApi = {
  // 本机运行时那两条（2026-10-07 区 7）：默认**没有问题** —— 既有用例照旧走
  // "重新初始化连接层"那条通用重试路径；要测"运行时起不来"时各自显式改返回值。
  runtimeStatus: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
  runtimeBootstrapRetry: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
  reconnectGateway: vi.fn(async () => undefined),
  onCommercialRelayBootstrapState: vi.fn((callback: (state: RelayBootstrapPublicState) => void) => {
    order.push('subscribe');
    listeners.push(callback);
    return () => {
      listeners = listeners.filter((item) => item !== callback);
    };
  }),
  commercialRelayBootstrapState: vi.fn(
    () =>
      new Promise<IpcResult<RelayBootstrapPublicState>>((resolve, reject) => {
        order.push('read');
        resolveRead = resolve;
        rejectRead = reject;
      }),
  ),
  commercialRelayBootstrapRetry: vi.fn(async () => ({ ok: true })),
  probeWorkspaceFsIdentity: vi.fn(async () => ({ state: 'ok' as const, dev: '1', ino: '2' })),
  ensureOurSkills: vi.fn(async () => ({ ok: true, result: { installed: [], failed: [] } })),
};

function emit(state: RelayBootstrapPublicState): void {
  for (const listener of [...listeners]) listener(state);
}

beforeEach(() => {
  listeners = [];
  order = [];
  resolveRead = null;
  rejectRead = null;
  relayApi.onCommercialRelayBootstrapState.mockClear();
  relayApi.commercialRelayBootstrapState.mockClear();
  relayApi.commercialRelayBootstrapRetry.mockClear();
  relayApi.runtimeStatus.mockReset().mockResolvedValue({ ok: true });
  relayApi.runtimeBootstrapRetry.mockReset().mockResolvedValue({ ok: true });
  relayApi.reconnectGateway.mockClear();
  relayApi.probeWorkspaceFsIdentity.mockClear();
  relayApi.ensureOurSkills.mockClear();
  gatewayMocks.reinitializeGatewayBootstrap.mockClear();
  gatewayMocks.refreshCatalogsForGateway.mockReset().mockResolvedValue(undefined);
  coordinatorMocks.run.mockClear();
  coordinatorMocks.reset.mockClear();

  Object.defineProperty(window, 'clawwork', { configurable: true, value: relayApi });

  // 网关连上了、目录**还没到** —— 这就是"正在准备模型"那个形状的现场。
  useUiStore.setState({
    defaultGatewayId: 'gw-1',
    gatewayStatusMap: { 'gw-1': 'connected' },
    modelCatalogByGateway: {},
  } as never);
});

describe('relay-ready catalog refresh', () => {
  function prepareLocal(status: 'connected' | 'connecting' = 'connected') {
    useUiStore.setState({
      defaultGatewayId: 'local-runtime',
      gatewayStatusMap: { 'local-runtime': status },
      modelCatalogByGateway: { 'local-runtime': [{ id: 'codex-cli', provider: 'codex-cli' }] },
      modelCatalogFailureByGateway: {},
    });
  }

  it('refreshes a nonempty CLI-only catalog when relay configuration becomes ready without resetting runs', async () => {
    prepareLocal();
    gatewayMocks.refreshCatalogsForGateway.mockImplementation(async (gatewayId, options) => {
      if (options?.isCurrent?.()) {
        useUiStore
          .getState()
          .setModelCatalogForGateway(gatewayId, [{ id: 'deepseek-v4-flash', provider: 'clawrouter' }]);
      }
    });
    const harness = mountHarness();
    harness.render();
    expect(harness.state.ai.phase).toBe('error');
    await act(async () => emit({ phase: 'running', updatedAt: 20 }));
    expect(gatewayMocks.refreshCatalogsForGateway).not.toHaveBeenCalled();
    await act(async () => emit({ phase: 'ready', updatedAt: 21 }));
    expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledOnce();
    expect(harness.state.ai.phase).toBe('ready');
    expect(gatewayMocks.reinitializeGatewayBootstrap).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('refreshes once per ready generation and ignores duplicate or older events', async () => {
    prepareLocal();
    const harness = mountHarness();
    harness.render();
    await act(async () => emit({ phase: 'ready', updatedAt: 21 }));
    await act(async () => emit({ phase: 'ready', updatedAt: 21 }));
    await act(async () => emit({ phase: 'ready', updatedAt: 20 }));
    expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledOnce();
    await act(async () => emit({ phase: 'running', updatedAt: 22 }));
    await act(async () => emit({ phase: 'ready', updatedAt: 23 }));
    expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledTimes(2);
    harness.unmount();
  });

  it('⭐ 目录晚热：空结论之后按 0/60/120 有界补问，可用目录一进 store 就停（真机 2026-10-04）', async () => {
    vi.useFakeTimers();
    try {
      prepareLocal();
      gatewayMocks.refreshCatalogsForGateway.mockImplementation(async (gatewayId, options) => {
        if (!options?.isCurrent?.()) return;
        // 第一问（0s）目录还没热 ⇒ 空结论落 store；补问时已经变热。
        const attempt = gatewayMocks.refreshCatalogsForGateway.mock.calls.length;
        useUiStore
          .getState()
          .setModelCatalogForGateway(
            gatewayId,
            attempt === 1 ? [] : [{ id: 'deepseek-v4-flash', provider: 'clawrouter' }],
          );
      });
      const harness = mountHarness();
      harness.render();
      await act(async () => emit({ phase: 'ready', updatedAt: 21 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledTimes(1);
      expect(harness.state.ai.phase).not.toBe('ready'); // 空目录 ≠ 能干活

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000); // +60s 的第一次补问
      });
      expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledTimes(2);
      expect(harness.state.ai.phase).toBe('ready');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000); // 已可用 ⇒ 后续窗口不再问
      });
      expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledTimes(2);
      harness.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('⛔ 补问封顶：始终为空 ⇒ 只在 0/60/120 各问一次，之后不再有计时器', async () => {
    vi.useFakeTimers();
    try {
      prepareLocal();
      gatewayMocks.refreshCatalogsForGateway.mockImplementation(async (gatewayId, options) => {
        if (options?.isCurrent?.()) useUiStore.getState().setModelCatalogForGateway(gatewayId, []);
      });
      const harness = mountHarness();
      harness.render();
      await act(async () => emit({ phase: 'ready', updatedAt: 21 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledTimes(3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600_000);
      });
      expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledTimes(3);
      harness.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('补问窗口在 scope 失效（断连）时立刻停止', async () => {
    vi.useFakeTimers();
    try {
      prepareLocal();
      gatewayMocks.refreshCatalogsForGateway.mockResolvedValue(undefined);
      const harness = mountHarness();
      harness.render();
      await act(async () => emit({ phase: 'ready', updatedAt: 21 }));
      expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledOnce();
      await act(async () => useUiStore.getState().setGatewayStatusByGateway('local-runtime', 'disconnected'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000);
      });
      expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledOnce();
      harness.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the existing local gateway connection without making a new connection', async () => {
    prepareLocal('connecting');
    const harness = mountHarness();
    harness.render();
    await act(async () => emit({ phase: 'ready', updatedAt: 21 }));
    expect(gatewayMocks.refreshCatalogsForGateway).not.toHaveBeenCalled();
    await act(async () => useUiStore.getState().setGatewayStatusByGateway('local-runtime', 'connected'));
    expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledOnce();
    expect(gatewayMocks.reinitializeGatewayBootstrap).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('does not refresh an inactive account and refreshes after the current entry is enabled', async () => {
    prepareLocal();
    const harness = mountHarness(false);
    harness.render();
    await act(async () => emit({ phase: 'ready', updatedAt: 21 }));
    expect(gatewayMocks.refreshCatalogsForGateway).not.toHaveBeenCalled();
    await act(async () => harness.render(true));
    expect(gatewayMocks.refreshCatalogsForGateway).toHaveBeenCalledOnce();
    harness.unmount();
  });

  it('does not apply local relay readiness to a remote gateway', async () => {
    const harness = mountHarness();
    harness.render();
    await act(async () => emit({ phase: 'ready', updatedAt: 21 }));
    expect(gatewayMocks.refreshCatalogsForGateway).not.toHaveBeenCalled();
    harness.unmount();
  });

  it.each(['workspace', 'disabled', 'gateway', 'disconnect', 'relay', 'unmount'] as const)(
    'invalidates an in-flight refresh at the %s boundary',
    async (boundary) => {
      prepareLocal();
      const harness = mountHarness();
      harness.render();
      await act(async () => emit({ phase: 'ready', updatedAt: 21 }));
      const isCurrent = gatewayMocks.refreshCatalogsForGateway.mock.calls[0]?.[1]?.isCurrent;
      expect(isCurrent?.()).toBe(true);
      await act(async () => {
        if (boundary === 'workspace') useTaskStore.getState().resetWorkspace();
        if (boundary === 'disabled') harness.render(false);
        if (boundary === 'gateway') useUiStore.getState().setDefaultGatewayId('gw-remote');
        if (boundary === 'disconnect') useUiStore.getState().setGatewayStatusByGateway('local-runtime', 'disconnected');
        if (boundary === 'relay') emit({ phase: 'idle', updatedAt: 22 });
        if (boundary === 'unmount') harness.unmount();
      });
      expect(isCurrent?.()).toBe(false);
      if (boundary !== 'unmount') harness.unmount();
    },
  );

  it('does not revive an old account refresh after disable and re-enable', async () => {
    prepareLocal();
    const harness = mountHarness();
    harness.render();
    await act(async () => emit({ phase: 'ready', updatedAt: 21 }));
    const oldGuard = gatewayMocks.refreshCatalogsForGateway.mock.calls[0]?.[1]?.isCurrent;
    await act(async () => harness.render(false));
    await act(async () => harness.render(true));
    expect(oldGuard?.()).toBe(false);
    expect(gatewayMocks.refreshCatalogsForGateway.mock.calls.at(-1)?.[1]?.isCurrent?.()).toBe(true);
    harness.unmount();
  });
});

describe('useStartupReadiness × 中转公开状态', () => {
  it('keeps newer media events and clears them at account or bootstrap boundaries', async () => {
    useUiStore.setState({
      defaultGatewayId: 'local-runtime',
      gatewayStatusMap: { 'local-runtime': 'connected' },
      modelCatalogByGateway: { 'local-runtime': [{ id: 'deepseek-v4-flash', provider: 'clawrouter' }] },
    } as never);
    const harness = mountHarness();
    harness.render();
    const media = { image: 'ready' as const, video: 'unavailable' as const };
    act(() => emit({ phase: 'ready', media, updatedAt: 9 }));
    expect(harness.state.media).toEqual(media);
    await act(async () =>
      resolveRead?.({
        ok: true,
        result: {
          phase: 'ready',
          media: { image: 'ready', video: 'ready' },
          updatedAt: 1,
        },
      }),
    );
    expect(harness.state.media).toEqual(media);
    act(() => emit({ phase: 'running', updatedAt: 10 }));
    expect(harness.state.media).toBeUndefined();
    act(() => emit({ phase: 'ready', media, updatedAt: 11 }));
    act(() => emit({ phase: 'idle', updatedAt: 12 }));
    act(() => emit({ phase: 'ready', media, updatedAt: 11 }));
    expect(harness.state.media).toBeUndefined();
    expect(relayApi.commercialRelayBootstrapRetry).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('⭐⭐ 先订阅再读初始快照：晚到的初始读不许把更新的结论盖回去', async () => {
    const harness = mountHarness();
    harness.render();

    // 顺序本身就是断言：读在前、订阅在后的话，"订阅前的最后一次转变"永远收不到。
    expect(order, '订阅必须先于初始读').toEqual(['subscribe', 'read']);
    expect(harness.state.relayFailure, '还没有结论时不许凭空报错').toBeNull();

    // 挂上之后主进程发来一条**确定性的**失败（第二台机器实机的形状）。
    act(() => emit({ phase: 'blocked', errorCode: 'license_bound_elsewhere', updatedAt: 9 }));
    expect(harness.state.relayFailure?.kind).toBe('organization-mismatch');
    expect(harness.state.ai.phase).toBe('error');
    expect(harness.state.composerBlocked, '有结论了就不该再锁着用户').toBe(false);

    // 初始读这时才回来，带着**更旧**的一条（窗口建好之前跑的那一轮）。
    await act(async () => {
      resolveRead?.({ ok: true, result: { phase: 'ready', updatedAt: 1 } });
    });
    expect(harness.state.relayFailure?.kind, '晚到的初始读不许覆盖更新的那条事件').toBe('organization-mismatch');
    expect(harness.state.ai.phase).not.toBe('ready');

    harness.unmount();
  });

  it('⭐ 取舍看 `updatedAt` 而不是"谁先到"：初始读更新时照常生效', async () => {
    const harness = mountHarness();
    harness.render();

    act(() => emit({ phase: 'blocked', errorCode: 'license_expired', updatedAt: 9 }));
    expect(harness.state.relayFailure?.kind).toBe('entitlement-rejected');

    await act(async () => {
      resolveRead?.({ ok: true, result: { phase: 'ready', updatedAt: 12 } });
    });
    expect(harness.state.relayFailure, '更新的那条说了算').toBeNull();
    expect(harness.state.hasError).toBe(false);

    harness.unmount();
  });

  it('⭐⭐ 可重试失败：先排队重跑商业 bootstrap，状态回到 ready 之后才刷网关与助手', async () => {
    const harness = mountHarness();
    harness.render();
    await act(async () => {
      resolveRead?.({ ok: true, result: { phase: 'retryable-error', errorCode: 'transport', updatedAt: 4 } });
    });

    expect(harness.state.relayFailure).toEqual({ kind: 'retryable', errorCode: 'transport' });
    expect(harness.state.composerBlocked).toBe(false);
    gatewayMocks.reinitializeGatewayBootstrap.mockClear();
    coordinatorMocks.run.mockClear();

    await act(async () => {
      await harness.state.retry();
    });
    expect(relayApi.commercialRelayBootstrapRetry, '重试要先让主进程重跑一轮').toHaveBeenCalledOnce();
    expect(
      gatewayMocks.reinitializeGatewayBootstrap,
      '现在就刷是白刷：中转配置还没落上去，目录照样取不到',
    ).not.toHaveBeenCalled();

    // 主进程那一轮跑完了（公开状态翻成 ready）。
    await act(async () => emit({ phase: 'ready', updatedAt: 6 }));
    await harness.flush();
    expect(gatewayMocks.reinitializeGatewayBootstrap).toHaveBeenCalledOnce();
    expect(coordinatorMocks.run, '助手也等 ready 之后再刷').toHaveBeenCalled();
    expect(harness.state.relayFailure).toBeNull();

    harness.unmount();
  });

  it('⭐⭐ 本机运行端起不来：重试**真的重跑一轮 bootstrap**（不再是原地重新初始化连接层）', async () => {
    relayApi.runtimeStatus.mockResolvedValue({ ok: false, reason: 'deploy-failed' });
    relayApi.runtimeBootstrapRetry.mockResolvedValue({ ok: true });
    const harness = mountHarness();
    harness.render();
    await harness.flush();

    await act(async () => {
      await harness.state.retry();
    });

    expect(relayApi.runtimeBootstrapRetry, '主进程那一条自助出口必须被用到').toHaveBeenCalledOnce();
    expect(relayApi.reconnectGateway, '起得来之后要叫网关这条 WS 去连（它可能早就 gaveUp 了）').toHaveBeenCalledWith(
      'gw-1',
    );
    expect(relayApi.commercialRelayBootstrapRetry, '这不是中转那一类失败，别乱发').not.toHaveBeenCalled();
    harness.unmount();
  });

  it('⭐ 重跑之后**还是**起不来：不假装成功（不重连、照旧等主进程那条推送）', async () => {
    relayApi.runtimeStatus.mockResolvedValue({ ok: false, reason: 'port-occupied' });
    relayApi.runtimeBootstrapRetry.mockResolvedValue({ ok: false, reason: 'port-occupied' });
    const harness = mountHarness();
    harness.render();
    await harness.flush();

    await act(async () => {
      await harness.state.retry();
    });

    expect(relayApi.runtimeBootstrapRetry).toHaveBeenCalledOnce();
    expect(relayApi.reconnectGateway, '没起来就别去打扰连接层').not.toHaveBeenCalled();
    harness.unmount();
  });

  it('⭐⭐ 确定性失败不给重试：既不排队重跑，也不刷目录（`license_required` 同样）', async () => {
    const harness = mountHarness();
    harness.render();
    await act(async () => {
      resolveRead?.({ ok: true, result: { phase: 'blocked', errorCode: 'license_bound_elsewhere', updatedAt: 4 } });
    });

    await act(async () => {
      await harness.state.retry();
    });
    expect(relayApi.commercialRelayBootstrapRetry, '再试一万次也是一样的结论').not.toHaveBeenCalled();
    expect(gatewayMocks.reinitializeGatewayBootstrap).not.toHaveBeenCalled();
    expect(coordinatorMocks.reset).not.toHaveBeenCalled();
    expect(harness.state.relayFailure?.kind, '结论不该被重试改掉').toBe('organization-mismatch');

    harness.unmount();
  });

  it('⭐⭐ "读不到"不是"不行了"：初始读失败按"还不知道"走，不许凭空报错', async () => {
    const harness = mountHarness();
    harness.render();

    await act(async () => {
      rejectRead?.(new Error('ipc down'));
    });
    expect(harness.state.relayFailure).toBeNull();
    expect(harness.state.hasError).toBe(false);
    expect(harness.state.ai.phase, '仍然是那条有界的目录推断').toBe('loading-models');
    expect(harness.state.composerBlocked).toBe(true);

    harness.unmount();
  });
});

/**
 * 输入框那一格（模型状态）—— `ChatInput` 把它交给 `relayModelStatusCopy`，
 * 这里钉的是那条覆盖**本身**：已知失败时不许再说"正在准备…"。
 *
 * ⚠️ 为什么要单独钉：`preparing: true` 那一档在界面上的表现是**转圈 + 一句承诺**
 *    （「准备完成后会自动显示，无需重复操作」）。失败已经确定时那句承诺永远不会兑现，
 *    用户照着它等下去就是"卡住"。
 */
describe('relayModelStatusCopy —— 输入框那一格不许再"准备"', () => {
  const t = (key: string): string => key;
  const cases: StartupRelayFailure[] = [
    { kind: 'activation-required', errorCode: 'license_required' },
    { kind: 'organization-mismatch', errorCode: 'license_bound_elsewhere' },
    { kind: 'entitlement-rejected', errorCode: 'license_expired' },
    { kind: 'activation-limit-reached', errorCode: 'activation_limit_reached' },
    { kind: 'retryable', errorCode: 'transport' },
  ];

  it('⭐⭐ 五档失败都是非准备态，而且换掉了"正在准备"那两句', () => {
    for (const failure of cases) {
      const copy = relayModelStatusCopy(failure, t);
      expect(copy.preparing, `${failure.errorCode} 不许转圈`).toBe(false);
      expect(copy.label).toBe('chatInput.modelsUnusable');
      // ⚠️ 标签**不许断言目录缺失**：目录可能好端端的（`relay_apply_failed` 就是这样），
      //    这句只说"手上没有能用的模型"。
      expect(copy.label).not.toBe('chatInput.modelsUnavailable');
      expect(copy.label).not.toBe('chatInput.noModelsAvailable');
      expect(copy.detail).not.toBe('chatInput.modelsLoadingDetail');
      expect(copy.detail).not.toBe('chatInput.aiServiceStartingDetail');
    }
  });

  it('⭐ 每一档说自己的出口（激活 / 组织不一致 / 卡失效 / 名额已满 / 再试一次）', () => {
    const detailFor = (failure: StartupRelayFailure): string => relayModelStatusCopy(failure, t).detail;

    expect(detailFor(cases[0])).toBe('chatInput.relayActivationRequiredDetail');
    expect(detailFor(cases[1])).toBe('chatInput.relayOrganizationMismatchDetail');
    expect(detailFor(cases[2])).toBe('chatInput.relayEntitlementRejectedDetail');
    expect(detailFor(cases[3]), '名额已满与卡失效不是同一句话').toBe('chatInput.relayActivationLimitReachedDetail');
    expect(detailFor(cases[4])).toBe('chatInput.relayRetryableDetail');
  });
});

/**
 * T03：`relay_apply_failed` 的**出口与其余"可重试"档不同** —— 它其实是确定性失败。
 *
 * `relay-startup.ts` 的 `case 'failed'` 刻意把"配置写不进网关/旧配置清理被拒"
 * 映射成 `retryable-error: relay_apply_failed`（DTO 闭集里没有"确定的非-entitlement
 * 失败"这个相位），但主进程给的是 `retryable:false`。其余三档（auth_unavailable /
 * transport / runtime_not_ready）是"等一等真会好"，这一档是"再点也一样，要看日志排查"。
 *
 * ⚠️ 不许新增相位/错误码（闭集冻结）——只在**文案与诊断口径**上把话说准：
 *    保留"可以再试一次"，但要说成**需要排查**，而不是**等待**。
 */
describe('relay_apply_failed 的文案 —— 要排查，不是等着就好（T03）', () => {
  const t = (key: string): string => key;
  const applyFailed: StartupRelayFailure = { kind: 'retryable', errorCode: 'relay_apply_failed' };

  it('⭐ 面板那句话走**独立**文案，不再复用"再试一次会好"那一句', () => {
    // `t` 是恒等函数，所以这里比的就是 i18n 键名。
    expect(relayFailureText(applyFailed, t)).toBe('startupReadiness.relayApplyFailed');
    expect(relayFailureText(applyFailed, t)).not.toBe('startupReadiness.relayRetryable');
  });

  it('⭐ 输入框那一格的 detail 同样独立', () => {
    expect(relayModelStatusCopy(applyFailed, t).detail).toBe('chatInput.relayApplyFailedDetail');
    expect(relayModelStatusCopy(applyFailed, t).detail).not.toBe('chatInput.relayRetryableDetail');
    // 仍然是"非准备态、不转圈"（复用上面那条不变量）。
    expect(relayModelStatusCopy(applyFailed, t).preparing).toBe(false);
  });

  it('⭐⭐ 其余三档**照旧**走"再试一次可能好"那句 —— 别把可重试的也一起说成要排查', () => {
    for (const code of ['auth_unavailable', 'transport', 'runtime_not_ready'] as const) {
      const failure: StartupRelayFailure = { kind: 'retryable', errorCode: code };
      expect(relayFailureText(failure, t), code).toBe('startupReadiness.relayRetryable');
      expect(relayModelStatusCopy(failure, t).detail, code).toBe('chatInput.relayRetryableDetail');
    }
  });
});

describe('startupFailureText —— 同屏两处说的是同一句话', () => {
  const t = (key: string): string => key;
  const base: Omit<StartupReadiness, 'ai' | 'relayFailure'> = {
    gatewayId: 'gw-1',
    assistants: { phase: 'waiting', completed: 0, total: 6, missingIds: [] },
    workspaceAvailable: true,
    conversationReady: false,
    isReady: false,
    hasError: true,
    composerBlocked: false,
  };

  it('⭐⭐ 已知的中转失败：面板与欢迎屏拿到的是同一条结论（不是各说各的）', () => {
    const failure: StartupRelayFailure = { kind: 'organization-mismatch', errorCode: 'license_bound_elsewhere' };
    const readiness = { ...base, ai: { phase: 'error' as const }, relayFailure: failure };

    expect(startupFailureText(readiness, t)).toBe(relayFailureText(failure, t));
    expect(startupFailureText(readiness, t)).toBe('startupReadiness.relayOrganizationMismatch');
  });

  it('⭐ 目录取不到也是结论（说"没能取到"，不是"正在准备"）', () => {
    expect(startupFailureText({ ...base, ai: { phase: 'catalog-failed' }, relayFailure: null }, t)).toBe(
      'startupReadiness.aiCatalogFailed',
    );
  });

  it('⭐ 没有已知失败时**没有**这句话（还在准备照旧转圈，别把"还没结论"说成失败）', () => {
    expect(
      startupFailureText({ ...base, ai: { phase: 'loading-models' }, hasError: false, relayFailure: null }, t),
    ).toBeNull();
    expect(
      startupFailureText({ ...base, ai: { phase: 'starting' }, hasError: false, relayFailure: null }, t),
    ).toBeNull();
    // AI 已经就绪、只是助手没装完：这一格没有"模型不可用"的话要说。
    expect(startupFailureText({ ...base, ai: { phase: 'ready' }, relayFailure: null }, t)).toBeNull();
  });
});

function renderComposer(props: { relayFailure?: StartupRelayFailure | null }): {
  container: HTMLDivElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render((<ChatInput {...props} />) as ReactElement));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/**
 * 输入框（渲染级）—— 复核发现的两个洞都在这里：
 *
 *   #3 下拉里那块明细原来 gate 在 `modelAvailability === 'empty'` 上，而实机观察到的形态是
 *      `models-loading`（relay 失败时 `preparing` 变 false，于是**整块不渲染**）：
 *      用户只剩下 chip 上一个被截断的标签，看不到"为什么"和"怎么办"。
 *   另一条：已知失败时 chip 不许再转圈、也不许说"正在准备模型…"。
 */
describe('ChatInput × 已知中转失败（渲染级）', () => {
  beforeEach(() => {
    sendMocks.modelAvailability = 'models-loading';
    sendMocks.modelLabel = '';
    sendMocks.currentModelEntry = undefined;
  });

  it('⭐⭐ 目录还在取 + 已知失败：chip 不转圈，下拉里的明细不许整块消失', () => {
    const relayFailure: StartupRelayFailure = { kind: 'organization-mismatch', errorCode: 'license_bound_elsewhere' };
    const { container, unmount } = renderComposer({ relayFailure });

    // 假绿防线：这一条只在**没有**已知失败时才该转圈，所以先证明哑件真的把目录设成了"还在取"。
    expect(sendMocks.modelAvailability).toBe('models-loading');
    expect(container.querySelectorAll('.animate-spin'), 'chip 不许转圈').toHaveLength(0);
    expect(container.textContent).toContain('chatInput.modelsUnusable');
    expect(container.textContent).not.toContain('chatInput.modelsLoading');
    expect(container.textContent, '下拉明细要给出"为什么/怎么办"').toContain(
      'chatInput.relayOrganizationMismatchDetail',
    );

    unmount();
  });

  it('⭐ 目录取不到（catalog-failed）同样要给明细（不许只认 `empty` 那一档）', () => {
    sendMocks.modelAvailability = 'catalog-failed';
    const { container, unmount } = renderComposer({ relayFailure: null });

    expect(container.textContent).toContain('chatInput.modelsUnavailable');
    expect(container.textContent, '取不到的明细原来整块不渲染').toContain('chatInput.modelsUnavailableDetail');
    unmount();
  });

  it('⭐ 没有已知失败、目录还在取：照旧是准备态（这条是上面两条的对照）', () => {
    const { container, unmount } = renderComposer({ relayFailure: null });

    expect(container.textContent).toContain('chatInput.modelsLoading');
    expect(container.textContent).toContain('chatInput.modelsLoadingDetail');
    expect(container.querySelectorAll('.animate-spin').length, '真在准备时才转圈').toBeGreaterThan(0);

    unmount();
  });
});

describe('startup filesystem scope isolation', () => {
  beforeEach(() => {
    relayApi.probeWorkspaceFsIdentity.mockReset().mockResolvedValue({ state: 'ok', dev: '1', ino: '2' });
    useUiStore.setState({ defaultGatewayId: 'gw-1', gatewayStatusMap: { 'gw-1': 'connected' } });
  });
  it.each(['workspace', 'gateway', 'disabled', 'unmounted'] as const)(
    'does not bootstrap from a probe after %s replacement',
    async (change) => {
      let finish: ((identity: { state: 'ok'; dev: string; ino: string }) => void) | undefined;
      relayApi.probeWorkspaceFsIdentity.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      relayApi.probeWorkspaceFsIdentity.mockImplementationOnce(() => new Promise(() => {}));
      const harness = mountHarness();
      try {
        harness.render();
        await harness.flush();
        expect(relayApi.probeWorkspaceFsIdentity).toHaveBeenCalledTimes(1);
        if (change === 'workspace')
          act(() => useTaskStore.setState({ workspaceEpoch: useTaskStore.getState().workspaceEpoch + 1 }));
        if (change === 'gateway')
          act(() => useUiStore.setState({ defaultGatewayId: 'gw-2', gatewayStatusMap: { 'gw-2': 'connected' } }));
        if (change === 'disabled') harness.render(false);
        if (change === 'unmounted') harness.unmount();
        await act(async () => finish?.({ state: 'ok', dev: '1', ino: '2' }));
        expect(coordinatorMocks.run).not.toHaveBeenCalled();
        expect(relayApi.ensureOurSkills).not.toHaveBeenCalled();
        if (change !== 'unmounted') expect(harness.state.workspaceAvailable).toBe(false);
      } finally {
        if (change !== 'unmounted') harness.unmount();
      }
    },
  );
  it('hides an old successful probe immediately when the workspace epoch changes', async () => {
    const harness = mountHarness();
    try {
      harness.render();
      await harness.flush();
      expect(harness.state.workspaceAvailable).toBe(true);
      relayApi.probeWorkspaceFsIdentity.mockImplementationOnce(() => new Promise(() => {}));
      act(() => useTaskStore.setState({ workspaceEpoch: useTaskStore.getState().workspaceEpoch + 1 }));
      expect(harness.state.workspaceAvailable).toBe(false);
    } finally {
      harness.unmount();
    }
  });
  it('does not invalidate a new workspace probe when an old retry resumes', async () => {
    let finishRetry: (() => void) | undefined;
    let finishNewProbe: ((identity: { state: 'ok'; dev: string; ino: string }) => void) | undefined;
    const harness = mountHarness();
    try {
      harness.render();
      await harness.flush();
      coordinatorMocks.run.mockClear();
      relayApi.ensureOurSkills.mockClear();
      gatewayMocks.reinitializeGatewayBootstrap.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRetry = () => resolve(undefined);
          }),
      );
      let oldRetry: Promise<void> | undefined;
      act(() => {
        oldRetry = harness.state.retry();
      });
      relayApi.probeWorkspaceFsIdentity.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNewProbe = resolve;
          }),
      );
      act(() => useTaskStore.setState({ workspaceEpoch: useTaskStore.getState().workspaceEpoch + 1 }));
      await harness.flush();
      await act(async () => {
        finishRetry?.();
        await oldRetry;
      });
      await act(async () => finishNewProbe?.({ state: 'ok', dev: '1', ino: '2' }));
      expect(harness.state.workspaceAvailable).toBe(true);
      expect(coordinatorMocks.run).toHaveBeenCalledTimes(1);
      expect(relayApi.ensureOurSkills).toHaveBeenCalledTimes(1);
    } finally {
      harness.unmount();
    }
  });
});
