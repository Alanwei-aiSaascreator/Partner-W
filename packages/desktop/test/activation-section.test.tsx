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

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
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
