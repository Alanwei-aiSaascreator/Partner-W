// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import InternalBetaHub from '../src/renderer/features/internal-beta/InternalBetaHub';
import { BETA_MODULES, useBetaStore, type BetaModule } from '../src/renderer/features/internal-beta/beta-store';
import type { PortableUpdatePublicState } from '@clawwork/shared';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 真接口模块的**测试侧锚点**：白名单之外的一切模块都是 Zustand + localStorage
 * 本机模拟，因此必须标「功能预览」。写成常量而不是从 `module.preview` 推导 ——
 * 从 preview 推导是循环论证（新模块忘了标 preview 也照样"通过"）。
 */
const REAL_IPC_MODULES = ['updates'];
const SIMULATED_MODULES = BETA_MODULES.filter((module) => !REAL_IPC_MODULES.includes(module.id));

/** 更新链的两个回调由测试自己触发：盘上失败是**发布出来的状态**，不抛异常到渲染进程。 */
let portableStateListener: ((state: PortableUpdatePublicState) => void) | null = null;
let updateErrorListener: ((error: { message: string }) => void) | null = null;

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
    portableStateListener = null;
    updateErrorListener = null;
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
      onUpdateError: vi.fn((listener: (error: { message: string }) => void) => {
        updateErrorListener = listener;
        return vi.fn();
      }),
      getUpdateState: vi.fn(async () => null),
      onUpdateStateChanged: vi.fn((listener: (state: PortableUpdatePublicState) => void) => {
        portableStateListener = listener;
        return vi.fn();
      }),
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

  it('⭐ 盘上空间不足：也说得出「还差多少」（公开状态优先于那句 errorMessage）', async () => {
    useBetaStore.getState().setActiveModule('updates');
    const { container, unmount } = render(<InternalBetaHub />);
    act(() => container.querySelector<HTMLElement>('[data-module="updates"]')?.click());
    await flushAsync();

    act(() => {
      portableStateListener?.({
        phase: 'error',
        currentVersion: '0.0.27',
        targetVersion: '0.0.28',
        errorCode: 'disk-space',
        requiredBytes: 5 * 1024 ** 3,
        availableBytes: 1024 ** 3,
        updatedAt: 1,
      });
    });
    act(() => updateErrorListener?.({ message: 'Download failed' }));
    await flushAsync();

    expect(container.textContent).toContain('还差 4.0 GiB');
    expect(container.textContent).not.toContain('Download failed');
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
   *
   * ⚠️ 遍历的是 `BETA_MODULES` 派生出来的集合，不是写死的 'operations'：
   *    只查运营后台的话，**新加一个模拟模块忘了标 `preview` 不会红**（F4）。
   */
  it('⭐ 本机模拟的模块必须标成「功能预览」（不能宣称已完成）', () => {
    expect(SIMULATED_MODULES.length).toBeGreaterThan(0);
    for (const module of SIMULATED_MODULES) {
      // 数据侧：本机模拟的模块必须带 preview 标记
      expect(module.preview, module.id).toBe(true);

      // 界面侧：当场出现「功能预览」徽章与提示（内测 1.0 不许当成"已完成"讲）
      useBetaStore.getState().setActiveModule(module.id);
      const { container, unmount } = render(<InternalBetaHub />);
      expect(container.textContent, module.id).toContain(module.label);
      expect(container.textContent, module.id).toContain('beta.previewBadge');
      expect(container.textContent, module.id).toContain('beta.previewHint');
      unmount();
    }
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

  /**
   * ⭐ F6：真接口模块不但不标预览，**也不许挂「本机内测数据」提示**。
   *
   * 原来非 preview 分支统一挂 `beta.localDataHint`（"当前为本机持久化内测数据"），
   * 而 `updates` 是全清单里**唯一接真 IPC** 的模块 —— 那是句假话。
   * 选择「不给真模块挂提示」而不是"新造一条文案"：不用再编 9 种语言的翻译，
   * 而"没有预览徽章"本身已经把它和模拟模块区分开了。
   */
  it('⭐ 自动升级接的是真接口 ⇒ 既不标预览、也不挂「本机内测数据」提示', () => {
    expect(REAL_IPC_MODULES.length).toBeGreaterThan(0);
    for (const id of REAL_IPC_MODULES) {
      useBetaStore.getState().setActiveModule(id as BetaModule);
      const { container, unmount } = render(<InternalBetaHub />);

      expect(container.textContent, id).toContain('自动升级');
      expect(container.textContent, id).not.toContain('beta.previewBadge');
      expect(container.textContent, id).not.toContain('beta.previewHint');
      expect(container.textContent, id).not.toContain('beta.localDataHint');

      unmount();
    }
  });

  /**
   * ⭐ F1 第二道防线：store 里冒出清单外的模块时，内测中心**不许抛**。
   *
   * 触发路径（真实存在）：旧版本用户点过「埋点分析 / 隐私与合规」⇒ localStorage
   * 里留着 `activeModule: 'analytics'`。store 层已经 clamp（见 beta-store 测试），
   * 这里注入的是"clamp 失效"的内存状态，验证界面自己的兜底：
   * `BETA_MODULES.find(...)!` 会给 undefined、`MODULE_COMPONENTS[active]` 也是
   * undefined —— 两个都会抛 TypeError，被根 ErrorBoundary 接成整应用错误页。
   */
  it('⭐ store 里冒出清单外的模块时不抛异常，界面回落到第一个模块', () => {
    useBetaStore.getState().setActiveModule('analytics' as unknown as BetaModule);

    let rendered: { container: HTMLDivElement; unmount: () => void } | null = null;
    expect(() => {
      rendered = render(<InternalBetaHub />);
    }).not.toThrow();

    const container = rendered!.container;
    expect(container.textContent).toContain(BETA_MODULES[0].label);
    expect(container.querySelector('[data-module="analytics"]')).toBeNull();
    expect(container.querySelector('[data-module="compliance"]')).toBeNull();
    rendered!.unmount();
  });
});
