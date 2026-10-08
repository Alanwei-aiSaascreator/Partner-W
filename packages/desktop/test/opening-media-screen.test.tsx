// @vitest-environment jsdom
// 开场片组件测：兜底链（error / 5s 无 canplay / reduceMotion）、循环、后台暂停、声音降级，
// 以及页面级不变式（视频事件绝不改变放行按钮状态）。
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryPreparationFacts } from '../src/renderer/lib/entry-preparation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import OpeningMedia from '../src/renderer/components/OpeningMedia';
import EntryPreparation from '../src/renderer/layouts/EntryPreparation';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const disposers: (() => void)[] = [];
function render(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  disposers.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, rerender: (next: ReactElement) => act(() => root.render(next)) };
}

let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(() => {
  disposers.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const mediaProps = { stopRequested: false, failed: false, reduceMotion: false, pose: 'idle' as const, label: 'L' };
const phaseOf = (container: HTMLElement) =>
  container.querySelector('[data-opening-phase]')?.getAttribute('data-opening-phase');

describe('OpeningMedia 兜底链', () => {
  it('默认渲染：吉祥物在、video 挂载但 idle、无 controls、aria-hidden', () => {
    const { container } = render(<OpeningMedia {...mediaProps} />);
    expect(container.querySelector('svg[data-pose]')).not.toBeNull();
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.controls).toBe(false);
    expect(video?.getAttribute('aria-hidden')).toBe('true');
    expect(phaseOf(container)).toBe('idle');
  });

  it('error 事件 → 视频卸载，吉祥物仍在', async () => {
    const { container } = render(<OpeningMedia {...mediaProps} />);
    await act(async () => container.querySelector('video')?.dispatchEvent(new Event('error')));
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('svg[data-pose]')).not.toBeNull();
    expect(phaseOf(container)).toBe('unavailable');
  });

  it('5s 无 canplay → 视频卸载（慢盘/损坏文件兜底）', () => {
    vi.useFakeTimers();
    const { container } = render(<OpeningMedia {...mediaProps} />);
    expect(container.querySelector('video')).not.toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(container.querySelector('video')).toBeNull();
    expect(phaseOf(container)).toBe('unavailable');
  });

  it('reduceMotion → 从不渲染视频、从不调用 play', () => {
    const { container } = render(<OpeningMedia {...mediaProps} reduceMotion />);
    expect(container.querySelector('video')).toBeNull();
    expect(playSpy).not.toHaveBeenCalled();
    expect(phaseOf(container)).toBe('unavailable');
  });
});

describe('OpeningMedia 播放与循环', () => {
  it('canplay → 起播（playing），loop=true，ended 不改变相位', async () => {
    const { container } = render(<OpeningMedia {...mediaProps} />);
    const video = container.querySelector('video')!;
    await act(async () => video.dispatchEvent(new Event('canplay')));
    expect(playSpy).toHaveBeenCalled();
    expect(phaseOf(container)).toBe('playing');
    expect(video.loop).toBe(true);
    await act(async () => video.dispatchEvent(new Event('ended')));
    expect(phaseOf(container)).toBe('playing');
  });

  it('stopRequested → pause + stopped，本挂载内不再播', async () => {
    const { container, rerender } = render(<OpeningMedia {...mediaProps} />);
    await act(async () => container.querySelector('video')!.dispatchEvent(new Event('canplay')));
    expect(phaseOf(container)).toBe('playing');
    rerender(<OpeningMedia {...mediaProps} stopRequested />);
    expect(pauseSpy).toHaveBeenCalled();
    expect(phaseOf(container)).toBe('stopped');
  });

  it('failed → pause（错误信息成为唯一焦点）', async () => {
    const { container, rerender } = render(<OpeningMedia {...mediaProps} />);
    await act(async () => container.querySelector('video')!.dispatchEvent(new Event('canplay')));
    pauseSpy.mockClear();
    rerender(<OpeningMedia {...mediaProps} failed />);
    expect(pauseSpy).toHaveBeenCalled();
  });

  it('后台暂停：hidden → pause；恢复可见 → 续播；stopped 后恢复可见不续播', async () => {
    const { container } = render(<OpeningMedia {...mediaProps} />);
    await act(async () => container.querySelector('video')!.dispatchEvent(new Event('canplay')));
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    try {
      pauseSpy.mockClear();
      playSpy.mockClear();
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      hidden = false;
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      expect(playSpy).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    }
  });
});

