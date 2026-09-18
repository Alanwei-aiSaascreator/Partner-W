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
 */

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ toast: toastSpy }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // ⚠️ 这个桩不能省：`@/stores/uiStore` 那条 import 链会走到真实的 i18n 初始化，
  //    它要 `i18n.use(initReactI18next)`；缺了就是「No initReactI18next export」收集失败。
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import { useUpdateCheck } from '../src/renderer/hooks/useUpdateCheck';
import { useUiStore } from '../src/renderer/stores/uiStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(): ReactElement | null {
  useUpdateCheck();
  return null;
}

describe('useUpdateCheck —— 有新版本要给可操作提示', () => {
  let container: HTMLDivElement;
  let root: Root;
  const checkForUpdates = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    toastSpy.mockClear();
    checkForUpdates.mockReset();
    (window as unknown as { clawwork: Record<string, unknown> }).clawwork = { checkForUpdates };
    useUiStore.setState({ hasUpdate: false, settingsOpen: false, settingsSection: null });

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
      await vi.advanceTimersByTimeAsync(5000);
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
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(toastSpy).not.toHaveBeenCalled();
    expect(useUiStore.getState().hasUpdate).toBe(false);
  });

  it('检查失败 ⇒ 只记日志，不弹提示也不抛（离线/被网络挡都很常见）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    checkForUpdates.mockRejectedValue(new Error('offline'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(toastSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
