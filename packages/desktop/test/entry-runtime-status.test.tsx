// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeBootstrapStatus } from '@clawwork/shared';
import { useEntryRuntimeStatus } from '../src/renderer/hooks/useEntryRuntimeStatus';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const reads: ReturnType<typeof deferred<RuntimeBootstrapStatus | null>>[] = [];
  const listeners = new Set<(status: RuntimeBootstrapStatus) => void>();
  const runtimeStatus = vi.fn(() => {
    const item = deferred<RuntimeBootstrapStatus | null>();
    reads.push(item);
    return item.promise;
  });
  const onRuntimeStatus = vi.fn((fn: (status: RuntimeBootstrapStatus) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  });
  Object.assign(window, { clawwork: { runtimeStatus, onRuntimeStatus } });
  return {
    reads,
    runtimeStatus,
    listeners,
    emit: (status: RuntimeBootstrapStatus) => {
      for (const listener of listeners) listener(status);
    },
  };
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const disposers: (() => void)[] = [];
function renderHook(
  hook: (props: { scope: string | null }) => RuntimeBootstrapStatus | null | undefined,
  options = { initialProps: { scope: 'A' as string | null } },
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const result: { current: RuntimeBootstrapStatus | null | undefined } = { current: undefined };
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
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.unstubAllGlobals();
});

describe('current entry runtime facts', () => {
  it('reads the actual boot snapshot for this scope', async () => {
    const f = fixture();
    const { result } = renderHook(() => useEntryRuntimeStatus('A'));
    expect(result.current).toBeUndefined();
    expect(f.runtimeStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      f.reads[0].resolve({ ok: true });
    });
    expect(result.current).toEqual({ ok: true });
  });
  it('subscribes before reading and ignores a late snapshot after an event', async () => {
    const f = fixture();
    const { result } = renderHook(() => useEntryRuntimeStatus('A'));
    act(() => f.emit({ ok: false, reason: 'process-exited' }));
    expect(f.runtimeStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      f.reads[0].resolve({ ok: true });
    });
    expect(result.current).toEqual({ ok: false, reason: 'process-exited' });
  });
  it('does not reuse an A snapshot across A to B to A', async () => {
    const f = fixture();
    const { result, rerender } = renderHook(({ scope }: { scope: string | null }) => useEntryRuntimeStatus(scope), {
      initialProps: { scope: 'A' as string | null },
    });
    expect(f.runtimeStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      f.reads[0].resolve({ ok: true });
    });
    rerender({ scope: 'B' });
    expect(result.current).toBeUndefined();
    rerender({ scope: 'A' });
    expect(result.current).toBeUndefined();
    await act(async () => {
      f.reads[1].resolve({ ok: false, reason: 'auth-rejected' });
    });
    expect(result.current).toBeUndefined();
    await act(async () => {
      f.reads[2].resolve({ ok: true });
    });
    expect(result.current).toEqual({ ok: true });
  });
  it('disabled entry does not read or keep old listeners', async () => {
    const f = fixture();
    const { result, rerender, unmount } = renderHook(
      ({ scope }: { scope: string | null }) => useEntryRuntimeStatus(scope),
      { initialProps: { scope: null as string | null } },
    );
    expect(f.runtimeStatus).not.toHaveBeenCalled();
    rerender({ scope: 'A' });
    expect(f.listeners.size).toBe(1);
    rerender({ scope: null });
    expect(result.current).toBeUndefined();
    expect(f.listeners.size).toBe(0);
    expect(f.runtimeStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      f.reads[0].resolve({ ok: true });
    });
    expect(result.current).toBeUndefined();
    unmount();
    expect(f.listeners.size).toBe(0);
  });
  it('failed snapshot read remains unconfirmed without inventing a bootstrap failure', async () => {
    const f = fixture();
    f.runtimeStatus.mockRejectedValueOnce(new Error('read unavailable'));
    const { result } = renderHook(() => useEntryRuntimeStatus('A'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
  });
});
