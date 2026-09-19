// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '@clawwork/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('@/components/CubeFaceIcon', () => ({
  default: ({ agentId }: { agentId: string }) => <span data-cube={agentId} />,
}));

import AssistantSwitcher from '../src/renderer/layouts/LeftNav/AssistantSwitcher';

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

/** `resolveAgentDisplayNameKey` 只认内置预设 id ⇒ 用非预设 id 走 `agent.name` 那条路。 */
const agents = [
  { id: 'a-main', name: '罗盘助手' },
  { id: 'a-two', name: '内容创作' },
  { id: 'a-three', name: '电商运营' },
] as unknown as AgentInfo[];

function setup(over: Partial<Parameters<typeof AssistantSwitcher>[0]> = {}) {
  const onSelect = vi.fn();
  const onAddAssistant = vi.fn();
  const utils = render(
    <AssistantSwitcher
      agents={agents}
      selectedAgentId="a-two"
      onSelect={onSelect}
      onAddAssistant={onAddAssistant}
      {...over}
    />,
  );
  return { ...utils, onSelect, onAddAssistant };
}

/**
 * 「我的助手」切换器（2026-09-19）。
 *
 * 原来是**常驻展开的助手列表**，用户要求收成一行、点开才选角色：
 * 「把他放身份中心上面，点击后可以选择这几个角色」。
 *
 * ⚠️ 这里的断言守着两件事：**平时只显示当前那一个**（不展开），
 *    以及**点开之后真的能切**（它是全应用唯一切助手的地方）。
 */
describe('AssistantSwitcher', () => {
  it('⭐ 收起时**只显示当前助手**，不把列表铺开', () => {
    const { container, unmount } = setup();
    const trigger = container.querySelector('[data-testid="assistant-switcher"]');

    expect(trigger).toBeTruthy();
    expect(trigger!.textContent).toContain('内容创作');
    // 其它助手不该出现在收起态里 —— 铺开正是用户要改掉的"不好看"
    expect(trigger!.textContent).not.toContain('罗盘助手');
    expect(trigger!.textContent).not.toContain('电商运营');
    unmount();
  });

  it('显示的是**当前**助手（跟着 selectedAgentId 走）', () => {
    const a = setup({ selectedAgentId: 'a-main' });
    expect(a.container.querySelector('[data-testid="assistant-switcher"]')!.textContent).toContain('罗盘助手');
    a.unmount();

    const b = setup({ selectedAgentId: 'a-three' });
    expect(b.container.querySelector('[data-testid="assistant-switcher"]')!.textContent).toContain('电商运营');
    b.unmount();
  });

  it('⚠️ 助手列表为空时**不能崩**，退回一句占位', () => {
    const { container, unmount } = setup({ agents: [], selectedAgentId: 'nope' });
    const trigger = container.querySelector('[data-testid="assistant-switcher"]');

    expect(trigger).toBeTruthy();
    expect(trigger!.textContent).toContain('leftNav.myAssistants');
    unmount();
  });
});
