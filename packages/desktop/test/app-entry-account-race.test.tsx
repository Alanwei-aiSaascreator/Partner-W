// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

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
  return { useUiStore: (selector: (value: typeof state) => unknown) => selector(state) };
});
vi.mock('../src/renderer/stores/taskStore', () => {
  const state = { startNewTask: vi.fn(), createTask: vi.fn(), setActiveTask: vi.fn() };
  return { useTaskStore: (selector: (value: typeof state) => unknown) => selector(state) };
});
vi.mock('../src/renderer/hooks/useGatewayBootstrap', () => ({ useGatewayBootstrap: vi.fn() }));
vi.mock('../src/renderer/hooks/useWorkspaceRefresh', () => ({ useWorkspaceRefresh: vi.fn() }));
vi.mock('../src/renderer/hooks/useUpdateCheck', () => ({ useUpdateCheck: vi.fn() }));
vi.mock('../src/renderer/hooks/useTraySync', () => ({ useTraySync: vi.fn() }));
vi.mock('../src/renderer/hooks/useModuleOpenTracking', () => ({ useModuleOpenTracking: vi.fn() }));
vi.mock('../src/renderer/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: vi.fn() }));
vi.mock('../src/renderer/hooks/useSettingsBootstrap', () => ({ useSettingsBootstrap: vi.fn() }));
vi.mock('../src/renderer/hooks/useStartupReadiness', () => ({ useStartupReadiness: () => ({ retry: vi.fn() }) }));
vi.mock('../src/renderer/hooks/useDocgenFailureToast', () => ({ useDocgenFailureToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useHtmlgenFailureToast', () => ({ useHtmlgenFailureToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useSlidegenToast', () => ({ useSlidegenToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useClaimGuardToast', () => ({ useClaimGuardToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useDeliveryActivitySubscription', () => ({ useDeliveryActivitySubscription: vi.fn() }));
vi.mock('../src/renderer/lib/gateway-disappearance', () => ({ useGatewayDisappearanceNotice: vi.fn() }));

import App from '../src/renderer/App';
import { loadOnboardingProfile } from '../src/renderer/lib/user-onboarding';

vi.mock('../src/renderer/lib/user-onboarding', () => ({
  loadOnboardingProfile: vi.fn(() => null),
  saveOnboardingProfile: vi.fn(),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    expect(container.querySelector('[data-account="account-B"]')).not.toBeNull();
    expect(loadOnboardingProfile).toHaveBeenCalledWith('account-B');
    expect(commercialSession).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
