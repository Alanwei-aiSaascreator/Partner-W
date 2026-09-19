// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// ⚠️ `vi.mock` 的工厂会被提升到文件最上面 ⇒ 里面引用的变量**必须**用 `vi.hoisted`
//    造，否则是 "Cannot access 'toastSpy' before initialization"。
const { toastSpy, selectAgentSpy } = vi.hoisted(() => ({
  toastSpy: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  selectAgentSpy: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({ toast: toastSpy }));

/**
 * 切助手那一步**打桩**：真身在 `test/agent-switch.test.ts`（纯逻辑）和实机里验。
 * 这里只问一件事 —— 按钮按下去**有没有走到切助手**，以及带的是哪个助手。
 */
vi.mock('@/hooks/useSelectAgent', () => ({ useSelectAgent: () => selectAgentSpy }));

import IdentityCenter, { IDENTITY_STORAGE_KEY } from '../src/renderer/layouts/IdentityCenter';
import { useUiStore } from '../src/renderer/stores/uiStore';

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

/** 点一下（包在 act 里，否则 React 的批处理不会 flush）。 */
function click(el: Element | null): void {
  if (!el) throw new Error('要点的元素不存在');
  act(() => {
    (el as HTMLElement).click();
  });
}

const selectedTagIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-tag][data-selected="true"]')].map((el) => el.getAttribute('data-tag') ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({ defaultGatewayId: 'gw-1' });
});

/**
 * 身份中心（2026-09-19 第二刀）。
 *
 * 第一刀只有排版，用户反馈「功能用不了」—— 因为按钮**压根没有 `onClick`**。
 * 这一刀把每个按钮接上，所以这里的断言从"版式不变量"升级成"按下去发生了什么事"。
 *
 * ⚠️ 有一条**仍然是排版**：推荐技能那排是死的（见组件文件头"刻意没做的"）。
 */
describe('IdentityCenter — 版式不变量', () => {
  it('渲染标题、卡片标题与底部固定栏', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const text = container.textContent ?? '';

    expect(container.querySelector('[data-testid="identity-center"]')).toBeTruthy();
    expect(text).toContain('identity.title');
    expect(text).toContain('identity.cardTitle');
    expect(text).toContain('identity.footerHint');
    expect(text).toContain('identity.save');
    unmount();
  });

  it('人群画像标签组合：共 5 个，其中恰好 4 个是选中态', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const tags = container.querySelectorAll('[data-tag]');

    expect(tags).toHaveLength(5);
    expect(selectedTagIds(container)).toEqual(['goalOriented', 'efficiency', 'logical', 'reporting']);
    // 没选中的那个必须显式标 false（而不是缺属性 —— 缺属性会让上面的 filter 也数不出来）
    const unselected = [...tags].filter((el) => el.getAttribute('data-selected') === 'false');
    expect(unselected.map((el) => el.getAttribute('data-tag'))).toEqual(['timeManagement']);
    unmount();
  });

  it('推荐技能：7 个，且都渲染出文案（⚠️ 这一排仍是展示，点不动）', () => {
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

describe('IdentityCenter — 按钮真的干活', () => {
  it('⭐ 点标签：点未选的选上，再点一下取消', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-tag="timeManagement"]'));
    expect(selectedTagIds(container)).toEqual(['goalOriented', 'efficiency', 'logical', 'reporting', 'timeManagement']);

    click(container.querySelector('[data-tag="goalOriented"]'));
    expect(selectedTagIds(container)).toEqual(['efficiency', 'logical', 'reporting', 'timeManagement']);
    unmount();
  });

  it('「重新选择」清空全部选中（一个都不剩）', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="reset"]'));
    expect(selectedTagIds(container)).toEqual([]);
    expect(container.querySelectorAll('[data-tag]')).toHaveLength(5);
    unmount();
  });

  it('⭐「换一个标签」整体轮换一格（不是随机 —— 连点两次结果可预期）', () => {
    const { container, unmount } = render(<IdentityCenter />);

    // ⚠️ 断言按**界面顺序**（DOM 里标签的先后），不是选中集合的插入顺序
    click(container.querySelector('[data-action="shuffle"]'));
    expect(selectedTagIds(container)).toEqual(['efficiency', 'logical', 'reporting', 'timeManagement']);

    // 再点一次：整体又挪一格 ⇒ 'goalOriented' 绕回环尾、重新被选上
    click(container.querySelector('[data-action="shuffle"]'));
    expect(selectedTagIds(container)).toEqual(['goalOriented', 'logical', 'reporting', 'timeManagement']);
    unmount();
  });

  it('⭐「应用此画像」真的切到推荐角色（rongying-office）并报成功', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="apply"]'));

    expect(selectAgentSpy).toHaveBeenCalledTimes(1);
    expect(selectAgentSpy).toHaveBeenCalledWith('rongying-office');
    expect(toastSpy.success).toHaveBeenCalledWith('identity.appliedToast');
    unmount();
  });

  it('⚠️ 一个标签都没选就点「应用」⇒ 不切助手，如实报错', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="reset"]'));
    click(container.querySelector('[data-action="apply"]'));

    expect(selectAgentSpy).not.toHaveBeenCalled();
    expect(toastSpy.error).toHaveBeenCalledWith('identity.needTag');
    expect(toastSpy.success).not.toHaveBeenCalled();
    unmount();
  });

  it('⚠️ 没有网关 ⇒ 不切助手，如实报错（不假装成功）', () => {
    useUiStore.setState({ defaultGatewayId: null });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="apply"]'));

    expect(selectAgentSpy).not.toHaveBeenCalled();
    expect(toastSpy.error).toHaveBeenCalledWith('identity.applyFailed');
    // ⚠️ 这条不能省：少了它，"报错之后还接着说已应用"的写法照样全绿 ——
    //    用户会同时看到「还没连上网关」和「已应用『高效办公』」两句互相打架的话。
    expect(toastSpy.success).not.toHaveBeenCalled();
    unmount();
  });

  it('⭐「保存并应用」= 应用 + 把标签选择落盘', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-tag="timeManagement"]'));
    click(container.querySelector('[data-action="save"]'));

    expect(selectAgentSpy).toHaveBeenCalledWith('rongying-office');
    expect(JSON.parse(window.localStorage.getItem(IDENTITY_STORAGE_KEY) ?? 'null')).toEqual([
      'goalOriented',
      'efficiency',
      'logical',
      'reporting',
      'timeManagement',
    ]);
    expect(toastSpy.success).toHaveBeenCalledWith('identity.savedToast');
    unmount();
  });

  it('⚠️ 没选标签就点「保存」⇒ 既不落盘也不切助手', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="reset"]'));
    click(container.querySelector('[data-action="save"]'));

    expect(selectAgentSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(IDENTITY_STORAGE_KEY)).toBeNull();
    expect(toastSpy.error).toHaveBeenCalledWith('identity.needTag');
    unmount();
  });
});
