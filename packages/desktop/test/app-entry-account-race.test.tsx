// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NormalizedOnboardingProfile, OnboardingProfile } from '../src/renderer/lib/user-onboarding';
import type { EntryPreparationProps } from '../src/renderer/layouts/EntryPreparation';

interface OnboardingViewProps {
  userId: string;
  mode?: 'first-run' | 'edit';
  initialProfile?: OnboardingProfile | null;
  onComplete: (profile: OnboardingProfile) => void;
}

type AppProfileFixture = Omit<NormalizedOnboardingProfile, 'version'> & Pick<OnboardingProfile, 'version'>;

const entryFactsFixture = vi.hoisted(() => ({
  startup: {
    gatewayId: 'local-runtime',
    relayPhase: 'ready' as 'ready' | 'running',
    ai: { phase: 'ready' },
    assistants: { phase: 'ready', completed: 6, total: 6, missingIds: [] },
    workspaceAvailable: true,
    conversationReady: true,
    isReady: true,
    hasError: false,
    composerBlocked: false,
    retry: vi.fn(async () => {}),
  },
  workspaceEpoch: 0,
  storeWorkspaceEpoch: null as number | null,
  runtime: { ok: true } as { ok: true } | { ok: false; reason: 'process-exited' },
  connected: true,
  catalogFailed: false,
  settingsOpen: false,
  onboardingProps: null as OnboardingViewProps | null,
  onboardingInstances: 0,
  changeAccount: null as (() => Promise<void>) | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('../src/renderer/lib/toast', () => ({
  Toaster: () => null,
  TOAST_DURATION_MS: 5000,
  TOAST_OPTIONS: {},
  toast: { success: vi.fn() },
}));
vi.mock('../src/renderer/layouts/LeftNav', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/TopBar', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/MainArea', () => ({
  default: ({ onboardingProfile }: { onboardingProfile: OnboardingProfile }) => (
    <div data-workspace-profile={onboardingProfile.userId} data-profile-nickname={onboardingProfile.nickname} />
  ),
}));
vi.mock('../src/renderer/layouts/RightPanel', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/Setup', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/Settings', () => ({
  default: ({ onEditOnboardingProfile }: { onEditOnboardingProfile: () => void }) => (
    <button data-edit-profile onClick={onEditOnboardingProfile} />
  ),
}));
vi.mock('../src/renderer/layouts/Onboarding', () => ({
  default: function OnboardingView(props: OnboardingViewProps) {
    const [instance] = useState(() => ++entryFactsFixture.onboardingInstances);
    entryFactsFixture.onboardingProps = props;
    return <div data-account={props.userId} data-onboarding-instance={instance} />;
  },
}));
vi.mock('../src/renderer/layouts/EntryPreparation', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/renderer/layouts/EntryPreparation')>();
  return {
    default: (props: EntryPreparationProps) => {
      entryFactsFixture.changeAccount = props.onChangeAccount;
      return <original.default {...props} />;
    },
  };
});
vi.mock('../src/renderer/components/ApprovalDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/CommandPalette', () => ({ default: () => null }));
vi.mock('../src/renderer/platform', () => {
  // V3-artifact（2026-10-14）：App 新增的结算通知 hook 经 stores/messageStore 的**转出口**
  // 以函数形态调用 useMessageStore —— 补最小同形桩（选择器 + getState/subscribe）。
  // executionBySession 恒空 ⇒ 通知路径不可达（这些账号竞态用例不涉及交付结算）。
  // C-B（2026-10-15）：App 又挂了额度刷新 hook，它读 processingBySession.size
  // （真实 store 为 Set<string>，见 core message-store）—— 桩必须跟着长（同形纪律）。
  const messageState = {
    executionBySession: {} as Record<string, unknown>,
    processingBySession: new Set<string>(),
  };
  const useMessageStore = (selector?: (state: typeof messageState) => unknown) =>
    selector ? selector(messageState) : messageState;
  Object.assign(useMessageStore, {
    getState: () => messageState,
    setState: () => {},
    subscribe: () => () => {},
  });
  return { composer: {}, useMessageStore };
});
vi.mock('../src/renderer/stores/uiStore', () => {
  const state = {
    defaultGatewayId: 'local-runtime',
    get gatewayStatusMap() {
      return { 'local-runtime': entryFactsFixture.connected ? 'connected' : 'disconnected' };
    },
    modelCatalogByGateway: { 'local-runtime': [{ id: 'deepseek', provider: 'clawrouter' }] },
    get modelCatalogFailureByGateway() {
      return { 'local-runtime': entryFactsFixture.catalogFailed };
    },
    gatewayReconnectInfo: {},
    runtimeBootstrapFailure: null,
    rightPanelOpen: false,
    leftNavCollapsed: false,
    get settingsOpen() {
      return entryFactsFixture.settingsOpen;
    },
    commandPaletteOpen: false,
    mainView: 'chat',
    theme: 'dark',
    leftNavWidth: 224,
    rightPanelWidth: 320,
    // Task 3：App 的视图门会调用（桩必须与真实 store 同形）
    artifactPanelMode: 'list',
    setArtifactPanelMode: vi.fn(),
    // Task 4：App 的布局裁定会读预览宽度偏好
    artifactPreviewWidth: 500,
    setArtifactPreviewWidth: vi.fn(),
    toggleRightPanel: vi.fn(),
    setSettingsOpen: vi.fn((value: boolean) => {
      entryFactsFixture.settingsOpen = value;
    }),
    setMainView: vi.fn(),
    toggleCommandPalette: vi.fn(),
    toggleLeftNavCollapsed: vi.fn(),
    setLeftNavWidth: vi.fn(),
    setRightPanelWidth: vi.fn(),
  };
  return {
    useUiStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('../src/renderer/stores/taskStore', () => {
  const state = {
    startNewTask: vi.fn(),
    createTask: vi.fn(),
    setActiveTask: vi.fn(),
    get workspaceEpoch() {
      return entryFactsFixture.workspaceEpoch;
    },
  };
  return {
    useTaskStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => ({
        ...state,
        workspaceEpoch: entryFactsFixture.storeWorkspaceEpoch ?? entryFactsFixture.workspaceEpoch,
      }),
    }),
  };
});
vi.mock('../src/renderer/hooks/useGatewayBootstrap', () => ({ useGatewayBootstrap: vi.fn() }));
vi.mock('../src/renderer/hooks/useWorkspaceRefresh', () => ({ useWorkspaceRefresh: vi.fn() }));
vi.mock('../src/renderer/hooks/useUpdateCheck', () => ({ useUpdateCheck: vi.fn() }));
vi.mock('../src/renderer/hooks/useTraySync', () => ({ useTraySync: vi.fn() }));
vi.mock('../src/renderer/hooks/useModuleOpenTracking', () => ({ useModuleOpenTracking: vi.fn() }));
vi.mock('../src/renderer/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: vi.fn() }));
vi.mock('../src/renderer/hooks/useSettingsBootstrap', () => ({ useSettingsBootstrap: vi.fn() }));
vi.mock('../src/renderer/hooks/useStartupReadiness', () => ({ useStartupReadiness: () => entryFactsFixture.startup }));
vi.mock('../src/renderer/hooks/useDocgenFailureToast', () => ({ useDocgenFailureToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useHtmlgenFailureToast', () => ({ useHtmlgenFailureToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useVideogenFailureToast', () => ({ useVideogenFailureToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useSlidegenToast', () => ({ useSlidegenToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useClaimGuardToast', () => ({ useClaimGuardToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useDeliveryActivitySubscription', () => ({ useDeliveryActivitySubscription: vi.fn() }));
// V3/V4（2026-10-14）：与上面同族 App 级 hook 一视同仁地 mock —— 账号竞态用例不涉及
// 执行事件订阅与本地历史恢复（真实实现要在 store 里走 tasks/db，超出本档断面）。
vi.mock('../src/renderer/hooks/useExecutionEventsSubscription', () => ({
  useExecutionEventsSubscription: vi.fn(),
  useExecutionHistoryRecovery: vi.fn(),
}));
vi.mock('../src/renderer/hooks/useAutoRetryFailedTurn', () => ({ useAutoRetryFailedTurn: vi.fn() }));
vi.mock('../src/renderer/lib/gateway-disappearance', () => ({ useGatewayDisappearanceNotice: vi.fn() }));

vi.mock('../src/renderer/hooks/useEntryRuntimeStatus', () => ({
  useEntryRuntimeStatus: () => entryFactsFixture.runtime,
}));
vi.mock('../src/renderer/lib/preset-agent-bootstrap', () => ({
  presetAgentBootstrapCoordinator: { getSnapshot: () => entryFactsFixture.startup.assistants },
}));
import App from '../src/renderer/App';
import {
  loadOnboardingProfile,
  loadOnboardingProfileResult,
  requestOnboardingProfileStorageFlush,
  saveOnboardingProfile,
} from '../src/renderer/lib/user-onboarding';

vi.mock('../src/renderer/lib/user-onboarding', () => {
  /**
   * 诊断入口与旧入口**共用同一把 mock**（BUG-034 集成在途）：`loadOnboardingProfileResult`
   * 从 `loadOnboardingProfile` 的返回值派生 reason/profile，所以 App 无论走哪条读取路径，
   * 本文件的 `mockReturnValue` 都照样生效 —— 集成前后这套账号竞态反例都不需要改写。
   */
  const loadOnboardingProfile = vi.fn((_userId: string): unknown => null);
  const reportOnboardingProfileLoad = vi.fn(() => false);
  const reportOnboardingProfileSave = vi.fn(() => false);
  return {
    loadOnboardingProfile,
    loadOnboardingProfileResult: vi.fn((userId: string) => {
      const profile = loadOnboardingProfile(userId);
      return {
        reason: profile ? 'ok' : 'missing',
        profile,
        diagnostic: { keyKind: profile ? 'v3' : null, recordVersion: null, sections: [] },
      };
    }),
    reportOnboardingProfileLoad,
    reportOnboardingProfileSave,
    saveOnboardingProfile: vi.fn(),
    // M3（BUG-034）：保存成功后的 session 刷新请求（App 完成回执接线点）。
    requestOnboardingProfileStorageFlush: vi.fn(),
  };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  entryFactsFixture.startup.relayPhase = 'ready';
  entryFactsFixture.workspaceEpoch = 0;
  entryFactsFixture.storeWorkspaceEpoch = null;
  entryFactsFixture.connected = true;
  entryFactsFixture.runtime = { ok: true };
  entryFactsFixture.catalogFailed = false;
  entryFactsFixture.settingsOpen = false;
  entryFactsFixture.onboardingProps = null;
  entryFactsFixture.onboardingInstances = 0;
  entryFactsFixture.changeAccount = null;
  vi.mocked(loadOnboardingProfile).mockReset().mockReturnValue(null);
  // 诊断入口只清调用记录、保留实现（它从 loadOnboardingProfile 派生）——否则上面的调用计数
  // 断言会被上一个用例污染。
  vi.mocked(loadOnboardingProfileResult).mockClear();
  vi.mocked(saveOnboardingProfile).mockReset();
  vi.mocked(requestOnboardingProfileStorageFlush).mockReset();
});
afterEach(() => vi.useRealTimers());

it('keeps startup account A from replacing explicit login B while OTP is pending', async () => {
  vi.useFakeTimers();
  const session = (userId: string) => ({
    ok: true,
    result: { signedIn: true, profile: { userId, nickname: '' }, orgs: [] },
  });
  let resolveStartup!: (value: ReturnType<typeof session>) => void;
  let resolveOtp!: (value: { ok: boolean }) => void;
  const commercialSession = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStartup = resolve;
        }),
    )
    .mockResolvedValueOnce(session('account-B'));
  const verify = vi.fn(
    () =>
      new Promise<{ ok: boolean }>((resolve) => {
        resolveOtp = resolve;
      }),
  );
  const unsubscribe = () => () => {};
  Object.assign(window, {
    clawwork: {
      reportPortableUpdateRendererReady: vi.fn(),
      setWindowButtonVisibility: vi.fn(),
      isWorkspaceConfigured: async () => true,
      commercialGetConfig: async () => ({
        ok: true,
        result: { supabaseUrl: 'https://example.test', hasAnonKey: true },
      }),
      saveProfile: vi.fn(async () => ({ ok: true })),
      commercialLocalSession: async () => {
        throw new Error('local session unavailable');
      },
      commercialSession,
      commercialSendOtp: async () => ({ ok: true }),
      commercialVerifyOtp: verify,
      commercialLicenseStatus: async () => ({ ok: true, result: activeLicense }),
      onArtifactSaved: unsubscribe,
      onQuickLaunchSubmit: unsubscribe,
      onTrayNavigateTask: unsubscribe,
      onNotificationNavigateTask: unsubscribe,
      onTrayOpenSettings: unsubscribe,
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const submit = () =>
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const input = (selector: string, value: string) => {
    const node = container.querySelector(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };
  try {
    await act(async () => root.render(<App />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    act(() => {
      input('input[type="tel"]', '13800138000');
      (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    });
    await act(async () => {
      submit();
    });
    act(() => input('input[inputmode="numeric"]', '123456'));
    await act(async () => {
      submit();
    });
    expect(verify).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveStartup(session('account-A'));
    });
    expect(container.querySelector('[data-login-region="form"]')).not.toBeNull();
    expect(loadOnboardingProfile).not.toHaveBeenCalledWith('account-A');
    // 直接钉 App 的诊断入口接线（BUG-034）：账号 = B、存储缺省、来源 = entry；A 一次都不许读。
    expect(loadOnboardingProfileResult).not.toHaveBeenCalledWith('account-A', undefined, { source: 'entry' });
    await act(async () => {
      resolveOtp({ ok: true });
    });
    expect(container.querySelector('[data-entry-continue]')).not.toBeNull();
    expect(loadOnboardingProfile).toHaveBeenCalledWith('account-B');
    expect(loadOnboardingProfileResult).toHaveBeenCalledWith('account-B', undefined, { source: 'entry' });
    expect(commercialSession).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

const activeLicense = {
  configured: true,
  activated: true,
  licenseId: 'license',
  orgId: 'org',
  licenseKey: 'RY-EXACT',
  sku: 'USB',
  status: 'active',
  expiresAt: null,
  maxActivations: 1,
  tokenQuotaMicros: 1000,
  tokenUsedMicros: 0,
  deviceFingerprint: 'device',
};
const missingLicense = {
  ...activeLicense,
  configured: false,
  activated: false,
  licenseId: null,
  orgId: null,
  licenseKey: null,
  status: null,
};
function installEntryBridge(overrides: Record<string, unknown> = {}) {
  const unsubscribe = () => () => {};
  const bridge = {
    reportPortableUpdateRendererReady: vi.fn(),
    setWindowButtonVisibility: vi.fn(),
    isWorkspaceConfigured: async () => true,
    commercialGetConfig: async () => ({ ok: true, result: { supabaseUrl: 'https://example.test', hasAnonKey: true } }),
    saveProfile: vi.fn(async () => ({ ok: true })),
    commercialLocalSession: async () => ({ ok: true, result: true }),
    commercialSession: vi.fn(async () => ({
      ok: true,
      result: { signedIn: true, profile: { userId: 'account-A', nickname: '' }, orgs: [] },
    })),
    commercialSendOtp: vi.fn(async () => ({ ok: true })),
    commercialVerifyOtp: vi.fn(async () => ({ ok: true })),
    commercialSignOut: vi.fn(async () => ({ ok: true })),
    runtimeStatus: async () => ({ ok: true }),
    commercialRelayBootstrapState: async () => ({
      ok: true,
      result: { phase: entryFactsFixture.startup.relayPhase, updatedAt: 1 },
    }),
    probeWorkspaceFsIdentity: async () => ({ state: 'ok' }),
    commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: missingLicense })),
    commercialLicenseActivate: vi.fn(async () => ({ ok: true, result: activeLicense })),
    commercialLicenseRecoverActivation: vi.fn(async () => ({ ok: true, result: activeLicense })),
    onArtifactSaved: unsubscribe,
    onQuickLaunchSubmit: unsubscribe,
    onTrayNavigateTask: unsubscribe,
    onNotificationNavigateTask: unsubscribe,
    onTrayOpenSettings: unsubscribe,
    ...overrides,
  };
  Object.assign(window, { clawwork: bridge });
  return bridge;
}
function mountEntry() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    render: async () => act(async () => root.render(<App />)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
    submit: () =>
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    input: (selector: string, value: string) => {
      const input = container.querySelector(selector)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
  };
}
it('keeps an already authenticated account without entitlement at activation and recovers an unknown result without OTP', async () => {
  const activate = vi.fn(async () => ({ ok: false, errorCode: 'activation_outcome_unknown' })),
    recover = vi.fn(async () => ({ ok: true, result: activeLicense }));
  const bridge = installEntryBridge({
      commercialLicenseActivate: activate,
      commercialLicenseRecoverActivation: recover,
    }),
    ui = mountEntry();
  try {
    await ui.render();
    expect(ui.container.querySelector('[data-account]')).toBeNull();
    expect(ui.container.querySelector('input[type="tel"]')).toBeNull();
    expect(ui.container.querySelector('input[type="password"]')).not.toBeNull();
    act(() => ui.input('input[type="password"]', 'RY-EXACT'));
    await act(async () => ui.submit());
    expect(ui.container.textContent).toContain('activation.errorOutcomeUnknown');
    expect(ui.container.querySelector('[data-account]')).toBeNull();
    await act(async () => ui.submit());
    expect(ui.container.querySelector('[data-entry-continue]')).not.toBeNull();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith('RY-EXACT');
    expect(bridge.commercialVerifyOtp).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});
it('uses an existing current entitlement without redeeming on restored authentication', async () => {
  const bridge = installEntryBridge({
      commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })),
    }),
    ui = mountEntry();
  try {
    await ui.render();
    expect(ui.container.querySelector('[data-entry-continue]')).not.toBeNull();
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});
it('does not activate until OTP is accepted and preserves the key through authenticated transition', async () => {
  const verify = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, errorCode: 'otp_verify_failed' })
    .mockResolvedValueOnce({ ok: true });
  const bridge = installEntryBridge({
      commercialLocalSession: async () => ({ ok: true, result: false }),
      commercialVerifyOtp: verify,
    }),
    ui = mountEntry();
  try {
    await ui.render();
    expect(ui.container.querySelector('input[type="password"]')).not.toBeNull();
    act(() => {
      ui.input('input[type="tel"]', '13800138000');
      ui.input('input[type="password"]', 'RY-EXACT');
      (ui.container.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    });
    await act(async () => ui.submit());
    act(() => ui.input('input[inputmode="numeric"]', '123456'));
    await act(async () => ui.submit());
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
    await act(async () => ui.submit());
    expect(bridge.commercialLicenseActivate).toHaveBeenCalledWith('RY-EXACT');
    expect(ui.container.querySelector('[data-entry-continue]')).not.toBeNull();
  } finally {
    ui.unmount();
  }
});
it('keeps explicit local mode separate from commercial activation', async () => {
  const bridge = installEntryBridge({
      commercialGetConfig: async () => ({ ok: true, result: { supabaseUrl: '', hasAnonKey: false } }),
    }),
    ui = mountEntry();
  try {
    await ui.render();
    expect(ui.container.querySelector('[data-account="local"]')).not.toBeNull();
    // 本地模式同样走诊断入口，但来源标签**必须**是 local-entry（不许和商业入口混用）。
    expect(loadOnboardingProfileResult).toHaveBeenCalledWith('local', undefined, { source: 'local-entry' });
    expect(bridge.commercialSession).not.toHaveBeenCalled();
    expect(bridge.commercialLicenseStatus).not.toHaveBeenCalled();
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});

it('does not redeem a displayed account card for a replaced backend session', async () => {
  const session = (userId: string) => ({
    ok: true,
    result: { signedIn: true, profile: { userId, nickname: '' }, orgs: [] },
  });
  const commercialSession = vi
    .fn()
    .mockResolvedValueOnce(session('account-A'))
    .mockResolvedValueOnce(session('account-B'));
  const bridge = installEntryBridge({ commercialSession }),
    ui = mountEntry();
  try {
    await ui.render();
    expect(ui.container.querySelector('input[type="password"]')).not.toBeNull();
    act(() => ui.input('input[type="password"]', 'A-CARD'));
    await act(async () => ui.submit());
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
    expect(ui.container.querySelector('[data-account="account-B"]')).toBeNull();
    expect((ui.container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('A-CARD');
  } finally {
    ui.unmount();
  }
});

it('keeps a licensed account on real preparation until an explicit continue', async () => {
  const bridge = installEntryBridge({
      commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })),
    }),
    ui = mountEntry();
  try {
    await ui.render();
    expect(ui.container.querySelector('[data-entry-continue]')).not.toBeNull();
    expect(ui.container.querySelector('[data-account]')).toBeNull();
    expect(bridge.commercialSession).toHaveBeenCalledTimes(1);
    await act(async () => ui.container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
    expect(ui.container.querySelector('[data-account="account-A"]')).not.toBeNull();
    expect(bridge.commercialSession).toHaveBeenCalledTimes(2);
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});
it('does not unlock preparation from a legacy ready flag while relay is still running', async () => {
  entryFactsFixture.startup.relayPhase = 'running';
  installEntryBridge({ commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })) });
  const ui = mountEntry();
  try {
    await ui.render();
    const button = ui.container.querySelector<HTMLButtonElement>('[data-entry-continue]');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(ui.container.querySelector('[data-account]')).toBeNull();
  } finally {
    ui.unmount();
  }
});
it('refuses a continue whose account changes during final backend verification', async () => {
  const session = (userId: string) => ({
    ok: true,
    result: { signedIn: true, profile: { userId, nickname: '' }, orgs: [] },
  });
  const commercialSession = vi
    .fn()
    .mockResolvedValueOnce(session('account-A'))
    .mockResolvedValueOnce(session('account-B'));
  const bridge = installEntryBridge({
      commercialSession,
      commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })),
    }),
    ui = mountEntry();
  try {
    await ui.render();
    expect(ui.container.querySelector('[data-entry-continue]')).not.toBeNull();
    await act(async () => ui.container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
    expect(ui.container.querySelector('[data-account]')).toBeNull();
    expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain('entryPreparation.recheckFailed');
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});
it('refuses a ready response after the workspace scope is replaced', async () => {
  const session = () => ({
    ok: true,
    result: { signedIn: true, profile: { userId: 'account-A', nickname: '' }, orgs: [] },
  });
  let finish!: (value: ReturnType<typeof session>) => void;
  const commercialSession = vi
    .fn()
    .mockResolvedValueOnce(session())
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
  installEntryBridge({
    commercialSession,
    commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })),
  });
  const ui = mountEntry();
  try {
    await ui.render();
    expect(ui.container.querySelector('[data-entry-continue]')).not.toBeNull();
    await act(async () => ui.container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
    entryFactsFixture.workspaceEpoch = 1;
    await ui.render();
    await act(async () => finish(session()));
    expect(ui.container.querySelector('[data-account]')).toBeNull();
    expect(ui.container.querySelector('[data-entry-continue]')).not.toBeNull();
  } finally {
    ui.unmount();
  }
});

it('checks the live connection store when it changes before React renders the license response', async () => {
  let finish!: (value: { ok: true; result: typeof activeLicense }) => void;
  const status = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, result: activeLicense })
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
  installEntryBridge({ commercialLicenseStatus: status });
  const ui = mountEntry();
  try {
    await ui.render();
    await act(async () => ui.container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
    entryFactsFixture.connected = false;
    await act(async () => finish({ ok: true, result: activeLicense }));
    expect(ui.container.querySelector('[data-account]')).toBeNull();
    expect(ui.container.querySelector('[data-entry-continue]')).not.toBeNull();
  } finally {
    ui.unmount();
  }
});
it.each([
  ['revoked', { ...activeLicense, status: 'revoked' }],
  ['expired', { ...activeLicense, expiresAt: '1970-01-01T00:00:00.000Z' }],
  ['unconfirmed', { ...activeLicense, orgId: null }],
])('removes stale ready facts when final license is %s', async (_label, invalid) => {
  const status = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, result: activeLicense })
    .mockResolvedValueOnce({ ok: true, result: invalid });
  const bridge = installEntryBridge({ commercialLicenseStatus: status }),
    ui = mountEntry();
  try {
    await ui.render();
    await act(async () => ui.container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
    expect(ui.container.querySelector('[data-entry-continue]')).toBeNull();
    expect(ui.container.querySelector('[data-account]')).toBeNull();
    expect(ui.container.querySelector('input[type="password"]')).not.toBeNull();
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});

it('rejects a workspace generation changed in the store before React receives it', async () => {
  let finish!: (value: { ok: true; result: typeof activeLicense }) => void;
  const status = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, result: activeLicense })
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
  installEntryBridge({ commercialLicenseStatus: status });
  const ui = mountEntry();
  try {
    await ui.render();
    await act(async () => ui.container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
    entryFactsFixture.storeWorkspaceEpoch = 1;
    await act(async () => finish({ ok: true, result: activeLicense }));
    expect(ui.container.querySelector('[data-account]')).toBeNull();
    expect(ui.container.querySelector('[data-entry-continue]')).not.toBeNull();
  } finally {
    ui.unmount();
  }
});

it.each(['relay', 'runtime'] as const)(
  'does not overwrite a newer %s failure with an earlier ready snapshot during final workspace read',
  async (kind) => {
    let finish!: (value: { state: 'ok' }) => void;
    installEntryBridge({
      commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })),
      probeWorkspaceFsIdentity: vi.fn(
        () =>
          new Promise((r) => {
            finish = r;
          }),
      ),
    });
    const ui = mountEntry();
    try {
      await ui.render();
      await act(async () => ui.container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
      if (kind === 'relay') entryFactsFixture.startup.relayPhase = 'running';
      else entryFactsFixture.runtime = { ok: false, reason: 'process-exited' };
      await ui.render();
      await act(async () => finish({ state: 'ok' }));
      expect(ui.container.querySelector('[data-account]')).toBeNull();
      expect(ui.container.querySelector('[data-entry-continue]')).not.toBeNull();
      expect(ui.container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.disabled).toBe(true);
    } finally {
      ui.unmount();
    }
  },
);

function onboardingProfileFor(userId: string, version: OnboardingProfile['version'] = 3): AppProfileFixture {
  const profile: AppProfileFixture = {
    version,
    userId,
    nickname: 'Saved account profile',
    role: 'finance',
    customRole: 'Hotel finance',
    useCases: ['office'],
    customGoal: 'Prepare monthly reports',
    selectedAssistantIds: ['family', 'research'],
    responseDetail: 'balanced',
    filePermission: 'ask-every-time',
    completedAt: '2026-10-04T00:00:00.000Z',
  };
  if (version === 3) {
    profile.introduction = 'Prepare hotel budgets';
    profile.industry = { code: 'H', generalConfirmed: false, source: 'user', catalogVersion: 1 };
    profile.questionnaire = { version: 1, answers: ['yes', 'no', null, 'yes'] };
    profile.persona = { id: null, source: 'default', ruleVersion: null };
    profile.workMatch = {
      source: 'ai',
      profileVersion: 'original-profile-version',
      requestId: 'saved-request',
      runId: 'saved-run',
      modelId: 'approved-model',
      summary: 'Original work recommendations',
      starters: ['Keep the selected assistants'],
      usageStatus: 'pending',
    };
  }
  return profile;
}

async function continueToOnboarding(ui: ReturnType<typeof mountEntry>): Promise<void> {
  await ui.render();
  await act(async () => ui.container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
  expect(entryFactsFixture.onboardingProps?.userId).toBe('account-A');
}

it.each([1, 2, 3] as const)(
  'saves the current account profile version %s without changing its receipt or selections',
  async (version) => {
    installEntryBridge({ commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })) });
    const ui = mountEntry();
    const profile = onboardingProfileFor('account-A', version);
    try {
      await continueToOnboarding(ui);
      act(() => entryFactsFixture.onboardingProps!.onComplete(profile));
      // BUG-034 集成（App.tsx）：第一参数 = profile 逐字相等；第 2/3 参 = 存储缺省 + 诊断来源。
      // source **不做宽断言** —— 它就是本轮诊断能力的核验点，换了标签必须在这里现形。
      expect(saveOnboardingProfile).toHaveBeenCalledExactlyOnceWith(profile, undefined, {
        source: 'entry-complete',
      });
      expect(ui.container.querySelector('[data-workspace-profile="account-A"]')).not.toBeNull();
      expect(ui.container.querySelector('[data-account]')).toBeNull();
    } finally {
      ui.unmount();
    }
  },
);

/**
 * M3（BUG-034）：完成回调在**保存成功之后**发起一次 session 刷新请求 —— fire-and-forget，
 * 回执不参与推进（因此不存在"异步等待期间旧回执把新账号/新工作区送进工作台"的窗口），
 * 失败/异常只留诊断。反例矩阵：成功恰一次 / 保存失败不发起且可重试 / 重复回执不重发 /
 * 越界回执不发起 / 回执永不落地也不卡首跑页 / 请求自身抛错照常进工作台。
 */
it('requests exactly one session flush after a successful save (no args, same source as the save)', async () => {
  installEntryBridge({ commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })) });
  const ui = mountEntry();
  const profile = onboardingProfileFor('account-A');
  try {
    await continueToOnboarding(ui);
    act(() => entryFactsFixture.onboardingProps!.onComplete(profile));
    expect(saveOnboardingProfile).toHaveBeenCalledExactlyOnceWith(profile, undefined, { source: 'entry-complete' });
    // 渠道无参数：渲染层不收分区/路径，目标 session 由主进程从 sender 解析。
    expect(requestOnboardingProfileStorageFlush).toHaveBeenCalledExactlyOnceWith('account-A', {
      source: 'entry-complete',
    });
    expect(ui.container.querySelector('[data-workspace-profile="account-A"]')).not.toBeNull();
  } finally {
    ui.unmount();
  }
});

