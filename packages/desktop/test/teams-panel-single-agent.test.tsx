// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const startNewTask = vi.fn();
  const setMainView = vi.fn();
  const setSelectedAgent = vi.fn();
  const loadTeams = vi.fn();
  const team = {
    id: 'team-design',
    name: '设计团队',
    emoji: '🎨',
    description: '',
    gatewayId: 'gw-1',
    agents: [
      { agentId: 'design-lead', isManager: true },
      { agentId: 'design-reviewer', isManager: false },
    ],
  };
  return {
    startNewTask,
    setMainView,
    setSelectedAgent,
    loadTeams,
    teamState: {
      teams: { [team.id]: team },
      loadTeams,
      deleteTeam: vi.fn(),
    },
    uiState: {
      setMainView,
      setSelectedAgent,
      defaultGatewayId: 'gw-1',
      agentCatalogByGateway: {
        'gw-1': { agents: [{ id: 'design-lead' }, { id: 'design-reviewer' }] },
      },
    },
    taskState: { startNewTask },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../src/renderer/stores/teamStore', () => ({
  useTeamStore: <T,>(selector: (state: typeof mocks.teamState) => T) => selector(mocks.teamState),
}));

vi.mock('../src/renderer/platform', () => ({
  useTaskStore: <T,>(selector: (state: typeof mocks.taskState) => T) => selector(mocks.taskState),
  useUiStore: <T,>(selector: (state: typeof mocks.uiState) => T) => selector(mocks.uiState),
}));

vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../src/renderer/components/semantic/WindowTitlebar', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/EmptyState', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/ConfirmDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactElement }) => <div>{children}</div>,
}));
vi.mock('../src/renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock('../src/renderer/layouts/TeamsPanel/TeamCard', () => ({
  default: ({ onStartChat }: { onStartChat: () => void }) => (
    <button type="button" data-testid="start-team-chat" onClick={onStartChat}>
      start
    </button>
  ),
}));
vi.mock('../src/renderer/layouts/TeamsPanel/TeamDetailView', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/TeamsPanel/TeamHubDetailView', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/TeamsPanel/CreateTeamWizard', () => ({ default: () => null }));
vi.mock('../src/renderer/components/TeamBuilderDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/TeamsPanel/TeamsHubTab', () => ({ default: () => null }));
// 「我的 AI 团队」圆桌要读真实会议记录（它自己会去 load）；这一条只测"点卡片进对话"，
// 所以把会议 store 钉成"已加载、无记录"（圆桌显示未启用，不影响本用例的断言）。
vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  useTeamMeetingStore: <T,>(selector: (state: { records: never[]; loaded: boolean }) => T) =>
    selector({ records: [], loaded: true }),
  teamMeetingController: { load: vi.fn(async () => undefined) },
}));

import TeamsPanel from '../src/renderer/layouts/TeamsPanel';

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

describe('TeamsPanel reliable team mode', () => {
  beforeEach(() => {
    mocks.startNewTask.mockClear();
    mocks.setMainView.mockClear();
    mocks.setSelectedAgent.mockClear();
    mocks.loadTeams.mockClear();
  });

  it('starts a multi-member team as one direct agent task, not an ensemble', () => {
    const view = render(<TeamsPanel />);

    act(() => {
      (view.container.querySelector('[data-testid="start-team-chat"]') as HTMLButtonElement).click();
    });

    expect(mocks.startNewTask).toHaveBeenCalledWith({
      gatewayId: 'gw-1',
      agentId: 'design-lead',
      ensemble: false,
      teamId: 'team-design',
    });
    expect(mocks.setMainView).toHaveBeenCalledWith('chat');
    expect(mocks.setSelectedAgent).toHaveBeenCalledWith('gw-1', 'design-lead');
    view.unmount();
  });

  /**
   * ⭐ 2026-10-07（质检 P3-6）：一个团队都没有时**不摆圆桌** —— 新用户会先看到五个岗位
   * 齐刷刷"未启用"、再看到下面"创建团队"，那是两遍空话。收成一句说明。
   */
  it('⭐ 空团队列表：圆桌收成一句说明，不摆五个「未启用」', () => {
    const originalTeams = mocks.teamState.teams;
    mocks.teamState.teams = {};
    const view = render(<TeamsPanel />);

    expect(view.container.querySelector('[data-testid="roundtable-empty-hint"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="team-roundtable"]')).toBeNull();

    view.unmount();
    mocks.teamState.teams = originalTeams;
  });
});
