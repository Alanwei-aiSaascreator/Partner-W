// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
vi.mock('../src/renderer/layouts/MainArea', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/RightPanel', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/Setup', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/Settings', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/Onboarding', () => ({
  default: ({ userId }: { userId: string }) => <div data-account={userId} />,
}));
vi.mock('../src/renderer/components/ApprovalDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/CommandPalette', () => ({ default: () => null }));
vi.mock('../src/renderer/platform', () => ({ composer: {} }));
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
    settingsOpen: false,
    commandPaletteOpen: false,
    mainView: 'chat',
    theme: 'dark',
    leftNavWidth: 224,
    rightPanelWidth: 320,
    toggleRightPanel: vi.fn(),
    setSettingsOpen: vi.fn(),
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
vi.mock('../src/renderer/hooks/useSlidegenToast', () => ({ useSlidegenToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useClaimGuardToast', () => ({ useClaimGuardToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useDeliveryActivitySubscription', () => ({ useDeliveryActivitySubscription: vi.fn() }));
vi.mock('../src/renderer/lib/gateway-disappearance', () => ({ useGatewayDisappearanceNotice: vi.fn() }));

vi.mock('../src/renderer/hooks/useEntryRuntimeStatus', () => ({
  useEntryRuntimeStatus: () => entryFactsFixture.runtime,
}));
vi.mock('../src/renderer/lib/preset-agent-bootstrap', () => ({
  presetAgentBootstrapCoordinator: { getSnapshot: () => entryFactsFixture.startup.assistants },
}));
import App from '../src/renderer/App';
import { loadOnboardingProfile } from '../src/renderer/lib/user-onboarding';

vi.mock('../src/renderer/lib/user-onboarding', () => ({
  loadOnboardingProfile: vi.fn(() => null),
  saveOnboardingProfile: vi.fn(),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  entryFactsFixture.startup.relayPhase = 'ready';
  entryFactsFixture.workspaceEpoch = 0;
  entryFactsFixture.storeWorkspaceEpoch = null;
  entryFactsFixture.connected = true;
  entryFactsFixture.runtime = { ok: true };
  entryFactsFixture.catalogFailed = false;
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
    await act(async () => {
      resolveOtp({ ok: true });
    });
    expect(container.querySelector('[data-entry-continue]')).not.toBeNull();
    expect(loadOnboardingProfile).toHaveBeenCalledWith('account-B');
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