it('does not request a flush when storage throws, and the retry still requests exactly one', async () => {
  const original = { ...onboardingProfileFor('account-A'), version: 3 as const };
  vi.mocked(loadOnboardingProfile).mockReturnValue(original);
  installEntryBridge({ commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })) });
  const ui = mountEntry();
  const updated = { ...original, nickname: 'Edited nickname' };
  try {
    await ui.render();
    await act(async () => ui.container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
    entryFactsFixture.settingsOpen = true;
    await ui.render();
    act(() => ui.container.querySelector<HTMLButtonElement>('[data-edit-profile]')?.click());
    const complete = entryFactsFixture.onboardingProps!.onComplete;
    vi.mocked(saveOnboardingProfile).mockImplementationOnce(() => {
      throw new DOMException('Storage unavailable', 'QuotaExceededError');
    });
    act(() => expect(() => complete(updated)).toThrow('Storage unavailable'));
    // 没保存成功 ⇒ 不许发刷新请求、不许推进；编辑页留住（可重试）。
    expect(requestOnboardingProfileStorageFlush).not.toHaveBeenCalled();
    expect(ui.container.querySelector('[data-workspace-profile]')).toBeNull();
    expect(ui.container.querySelector('[data-onboarding-instance]')).not.toBeNull();
    act(() => entryFactsFixture.onboardingProps!.onComplete(updated));
    expect(requestOnboardingProfileStorageFlush).toHaveBeenCalledTimes(1);
    expect(ui.container.querySelector('[data-profile-nickname="Edited nickname"]')).not.toBeNull();
  } finally {
    ui.unmount();
  }
});

