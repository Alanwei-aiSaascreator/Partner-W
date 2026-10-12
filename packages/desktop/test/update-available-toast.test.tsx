// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-U3：发现新版本时**必须给一条可操作的提示**（只亮红点对远程用户等于没有）。
 *
 * 这条测试钉的是三件事：
 *   ① 有新版本 ⇒ 弹提示；没有 ⇒ 不弹（不打扰）
 *   ② 提示带一个按钮，点了会把用户送到「设置 → 关于」那条已有的更新流程
 *   ③ 跳转请求走 store 的两个字段（`settingsOpen` + `settingsSection`），
 *      而不是某个组件内部的临时状态 —— 这样设置页才能接得住
 *
 * 2026-10-11（升级补齐）追加一组：
 *   ④ 启动离线恢复联网（online）/ 长期不退出（30 分钟周期）/ 回前台都要再查一次 ——
 *      但事件类检查 60 秒节流、请求进行中去重（不重入、不刷屏）；
 *   ⑤ 同一频道同一版本只提示一次（每应用生命周期）；卸载把 timer/listener 全清掉。
 */

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ toast: toastSpy }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // ⚠️ 这个桩不能省：`@/stores/uiStore` 那条 import 链会走到真实的 i18n 初始化，
  //    它要 `i18n.use(initReactI18next)`；缺了就是「No initReactI18next export」收集失败。
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import { resetUpdateCheckLifecycleForTests, useUpdateCheck } from '../src/renderer/hooks/useUpdateCheck';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { useSettingsStore } from '../src/renderer/stores/settingsStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(): ReactElement | null {
  useUpdateCheck();
  return null;
}

const STARTUP_MS = 5_000;
const PERIODIC_MS = 30 * 60_000;
const THROTTLE_MS = 60_000;

type ClaudeApi = { clawwork: Record<string, unknown> };

function dispatchOnline(): void {
  window.dispatchEvent(new Event('online'));
}

