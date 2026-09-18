// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useModuleOpenTracking } from '../src/renderer/hooks/useModuleOpenTracking';
import { createModuleOpenTracker } from '../src/renderer/lib/module-open-tracking';
import { useUiStore } from '../src/renderer/stores/uiStore';

/**
 * `module_opened` 是渲染层唯一主动上报的事件（切主视图时）。
 *
 * 两条必须钉住的性质：
 *   ① **同模块 60 秒一次** —— 用户来回切页（侧栏 / 命令面板 / 快捷键各是一个调用点）
 *      不能把看板刷成一堆重复的「打开模块」；
 *   ② **节流表在模块作用域** —— 放进组件里的话，任何一次重挂载都会把它清零，
 *      于是「切走再切回来」就又能发一遍，① 等于没做。
 *
 * ⚠️ 60_000 是**产品口径**（不是实现细节），所以这里写死而不是 import 常量：
 *    实现换成 30 秒或 5 分钟都应该让这条测试红。
 */
const THROTTLE_MS = 60_000;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactElement): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function Probe(): null {
  useModuleOpenTracking();
  return null;
}

describe('module_opened 节流单元（时钟与发送函数都可注入）', () => {
  it('同模块 60 秒内只发一次', () => {
    const sent: string[] = [];
    let now = 0;
    const track = createModuleOpenTracker({ now: () => now, send: (module) => sent.push(module) });

    track('chat');
    now = THROTTLE_MS - 1;
    track('chat');

    expect(sent).toEqual(['chat']);
  });

  it('满 60 秒之后同一模块可以再发', () => {
    const sent: string[] = [];
    let now = 0;
    const track = createModuleOpenTracker({ now: () => now, send: (module) => sent.push(module) });

    track('chat');
    now = THROTTLE_MS;
    track('chat');

    expect(sent).toEqual(['chat', 'chat']);
  });

  it('不同模块各记各的，互不影响', () => {
    const sent: string[] = [];
    let now = 0;
    const track = createModuleOpenTracker({ now: () => now, send: (module) => sent.push(module) });

    track('chat');
    track('growth');
    now = THROTTLE_MS - 1;
    track('chat');

    expect(sent).toEqual(['chat', 'growth']);
  });
});

describe('module_opened 的渲染层接线', () => {
  let analyticsTrack: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00Z'));
    analyticsTrack = vi.fn().mockResolvedValue({ ok: true, result: null });
    (window as unknown as { clawwork: Record<string, unknown> }).clawwork = { analyticsTrack };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('挂载时按当前主视图记一次，卸载后重挂载不再重复（节流表不在组件里）', () => {
    useUiStore.setState({ mainView: 'archived' });

    const first = render(<Probe />);
    expect(analyticsTrack).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = render(<Probe />);
    second.unmount();

    expect(analyticsTrack).toHaveBeenCalledTimes(1);
    expect(analyticsTrack).toHaveBeenCalledWith({ event: 'module_opened', props: { module: 'archived' } });
  });

  it('切到别的模块各记一次；60 秒内切回原模块不重复', () => {
    useUiStore.setState({ mainView: 'cron' });
    const { unmount } = render(<Probe />);

    act(() => useUiStore.setState({ mainView: 'teams' }));
    act(() => useUiStore.setState({ mainView: 'cron' }));

    expect(
      analyticsTrack.mock.calls.map(([payload]) => (payload as { props: { module: string } }).props.module),
    ).toEqual(['cron', 'teams']);

    unmount();
  });

  it('同一个值再设一遍不算切换（不重复发）', () => {
    useUiStore.setState({ mainView: 'files' });
    const { unmount } = render(<Probe />);

    act(() => useUiStore.setState({ mainView: 'files' }));

    expect(analyticsTrack).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('App 挂了 useModuleOpenTracking（渲染层唯一一处上报调用点）', () => {
    const app = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');

    expect(app).toContain('useModuleOpenTracking()');
  });
});
