// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MascotPet from '../src/renderer/components/MascotPet';

/**
 * 「小盈」灵宠（2026-10-17 用户：吉祥物 + 类似 Codex 的灵宠）。
 *
 * 三条底线：
 *  ① 默认出现；
 *  ② 点一下冒一句（可重复点，句子轮换）；
 *  ③ 关掉后记住 —— 灵宠不能变成关不掉的广告。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/assets/mascot/xiaoying-256.png', () => ({ default: 'mascot.png' }));

let container: HTMLDivElement;
let root: Root;

function mount(): ReactElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<MascotPet />));
  return <MascotPet />;
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function click(el: Element | null): void {
  if (!el) throw new Error('element missing');
  act(() => {
    (el as HTMLElement).click();
  });
}

describe('MascotPet', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.useRealTimers();
  });

  it('默认渲染，点一下冒泡', () => {
    mount();
    expect(byTestId('mascot-pet')).toBeTruthy();
    click(byTestId('mascot-pet'));
    expect(container.textContent).toContain('mascot.line0');
  });

  it('再点一次换下一句（轮换）', () => {
    mount();
    click(byTestId('mascot-pet'));
    click(byTestId('mascot-pet'));
    expect(container.textContent).toContain('mascot.line1');
  });

  /**
   * 2026-10-18 现场：「宠物开局有然后不见了」。
   * 两个角标按钮是 88×88 吉祥物左上/右上角的 16×16 命中区，靠 `group-hover` 才可见。
   * 旧实现里承载它们的 div 上**没有 `group`** ⇒ `group-hover:opacity-100` 永远不生效：
   *   - 用户看不到"放到桌面"的入口（所以只能乱点）；
   *   - 更方便误触那个一直 `opacity-0`、却照样可点的 X —— 点下去就是**永久隐藏**。
   */
  it('⭐ 角标按钮必须有 group 祖先（否则 group-hover 永远不生效，按钮全程隐形）', () => {
    mount();
    const actions = byTestId('mascot-actions');
    expect(actions).not.toBeNull();
    expect(actions!.classList.contains('group')).toBe(true);
    // 两个角标都在，且真的挂在那个 group 里面（不是散落在别处）
    expect(actions!.querySelector('[data-testid="mascot-desktop"]')).not.toBeNull();
    expect(actions!.querySelector('[data-testid="mascot-dismiss"]')).not.toBeNull();
  });

  /**
   * 6s 自动收是"宠物自己消失了"的另一半体感来源（一句还没读完就没了）。
   * 解释性修复：只放宽常量（6s → 30s），语义不变。
   */
  it('⭐ 气泡 30s 才自动收（6s 时还在）', () => {
    vi.useFakeTimers();
    mount();
    click(byTestId('mascot-pet'));
    expect(container.textContent).toContain('mascot.line0');

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(container.textContent).toContain('mascot.line0');

    act(() => {
      vi.advanceTimersByTime(24_000);
    });
    expect(container.textContent).not.toContain('mascot.line0');
  });

  it('⭐ 关掉后隐藏并记住（重挂载也不回来）', () => {
    mount();
    click(byTestId('mascot-dismiss'));
    expect(byTestId('mascot-pet')).toBeNull();
    expect(localStorage.getItem('rongying-cube:mascot-hidden:v1')).toBe('1');
    act(() => root.unmount());
    container.remove();
    mount();
    expect(byTestId('mascot-pet')).toBeNull();
  });
});

/**
 * 显隐开关的回头路（2026-10-18 用户现场：「后面消失了」）。
 *
 * 修好那个不可见的 X 之后，"藏起来"仍需要一条用户找得到的恢复路径：
 * 设置 → 通用 的开关与灵宠共用 `lib/mascot-visibility.ts` 这一份读写 + 事件广播。
 */
describe('MascotPet —— 显隐开关可恢复', () => {
  it('⭐ 写完开关后（同窗口）灵宠当场重新出现，不用重挂载', async () => {
    const { setMascotHidden } = await import('../src/renderer/lib/mascot-visibility');
    // 上一条用例把"藏起来"写进了 localStorage；本组不在那个 describe 的
    // beforeEach 作用域里，必须自己清掉，否则挂上来就是隐藏态。
    localStorage.clear();

    mount();
    expect(container.querySelector('[data-testid="mascot-actions"]')).not.toBeNull();

    act(() => setMascotHidden(true));
    expect(container.querySelector('[data-testid="mascot-actions"]')).toBeNull();

    act(() => setMascotHidden(false));
    expect(container.querySelector('[data-testid="mascot-actions"]')).not.toBeNull();
  });
});
