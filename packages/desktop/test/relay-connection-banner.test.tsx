// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import type { RelayLivenessPublicState } from '@clawwork/shared';
import RelayConnectionBanner from '../src/renderer/components/RelayConnectionBanner';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let emit: ((state: RelayLivenessPublicState) => void) | null = null;
let unsubscribe: ReturnType<typeof vi.fn> = vi.fn();
let probe: ReturnType<typeof vi.fn> = vi.fn();

function mount(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render((<RelayConnectionBanner />) as ReactElement));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const flush = (): Promise<void> => act(async () => {});

describe('RelayConnectionBanner', () => {
  beforeEach(() => {
    emit = null;
    unsubscribe = vi.fn();
    probe = vi.fn(async () => ({ ok: true }));
    Object.assign(window, {
      clawwork: {
        onCommercialRelayLivenessState: (cb: (s: RelayLivenessPublicState) => void) => {
          emit = cb;
          return unsubscribe;
        },
        commercialRelayLivenessState: async () => ({ ok: true, result: { phase: 'unknown', updatedAt: 1 } }),
        commercialRelayLivenessProbe: probe,
      },
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('初读 unknown ⇒ 什么都不显示（不许常驻一块假横幅）', async () => {
    const { container, unmount } = mount();
    await flush();
    expect(container.textContent).toBe('');
    unmount();
  });

  it('⭐ down ⇒ 出横幅 + [立即重试] 真的请求探测', async () => {
    const { container, unmount } = mount();
    await flush();
    await act(async () => emit?.({ phase: 'down', updatedAt: 2 }));
    expect(container.textContent).toContain('connection.relayUnreachable');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('connection.retryNow'));
    expect(retry, '断线必须有出口').toBeTruthy();
    act(() => retry?.click());
    expect(probe).toHaveBeenCalled();
    unmount();
  });

  it('⭐ 恢复（up）⇒ 横幅静默消失', async () => {
    const { container, unmount } = mount();
    await flush();
    await act(async () => emit?.({ phase: 'down', updatedAt: 2 }));
    expect(container.textContent).not.toBe('');
    await act(async () => emit?.({ phase: 'up', updatedAt: 3 }));
    expect(container.textContent).toBe('');
    unmount();
  });

  it('⭐ 晚到的旧事件不许覆盖更新的结论（按 updatedAt 取舍）', async () => {
    const { container, unmount } = mount();
    await flush();
    await act(async () => emit?.({ phase: 'up', updatedAt: 9 }));
    await act(async () => emit?.({ phase: 'down', updatedAt: 5 }));
    expect(container.textContent, 'updatedAt=5 比手头的 9 旧，不许翻回去').toBe('');
    unmount();
  });

  it('卸载时退订（返回的退订函数真的被调）', async () => {
    const { unmount } = mount();
    await flush();
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
