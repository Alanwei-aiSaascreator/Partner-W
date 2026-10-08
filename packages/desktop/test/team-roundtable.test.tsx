// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamMeetingRecord } from '@clawwork/shared';
import {
  ROUNDTABLE_POSITIONS,
  deriveRoundtableSignal,
  deriveStageStatus,
} from '../src/renderer/layouts/TeamsPanel/roundtable';

const mocks = vi.hoisted(() => ({
  records: [] as TeamMeetingRecord[],
  loaded: true,
  load: vi.fn(async () => undefined),
}));

vi.mock('react-i18next', () => ({
  // 带插值时把取值也显示出来（`key({"question":"…"})`），才能钉住"最近会议"那句里的问题原文。
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}(${JSON.stringify(options)})` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../src/renderer/platform', () => ({
  useUiStore: <T,>(selector: (state: { defaultGatewayId: string }) => T) => selector({ defaultGatewayId: 'gw-1' }),
}));

vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  useTeamMeetingStore: <T,>(selector: (state: { records: TeamMeetingRecord[]; loaded: boolean }) => T) =>
    selector({ records: mocks.records, loaded: mocks.loaded }),
  teamMeetingController: { load: mocks.load },
}));

import TeamRoundtable from '../src/renderer/layouts/TeamsPanel/TeamRoundtable';

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

function turn(stage: Turn['stage'], status: Turn['status']): Turn {
  return {
    id: `${stage}-${status}`,
    stage,
    taskId: `task-${stage}`,
    agentId: `agent-${stage}`,
    agentName: `name-${stage}`,
    sessionKey: `session-${stage}`,
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
    question: '如何安排本周发布？',
    addenda: [],
    status: 'running',
    stopRequested: false,
    turns: [],
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('roundtable signal derivation (真实信号 → 五岗位状态)', () => {
  it('没有任何会议记录 ⇒ 五岗位全部「未启用」，不编进度', () => {
    const { record: latest, statuses } = deriveRoundtableSignal([], { gatewayId: 'gw-1' });
    expect(latest).toBeNull();
    for (const position of ROUNDTABLE_POSITIONS) expect(statuses[position]).toBe('disabled');
  });

  it('⭐ 拿不到网关 id ⇒ 按**无信号**处理（不把别的网关的会议当本团队状态）', () => {
    // ⚠️ 2026-10-07（质检 P3-2）：老判据 `!options.gatewayId || …` 在缺网关时恒真，
    //    任意网关上的会议都会被当成"本团队"的进度。
    const other = record({ turns: [turn('proposal', 'running')] });

    const withoutGateway = deriveRoundtableSignal([other], {});
    expect(withoutGateway.record).toBeNull();
    for (const position of ROUNDTABLE_POSITIONS) expect(withoutGateway.statuses[position]).toBe('disabled');

    // 对照组：网关给了、也对得上 ⇒ 同一条记录正常生效
    const withGateway = deriveRoundtableSignal([other], { gatewayId: 'gw-1' });
    expect(withGateway.record?.id).toBe('meeting-1');
    expect(withGateway.statuses.researcher).toBe('working');
  });

  it('进行中的 proposal 落到调研员+分析师；completed 的 review 落到质检师', () => {
    const { statuses } = deriveRoundtableSignal(
      [record({ turns: [turn('proposal', 'running'), turn('review', 'completed')] })],
      { gatewayId: 'gw-1' },
    );
    expect(statuses.researcher).toBe('working');
    expect(statuses.analyst).toBe('working');
    expect(statuses.inspector).toBe('done');
    // 这次会议没有跑到 summary：创作师/制作师如实显示「待命」。
    expect(statuses.creator).toBe('idle');
    expect(statuses.producer).toBe('idle');
  });

  it('汇总阶段失败落到创作师+制作师「需要处理」', () => {
    const { statuses } = deriveRoundtableSignal(
      [record({ status: 'failed', turns: [turn('proposal', 'completed'), turn('summary', 'failed')] })],
      { gatewayId: 'gw-1' },
    );
    expect(statuses.researcher).toBe('done');
    expect(statuses.analyst).toBe('done');
    expect(statuses.creator).toBe('attention');
    expect(statuses.producer).toBe('attention');
    expect(statuses.inspector).toBe('idle');
  });

  it('取最新一条记录（updatedAt 优先），且按网关过滤', () => {
    const older = record({
      id: 'older',
      updatedAt: '2026-10-06T00:00:00.000Z',
      turns: [turn('proposal', 'completed')],
    });
    const newer = record({ id: 'newer', updatedAt: '2026-10-06T01:00:00.000Z', turns: [turn('proposal', 'running')] });
    const otherGateway = record({
      id: 'other-gw',
      gatewayId: 'gw-2',
      updatedAt: '2026-10-06T02:00:00.000Z',
      turns: [turn('proposal', 'failed')],
    });
    const { record: latest, statuses } = deriveRoundtableSignal([older, otherGateway, newer], { gatewayId: 'gw-1' });
    expect(latest?.id).toBe('newer');
    expect(statuses.analyst).toBe('working');
  });

  it('部分完成 + 部分失败 ⇒ 需要处理优先于已完成（不粉饰）', () => {
    expect(deriveStageStatus([turn('review', 'completed'), turn('review', 'failed')])).toBe('attention');
    expect(deriveStageStatus([])).toBeNull();
    expect(deriveStageStatus([turn('review', 'pending')])).toBe('idle');
    expect(deriveStageStatus([turn('review', 'dispatching')])).toBe('working');
  });
});

describe('TeamRoundtable 组件', () => {
  beforeEach(() => {
    mocks.records = [];
    mocks.loaded = true;
    mocks.load.mockClear();
  });

  it('圆桌渲染主罗盘 + 五个岗位，状态来自真实记录', () => {
    mocks.records = [record({ turns: [turn('proposal', 'running'), turn('review', 'completed')] })];
    const view = render(<TeamRoundtable />);
    expect(view.container.querySelector('[data-testid="roundtable-compass"]')).not.toBeNull();
    const nodes = [...view.container.querySelectorAll('[data-position]')];
    expect(nodes.map((node) => node.getAttribute('data-position'))).toEqual([...ROUNDTABLE_POSITIONS]);
    const byPosition = new Map(
      nodes.map((node) => [node.getAttribute('data-position'), node.getAttribute('data-status')]),
    );
    expect(byPosition.get('researcher')).toBe('working');
    expect(byPosition.get('inspector')).toBe('done');
    expect(byPosition.get('creator')).toBe('idle');
    // 岗位名走与个性化中心**共用**的词表（`identity.teamPosition.*`）
    expect(view.container.textContent).toContain('identity.teamPosition.researcher.name');
    expect(view.container.textContent).toContain('teams.roundtable.status.working');
    // 真实出处要可见：最近一次会议的问题
    expect(view.container.textContent).toContain('teams.roundtable.latest');
    expect(view.container.textContent).toContain('如何安排本周发布？');
    view.unmount();
  });

  it('没有记录时五岗位「未启用」，并且不会去 load 第二次', () => {
    mocks.loaded = false;
    const view = render(<TeamRoundtable />);
    const nodes = [...view.container.querySelectorAll('[data-position]')];
    expect(nodes.every((node) => node.getAttribute('data-status') === 'disabled')).toBe(true);
    expect(view.container.textContent).toContain('teams.roundtable.status.disabled');
    expect(mocks.load).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
