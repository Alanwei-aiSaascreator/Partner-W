// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryPreparationFacts } from '../src/renderer/lib/entry-preparation';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
import EntryPreparation from '../src/renderer/layouts/EntryPreparation';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  return { container, rerender: (ui: ReactElement) => act(() => root.render(ui)) };
}
const callbacks = () => ({
  onContinue: vi.fn(async () => {}),
  onRetry: vi.fn(async () => {}),
  onChangeAccount: vi.fn(async () => {}),
  onChooseWorkspace: vi.fn(),
});
afterEach(() => {
  disposers.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});
describe('EntryPreparation', () => {
  it('keeps continue disabled after time and animation completion without actual relay readiness', async () => {
    vi.useFakeTimers();
    const cb = callbacks();
    const pending = { ...facts, startup: { ...facts.startup, relayPhase: 'running' as const } };
    const { container } = render(<EntryPreparation facts={pending} {...cb} />);
    const button = container.querySelector<HTMLButtonElement>('[data-entry-continue]');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(120000);
      container.querySelector('[data-entry-animation]')?.dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(button?.disabled).toBe(true);
    expect(cb.onContinue).not.toHaveBeenCalled();
  });
  it('shows ready without auto navigation and waits for explicit continue', async () => {
    const cb = callbacks();
    const { container } = render(<EntryPreparation facts={facts} {...cb} />);
    expect(container.textContent).toContain('entryPreparation.ready');
    expect(cb.onContinue).not.toHaveBeenCalled();
    const button = container.querySelector<HTMLButtonElement>('[data-entry-continue]');
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(cb.onContinue).toHaveBeenCalledTimes(1);
  });
  it.each([
    'process-exited',
    'ready-timeout',
    'port-occupied',
    'auth-rejected',
    'state-migration-blocked',
    'deploy-failed',
    'unknown',
  ] as const)('shows %s with the in-app retry exit (不再是"完全退出重开")', async (reason) => {
    const cb = callbacks();
    const failed = { ...facts, runtime: { ok: false as const, reason } };
    const { container } = render(<EntryPreparation facts={failed} {...cb} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('entryPreparation.runtimeRetryHint');
    expect(container.textContent).toContain('entryPreparation.needsAttention');
    // ⭐ 运行端起不来时「重新准备」**必须留着**：它现在真的重跑一轮 bootstrap
    //   （IPC `runtime:bootstrap-retry`），不是原来那个按了没用的按钮。
    const retry = container.querySelector<HTMLButtonElement>('[data-entry-retry]');
    expect(retry).not.toBeNull();
    await act(async () => retry?.click());
    expect(cb.onRetry).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.disabled).toBe(true);
    expect(container.querySelector('[data-entry-account]')).not.toBeNull();
    expect(container.querySelector('[data-entry-workspace]')).not.toBeNull();
  });
  it('keeps retry available for service configuration failures after a successful local boot', async () => {
    const cb = callbacks();
    const failed = {
      ...facts,
      startup: {
        ...facts.startup,
        relayPhase: 'retryable-error' as const,
        relayFailure: { kind: 'retryable' as const, errorCode: 'transport' as const },
      },
    };
    const { container } = render(<EntryPreparation facts={failed} {...cb} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-entry-retry]')?.click());
    expect(cb.onRetry).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain('entryPreparation.runtimeRetryHint');
  });
  it('keeps the known runtime cause when a concurrent final check rejects', async () => {
    const cb = callbacks();
    let reject!: (reason: Error) => void;
    cb.onContinue.mockImplementationOnce(
      () =>
        new Promise<void>((_, r) => {
          reject = r;
        }),
    );
    const { container, rerender } = render(<EntryPreparation facts={facts} {...cb} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
    rerender(<EntryPreparation facts={{ ...facts, runtime: { ok: false, reason: 'port-occupied' } }} {...cb} />);
    await act(async () => reject(new Error('private check failure')));
    const alert = container.querySelector('[role="alert"]')?.textContent;
    expect(alert).toContain('startupReadiness.gatewayPortOccupied');
    expect(alert).toContain('entryPreparation.runtimeRetryHint');
    expect(alert).not.toContain('entryPreparation.recheckFailed');
    expect(alert).not.toContain('private check failure');
    expect(container.querySelector('[data-entry-retry]')).not.toBeNull();
  });
  it('rejects a failed final recheck without leaving and releases the button for retry', async () => {
    const cb = callbacks();
    cb.onContinue.mockRejectedValueOnce(new Error('private backend detail'));
    const { container } = render(<EntryPreparation facts={facts} {...cb} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('entryPreparation.recheckFailed');
    expect(container.textContent).not.toContain('private backend detail');
    expect(container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.disabled).toBe(false);
  });
});

/**
 * 部署进度上屏（2026-10-07 体检问题 1/2）。
 *
 * 主进程一直在报真实阶段（校验 → 解压 → 装 Node → 换入），而这条信号原来到不了界面 ——
 * 首跑 1–20 分钟只显示一格不动的 17%。这里钉住"它真的渲染出来了"，以及两个容易犯的错：
 *   - **只在没结论时才显示**（就绪/失败之后不该继续挂着一条旧百分比）；
 *   - `stalled` 有自己那句话，且**不硬编一个百分比**。
 */
describe('部署进度：准备页说得出"现在在干什么"', () => {
  const runtimeFacts = {
    ...facts,
    // `stage==='runtime'` 且**没有失败结论**：运行时 OK，网关身份还没认到（首跑真实形状）。
    startup: { ...facts.startup, gatewayId: null },
  };
  afterEach(() => {
    delete (window as { clawwork?: unknown }).clawwork;
  });
  function stubClawwork(progress: unknown) {
    const listeners = new Set<(value: unknown) => void>();
    Object.assign(window, {
      clawwork: {
        onRuntimeDeployProgress: (fn: (value: unknown) => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        runtimeDeployProgress: async () => progress,
        isPortableWorkspace: async () => false,
      },
    });
    return {
      emit: (value: unknown) => {
        for (const fn of [...listeners]) fn(value);
      },
    };
  }
  it('runtime 阶段显示真实阶段文案 + 真实百分比 + 已等时间', async () => {
    stubClawwork({ phase: 'extract', done: 42, total: 100, startedAt: Date.now() - 65_000 });
    const cb = callbacks();
    const { container } = render(<EntryPreparation facts={runtimeFacts} {...cb} />);
    await act(async () => {
      await Promise.resolve();
    });
    const line = container.querySelector('[data-entry-deploy-progress]');
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain('entryPreparation.deployExtract');
    expect(line?.textContent, '解压那一段有真实的 done/total 百分比').toContain('42%');
    expect(line?.textContent, '已等时间是主进程给的 startedAt 算出来的').toContain('startupReadiness.elapsed');
    // 等待期间那两句人话（原来挂在用户到不了的屏上）
    expect(container.textContent).toContain('startupReadiness.keepOpen');
  });
  it('stalled 有自己的那句话，且**不编百分比**', async () => {
    const bus = stubClawwork({ phase: 'extract', done: 42, total: 100, startedAt: Date.now() - 1000 });
    const cb = callbacks();
    const { container } = render(<EntryPreparation facts={runtimeFacts} {...cb} />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => bus.emit({ phase: 'stalled', done: 42, total: 100, startedAt: Date.now() - 200_000 }));
    const line = container.querySelector('[data-entry-deploy-progress]');
    expect(line?.textContent).toContain('entryPreparation.deployStalled');
    expect(line?.textContent, '停滞不是进度：不许硬编一个百分比出来').not.toContain('42%');
  });
});

it('clears old busy state on scope replacement and ignores the old action completion', async () => {
  const cb = callbacks();
  let resolve!: () => void;
  cb.onContinue.mockImplementationOnce(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const { container, rerender } = render(<EntryPreparation facts={facts} {...cb} />);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
  const factsB = { ...facts, scopeKey: 'B', currentScopeKey: 'B' };
  rerender(<EntryPreparation facts={factsB} {...cb} />);
  expect(container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.disabled).toBe(false);
  await act(async () => resolve());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
