// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import NavMenu from '../src/renderer/layouts/LeftNav/NavMenu';
import { TooltipProvider } from '../src/renderer/components/ui/tooltip';

/**
 * 收纳态（60px 图标条）—— 2026-09-29 按体验稿 `侧栏收纳-方案.html` 改。
 *
 * 收起后**不再是宽度归零**，而是缩成图标条：导航项还在、图标居中、悬停/聚焦出气泡说名字。
 *
 * ## 为什么这个文件单独存在，而不是并进 `left-nav-menu.test.tsx`
 *
 * 那支测试渲染 `NavMenu` 时**没有 `TooltipProvider`** —— 而 Radix 的 `Tooltip.Root`
 * 没有 provider 会**直接抛**。所以"逐行挂气泡"这条路，必须由**带 provider** 的用例来守，
 * 而那支文件必须继续在**没有 provider** 的情况下渲染通过（它守的是"展开态不挂气泡"这一面）。
 *
 * ## 这一条守的是什么（比"样式对不对"更要紧）
 *
 * 收纳态最容易悄悄退化成"图标点不着/说不清是什么"：
 * - 标签一旦用**条件渲染**删掉，`textContent` 里就没了 —— 既有测试会红，读屏也读不出；
 * - 标签用 CSS 隐藏后，可访问名会变空 —— 必须补 `aria-label`；
 * - 收起态忘了挂气泡 ⇒ 用户只能靠猜；展开态**误挂**气泡 ⇒ 没有 provider 的场景直接炸。
 */

const whoami = { name: '生活家庭' };

// 与其他 renderer 测试一致：不设这一行，Radix 的 portal 状态更新会刷一屏 act 警告。
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

/** 收起态：外壳的 `TooltipProvider` 在生产里兜着，单测要自己包一层。 */
function renderRail(over: Partial<Parameters<typeof NavMenu>[0]> = {}) {
  return render(
    <TooltipProvider>
      <NavMenu
        mainView="chat"
        settingsOpen={false}
        onSelectView={vi.fn()}
        onOpenSettings={vi.fn()}
        hasUpdate={false}
        collapsed
        assistantSlot={<span data-testid="assistant-slot">{whoami.name}</span>}
        {...over}
      />
    </TooltipProvider>,
  );
}

describe('NavMenu 收纳态', () => {
  it('标签仍然在 DOM 里，只是被隐藏了（不是条件渲染）', () => {
    const { container, unmount } = renderRail();
    const row = container.querySelector('[data-nav="skills"]') as HTMLButtonElement;
    const label = row.querySelector('span') as HTMLElement;

    expect(label.textContent, '文案不许从 DOM 里消失').toContain('leftNav.pages.skills');
    expect(label.className, '要靠 CSS 隐藏').toContain('hidden');
    unmount();
  });

  it('每一行都有可访问名（标签隐藏后不能变成空名）', () => {
    const { container, unmount } = renderRail();
    const rows = [...container.querySelectorAll('[data-nav]')] as HTMLButtonElement[];
    expect(rows.length).toBeGreaterThanOrEqual(6);

    for (const row of rows) {
      const name = row.getAttribute('aria-label') ?? '';
      expect(name, `${row.dataset.nav} 缺可访问名`).not.toBe('');
      // 名字必须**就是那行可见文案**（不是另写一句）。气泡里可能追加角标
      // （`文案 · Beta`），所以只比第一段。
      const visible = name.split(' · ')[0];
      expect(row.textContent, `${row.dataset.nav} 的可访问名与文案对不上`).toContain(visible);
    }
    unmount();
  });

  it('⭐ 收起时每一行都被气泡包住（触发器带 data-state）', () => {
    const { container, unmount } = renderRail();
    expect(container.querySelector('[data-nav="teams"]')?.getAttribute('data-state')).toBe('closed');
    unmount();
  });

  it('⭐ 展开时**不**挂气泡 —— 没有 provider 的场景不许炸', () => {
    // 故意不包 TooltipProvider：这正是 `left-nav-menu.test.tsx` 的处境。
    const { container, unmount } = render(
      <NavMenu
        mainView="chat"
        settingsOpen={false}
        onSelectView={vi.fn()}
        onOpenSettings={vi.fn()}
        hasUpdate={false}
      />,
    );
    expect(container.querySelector('[data-nav="teams"]')?.getAttribute('data-state')).toBeNull();
    expect(container.textContent).toContain('leftNav.pages.teams');
    unmount();
  });

  it('角标信息不丢：收起落成角落圆点，文字进气泡', () => {
    const { container, unmount } = renderRail();
    const teams = container.querySelector('[data-nav="teams"]') as HTMLButtonElement;

    expect(teams.getAttribute('aria-label'), '角标文字要进可访问名').toContain('Beta');
    expect(teams.querySelector('[data-testid="nav-badge-dot"]'), '收起时要有角落圆点').not.toBeNull();
    unmount();
  });

  it('助手槽位在收纳态照旧渲染（它不是 NavItem，别在改写 map 时漏掉）', () => {
    const { container, unmount } = renderRail();
    expect(container.querySelector('[data-testid="assistant-slot"]')).not.toBeNull();
    unmount();
  });

  /**
   * ⭐ 2026-10-18：顶部顺序与展开态一致 ——「智能体市场」（`agents`）在一级，
   *    「资料库」（`kb`）已移入「更多」，收纳态也必须先展开才出现。
   */
  it('⭐ 收纳态顺序：agents 在一级，kb 收在「更多」里', () => {
    const { container, unmount } = renderRail();
    const keys = [...container.querySelectorAll('[data-nav]')].map((el) => el.getAttribute('data-nav'));
    expect(keys).toEqual(['new-task', 'teams', 'skills', 'experts', 'agents', 'more']);

    act(() => (container.querySelector('[data-nav="more"]') as HTMLElement).click());
    const expanded = [...container.querySelectorAll('[data-nav]')].map((el) => el.getAttribute('data-nav'));
    expect(expanded).toContain('kb');
    unmount();
  });
});
