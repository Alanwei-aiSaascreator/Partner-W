// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../src/renderer/i18n/locales/zh.json';

/** 用真实中文文案渲染：这样"提示是中文"才是被验证过的。 */
function translate(key: string, values?: Record<string, unknown>): string {
  let node: unknown = zh;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return key;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'string') return key;
  if (!values) return node;
  return node.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values[name] ?? ''));
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'zh' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// 两个 tab 的内容各自打桩：本任务只验证"壳"与切换，tab 自己的行为在后面的任务测
vi.mock('../src/renderer/layouts/MarketPanel/MarketTab', () => ({
  default: () => <div data-testid="market-tab">market</div>,
}));
vi.mock('../src/renderer/layouts/MarketPanel/MyTemplatesTab', () => ({
  default: () => <div data-testid="my-templates-tab">mine</div>,
}));

import MarketPanel from '../src/renderer/layouts/MarketPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(<MarketPanel />));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function tabButton(container: HTMLElement, text: string): HTMLButtonElement | null {
  return ([...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) ??
    null) as HTMLButtonElement | null;
}

describe('MarketPanel', () => {
  beforeEach(() => {
    Object.assign(window, { clawwork: {} });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('默认显示市场，点「我的模板」切过去', () => {
    const view = render();
    expect(view.container.querySelector('[data-testid="market-tab"]')).not.toBeNull();

    act(() => tabButton(view.container, translate('market.tabMine'))?.click());
    expect(view.container.querySelector('[data-testid="my-templates-tab"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="market-tab"]')).toBeNull();
    view.unmount();
  });

  it('两个 tab 按钮用 aria-selected 标出当前选中的那个', () => {
    const view = render();
    expect(tabButton(view.container, translate('market.tabMarket'))?.getAttribute('aria-selected')).toBe('true');
    expect(tabButton(view.container, translate('market.tabMine'))?.getAttribute('aria-selected')).toBe('false');

    act(() => tabButton(view.container, translate('market.tabMine'))?.click());
    expect(tabButton(view.container, translate('market.tabMine'))?.getAttribute('aria-selected')).toBe('true');
    view.unmount();
  });

  it('面板有稳定的 testid（真机彩排与后续测试都用它定位）', () => {
    const view = render();
    expect(view.container.querySelector('[data-testid="market-panel"]')).not.toBeNull();
    view.unmount();
  });
});
