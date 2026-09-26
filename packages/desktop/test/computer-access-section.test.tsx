// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { resetSettingsStore } from '../src/renderer/stores/settingsStore';
import { computerAccessApplied, computerAccessRevision } from '../src/renderer/lib/computer-access-runtime';

/**
 * 设置页「电脑操控权限」那一块。
 *
 * ⚠️ 这一组的判据刻意**不撞文案**（文案会随语言变），全部落在 `data-action` 与
 *    **真的发出去了什么载荷**上 —— 上一轮身份中心的教训就是：
 *    「按钮有没有 handler」测不出「点了以后世界有没有变化」。
 */

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

type FakeTask = { id: string; gatewayId: string; sessionKey: string; title: string };
const useTaskStoreFake = create<{
  activeTaskId: string | null;
  tasks: FakeTask[];
}>(() => ({ activeTaskId: null, tasks: [] }));

vi.mock('@/platform', () => {
  // ⚠️ 组件在处理函数里用 `useTaskStore.getState()` 读快照 ⇒ 桩也必须带 `getState`，
  //    否则测出来的失败是夹具的、不是产品的。
  const hook = <T,>(selector: (s: { activeTaskId: string | null; tasks: FakeTask[] }) => T) =>
    useTaskStoreFake(selector);
  hook.getState = useTaskStoreFake.getState;
  return { useTaskStore: hook };
});

vi.mock('../src/renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (open ? <>{children}</> : null),
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

async function flushAsync(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function click(el: Element | null): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function clickAsync(el: Element | null): Promise<void> {
  click(el);
  await flushAsync();
}

const TASK: FakeTask = {
  id: 't1',
  gatewayId: 'local-runtime',
  sessionKey: 'agent:main:t1',
  title: 'T',
};

describe('设置页「电脑操控权限」', () => {
  let patchSession: ReturnType<typeof vi.fn>;
  let updateSettings: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetSettingsStore();
    computerAccessApplied.clear();
    toastError.mockClear();
    toastSuccess.mockClear();
    useTaskStoreFake.setState({ activeTaskId: TASK.id, tasks: [TASK] });

    patchSession = vi.fn().mockResolvedValue({ ok: true });
    updateSettings = vi.fn().mockResolvedValue({ ok: true, config: {} });
    (globalThis.window as unknown as { clawwork: Record<string, unknown> }).clawwork = {
      getSettings: vi.fn().mockResolvedValue({ workspacePath: '/tmp/ws', gateways: [] }),
      updateSettings,
      patchSession,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mountWithSetting(computerAccess: unknown) {
    const ComputerAccessSection = (await import('../src/renderer/layouts/Settings/sections/ComputerAccessSection'))
      .default;
    window.clawwork.getSettings = vi.fn().mockResolvedValue({ workspacePath: '/tmp/ws', gateways: [], computerAccess });
    const { useSettingsStore } = await import('../src/renderer/stores/settingsStore');
    await act(async () => {
      await useSettingsStore.getState().refresh();
    });
    const view = render(<ComputerAccessSection />);
    await flushAsync();
    return view;
  }

  const switchEl = (c: HTMLElement) => c.querySelector('[data-action="computer-access-toggle"]');
  const confirmEl = (c: HTMLElement) => c.querySelector('[data-action="computer-access-confirm"]');
  const ackEl = (c: HTMLElement) => c.querySelector('[data-field="computer-access-ack"]');

  it('缺省是安全档：开关关着', async () => {
    const { container, unmount } = await mountWithSetting(undefined);
    expect(switchEl(container)?.getAttribute('aria-checked')).toBe('false');
    unmount();
  });

  it('判据 2：点开关只弹同意框，**一个写请求都不发**', async () => {
    const { container, unmount } = await mountWithSetting(undefined);
    await clickAsync(switchEl(container));

    expect(confirmEl(container), '同意框该出现').not.toBeNull();
    expect(patchSession, '同意之前不许切会话').not.toHaveBeenCalled();
    expect(updateSettings, '同意之前不许落设置').not.toHaveBeenCalled();
    unmount();
  });

  it('判据 2：没勾选 ⇒ 确认按钮 disabled，点了也不发请求', async () => {
    const { container, unmount } = await mountWithSetting(undefined);
    await clickAsync(switchEl(container));

    expect((confirmEl(container) as HTMLButtonElement).disabled).toBe(true);
    await clickAsync(confirmEl(container));
    expect(patchSession).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
    unmount();
  });

  it('判据 3：勾选 + 确认 ⇒ 真的切当前会话为 full，并把设置落成 full', async () => {
    const { container, unmount } = await mountWithSetting(undefined);
    const revisionBefore = computerAccessRevision();
    await clickAsync(switchEl(container));

    click(ackEl(container));
    await flushAsync();
    await clickAsync(confirmEl(container));

    expect(patchSession).toHaveBeenCalledWith('local-runtime', TASK.sessionKey, { permissionMode: 'full' });
    expect(updateSettings).toHaveBeenCalledWith({ computerAccess: 'full' });
    expect(computerAccessApplied.get(TASK.sessionKey)).toBe('full');
    // ⭐ 开关也必须**通知界面重读**：不通知的话徽章要等切走再切回来才出现（真机抓到过）。
    expect(computerAccessRevision(), '开关那一刻修订号必须前进').toBeGreaterThan(revisionBefore);
    unmount();
  });

  it('判据 6：切会话失败 ⇒ **设置一个字节都不落**，且如实报错（界面不许显示已开）', async () => {
    patchSession.mockResolvedValue({ ok: false, error: 'gateway refused' });
    const { container, unmount } = await mountWithSetting(undefined);
    await clickAsync(switchEl(container));

    click(ackEl(container));
    await flushAsync();
    await clickAsync(confirmEl(container));

    expect(patchSession).toHaveBeenCalled();
    expect(updateSettings, '切失败还落设置 = 界面在说谎').not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    expect(computerAccessApplied.has(TASK.sessionKey)).toBe(false);
    unmount();
  });

  it('判据 5：关掉全权**不弹框**，直接显式写 guarded 收回', async () => {
    const { container, unmount } = await mountWithSetting('full');
    expect(switchEl(container)?.getAttribute('aria-checked')).toBe('true');

    await clickAsync(switchEl(container));

    expect(confirmEl(container), '收回权限不该再要一次同意').toBeNull();
    expect(patchSession).toHaveBeenCalledWith('local-runtime', TASK.sessionKey, { permissionMode: 'guarded' });
    expect(updateSettings).toHaveBeenCalledWith({ computerAccess: 'safe' });
    unmount();
  });

  it('关掉全权时写失败 ⇒ 也不落设置（否则下次启动会以为还开着）', async () => {
    patchSession.mockResolvedValue({ ok: false, error: 'nope' });
    const { container, unmount } = await mountWithSetting('full');

    await clickAsync(switchEl(container));

    expect(updateSettings).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    unmount();
  });
});
