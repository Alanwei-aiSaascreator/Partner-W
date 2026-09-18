// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import InternalBetaHub from '../src/renderer/features/internal-beta/InternalBetaHub';
import { useBetaStore } from '../src/renderer/features/internal-beta/beta-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('InternalBetaHub', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
    window.history.replaceState(null, '', '#/');
    act(() => useBetaStore.getState().resetDemo());
    (window as unknown as { clawwork: Record<string, unknown> }).clawwork = {
      getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
      checkForUpdates: vi.fn().mockResolvedValue({
        hasUpdate: true,
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        releaseUrl: 'https://example.com/release',
        releaseNotes: '修复文件交付问题',
      }),
      downloadUpdate: vi.fn().mockResolvedValue({ ok: true }),
      installUpdate: vi.fn().mockResolvedValue({ ok: true }),
      onUpdateDownloadProgress: vi.fn(() => vi.fn()),
      onUpdateDownloaded: vi.fn(() => vi.fn()),
      onUpdateError: vi.fn(() => vi.fn()),
    };
  });

  it('exposes every company beta module as direct navigation', () => {
    const { container, unmount } = render(<InternalBetaHub />);
    for (const id of ['operations', 'updates']) {
      expect(container.querySelector(`[data-module="${id}"]`)).toBeTruthy();
    }
    // 广场与团队已毕业到主界面（真后端），内测中心不再有它们的入口
    expect(container.querySelector('[data-module="team"]')).toBeNull();
    expect(container.querySelector('[data-module="square"]')).toBeNull();
    expect(container.querySelector('[data-module="market"]')).toBeNull();
    expect(container.querySelector('[data-module="creator"]')).toBeNull();
    // P3：悬赏与成长中心也毕业了（真实现分别在「团队协作 → 悬赏」与全局栏「成长」）
    expect(container.querySelector('[data-module="bounty"]')).toBeNull();
    expect(container.querySelector('[data-module="game"]')).toBeNull();
    // P4：埋点分析（数据搬到运营看板）与隐私与合规（搬到设置页「隐私与数据」）
    expect(container.querySelector('[data-module="analytics"]')).toBeNull();
    expect(container.querySelector('[data-module="compliance"]')).toBeNull();
    unmount();
  });

  it('uses the Electron updater and shows the real available version', async () => {
    useBetaStore.getState().setActiveModule('updates');
    const { container, unmount } = render(<InternalBetaHub />);
    act(() => container.querySelector<HTMLButtonElement>('[data-action="check-update"]')?.click());
    await flushAsync();
    expect(window.clawwork.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('1.1.0');
    expect(container.textContent).not.toContain('内测模拟升级');
    unmount();
  });

  it('opens only the configured admin console URL', () => {
    useBetaStore.getState().setActiveModule('operations');
    const first = render(<InternalBetaHub />);
    const disabled = first.container.querySelector<HTMLButtonElement>('[data-action="open-admin"]')!;
    expect(disabled.disabled).toBe(true);
    first.unmount();

    vi.stubEnv('VITE_ADMIN_CONSOLE_URL', 'https://admin.example.com/console');
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const second = render(<InternalBetaHub />);
    const enabled = second.container.querySelector<HTMLButtonElement>('[data-action="open-admin"]')!;
    expect(enabled.disabled).toBe(false);
    act(() => enabled.click());
    expect(open).toHaveBeenCalledWith('https://admin.example.com/console', '_blank', 'noopener,noreferrer');
    second.unmount();
  });

  /**
   * 交接单（2026-09-16）明确点名：内测中心里除「调用真实更新接口」外**几乎全是**
   * Zustand + localStorage 本地模拟（假团队、假邀请码、本地模板 ID、本机悬赏…），
   * 内测 1.0 **不能**把这些宣称成「已完成」。
   *
   * 两个方向都要断言：模拟模块**必须**标成「功能预览」，真接口模块（自动升级）
   * **不许**被标 —— 只测一个方向的话，"全标成预览"和"全不标"都能蒙混过去。
   */
  it('⭐ 本机模拟的模块必须标成「功能预览」（不能宣称已完成）', () => {
    // 广场/团队/市场/创作者/悬赏/成长都毕业了，这里改用运营后台（仍是本机模拟）
    useBetaStore.getState().setActiveModule('operations');
    const { container, unmount } = render(<InternalBetaHub />);

    expect(container.textContent).toContain('运营后台');
    expect(container.textContent).toContain('beta.previewBadge');
    expect(container.textContent).toContain('beta.previewHint');

    unmount();
  });

  /**
   * ⭐ P4 毕业的**最重要**一条：界面上不许同时存在一个真入口和一个假入口。
   *
   * 真入口 = 设置页「隐私与数据」（Task 14，走 main 的隐私 IPC + 真工单）；
   * 假入口 = 内测中心原来的「隐私与合规」（Zustand + localStorage，只写本机）。
   * 两个同名入口并排挂着，用户点哪个取决于运气；运营看到的后台数据也取决于运气。
   *
   * ⚠️ 只断言导航项不存在是不够的：模块可以从导航里摘掉而组件照样被渲染出来
   *    （比如路由直进 / 渲染分支漏删）—— 所以正文里的**假控件原文**也一并钉住。
   */
  it('⭐ 埋点分析与隐私合规已毕业：导航与正文都不再留假入口', () => {
    useBetaStore.getState().setActiveModule('operations');
    const { container, unmount } = render(<InternalBetaHub />);

    expect(container.querySelector('[data-module="analytics"]')).toBeNull();
    expect(container.querySelector('[data-module="compliance"]')).toBeNull();
    for (const fake of [
      '埋点分析',
      '隐私与合规',
      '今日核心事件',
      '我的数据权利',
      '申请导出我的数据',
      '申请删除账号与数据',
      '同意并继续',
    ]) {
      expect(container.textContent, fake).not.toContain(fake);
    }
    // 运营后台（仍是本机模拟）还在，毕业生只走了这两个
    expect(container.textContent).toContain('运营后台');

    unmount();
  });

  it('⭐ 自动升级接的是真接口 ⇒ **不**标成预览', () => {
    useBetaStore.getState().setActiveModule('updates');
    const { container, unmount } = render(<InternalBetaHub />);

    expect(container.textContent).toContain('自动升级');
    expect(container.textContent).not.toContain('beta.previewBadge');
    expect(container.textContent).not.toContain('beta.previewHint');

    unmount();
  });
});
