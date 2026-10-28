// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import ActivationSection, { activationErrorKey } from '../src/renderer/layouts/Settings/sections/ActivationSection';
import { useCommercialStore } from '../src/renderer/stores/commercialStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 「换一张卡」入口**必须永远在**。
 *
 * ## 为什么单独钉这一条
 *
 * 2026-09-24 的真实客诉：「显示之前绑定的也改不了」。
 * 当时 `ActivationSection` 只要 `licence.activated` 为真就 `return` 一个
 * 「已绑定授权」提示 —— **输入框整个不渲染**，而这是全 App 唯一的激活入口
 * （登录页、引导页都没有）。于是：
 *
 *   · 账号名下有**任何一个** owner 组织有生效的卡（`auth.ts` 的缺陷见
 *     `account-overview-org.test.ts`），界面就宣布"你已绑定"；
 *   · 用户真正想用的那张卡绑在别处时，他连"再输一次"的地方都没有。
 *
 * 修法不是"取消已绑定提示"，而是**在提示旁边永远留一条换卡的路**。
 */

function render(ui: ReactElement): {
  container: HTMLDivElement;
  rerender: (next: ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (next: ReactElement) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function setOverview(activated: boolean): void {
  useCommercialStore.setState({
    status: 'ready',
    errorMessage: '',
    overview: {
      account: { userId: 'u1', phone: '18581821250', email: null, nickname: null, avatar: null },
      org: { id: 'org-owner', name: 'org', plan: 'pro', role: 'owner' },
      license: activated
        ? {
            activated: true,
            licenseId: 'license-1',
            orgId: 'org-owner',
            licenseKey: 'RY-TEST-0001',
            sku: 'USB-内测版',
            status: 'active',
            expiresAt: null,
            tokenQuotaMicros: 5_000_000_000,
            tokenUsedMicros: 0,
          }
        : null,
      device: { fingerprint: 'fp', shortFingerprint: 'fp-short' },
      fetchedAt: '2026-09-24T00:00:00Z',
    },
  });
}

function input(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('input');
}

function clickByText(container: HTMLElement, text: string): void {
  const target = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!target) throw new Error(`没找到按钮：${text}（现有：${container.textContent}）`);
  act(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('ActivationSection', () => {
  beforeEach(() => {
    useCommercialStore.setState({ status: 'idle', overview: null, errorMessage: '' });
  });

  it('已绑定 ⇒ 仍然给一条「换一张卡」的路（点开才出输入框，不喧宾夺主）', () => {
    setOverview(true);
    const { container, unmount } = render(<ActivationSection />);

    expect(container.textContent, '已绑定的提示还在').toContain('activation.boundDesc');
    expect(input(container), '默认不铺开输入框').toBeNull();

    clickByText(container, 'activation.replaceCard');

    expect(input(container), '点「换一张卡」之后输入框必须出现').not.toBeNull();
    expect(input(container)?.getAttribute('aria-label')).toBe('activation.placeholder');
    unmount();
  });

  it('未绑定 ⇒ 输入框直接就在（不需要先点换卡）', () => {
    setOverview(false);
    const { container, unmount } = render(<ActivationSection />);

    expect(input(container)).not.toBeNull();
    expect(container.textContent, '未绑定时不该出现"换一张卡"').not.toContain('activation.replaceCard');
    unmount();
  });

  it('换卡的按钮真的能点开 —— 不是 disabled 的死按钮', () => {
    setOverview(true);
    const { container, unmount } = render(<ActivationSection />);

    const target = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('activation.replaceCard'),
    );
    expect(target, '按钮存在').toBeTruthy();
    expect((target as HTMLButtonElement).disabled, '按钮必须可点').toBe(false);
    unmount();
  });

  it('响应丢失使用专用提示，不冒充普通激活失败', () => {
    expect(activationErrorKey('activation_outcome_unknown')).toBe('activation.errorOutcomeUnknown');
  });
});

/**
 * R2（2026-10-10 集中终审 §4）：显式换卡的生命周期 —— 单飞 / 未知结果恢复 /
 * 存活与 scope 作废 / 辅助刷新失败不改激活事实。与主审 U2 裁判同构的正式回归。
 */
describe('ActivationSection — 生命周期边界（R2）', () => {
  function bridge(overrides: Record<string, unknown> = {}) {
    const api = {
      commercialLicenseActivate: vi.fn(async () => ({ ok: true })),
      commercialLicenseRecoverActivation: vi.fn(async () => ({ ok: true })),
      commercialAccountOverview: vi.fn(async () => ({ ok: true, result: null })),
      commercialUsageReport: vi.fn(async () => 0),
      ...overrides,
    };
    Object.defineProperty(window, 'clawwork', { configurable: true, value: api });
    return api;
  }
  function fillAndSubmit(container: HTMLElement, value: string): void {
    const inputEl = container.querySelector('input');
    if (!inputEl) throw new Error('missing activation input');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputEl, value);
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  }

  beforeEach(() => {
    useCommercialStore.setState({ status: 'idle', overview: null, errorMessage: '' });
  });

  it('⭐ 同帧双 Enter 只发一次激活 IPC（ref 单飞，不靠尚未生效的 busy state）', async () => {
    let finish!: (value: unknown) => void;
    const api = bridge({
      commercialLicenseActivate: vi.fn(() => new Promise((resolve) => (finish = resolve))),
    });
    const { container, unmount } = render(<ActivationSection />);
    fillAndSubmit(container, 'RY-SAME-FRAME');
    // 同一帧里第二次 Enter —— busy state 还没来得及生效
    act(() =>
      container.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(api.commercialLicenseActivate).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    unmount();
  });

  it('⭐ 未知结果：第二次 Enter 先 recover、不再第二次 activate（同卡）', async () => {
    const api = bridge({
      commercialLicenseActivate: vi.fn(async () => ({ ok: false, errorCode: 'activation_outcome_unknown' })),
    });
    const { container, unmount } = render(<ActivationSection />);
    fillAndSubmit(container, 'RY-UNKNOWN');
    await act(async () => {});
    await act(async () => {
      container.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(api.commercialLicenseActivate).toHaveBeenCalledTimes(1);
    expect(api.commercialLicenseRecoverActivation).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('activation.errorOutcomeUnknown');
    unmount();
  });

  it('⭐ 未知结果：换输入也不能绕过 pending（仍先 recover）', async () => {
    const api = bridge({
      commercialLicenseActivate: vi.fn(async () => ({ ok: false, errorCode: 'activation_outcome_unknown' })),
    });
    const { container, unmount } = render(<ActivationSection />);
    fillAndSubmit(container, 'RY-UNKNOWN');
    await act(async () => {});
    fillAndSubmit(container, 'RY-DIFFERENT');
    expect(api.commercialLicenseActivate).toHaveBeenCalledTimes(1);
    expect(api.commercialLicenseRecoverActivation).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('⭐ 卸载后迟到的成功回包：不发 usageReport、不回调（不落任何新操作）', async () => {
    let finish!: (value: unknown) => void;
    const api = bridge({
      commercialLicenseActivate: vi.fn(() => new Promise((resolve) => (finish = resolve))),
    });
    const onActivated = vi.fn();
    const { container, unmount } = render(<ActivationSection onActivated={onActivated} />);
    fillAndSubmit(container, 'RY-LATE');
    unmount();
    await act(async () => finish({ ok: true }));
    expect(api.commercialAccountOverview).not.toHaveBeenCalled();
    expect(api.commercialUsageReport).not.toHaveBeenCalled();
    expect(onActivated).not.toHaveBeenCalled();
  });

  it('⭐ 成功后的辅助统计失败不改写激活事实：无错误文案、仍回调一次', async () => {
    bridge({
      commercialUsageReport: vi.fn(async () => {
        throw new Error('usage report down');
      }),
    });
    const onActivated = vi.fn();
    const { container, unmount } = render(<ActivationSection onActivated={onActivated} />);
    fillAndSubmit(container, 'RY-OK');
    await act(async () => {});
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onActivated).toHaveBeenCalledTimes(1);
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('');
    unmount();
  });

  it('scope 变化（切号）作废在途尝试：不回调、不落任何新操作', async () => {
    let finish!: (value: unknown) => void;
    const api = bridge({
      commercialLicenseActivate: vi.fn(() => new Promise((resolve) => (finish = resolve))),
    });
    const onActivated = vi.fn();
    const ui = render(<ActivationSection accountScope="A" onActivated={onActivated} />);
    fillAndSubmit(ui.container, 'RY-SCOPED');
    ui.rerender(<ActivationSection accountScope="B" onActivated={onActivated} />);
    await act(async () => finish({ ok: true }));
    expect(api.commercialAccountOverview).not.toHaveBeenCalled();
    expect(api.commercialUsageReport).not.toHaveBeenCalled();
    expect(onActivated).not.toHaveBeenCalled();
    ui.unmount();
  });
});