it('accepts a completion once: replaying the identical callback re-saves nothing and re-requests nothing', async () => {
  installEntryBridge({ commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })) });
  const ui = mountEntry();
  const profile = onboardingProfileFor('account-A');
  try {
    await continueToOnboarding(ui);
    const complete = entryFactsFixture.onboardingProps!.onComplete;
    act(() => complete(profile));
    expect(saveOnboardingProfile).toHaveBeenCalledTimes(1);
    act(() => complete(profile)); // 重复回执：同一账号/代次/工作区代次/档案逐字
    expect(saveOnboardingProfile).toHaveBeenCalledTimes(1);
    expect(requestOnboardingProfileStorageFlush).toHaveBeenCalledTimes(1);
  } finally {
    ui.unmount();
  }
});

it('never requests a flush for a completion refused at the boundary (other account profile)', async () => {
  installEntryBridge({ commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })) });
  const ui = mountEntry();
  try {
    await continueToOnboarding(ui);
    act(() => entryFactsFixture.onboardingProps!.onComplete(onboardingProfileFor('account-B')));
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
    expect(requestOnboardingProfileStorageFlush).not.toHaveBeenCalled();
    expect(ui.container.querySelector('[data-account="account-A"]')).not.toBeNull();
  } finally {
    ui.unmount();
  }
});