describe('OpeningMedia 声音策略', () => {
  it('正常路径：带声 play 成功 → 按钮为"静音"态（aria-pressed=false）', async () => {
    const { container } = render(<OpeningMedia {...mediaProps} />);
    await act(async () => container.querySelector('video')!.dispatchEvent(new Event('canplay')));
    const button = container.querySelector('button[aria-pressed]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.textContent).toContain('entryPreparation.mediaMute');
    expect(container.querySelector('video')!.muted).toBe(false);
  });

  it('被拒降级：静音继续播 + 按钮切"打开声音"（aria-pressed=true）；点击恢复声音', async () => {
    playSpy.mockReset();
    playSpy.mockImplementationOnce(() => Promise.reject(new Error('autoplay blocked')));
    playSpy.mockImplementation(() => Promise.resolve());
    const { container } = render(<OpeningMedia {...mediaProps} />);
    await act(async () => container.querySelector('video')!.dispatchEvent(new Event('canplay')));
    const video = container.querySelector('video')!;
    expect(phaseOf(container)).toBe('playing');
    expect(video.muted).toBe(true);
    const button = container.querySelector('button[aria-pressed]');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.textContent).toContain('entryPreparation.mediaUnmute');
    await act(async () => (button as HTMLButtonElement).click());
    expect(video.muted).toBe(false);
    expect(container.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('页面级不变式（视频事件绝不改变放行）', () => {
  const facts: EntryPreparationFacts = {
    scopeKey: 'A',
    currentScopeKey: 'A',
    accountUserId: 'A',
    entitlement: { userId: 'A', licenseId: 'L', orgId: 'O', status: 'active', expiresAt: null },
    runtime: { ok: true },
    startup: {
      gatewayId: 'local-runtime',
      relayPhase: 'ready',
      ai: { phase: 'ready' },
      assistants: { phase: 'ready', completed: 6, total: 6, missingIds: [] },
      workspaceAvailable: true,
      conversationReady: true,
      isReady: true,
      hasError: false,
      composerBlocked: false,
    },
  };
  const callbacks = () => ({
    onContinue: vi.fn(async () => {}),
    onRetry: vi.fn(async () => {}),
    onChangeAccount: vi.fn(async () => {}),
    onChooseWorkspace: vi.fn(),
  });

  it('未就绪时 dispatch canplay/playing/timeupdate/ended/animationend → 按钮仍 disabled、onContinue 未被调用', async () => {
    const cb = callbacks();
    const pending = { ...facts, startup: { ...facts.startup, relayPhase: 'running' as const } };
    const { container } = render(<EntryPreparation facts={pending} {...cb} />);
    const button = container.querySelector<HTMLButtonElement>('[data-entry-continue]');
    const video = container.querySelector('video');
    expect(button?.disabled).toBe(true);
    await act(async () => {
      video?.dispatchEvent(new Event('canplay'));
      video?.dispatchEvent(new Event('playing'));
      video?.dispatchEvent(new Event('timeupdate'));
      video?.dispatchEvent(new Event('ended'));
      container.querySelector('[data-entry-animation]')?.dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(button?.disabled).toBe(true);
    expect(cb.onContinue).not.toHaveBeenCalled();
  });

  it('就绪 → 按钮弹出且可用、视频继续播；点击继续 → 视频暂停+淡出（stopped）、随后正常放行', async () => {
    const cb = callbacks();
    const { container } = render(<EntryPreparation facts={facts} {...cb} />);
    const video = container.querySelector('video')!;
    await act(async () => video.dispatchEvent(new Event('canplay')));
    expect(phaseOf(container)).toBe('playing');
    const button = container.querySelector<HTMLButtonElement>('[data-entry-continue]');
    expect(button?.disabled).toBe(false);
    pauseSpy.mockClear();
    await act(async () => button?.click());
    expect(cb.onContinue).toHaveBeenCalledTimes(1);
    expect(pauseSpy).toHaveBeenCalled();
    expect(phaseOf(container)).toBe('stopped');
  });
});
