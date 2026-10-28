// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillStatusReport } from '@clawwork/shared';

/**
 * 设置 → 「技能」：**开机自装未全生效**的常驻提示（2026-10-11 升级补齐）。
 *
 * 评审要点：技能冲突（用户改过的随包技能没被自动升级）**不得被当作"已升级成功"**，
 * 也不得被静默吞掉 —— 要**显示受影响技能**并接**既有**修复入口（技能市场
 * 「修复随包版本」，`skills:our-install` 的 confirmed-repair）。
 *
 * `t` 用真实中文词表查（同 `skills-section-labels.test.tsx`）：断言的是用户实际
 * 看到的中文，漏翻的键会以 `settings.xxx` 的键名形状出现，不会静默变空。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const raw = key.split('.').reduce<unknown>((acc, part) => {
        if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
        return undefined;
      }, zhLocale as unknown);
      if (typeof raw !== 'string') return key;
      if (!opts) return raw;
      return raw.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts[name] ?? ''));
    },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

vi.mock('../src/renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import zhLocale from '../src/renderer/i18n/locales/zh.json';
import SkillsSection from '../src/renderer/layouts/Settings/sections/SkillsSection';
import { useUiStore } from '../src/renderer/stores/uiStore';
import {
  clearBundledSkillsReport,
  publishBundledSkillsReport,
  resetBundledSkillsReportForTests,
} from '../src/renderer/lib/ensure-bundled-skills';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GATEWAY = 'gw-1';

const REPORT: SkillStatusReport = {
  workspaceDir: '/tmp/ws',
  managedSkillsDir: '/tmp/skills',
  skills: [],
};

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

function seed(): void {
  useUiStore.setState({
    gatewayStatusMap: { [GATEWAY]: 'connected' },
    gatewayInfoMap: {},
    defaultGatewayId: GATEWAY,
    agentCatalogByGateway: { [GATEWAY]: { defaultId: 'main', agents: [{ id: 'main' }] } },
    skillsStatusByGateway: { [GATEWAY]: { ...REPORT, agentId: 'main' } },
    mainView: 'chat',
    settingsOpen: true,
  });
}

const zh = (path: string): string =>
  path.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
    return undefined;
  }, zhLocale as unknown) as string;

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text));
}

describe('设置 → 技能：开机自装未全生效的提示（冲突 ≠ 升级成功）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetBundledSkillsReportForTests();
    seed();
  });

  it('没有报告 ⇒ 这一页不多出任何提示（默认态不变）', () => {
    const { container, unmount } = render(<SkillsSection />);

    expect(container.textContent).not.toContain(zh('settings.bundledSkillsConflicts').slice(0, 8));

    unmount();
  });

  it('⭐ 有冲突：显示受影响技能（名字）+ 既有修复入口；点它去技能市场', () => {
    publishBundledSkillsReport({
      gatewayId: GATEWAY,
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['scripts/generate.cjs'] }],
      failed: [],
      names: { 'deck-layout': '幻灯版面（自己排）' },
      updatedAt: 1,
    });
    const { container, unmount } = render(<SkillsSection />);

    const text = container.textContent ?? '';
    expect(text).toContain('幻灯版面（自己排）');
    expect(text, '要件数，不要含糊').toContain('1 个随包技能');
    expect(text, '原样保留了用户的修改这件事要说清').toContain('保留了你的本地修改');

    const fix = buttonByText(container, zh('settings.bundledSkillsFix'));
    expect(fix, '找不到修复入口按钮').toBeDefined();

    act(() => fix?.click());
    // 走的是**既有**导航：主视图切到技能市场（那里每行已装技能有「修复随包版本」）
    expect(useUiStore.getState().mainView).toBe('skills');
    expect(useUiStore.getState().settingsOpen).toBe(false);

    unmount();
  });

  it('只有失败（没有冲突）：提示"稍后自动重试"，且**不给**修复按钮', () => {
    publishBundledSkillsReport({
      gatewayId: GATEWAY,
      conflicts: [],
      failed: [{ slug: 'html-deliverable', error: 'EBUSY' }],
      names: { 'html-deliverable': '网页交付' },
      updatedAt: 1,
    });
    const { container, unmount } = render(<SkillsSection />);

    const text = container.textContent ?? '';
    expect(text).toContain('网页交付');
    expect(text).toContain('未完成');
    expect(buttonByText(container, zh('settings.bundledSkillsFix')), '失败不是用户要修的东西').toBeUndefined();

    unmount();
  });

  it('报告被清除（例如下一次开机全部生效）⇒ 提示跟着消失', () => {
    publishBundledSkillsReport({
      gatewayId: GATEWAY,
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] }],
      failed: [],
      names: {},
      updatedAt: 1,
    });
    const { container, unmount } = render(<SkillsSection />);
    expect(container.textContent).toContain('deck-layout');

    act(() => clearBundledSkillsReport());
    expect(container.textContent).not.toContain('deck-layout');

    unmount();
  });

  // ─────────────── ⭐ B3(b)（2026-10-11 整改）：报告按网关归属 ───────────────

  it('⭐ B3：报告属于别的网关（gw-1）而这一页在看 gw-2 ⇒ 不出提示（显示与修复入口同归属）', () => {
    publishBundledSkillsReport({
      gatewayId: 'gw-1',
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] }],
      failed: [],
      names: { 'deck-layout': '幻灯版面（自己排）' },
      updatedAt: 1,
    });
    // 这一页（设置 → 技能）选中/默认都是 gw-2：gw-1 的报告不许串到这里来。
    useUiStore.setState({
      gatewayStatusMap: { 'gw-2': 'connected' },
      gatewayInfoMap: {},
      defaultGatewayId: 'gw-2',
      agentCatalogByGateway: { 'gw-2': { defaultId: 'main', agents: [{ id: 'main' }] } },
      skillsStatusByGateway: {},
      mainView: 'chat',
      settingsOpen: true,
    } as never);

    const { container, unmount } = render(<SkillsSection />);

    const text = container.textContent ?? '';
    expect(text, 'gw-1 的报告不许显示在 gw-2 的页面上').not.toContain('幻灯版面（自己排）');
    expect(
      buttonByText(container, zh('settings.bundledSkillsFix')),
      '导航会落到默认网关的市场，这里不许给入口',
    ).toBeUndefined();

    unmount();
  });

  it('⭐ B3：报告属于当前网关（gw-2）⇒ 照常显示并给修复入口', () => {
    publishBundledSkillsReport({
      gatewayId: 'gw-2',
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] }],
      failed: [],
      names: { 'deck-layout': '幻灯版面（自己排）' },
      updatedAt: 1,
    });
    useUiStore.setState({
      gatewayStatusMap: { 'gw-2': 'connected' },
      gatewayInfoMap: {},
      defaultGatewayId: 'gw-2',
      agentCatalogByGateway: { 'gw-2': { defaultId: 'main', agents: [{ id: 'main' }] } },
      skillsStatusByGateway: {},
      mainView: 'chat',
      settingsOpen: true,
    } as never);

    const { container, unmount } = render(<SkillsSection />);

    expect(container.textContent).toContain('幻灯版面（自己排）');
    expect(buttonByText(container, zh('settings.bundledSkillsFix'))).toBeDefined();

    unmount();
  });
});
