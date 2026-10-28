// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo, Team } from '@clawwork/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
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
  it('pins the default, collapses team members under their local name, and selects members without duplicates', async () => {
    const team: Team = {
      id: 'team-1',
      name: '研究团队',
      gatewayId: 'gw',
      emoji: '',
      description: '',
      source: 'local',
      version: '1',
      createdAt: '',
      updatedAt: '',
      agents: [{ agentId: 'a-two', role: 'worker', isManager: false, skills: [], position: 'expert' }],
    };
    const view = setup({ gatewayId: 'gw', defaultAgentId: 'a-main', teams: [team], selectedAgentId: 'a-main' });
    try {
      await act(async () => {
        (view.container.querySelector('[data-testid="assistant-switcher"]') as HTMLElement).click();
      });
      const group = document.querySelector('[data-team="team-1"]') as HTMLElement;
      expect(group).not.toBeNull();
      const toggle = group.querySelector('button[aria-expanded]') as HTMLButtonElement;
      expect(toggle.textContent).toContain('研究团队');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.querySelectorAll('[data-agent="a-two"]')).toHaveLength(1);
      expect(document.querySelector('[data-agent]')?.getAttribute('data-agent')).toBe('a-main');
      // 次级组默认**收起**：`aria-expanded=false` + 内容 `hidden`（呈现层降级，见下一条用例）。
      const skillsGroup = document.querySelector('[data-independent-assistants]') as HTMLElement;
      expect(skillsGroup).not.toBeNull();
      expect(skillsGroup.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
      expect((skillsGroup.querySelector('ul') as HTMLUListElement).hidden).toBe(true);
      expect(skillsGroup.querySelector('button[aria-expanded]')?.textContent).toContain(
        'leftNav.independentAssistants',
      );
      await act(async () => toggle.click());
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      await act(async () => {
        (group.querySelector('[data-agent="a-two"]') as HTMLElement).click();
      });
      expect(view.onSelect).toHaveBeenCalledWith('a-two');
    } finally {
      view.unmount();
    }
  });

  it('⭐ 六类预置助手收进「技能与能力」次级折叠组，默认不占一级入口', async () => {
    const presetAgents = [
      { id: 'partner-w-content', name: '内容创作' },
      { id: 'partner-w-video', name: '拍摄剪辑' },
      { id: 'partner-w-office', name: '高效办公' },
    ] as unknown as AgentInfo[];
    const view = setup({
      agents: [{ id: 'main', name: '罗盘助手' } as unknown as AgentInfo, ...presetAgents],
      selectedAgentId: 'main',
      defaultAgentId: 'main',
    });
    try {
      await act(async () => {
        (view.container.querySelector('[data-testid="assistant-switcher"]') as HTMLElement).click();
      });
      const skillsGroup = document.querySelector('[data-independent-assistants]') as HTMLElement;
      const skillsToggle = skillsGroup.querySelector('button[aria-expanded]') as HTMLButtonElement;
      // 收起态：六类整体收进次级组，内容 `hidden`（它们不再是一级入口）
      expect(skillsToggle.getAttribute('aria-expanded')).toBe('false');
      expect((skillsGroup.querySelector('ul') as HTMLUListElement).hidden).toBe(true);
      await act(async () => skillsToggle.click());
      expect(skillsToggle.getAttribute('aria-expanded')).toBe('true');
      // 展开后仍可选（能力还在，只是降级呈现）
      await act(async () => {
        (document.querySelector('[data-agent="partner-w-video"]') as HTMLElement).click();
      });
      expect(view.onSelect).toHaveBeenCalledWith('partner-w-video');
    } finally {
      view.unmount();
    }
  });

  it('uses the custom emoji in the trigger and expands the selected team', async () => {
    const team: Team = {
      id: 'selected-team',
      name: 'Design',
      gatewayId: 'gw',
      emoji: '',
      description: '',
      source: 'local',
      version: '1',
      createdAt: '',
      updatedAt: '',
      agents: [{ agentId: 'a-two', role: 'worker', isManager: false, skills: [] }],
    };
    const view = setup({
      gatewayId: 'gw',
      teams: [team],
      agents: agents.map((agent) => (agent.id === 'a-two' ? { ...agent, identity: { emoji: 'Z' } } : agent)),
    });
    try {
      expect(view.container.querySelector('[data-testid="assistant-switcher"]')?.textContent).toContain('Z');
      await act(async () => {
        (view.container.querySelector('[data-testid="assistant-switcher"]') as HTMLElement).click();
      });
      expect(
        document.querySelector('[data-team="selected-team"] button[aria-expanded]')?.getAttribute('aria-expanded'),
      ).toBe('true');
    } finally {
      view.unmount();
    }
  });

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
