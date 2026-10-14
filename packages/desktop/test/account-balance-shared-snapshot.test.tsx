// @vitest-environment jsdom
/**
 * BUG-082 / C-B §3：账户页的余额必须是**共用快照**，不是自己的那一份。
 *
 * 事实（2026-10-15 核查）：账户页原来有自己的 `overview/status` state + 自己的
 * `cw:account-overview` 缓存 —— 于是同一时刻屏幕上有两个真源（账户页一个、
 * 顶栏/总览走 commercialStore 另一个），能同时显示两个不同的余额；而账户页那份
 * **永不自愈**，只能靠"重新进这一页 / 重开"。
 *
 * 这组断言锁住：
 *   ① 后台刷新（store 更新）时账户页跟着变 —— 不需要切页/重开；
 *   ② 本页不再写自己的余额缓存；
 *   ③ 余额保留可见小数（1000.40 → 1000.10 看得出来）；
 *   ④ 读不到最新值时**保留最近成功值**并如实给时间/状态，不归零。
 *
 * 渲染方式沿用仓库既有模式（createRoot + act，真实 zh 词表，仅对话框外壳与 IPC 用替身）。
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../src/renderer/i18n/locales/zh.json';

function lookup(locale: unknown, key: string): string {
  let node: unknown = locale;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return key;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : key;
}

function translate(key: string, params?: Record<string, unknown>): string {
  let text = lookup(zh, key);
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{{${name}}}`).join(String(value));
    }
  }
  return text;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'zh' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import AccountSection from '../src/renderer/layouts/Settings/sections/AccountSection';
import { useCommercialStore } from '../src/renderer/stores/commercialStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const overviewMock = vi.fn();

const CREDITS = 1_000_000;

/** 总额 2000 积分；remaining 由 `remainingCredits` 反推。 */
function overviewWithRemaining(remainingCredits: number, fetchedAt = '2026-10-15T10:00:00.000Z') {
  return {
    account: { userId: 'u1', phone: '8618338607148', nickname: '测试用户', avatar: null, email: null },
    org: { id: 'o1', name: '我的空间', plan: 'pro', role: 'owner' },
    license: {
      activated: true,
      licenseId: 'l1',
      orgId: 'o1',
      licenseKey: 'RY-1',
      sku: 'USB-内测版',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: 2000 * CREDITS,
      tokenUsedMicros: (2000 - remainingCredits) * CREDITS,
    },
    device: { fingerprint: 'fp', shortFingerprint: 'DEV-1234' },
    fetchedAt,
  };
}

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderPanel(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<AccountSection onboardingProfile={null} />));
  await flushAsync();
  await flushAsync();
  await flushAsync();
  return host;
}

beforeEach(() => {
  vi.clearAllMocks();
  try {
    localStorage.clear();
  } catch {
    // jsdom 里一定有；这一层只是防御
  }
  (globalThis.window as unknown as Window & typeof globalThis & { clawwork: Record<string, unknown> }).clawwork = {
    commercialAccountOverview: overviewMock.mockResolvedValue({ ok: true, result: overviewWithRemaining(1000.4) }),
    commercialRechargeSkus: vi.fn().mockResolvedValue({ ok: true, result: [] }),
  } as unknown as Window['clawwork'] & Record<string, unknown>;
  useCommercialStore.setState({ overview: overviewWithRemaining(1000.4) as never, status: 'ready', errorMessage: '' });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  document.body.innerHTML = '';
});

describe('账户页余额 = 共用快照（BUG-082 / C-B）', () => {
  it('⭐ 后台刷新把 store 快照更新后，账户页跟着变（不切页、不重开）', async () => {
    const panel = await renderPanel();
    expect(panel.textContent).toContain('1,000.40');

    // 模拟一次后台消费后的轻量刷新（store 快照落新值）
    await act(async () => {
      useCommercialStore.setState({ overview: overviewWithRemaining(1000.1) as never, status: 'ready' });
    });

    expect(panel.textContent).toContain('1,000.10');
    expect(panel.textContent).not.toContain('1,000.40');
  });

  it('⭐ 本页不再写自己的余额缓存（只有 store 那一份）', async () => {
    await renderPanel();
    expect(localStorage.getItem('cw:account-overview')).toBeNull();
    expect(localStorage.getItem('cw:commercial-overview')).not.toBeNull();
  });

  it('⭐ 读不到最新值时保留最近成功值 + 如实给更新时间（不归零）', async () => {
    overviewMock.mockResolvedValue({ ok: false, error: 'network down' });
    const panel = await renderPanel();

    await act(async () => {
      await useCommercialStore.getState().load();
    });

    expect(panel.textContent, '离线也要显示最近一次成功的余额').toContain('1,000.40');
    expect(panel.textContent).toContain(zh.account.offline);
    const syncedAt = panel.querySelector('[data-account-synced-at]');
    expect(syncedAt?.textContent).toContain(new Date('2026-10-15T10:00:00.000Z').toLocaleTimeString());
  });

  it('更新时间跟着快照走（不是本页自己记的时刻）', async () => {
    const panel = await renderPanel();
    await act(async () => {
      useCommercialStore.setState({
        overview: overviewWithRemaining(1000.4, '2026-10-15T12:34:56.000Z') as never,
        status: 'ready',
      });
    });
    expect(panel.querySelector('[data-account-synced-at]')?.textContent).toContain(
      new Date('2026-10-15T12:34:56.000Z').toLocaleTimeString(),
    );
  });
});
