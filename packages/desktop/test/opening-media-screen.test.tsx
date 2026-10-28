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
  let alive = true;
  const unmount = () => {
    if (!alive) return;
    act(() => root.unmount());
    container.remove();
    alive = false;
  };
  disposers.push(unmount);
  return { container, rerender: (next: ReactElement) => act(() => root.render(next)), unmount };
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

  it('⭐ U3（2026-10-10 基线审查）：后台期间迟到的 canplay 不得起播，回可见才补上', async () => {
    const { container } = render(<OpeningMedia {...mediaProps} />);
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    try {
      await act(async () => container.querySelector('video')!.dispatchEvent(new Event('canplay')));
      expect(playSpy).not.toHaveBeenCalled();
      expect(phaseOf(container)).toBe('idle');
      hidden = false;
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(phaseOf(container)).toBe('playing');
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    }
  });

  it('⭐ U3：stopRequested 之后迟到的 play reject 不得恢复播放', async () => {
    let rejectPlay: (reason: Error) => void = () => {};
    playSpy.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectPlay = reject;
        }),
    );
    const { container, rerender } = render(<OpeningMedia {...mediaProps} />);
    act(() => container.querySelector('video')!.dispatchEvent(new Event('canplay')));
    rerender(<OpeningMedia {...mediaProps} stopRequested />);
    await act(async () => rejectPlay(new Error('synthetic interrupted play')));
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(phaseOf(container)).not.toBe('playing');
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

/**
 * R6（2026-10-10 集中终审 §8）：**所有播放入口共用生命周期许可** ——
 * 与主审 U3 裁判同构的正式回归：pending/hidden 必须 pause、unmute 迟到 resolve
 * 不能救活 stopped、error 作废在途 play、卸载作废在途 reject、动态 reduce-motion
 * 作废在途 resolve；外加 stop/failed/hidden 三个成功控制的迟到 resolve 不落 playing。
 */
describe('OpeningMedia 生命周期许可（R6）', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  const setHidden = (value: boolean): void => {
    Object.defineProperty(document, 'hidden', { configurable: true, value });
  };
  afterEach(() => {
    setHidden(false);
  });

  it('⭐ pending play 遇 hidden：必须 pause（不能只在 playing 相位才暂停）', async () => {
    const work = deferred<void>();
    playSpy.mockReturnValueOnce(work.promise);
    const { container } = render(<OpeningMedia {...mediaProps} />);
    act(() => container.querySelector('video')!.dispatchEvent(new Event('canplay')));
    pauseSpy.mockClear();
    setHidden(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    await act(async () => work.resolve());
    expect(phaseOf(container)).not.toBe('playing');
  });

  it('⭐ unmute 的迟到 resolve 不能把 stopped 相位救活', async () => {
    const { container, rerender } = render(<OpeningMedia {...mediaProps} />);
    await act(async () => container.querySelector('video')!.dispatchEvent(new Event('canplay')));
    const button = container.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    act(() => button.click()); // 静音
    const work = deferred<void>();
    playSpy.mockReturnValueOnce(work.promise);
    act(() => button.click()); // 开声音 → play 挂起
    rerender(<OpeningMedia {...mediaProps} stopRequested />);
    expect(phaseOf(container)).toBe('stopped');
    await act(async () => work.resolve());
    expect(phaseOf(container)).toBe('stopped');
  });

  it('⭐ error 作废在途 play：迟到的 resolve 不许把"无视频"的界面顶成 playing（也不留声音键）', async () => {
    const work = deferred<void>();
    playSpy.mockReturnValueOnce(work.promise);
    const { container } = render(<OpeningMedia {...mediaProps} />);
    act(() => container.querySelector('video')!.dispatchEvent(new Event('canplay')));
    act(() => container.querySelector('video')!.dispatchEvent(new Event('error')));
    expect(phaseOf(container)).toBe('unavailable');
    await act(async () => work.resolve());
    expect(phaseOf(container)).toBe('unavailable');
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('button[aria-pressed]')).toBeNull();
  });

  it('⭐ 卸载作废在途 reject：不许对已脱离文档的视频再 play（不重试）', async () => {
    const work = deferred<void>();
    playSpy.mockReturnValueOnce(work.promise);
    const ui = render(<OpeningMedia {...mediaProps} />);
    act(() => ui.container.querySelector('video')!.dispatchEvent(new Event('canplay')));
    ui.unmount();
    await act(async () => work.reject(new Error('late play rejection')));
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('⭐ 动态开启 reduce-motion：作废在途 resolve（非 playing、无视频、无声音键）', async () => {
    const work = deferred<void>();
    playSpy.mockReturnValueOnce(work.promise);
    const { container, rerender } = render(<OpeningMedia {...mediaProps} />);
    act(() => container.querySelector('video')!.dispatchEvent(new Event('canplay')));
    rerender(<OpeningMedia {...mediaProps} reduceMotion />);
    await act(async () => work.resolve());
    expect(phaseOf(container)).not.toBe('playing');
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('button[aria-pressed]')).toBeNull();
  });

  it.each(['stop', 'failed', 'hidden'] as const)(
    '控制：初次 play 的迟到 resolve 在 %s 之后不得落 playing（play 恰一次）',
    async (change) => {
      const work = deferred<void>();
      playSpy.mockReturnValueOnce(work.promise);
      const ui = render(<OpeningMedia {...mediaProps} />);
      act(() => ui.container.querySelector('video')!.dispatchEvent(new Event('canplay')));
      if (change === 'hidden') {
        setHidden(true);
        act(() => document.dispatchEvent(new Event('visibilitychange')));
      } else {
        ui.rerender(<OpeningMedia {...mediaProps} stopRequested={change === 'stop'} failed={change === 'failed'} />);
      }
      await act(async () => work.resolve());
      expect(phaseOf(ui.container)).not.toBe('playing');
      expect(playSpy).toHaveBeenCalledTimes(1);
    },
  );
});