it('does not await the flush receipt: a never-settling request cannot hold the workspace transition', async () => {
  installEntryBridge({ commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })) });
  const ui = mountEntry();
  try {
    await continueToOnboarding(ui);
    // 永不落地的回执：App 若 await 它，本用例会卡在首跑页（断言立即现形）。
    vi.mocked(requestOnboardingProfileStorageFlush).mockReturnValueOnce(new Promise(() => {}) as unknown as void);
    act(() => entryFactsFixture.onboardingProps!.onComplete(onboardingProfileFor('account-A')));
    expect(ui.container.querySelector('[data-workspace-profile="account-A"]')).not.toBeNull();
    expect(ui.container.querySelector('[data-account]')).toBeNull();
    expect(requestOnboardingProfileStorageFlush).toHaveBeenCalledTimes(1);
  } finally {
    ui.unmount();
  }
});

it('still enters the workspace when the flush request itself throws (best effort, no stuck page)', async () => {
  installEntryBridge({ commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })) });
  const ui = mountEntry();
  try {
    await continueToOnboarding(ui);
    vi.mocked(requestOnboardingProfileStorageFlush).mockImplementationOnce(() => {
      throw new Error('bridge exploded');
    });
    act(() => entryFactsFixture.onboardingProps!.onComplete(onboardingProfileFor('account-A')));
    expect(ui.container.querySelector('[data-workspace-profile="account-A"]')).not.toBeNull();
    expect(ui.container.querySelector('[data-account]')).toBeNull();
  } finally {
    ui.unmount();
  }
});

