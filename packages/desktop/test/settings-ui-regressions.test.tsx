// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../src/renderer/context/ThemeProvider';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { resetSettingsStore } from '../src/renderer/stores/settingsStore';
import GatewaysSection from '../src/renderer/layouts/Settings/sections/GatewaysSection';
import AccountSection from '../src/renderer/layouts/Settings/sections/AccountSection';
import AboutSection from '../src/renderer/layouts/Settings/sections/AboutSection';
import type { OnboardingProfile } from '../src/renderer/lib/user-onboarding';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function render(element: React.ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(element);
  });

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('settings UI regressions', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useUiStore.setState({
      theme: 'auto',
      density: 'comfortable',
      gatewayInfoMap: {},
      gatewayStatusMap: {},
      defaultGatewayId: null,
    });
    resetSettingsStore();

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    (globalThis.window as unknown as Window & typeof globalThis & { clawwork: Record<string, unknown> }).clawwork = {
      getSettings: vi.fn().mockResolvedValue(null),
      updateSettings: vi.fn().mockResolvedValue({ ok: true, config: {} }),
      getQuickLaunchConfig: vi.fn().mockResolvedValue({ enabled: false, shortcut: 'Alt+Space', sendShortcut: 'enter' }),
      getTrayEnabled: vi.fn().mockResolvedValue(true),
      setTrayEnabled: vi.fn().mockResolvedValue(true),
      testGateway: vi.fn().mockResolvedValue({ ok: true }),
      updateGateway: vi.fn().mockResolvedValue({ ok: true }),
      addGateway: vi.fn().mockResolvedValue({ ok: true }),
      removeGateway: vi.fn().mockResolvedValue({ ok: true }),
      setDefaultGateway: vi.fn().mockResolvedValue({ ok: true }),
      commercialAccountOverview: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          account: { id: 'user-1', phone: '8618338607148', nickname: '测试用户', avatar: null, email: null },
          org: null,
          license: null,
          device: { shortFingerprint: 'DEV-1234' },
          fetchedAt: '2026-09-16T00:00:00.000Z',
        },
      }),
      commercialRechargeSkus: vi.fn().mockResolvedValue({ ok: true, result: [] }),
    } as unknown as Window['clawwork'] & Record<string, unknown>;
  });

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  it('does not persist the default auto theme before loading saved settings', async () => {
    const getSettings = vi.fn().mockResolvedValue({
      workspacePath: '/tmp/workspace',
      gateways: [],
      theme: 'light',
    });
    const updateSettings = vi.fn().mockResolvedValue({ ok: true, config: {} });
    window.clawwork.getSettings = getSettings;
    window.clawwork.updateSettings = updateSettings;

    const { unmount } = render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );

    expect(updateSettings).not.toHaveBeenCalled();

    await flushAsync();
    await flushAsync();

    expect(useUiStore.getState().theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(updateSettings).not.toHaveBeenCalled();

    unmount();
  });

  it('syncs the default gateway into the ui store when settings are loaded', async () => {
    window.clawwork.getSettings = vi.fn().mockResolvedValue({
      workspacePath: '/tmp/workspace',
      defaultGatewayId: 'gw-2',
      gateways: [
        { id: 'gw-1', name: 'Gateway 1', url: 'ws://127.0.0.1:18789' },
        { id: 'gw-2', name: 'Gateway 2', url: 'ws://127.0.0.1:28789' },
      ],
    });

    const { unmount } = render(<GatewaysSection />);

    await flushAsync();
    await flushAsync();
    await flushAsync();

    expect(useUiStore.getState().defaultGatewayId).toBe('gw-2');

    unmount();
  });

  it('shows the saved work profile and opens the editor without signing out', async () => {
    const profile: OnboardingProfile = {
      version: 2,
      userId: 'user-1',
      nickname: '小荣',
      role: 'operations',
      customRole: '',
      useCases: ['content', 'ecommerce'],
      customGoal: '每周整理经营数据并生成活动文案',
      selectedAssistantIds: ['content', 'ecommerce'],
      responseDetail: 'balanced',
      filePermission: 'ask-every-time',
      completedAt: '2026-09-16T00:00:00.000Z',
    };
    const onEditProfile = vi.fn();
    const { container, unmount } = render(<AccountSection onboardingProfile={profile} onEditProfile={onEditProfile} />);

    await flushAsync();
    await flushAsync();

    const editButton = container.querySelector('[data-account-purpose-edit]') as HTMLButtonElement;
    expect(editButton).not.toBeNull();
    expect(container.textContent).toContain('每周整理经营数据并生成活动文案');
    act(() => editButton.click());
    expect(onEditProfile).toHaveBeenCalledTimes(1);
    expect(window.clawwork.commercialSignOut).toBeUndefined();

    unmount();
  });
});

/**
 * 关于面板的更新检查。
 *
 * 2026-09-17 实机日志（×10）：面板把 electron-updater 的英文原文直接渲染出来 ——
 * `Cannot find channel "latest.yml" update info: HttpError: 404 Not Found`。
 * 而更新服务**当时还没部署**，等于每次打开设置都甩一段英文堆栈。
 */
describe('AboutSection —— 更新失败要说人话', () => {
  it('⭐ 404 不留英文堆栈，说明"更新清单还没就绪"', async () => {
    Object.assign(window, {
      clawwork: {
        ...(window as unknown as { clawwork?: object }).clawwork,
        checkForUpdates: vi.fn(async () => {
          throw new Error('Error: Cannot find channel "latest.yml" update info: HttpError: 404 Not Found');
        }),
        onUpdateError: vi.fn(() => () => {}),
        onUpdateDownloaded: vi.fn(() => () => {}),
        onUpdateDownloadProgress: vi.fn(() => () => {}),
        getDeviceId: vi.fn(async () => 'device-1'),
        getAppVersion: vi.fn(async () => '0.0.16'),
        reportDebugEvent: vi.fn(),
        getUpdateChannel: vi.fn(async () => 'stable'),
        setUpdateChannel: vi.fn(async () => ({ ok: true })),
        installUpdate: vi.fn(async () => ({ ok: true })),
        downloadUpdate: vi.fn(async () => ({ ok: true })),
      },
    });

    const { container, unmount } = render(<AboutSection />);
    // 挂载后的检查是一条 then/catch 链，光等微任务不够 —— 让它跑完一个宏任务
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      (window as unknown as { clawwork: { checkForUpdates: ReturnType<typeof vi.fn> } }).clawwork.checkForUpdates,
      '挂载时应当发起一次检查',
    ).toHaveBeenCalled();
    expect(container.textContent).toContain('更新清单');
    expect(container.textContent).not.toContain('HttpError');
    expect(container.textContent).not.toContain('latest.yml');
    expect(container.textContent).not.toContain('404');

    unmount();
  });
});
