// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PetWindow from '../src/renderer/pet/PetWindow';

/**
 * 桌面宠物窗的**拖拽结构**（2026-10-18 用户现场：「也拖不动」）。
 *
 * 事实链（三轮实机）：
 *   · Electron 只认 `-webkit-app-region: drag` 的元素（`theme.css` 里 `.pet-window .drag`）；
 *   · 第一轮只有 64×16 把手 ⇒ 抓吉祥物拖不动；第二轮整窗 drag 层被内容层吃掉事件，
 *     仍拖不动；第三轮把内容层改成 `pointer-events-none`，并**让吉祥物自己也是 drag**
 *     —— 用户伸手抓的就是它。代价是 drag 吞掉 click / contextmenu ⇒ 菜单改由按钮打开。
 *
 * ⇒ 回归契约：**整窗存在 drag 层**、**吉祥物本身可拖**、**所有按钮 nodrag**、
 *   **菜单必须有不依赖右键的入口**。只断言"页面上有一个 drag 类"是没用的。
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
  act(() => root.render(<PetWindow />));
  return <PetWindow />;
}

function petRoot(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.pet-window');
  if (!el) throw new Error('.pet-window missing');
  return el;
}

describe('PetWindow 拖拽结构', () => {
  beforeEach(() => {
    mount();
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  it('⭐ 存在一个覆盖整窗的 drag 层（不是只有那条小把手）', () => {
    const fullSurfaceDrag = petRoot().querySelector('.drag.absolute.inset-0');
    expect(fullSurfaceDrag).not.toBeNull();
  });

  it('drag 层是第一个子元素（交互层必须排在它之后才收得到点击）', () => {
    const first = petRoot().firstElementChild;
    expect(first?.classList.contains('drag')).toBe(true);
  });

  it('⭐ 所有按钮都是 nodrag（整窗 drag 层不能吞掉点击）', () => {
    const buttons = [...petRoot().querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(4);
    for (const element of buttons) {
      expect(element.classList.contains('nodrag')).toBe(true);
    }
  });

  it('⭐ 吉祥物本身也是 drag 区（2026-10-18 第三轮：用户抓的就是它）', () => {
    const mascot = petRoot().querySelector('img');
    expect(mascot).not.toBeNull();
    expect(mascot!.classList.contains('drag')).toBe(true);
    expect(mascot!.classList.contains('nodrag')).toBe(false);
  });

  it('菜单入口改由按钮承担（drag 会吞掉右键，不能只靠 contextmenu）', () => {
    const trigger = petRoot().querySelector('[data-pet-menu-trigger="true"]');
    expect(trigger).not.toBeNull();
    expect(petRoot().querySelector('[data-pet-menu="greet"]')).toBeNull();
    act(() => (trigger as HTMLElement).click());
    expect(petRoot().querySelector('[data-pet-menu="greet"]')).not.toBeNull();
  });

  it('交互内容包在 z-10 层里（压在透明拖拽层之上）', () => {
    const content = petRoot().querySelector('.relative.z-10');
    expect(content).not.toBeNull();
    expect(content!.querySelector('button')).not.toBeNull();
    expect(content!.querySelector('img')).not.toBeNull();
  });
});