it('refuses a profile belonging to another account at the final App save boundary', async () => {
  installEntryBridge({ commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })) });
  const ui = mountEntry();
  try {
    await continueToOnboarding(ui);
    act(() => entryFactsFixture.onboardingProps!.onComplete(onboardingProfileFor('account-B')));
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
    expect(ui.container.querySelector('[data-account="account-A"]')).not.toBeNull();
    expect(ui.container.querySelector('[data-workspace-profile]')).toBeNull();
  } finally {
    ui.unmount();
  }
});

it('refuses final save when the live workspace store changed before React receives it', async () => {
  installEntryBridge({ commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })) });
  const ui = mountEntry();
  try {
    await continueToOnboarding(ui);
    const complete = entryFactsFixture.onboardingProps!.onComplete;
    entryFactsFixture.storeWorkspaceEpoch = 1;
    act(() => complete(onboardingProfileFor('account-A')));
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
    expect(ui.container.querySelector('[data-account="account-A"]')).not.toBeNull();
  } finally {
    ui.unmount();
  }
});

it('refuses a retained local save callback after a newer workspace has rendered', async () => {
  installEntryBridge({
    commercialGetConfig: async () => ({ ok: true, result: { supabaseUrl: '', hasAnonKey: false } }),
  });
  const ui = mountEntry();
  try {
    await ui.render();
    const complete = entryFactsFixture.onboardingProps!.onComplete;
    entryFactsFixture.workspaceEpoch = 1;
    await ui.render();
    act(() => complete(onboardingProfileFor('local')));
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
    expect(ui.container.querySelector('[data-account="local"]')).not.toBeNull();
  } finally {
    ui.unmount();
  }
});