function dispatchForeground(): void {
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useUpdateCheck —— 有新版本要给可操作提示', () => {
  let container: HTMLDivElement;
  let root: Root;
  const checkForUpdates = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    resetUpdateCheckLifecycleForTests();
    toastSpy.mockClear();
    checkForUpdates.mockReset();
    (window as unknown as ClaudeApi).clawwork = { checkForUpdates };
    useUiStore.setState({ hasUpdate: false, settingsOpen: false, settingsSection: null });
    useSettingsStore.setState({ settings: null, loaded: false, loading: false });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('有新版本 ⇒ 弹提示 + 标记 hasUpdate；点提示的按钮 ⇒ 打开「设置 → 关于」', async () => {
    checkForUpdates.mockResolvedValue({ hasUpdate: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_MS);
    });

    expect(useUiStore.getState().hasUpdate).toBe(true);
    expect(toastSpy).toHaveBeenCalledTimes(1);

    const [message, options] = toastSpy.mock.calls[0] as [string, { action?: { label: string; onClick: () => void } }];
    expect(message).toBe('leftNav.updateAvailable');
    expect(options.action?.label).toBe('settings.checkForUpdates');

    act(() => options.action?.onClick());
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsSection).toBe('about');
  });

  it('没有新版本 ⇒ 什么都不弹（不打扰用户）', async () => {
    checkForUpdates.mockResolvedValue({ hasUpdate: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_MS);
    });

    expect(toastSpy).not.toHaveBeenCalled();
    expect(useUiStore.getState().hasUpdate).toBe(false);
  });

  it('检查失败 ⇒ 只记日志，不弹提示也不抛（离线/被网络挡都很常见）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    checkForUpdates.mockRejectedValue(new Error('offline'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_MS);
    });

    expect(toastSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // ─────────────── 2026-10-11 升级补齐：事件类检查 ───────────────

  it('启动时离线：恢复联网（online）后能发现更新', async () => {
    checkForUpdates
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ hasUpdate: true, latestVersion: '1.1.0' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_MS);
    });
    expect(toastSpy, '离线那次不该打扰用户').not.toHaveBeenCalled();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);

    await act(async () => {
      dispatchOnline();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().hasUpdate).toBe(true);
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it('长期不退出：30 分钟周期检查能发现更新', async () => {
    checkForUpdates.mockResolvedValueOnce({ hasUpdate: false }).mockResolvedValue({
      hasUpdate: true,
      latestVersion: '1.1.0',
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_MS);
    });
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().hasUpdate).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PERIODIC_MS);
    });

    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().hasUpdate).toBe(true);
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it('周期/联网/回前台同时触发：进行中的请求去重，60 秒内不再重入', async () => {
    let resolveFirst: ((value: { hasUpdate: boolean }) => void) | null = null;
    checkForUpdates
      .mockImplementationOnce(
        () =>
          new Promise<{ hasUpdate: boolean }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ hasUpdate: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_MS);
    });
    expect(checkForUpdates).toHaveBeenCalledTimes(1);

    // 三个事件源在请求飞行中同时触发 ⇒ 全部并入同一个请求
    await act(async () => {
      dispatchOnline();
      dispatchForeground();
      await vi.advanceTimersByTimeAsync(PERIODIC_MS);
    });
    expect(checkForUpdates, '请求进行中不许重入').toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.({ hasUpdate: false });
      await vi.advanceTimersByTimeAsync(0);
    });

    // 完成之后第一次事件检查照发（它就是节流基准）
    await act(async () => {
      dispatchOnline();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkForUpdates).toHaveBeenCalledTimes(2);

    // 节流窗内的两个事件（前台 + 联网）都不许再发请求
    await act(async () => {
      dispatchForeground();
      dispatchOnline();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkForUpdates, '60 秒节流内不许重入').toHaveBeenCalledTimes(2);

    // 过窗后恢复
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THROTTLE_MS + 1_000);
      dispatchOnline();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it('同一频道同一版本只提示一次（每应用生命周期），红点照常保持', async () => {
    checkForUpdates.mockResolvedValue({ hasUpdate: true, latestVersion: '1.1.0' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_MS);
    });
    expect(toastSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PERIODIC_MS);
    });
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    expect(toastSpy, '同频道同版本不许刷屏').toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().hasUpdate).toBe(true);
  });

  it('卸载后不再检查（timer 与事件监听都清掉）', async () => {
    checkForUpdates.mockResolvedValue({ hasUpdate: false });

    act(() => root.unmount());
    // 换一个新的空 root 收尾（afterEach 还会 unmount 一次）
    root = createRoot(container);

    await act(async () => {
      dispatchOnline();
      dispatchForeground();
      await vi.advanceTimersByTimeAsync(PERIODIC_MS + STARTUP_MS);
    });

    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it('手动检查不受事件节流影响（hook 不包裹 window.clawwork.checkForUpdates）', async () => {
    checkForUpdates.mockResolvedValue({ hasUpdate: false });
    const installClawMock = (window as unknown as ClaudeApi).clawwork.checkForUpdates;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_MS);
    });

    expect((window as unknown as ClaudeApi).clawwork.checkForUpdates).toBe(installClawMock);

    // 「设置 → 关于」的手动检查是直接调这条 API：节流管不到它
    await act(async () => {
      await ((window as unknown as ClaudeApi).clawwork.checkForUpdates as () => Promise<unknown>)();
    });
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
  });

  // ─────────────── B2（2026-10-11 整改）：频道归属 ───────────────

  it('⭐ B2：在途切频道 —— 旧 stable 的**普通**响应不许消费 beta 的通知键（也不写红点）', async () => {
    // stable 检查在飞；用户切到 beta；stable 的答复晚到 ⇒ 它描述的是**旧频道**的检查。
    // ⚠️ 复审二轮：用**真实 IPC 响应形状**（带 channel + state）——旧版测试漏了 channel，
    //    只命中"旧 preload 兜底"，把真实通道上的过期保护漏洞放过去了。
    let resolveCheck:
      | ((value: { hasUpdate: boolean; latestVersion: string; state: string; channel: string }) => void)
      | null = null;
    checkForUpdates.mockImplementationOnce(
      () =>
        new Promise<{ hasUpdate: boolean; latestVersion: string; state: string; channel: string }>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_MS);
    });
    expect(checkForUpdates).toHaveBeenCalledTimes(1);

    await act(async () => {
      useSettingsStore.setState({ settings: { updateChannel: 'beta' } as never, loaded: true, loading: false });
      resolveCheck?.({ hasUpdate: true, latestVersion: '1.1.0', state: 'available', channel: 'stable' });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(toastSpy, '旧 stable 的普通结果已经过期：不许弹').not.toHaveBeenCalled();
    expect(useUiStore.getState().hasUpdate, '红点不许被旧结果点亮').toBe(false);

    // beta 频道自己的检查照常提示一次（证明 stable 没有把 beta 的通知键吃掉）。
    checkForUpdates.mockResolvedValue({ hasUpdate: true, latestVersion: '1.1.0', state: 'available', channel: 'beta' });
    await act(async () => {
      dispatchOnline();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy, 'beta 的同版本结果仍应提示（键没被旧结果消费）').toHaveBeenCalledTimes(1);
  });

  it('⭐ B2：旧 preload（响应没有 channel）—— 设置动过就整条忽略（兜底口径原样保留）', async () => {
    let resolveCheck: ((value: { hasUpdate: boolean; latestVersion: string }) => void) | null = null;
    checkForUpdates.mockImplementationOnce(
      () =>
        new Promise<{ hasUpdate: boolean; latestVersion: string }>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_MS);
    });
    await act(async () => {
      useSettingsStore.setState({ settings: { updateChannel: 'beta' } as never, loaded: true, loading: false });
      resolveCheck?.({ hasUpdate: true, latestVersion: '1.1.0' });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(toastSpy, '无法归因的旧结果：设置动过就忽略').not.toHaveBeenCalled();
    expect(useUiStore.getState().hasUpdate).toBe(false);
  });

  it('⭐ B2：旧频道的**在途/就绪事务**（ready）仍然有效：提示保留、键按事务实际频道记', async () => {
    // 与上一条同一场景（stable 在飞、已切 beta），唯独结果是一次 ready 事务 ——
    // 它是可安装资产，不许被"频道动过"一刀切掉；归属记在事务自己的频道名下。
    let resolveCheck:
      | ((value: { hasUpdate: boolean; latestVersion: string; state: string; channel: string }) => void)
      | null = null;
    checkForUpdates.mockImplementationOnce(
      () =>
        new Promise<{ hasUpdate: boolean; latestVersion: string; state: string; channel: string }>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_MS);
    });
    await act(async () => {
      useSettingsStore.setState({ settings: { updateChannel: 'beta' } as never, loaded: true, loading: false });
      resolveCheck?.({ hasUpdate: true, latestVersion: '1.1.0', state: 'ready', channel: 'stable' });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(toastSpy, '旧频道的 ready 事务仍是有效候选：必须提示').toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().hasUpdate).toBe(true);
  });

  it('⭐ B2：主进程给出实际频道（旧 ready 事务属旧频道）⇒ 按实际频道记账、提示不丢', async () => {
    // 用户已切到 beta，但主进程回报的结果归属 stable（旧 ready 事务）——它仍然有效。
    checkForUpdates.mockResolvedValue({
      hasUpdate: true,
      latestVersion: '1.1.0',
      state: 'ready',
      channel: 'stable',
    });
    useSettingsStore.setState({ settings: { updateChannel: 'beta' } as never, loaded: true, loading: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_MS);
    });

    expect(toastSpy, '旧频道的候选仍然要提示（归属=事务实际频道，不是当前设置）').toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().hasUpdate).toBe(true);

    // 切回 stable 再查：同一个 stable 事务 = 同频道同版本，不该再刷一次
    //（键要记在**事务的频道**名下；如果记成 beta::1.1.0，这次就会重复弹）。
    await act(async () => {
      useSettingsStore.setState({ settings: { updateChannel: 'stable' } as never, loaded: true, loading: false });
      await vi.advanceTimersByTimeAsync(THROTTLE_MS + 1_000);
      dispatchOnline();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastSpy, '键按事务实际频道(stable)记：同频道同版本不再提示').toHaveBeenCalledTimes(1);
  });
});
