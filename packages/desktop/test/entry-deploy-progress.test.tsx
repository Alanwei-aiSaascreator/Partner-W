// @vitest-environment jsdom
/**
 * 准备页的**部署进度**订阅（`useEntryDeployProgress`）。
 *
 * 与 `entry-runtime-status.test.tsx` 同一个形状：先订阅、再补读，晚到的初始读**不许**
 * 盖掉已经到手的事件（否则界面会把"已经在解压 60%"倒回几百毫秒前）。
 * 另外多钉一条宿主差异：**没有这条通道时不许把整块屏带崩**（pwa / 更老的 preload）。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeDeployProgress } from '@clawwork/shared';
import { useEntryDeployProgress } from '../src/renderer/hooks/useEntryDeployProgress';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fixture() {
  const reads: ReturnType<typeof deferred<RuntimeDeployProgress | null>>[] = [];
  const listeners = new Set<(progress: RuntimeDeployProgress | null) => void>();
  const runtimeDeployProgress = vi.fn(() => {
    const item = deferred<RuntimeDeployProgress | null>();
    reads.push(item);
    return item.promise;
  });
  const onRuntimeDeployProgress = vi.fn((fn: (progress: RuntimeDeployProgress | null) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  });
  Object.assign(window, { clawwork: { runtimeDeployProgress, onRuntimeDeployProgress } });
  return {
    reads,
    runtimeDeployProgress,
    listeners,
    emit: (progress: RuntimeDeployProgress | null) => {
      for (const listener of [...listeners]) listener(progress);
    },
  };
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const disposers: (() => void)[] = [];
function renderHook(
  hook: (props: { scope: string | null }) => RuntimeDeployProgress | null | undefined,
  options = { initialProps: { scope: 'A' as string | null } },
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const result: { current: RuntimeDeployProgress | null | undefined } = { current: undefined };
  function Probe({ scope }: { scope: string | null }) {
    result.current = hook({ scope });
    return null;
  }
  const rerender = (props: { scope: string | null }) => act(() => root.render(<Probe {...props} />));
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    act(() => root.unmount());
    container.remove();
  };
  disposers.push(unmount);
  rerender(options.initialProps);
  return { result, rerender, unmount };
}

const SNAPSHOT: RuntimeDeployProgress = { phase: 'extract', done: 40, total: 100, startedAt: 1_000 };

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  delete (window as { clawwork?: unknown }).clawwork;
  vi.unstubAllGlobals();
});

describe('部署进度订阅', () => {
  it('补读到主进程快照（`null` = 现在没有部署在进行）', async () => {
    const f = fixture();
    const { result } = renderHook(() => useEntryDeployProgress('A'));
    expect(result.current, '还没读回来 = 没有结论').toBeUndefined();
    expect(f.runtimeDeployProgress).toHaveBeenCalledTimes(1);
    await act(async () => {
      f.reads[0].resolve(SNAPSHOT);
    });
    expect(result.current).toEqual(SNAPSHOT);

    const g = fixture();
    const second = renderHook(() => useEntryDeployProgress('A'));
    await act(async () => {
      g.reads[0].resolve(null);
    });
    expect(second.result.current).toBeNull();
  });

  it('⭐ 先订阅再补读：晚到的初始读**不许**盖掉已经到手的事件', async () => {
    const f = fixture();
    const { result } = renderHook(() => useEntryDeployProgress('A'));
    expect(f.listeners.size, '订阅必须早于补读').toBe(1);
    act(() => f.emit({ phase: 'extract', done: 90, total: 100, startedAt: 1_000 }));
    await act(async () => {
      f.reads[0].resolve(SNAPSHOT);
    });
    expect(result.current, '事件更新，旧补读不该把它倒回去').toEqual({
      phase: 'extract',
      done: 90,
      total: 100,
      startedAt: 1_000,
    });
  });

  it('部署结束（推 null）清掉那行', async () => {
    const f = fixture();
    const { result } = renderHook(() => useEntryDeployProgress('A'));
    await act(async () => {
      f.reads[0].resolve(SNAPSHOT);
    });
    act(() => f.emit(null));
    expect(result.current).toBeNull();
  });

  it('scope 换了就不认旧快照（A → B → A 不许复用）', async () => {
    const f = fixture();
    const { result, rerender } = renderHook(({ scope }: { scope: string | null }) => useEntryDeployProgress(scope), {
      initialProps: { scope: 'A' as string | null },
    });
    await act(async () => {
      f.reads[0].resolve(SNAPSHOT);
    });
    expect(result.current).toEqual(SNAPSHOT);
    rerender({ scope: 'B' });
    expect(result.current).toBeUndefined();
    await act(async () => {
      f.reads[1].resolve(null);
    });
    expect(result.current).toBeNull();
    rerender({ scope: 'A' });
    expect(result.current).toBeUndefined();
  });

  it('⭐ 宿主没有这条通道（更老的 preload / pwa）⇒ 一直"没有结论"，不崩', async () => {
    Object.assign(window, { clawwork: {} });
    const { result } = renderHook(() => useEntryDeployProgress('A'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeUndefined();
  });

  it('scope 为 null ⇒ 不读也不订阅', async () => {
    const f = fixture();
    renderHook(() => useEntryDeployProgress(null));
    expect(f.runtimeDeployProgress).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(0);
  });
});