it.each(['first-run', 'edit'] as const)(
  'remounts the local %s form when its workspace generation changes',
  async (mode) => {
    if (mode === 'edit')
      vi.mocked(loadOnboardingProfile).mockReturnValue({ ...onboardingProfileFor('local'), version: 3 });
    installEntryBridge({
      commercialGetConfig: async () => ({ ok: true, result: { supabaseUrl: '', hasAnonKey: false } }),
    });
    const ui = mountEntry();
    try {
      await ui.render();
      if (mode === 'edit') {
        entryFactsFixture.settingsOpen = true;
        await ui.render();
        act(() => ui.container.querySelector<HTMLButtonElement>('[data-edit-profile]')?.click());
        expect(entryFactsFixture.onboardingProps?.mode).toBe('edit');
      }
      const originalInstance = ui.container
        .querySelector('[data-onboarding-instance]')!
        .getAttribute('data-onboarding-instance');
      entryFactsFixture.workspaceEpoch = 1;
      await ui.render();
      const currentInstance = ui.container
        .querySelector('[data-onboarding-instance]')!
        .getAttribute('data-onboarding-instance');
      expect(currentInstance).not.toBe(originalInstance);
      expect(saveOnboardingProfile).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  },
);

it('refuses final save as soon as an account change starts while the same account is still rendered', async () => {
  let finish!: (value: { ok: true }) => void;
  installEntryBridge({
    commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })),
    commercialSignOut: vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = resolve;
        }),
    ),
  });
  const ui = mountEntry();
  let changing: Promise<void> | null = null;
  try {
    await continueToOnboarding(ui);
    const complete = entryFactsFixture.onboardingProps!.onComplete;
    act(() => {
      changing = entryFactsFixture.changeAccount!();
      complete(onboardingProfileFor('account-A'));
    });
    expect(saveOnboardingProfile).not.toHaveBeenCalled();
    expect(ui.container.querySelector('[data-account="account-A"]')).not.toBeNull();
  } finally {
    await act(async () => {
      finish({ ok: true });
      await changing;
    });
    ui.unmount();
  }
});

