// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import IdentityCenter from '../src/renderer/layouts/IdentityCenter';

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

/**
 * 身份中心 —— **本版只有排版**。
 *
 * ⚠️ 这里的断言**刻意钉的是版式不变量**（有几个标签、几个技能、几个客群，
 *    哪几个标签是选中态），不是业务逻辑 —— 因为这一版压根没有业务逻辑。
 *    将来接上真实数据时，这几条**应该**跟着改：那时它们就不再是"排版"而是"数据"了。
 */
describe('IdentityCenter（本版只有排版）', () => {
  it('渲染标题、卡片标题与底部固定栏', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const text = container.textContent ?? '';

    expect(container.querySelector('[data-testid="identity-center"]')).toBeTruthy();
    expect(text).toContain('identity.title');
    expect(text).toContain('identity.cardTitle');
    // 底部固定栏那句话与保存按钮
    expect(text).toContain('identity.footerHint');
    expect(text).toContain('identity.save');
    unmount();
  });

  it('⭐ 人群画像标签组合：共 5 个，其中恰好 4 个是选中态', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const tags = container.querySelectorAll('[data-tag]');

    expect(tags).toHaveLength(5);
    const selected = [...tags].filter((el) => el.getAttribute('data-selected') === 'true');
    expect(selected).toHaveLength(4);
    // 选中的是哪四个也要钉住：漏一个或串位都不该悄悄过
    expect(selected.map((el) => el.getAttribute('data-tag'))).toEqual([
      'goalOriented',
      'efficiency',
      'logical',
      'reporting',
    ]);
    // 没选中的那个必须显式标 false（而不是缺属性 —— 缺属性会让上面的 filter 也数不出来）
    const unselected = [...tags].filter((el) => el.getAttribute('data-selected') === 'false');
    expect(unselected.map((el) => el.getAttribute('data-tag'))).toEqual(['timeManagement']);
    unmount();
  });

  it('推荐技能：7 个，且都渲染出文案', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const skills = container.querySelector('[data-field="skills"]');

    expect(skills).toBeTruthy();
    expect(skills!.children).toHaveLength(7);
    expect(skills!.textContent).toContain('identity.skill.docManager');
    expect(skills!.textContent).toContain('identity.skill.mailExpert');
    unmount();
  });

  it('推荐角色：只渲染一个角色的值', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const role = container.querySelector('[data-field="role"]');

    expect(role).toBeTruthy();
    expect(role!.textContent).toBe('identity.roleValue');
    unmount();
  });

  it('其它客群：4 个，每个都有名字与说明', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const groups = container.querySelectorAll('[data-group]');

    expect(groups).toHaveLength(4);
    expect([...groups].map((el) => el.getAttribute('data-group'))).toEqual([
      'educator',
      'legal',
      'ecommerce',
      'engineer',
    ]);
    for (const key of ['educator', 'legal', 'ecommerce', 'engineer']) {
      const g = container.querySelector(`[data-group="${key}"]`);
      expect(g!.textContent).toContain(`identity.group.${key}.name`);
      expect(g!.textContent).toContain(`identity.group.${key}.desc`);
    }
    unmount();
  });
});
