// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, Team, TeamMeetingRecord } from '@clawwork/shared';

const mocks = vi.hoisted(() => ({
  task: undefined as Task | undefined,
  teams: {} as Record<string, Team>,
  records: [] as TeamMeetingRecord[],
  loaded: true,
  load: vi.fn(async () => undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../src/renderer/platform', () => ({
  useTaskStore: <T,>(selector: (state: { tasks: Task[] }) => T) => selector({ tasks: mocks.task ? [mocks.task] : [] }),
  useUiStore: <T,>(selector: (state: unknown) => T) =>
    selector({
      agentCatalogByGateway: {
        'gw-1': {
          agents: [
            { id: 'lead', name: '队长' },
            { id: 'reviewer', name: '审稿人' },
          ],
        },
      },
    }),
}));

vi.mock('../src/renderer/stores/teamStore', () => ({
  useTeamStore: <T,>(selector: (state: { teams: Record<string, Team> }) => T) => selector({ teams: mocks.teams }),
}));

vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  useTeamMeetingStore: <T,>(selector: (state: { records: TeamMeetingRecord[]; loaded: boolean }) => T) =>
    selector({ records: mocks.records, loaded: mocks.loaded }),
  teamMeetingController: { load: mocks.load },
}));

import TeamCollabBar from '../src/renderer/features/team-meeting/TeamCollabBar';
import { recordPhase, turnPhase, turnsPhase } from '../src/renderer/features/team-meeting/status';

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

type Turn = TeamMeetingRecord['turns'][number];

function turn(agentId: string, status: Turn['status']): Turn {
  return {
    id: `${agentId}-${status}`,
    stage: 'proposal',
    taskId: `task-${agentId}`,
    agentId,
    agentName: agentId,
    sessionKey: `session-${agentId}`,
    status,
    messageIds: [],
  };
}

function record(overrides: Partial<TeamMeetingRecord> = {}): TeamMeetingRecord {
  return {
    id: 'meeting-1',
    ownerTaskId: 'task-owner',
    teamId: 'team-1',
    gatewayId: 'gw-1',
    revision: 0,
    question: '问题',
    addenda: [],
    status: 'running',
    stopRequested: false,
    turns: [],
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    ...overrides,
  };
}

const team: Team = {
  id: 'team-1',
  name: '设计团队',
  emoji: '🎨',
  description: '',
  gatewayId: 'gw-1',
  source: 'local',
  version: '1',
  agents: [
    { agentId: 'lead', role: 'coordinator', isManager: true, skills: [], position: 'moderator' },
    { agentId: 'reviewer', role: 'worker', isManager: false, skills: [] },
  ],
  createdAt: '',
  updatedAt: '',
};

describe('meeting status mapping (真实 turn status → 展示相位)', () => {
  it('running/dispatching ⇒ 工作中；completed ⇒ 已完成；failed ⇒ 需要处理；pending/stopped ⇒ 待命', () => {
    expect(turnPhase('running')).toBe('working');
    expect(turnPhase('dispatching')).toBe('working');
    expect(turnPhase('completed')).toBe('done');
    expect(turnPhase('failed')).toBe('attention');
    expect(turnPhase('interrupted')).toBe('attention');
    expect(turnPhase('pending')).toBe('idle');
    expect(turnPhase('stopped')).toBe('idle');
    expect(turnsPhase([])).toBeNull();
    expect(turnsPhase([turn('a', 'completed'), turn('a', 'failed')])).toBe('attention');
    expect(recordPhase(record({ status: 'completed', turns: [turn('a', 'completed')] }))).toBe('done');
    expect(recordPhase(record({ status: 'failed' }))).toBe('attention');
  });
});

describe('TeamCollabBar 聊天页团队协作条', () => {
  beforeEach(() => {
    mocks.task = undefined;
    mocks.teams = {};
    mocks.records = [];
    mocks.loaded = true;
    mocks.load.mockClear();
  });

  it('默认收起；非团队任务显「未启用」并如实说明', () => {
    mocks.task = { id: 'task-1', gatewayId: 'gw-1', title: 't' } as Task;
    const view = render(<TeamCollabBar taskId="task-1" />);
    const bar = view.container.querySelector('[data-testid="team-collab-bar"]') as HTMLElement;
    expect(bar.getAttribute('data-status')).toBe('disabled');
    const toggle = bar.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.textContent).toContain('meeting.collabTitle');
    expect(view.container.textContent).toContain('teams.roundtable.status.disabled');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(view.container.textContent).toContain('meeting.collabNotTeam');
    view.unmount();
  });

  it('有真实会议记录：条上整状态与逐人状态都来自 turns', () => {
    mocks.task = { id: 'task-1', gatewayId: 'gw-1', teamId: 'team-1', title: 't' } as Task;
    mocks.teams = { 'team-1': team };
    mocks.records = [
      record({
        turns: [turn('lead', 'running'), turn('reviewer', 'completed')],
        updatedAt: '2026-10-06T02:00:00.000Z',
      }),
    ];
    const view = render(<TeamCollabBar taskId="task-1" />);
    const bar = view.container.querySelector('[data-testid="team-collab-bar"]') as HTMLElement;
    expect(bar.getAttribute('data-status')).toBe('working');
    act(() => (bar.querySelector('button[aria-expanded]') as HTMLButtonElement).click());
    expect(view.container.textContent).toContain('meeting.collabMembers');
    const rows = [...view.container.querySelectorAll('li')];
    expect(rows[0].textContent).toContain('队长');
    expect(rows[0].textContent).toContain('teams.roundtable.status.working');
    expect(rows[1].textContent).toContain('审稿人');
    expect(rows[1].textContent).toContain('teams.roundtable.status.done');
    view.unmount();
  });

  it('团队存在但从未开过会：整条「待命」（不是「未启用」），成员全部「待命」——不编进度', () => {
    // ⚠️ 2026-10-07（质检 P3-1）：没入团队才是「未启用」；在团队里只是还没开会 ⇒「待命」。
    mocks.task = { id: 'task-1', gatewayId: 'gw-1', teamId: 'team-1', title: 't' } as Task;
    mocks.teams = { 'team-1': team };
    const view = render(<TeamCollabBar taskId="task-1" />);
    const bar = view.container.querySelector('[data-testid="team-collab-bar"]') as HTMLElement;
    expect(bar.getAttribute('data-status')).toBe('idle');
    expect(view.container.textContent).toContain('teams.roundtable.status.idle');
    act(() => (bar.querySelector('button[aria-expanded]') as HTMLButtonElement).click());
    expect(view.container.textContent).toContain('meeting.collabNoMeeting');
    const rows = [...view.container.querySelectorAll('li')];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.textContent?.includes('teams.roundtable.status.idle'))).toBe(true);
    view.unmount();
  });
});