it('refuses a retained save callback after App unmount invalidates authentication', async () => {
  installEntryBridge({ commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })) });
  const ui = mountEntry();
  await continueToOnboarding(ui);
  const complete = entryFactsFixture.onboardingProps!.onComplete;
  ui.unmount();
  complete(onboardingProfileFor('account-A'));
  expect(saveOnboardingProfile).not.toHaveBeenCalled();
});

it('keeps the profile editor mounted when storage throws and permits a current-scope retry', async () => {
  const original = { ...onboardingProfileFor('account-A'), version: 3 as const };
  vi.mocked(loadOnboardingProfile).mockReturnValue(original);
  installEntryBridge({ commercialLicenseStatus: vi.fn(async () => ({ ok: true, result: activeLicense })) });
  const ui = mountEntry();
  const failure = new DOMException('Storage unavailable', 'QuotaExceededError');
  const updated = { ...original, nickname: 'Edited nickname' };
  try {
    await ui.render();
    await act(async () => ui.container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
    entryFactsFixture.settingsOpen = true;
    await ui.render();
    act(() => ui.container.querySelector<HTMLButtonElement>('[data-edit-profile]')?.click());
    expect(entryFactsFixture.onboardingProps?.mode).toBe('edit');
    const instance = ui.container.querySelector('[data-onboarding-instance]')!.getAttribute('data-onboarding-instance');
    const complete = entryFactsFixture.onboardingProps!.onComplete;
    vi.mocked(saveOnboardingProfile).mockImplementationOnce(() => {
      throw failure;
    });
    act(() => expect(() => complete(updated)).toThrow('Storage unavailable'));
    expect(ui.container.querySelector('[data-onboarding-instance]')!.getAttribute('data-onboarding-instance')).toBe(
      instance,
    );
    expect(entryFactsFixture.onboardingProps?.initialProfile).toBe(original);
    expect(ui.container.querySelector('[data-workspace-profile]')).toBeNull();
    act(() => entryFactsFixture.onboardingProps!.onComplete(updated));
    // 两次调用的形状一致：profile 逐字 + (undefined, {source}) —— 失败那次也走同一形状。
    expect(saveOnboardingProfile).toHaveBeenNthCalledWith(1, updated, undefined, { source: 'entry-complete' });
    expect(saveOnboardingProfile).toHaveBeenNthCalledWith(2, updated, undefined, { source: 'entry-complete' });
    expect(ui.container.querySelector('[data-profile-nickname="Edited nickname"]')).not.toBeNull();
    expect(ui.container.querySelector('[data-account]')).toBeNull();
  } finally {
    ui.unmount();
  }
});
