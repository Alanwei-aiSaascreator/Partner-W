// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamMeetingRecord } from '@clawwork/shared';
import {
  ROUNDTABLE_POSITIONS,
  attributeTurnToPosition,
  deriveRoundtableSignal,
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

function turn(stage: Turn['stage'], status: Turn['status'], agentId = `agent-${stage}`): Turn {
  return {
    id: `${stage}-${status}`,
    stage,
    taskId: `task-${stage}`,
    agentId,
    agentName: `name-${agentId}`,
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

describe('roundtable signal derivation (真实信号 → 岗位归属)', () => {
  it('没有任何会议记录 ⇒ 无岗位、无参与名单，不编任何东西', () => {
    const {
      record: latest,
      positions,
      participants,
      unattributed,
    } = deriveRoundtableSignal([], {
      gatewayId: 'gw-1',
    });
    expect(latest).toBeNull();
    expect(positions).toEqual([]);
    expect(participants).toEqual([]);
    expect(unattributed).toEqual([]);
  });

  it('⭐ 拿不到网关 id ⇒ 按**无信号**处理（不把别的网关的会议当本团队状态）', () => {
    // ⚠️ 2026-10-07（质检 P3-2）：老判据 `!options.gatewayId || …` 在缺网关时恒真，
    //    任意网关上的会议都会被当成"本团队"的进度。
    const other = record({ turns: [turn('proposal', 'running')] });
    expect(deriveRoundtableSignal([other], {}).record).toBeNull();

    // 对照组：网关给了、也对得上 ⇒ 同一条记录正常生效
    expect(deriveRoundtableSignal([other], { gatewayId: 'gw-1' }).record?.id).toBe('meeting-1');
  });

  /**
   * ⭐ 2026-10-16（T30）反例：旧版按 `stage` **写死**把阶段映射成岗位
   *    （proposal→调研员+分析师…），一眼都没看 `turn.agentId` —— 那就是编造归属。
   *    这一条钉住"那条映射被删掉了"：换 stage 换不出任何岗位。
   */
  it('⭐ 归属只认真实信号：任何 stage 组合都归不出岗位（positions 恒空）', () => {
    const onlyProposal = deriveRoundtableSignal([record({ turns: [turn('proposal', 'running')] })], {
      gatewayId: 'gw-1',
    });
    const allStages = deriveRoundtableSignal(
      [record({ turns: [turn('proposal', 'running'), turn('review', 'completed'), turn('summary', 'failed')] })],
      { gatewayId: 'gw-1' },
    );
    expect(onlyProposal.positions).toEqual([]);
    expect(allStages.positions).toEqual([]);
  });

  it('⭐ 真源没有岗位载体 ⇒ attributeTurnToPosition 恒为 null', () => {
    // 真源补上真实岗位载体（例如 turn 带 position）时，这一条应当被改写而不是被删掉。
    for (const stage of ['proposal', 'review', 'summary'] as const) {
      expect(attributeTurnToPosition(turn(stage, 'running'))).toBeNull();
    }
    // 反空转：这份岗位清单本身必须还是那五个（别把断言写成恒真）
    expect([...ROUNDTABLE_POSITIONS]).toEqual(['researcher', 'analyst', 'creator', 'producer', 'inspector']);
  });

  it('真实参与名单直接来自 turn.agentId/agentName/stage/status（不是按阶段猜的）', () => {
    const { participants } = deriveRoundtableSignal(
      [
        record({
          turns: [
            turn('proposal', 'running', 'lead'),
            turn('review', 'completed', 'reviewer'),
            turn('summary', 'failed', 'lead'),
          ],
        }),
      ],
      { gatewayId: 'gw-1' },
    );
    expect(participants).toEqual([
      { agentId: 'lead', name: 'name-lead', stage: 'proposal', phase: 'working' },
      { agentId: 'reviewer', name: 'name-reviewer', stage: 'review', phase: 'done' },
      { agentId: 'lead', name: 'name-lead', stage: 'summary', phase: 'attention' },
    ]);
  });

  it('归因缺口：每一轮都留一条（供归因日志），且带上真实 agentId/stage', () => {
    const { unattributed } = deriveRoundtableSignal(
      [record({ turns: [turn('proposal', 'running', 'lead'), turn('review', 'completed', 'reviewer')] })],
      { gatewayId: 'gw-1' },
    );
    expect(unattributed).toHaveLength(2);
    expect(unattributed[0]).toMatchObject({ agentId: 'lead', stage: 'proposal' });
    expect(unattributed[1]).toMatchObject({ agentId: 'reviewer', stage: 'review' });
    expect(unattributed.every((gap) => gap.reason.includes('no position carrier'))).toBe(true);
  });

  it('取最新一条记录（updatedAt 优先），且按网关过滤', () => {
    const older = record({
      id: 'older',
      updatedAt: '2026-10-06T00:00:00.000Z',
      turns: [turn('proposal', 'completed')],
    });
    const newer = record({
      id: 'newer',
      updatedAt: '2026-10-06T01:00:00.000Z',
      turns: [turn('proposal', 'running', 'lead')],
    });
    const otherGateway = record({
      id: 'other-gw',
      gatewayId: 'gw-2',
      updatedAt: '2026-10-06T02:00:00.000Z',
      turns: [turn('proposal', 'failed')],
    });
    const { record: latest, participants } = deriveRoundtableSignal([older, otherGateway, newer], {
      gatewayId: 'gw-1',
    });
    expect(latest?.id).toBe('newer');
    expect(participants.map((p) => p.agentId)).toEqual(['lead']);
  });
});

describe('TeamRoundtable 组件', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.records = [];
    mocks.loaded = true;
    mocks.load.mockClear();
    // 归因日志本身在下面第一条里被断言；这里顺手把它从测试输出里摘掉（不是关掉功能）。
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => warn.mockRestore());

  /**
   * ⭐ 2026-10-16（T30）裁决口径：**无真实归因时不渲染任何岗位徽章** ——
   *    不是渲染 5 个"未归因"灰徽章（那是把"我们没有这条数据"变成常驻噪声）。
   */
  it('⭐ 有真实会议记录但无真实归因 ⇒ 一个岗位徽章都不渲染', () => {
    mocks.records = [record({ turns: [turn('proposal', 'running', 'lead'), turn('review', 'completed', 'reviewer')] })];
    const view = render(<TeamRoundtable />);
    expect(view.container.querySelectorAll('[data-position]')).toHaveLength(0);
    expect(view.container.querySelector('[data-testid="roundtable-compass"]')).not.toBeNull();
    // 真实出处要可见：最近一次会议的问题
    expect(view.container.textContent).toContain('teams.roundtable.latest');
    expect(view.container.textContent).toContain('如何安排本周发布？');
    // 归因日志：归不到岗位的轮次要留痕（带真实 agentId/stage）
    const gapCall = warn.mock.calls.find((call) => String(call[0]).includes('teams:roundtable'));
    expect(gapCall).toBeTruthy();
    expect(JSON.stringify(gapCall?.[1])).toContain('lead');
    view.unmount();
  });

  it('⭐ 真实参与名单来自 turn.agentId：显真名 + 真阶段 + 真状态', () => {
    mocks.records = [record({ turns: [turn('proposal', 'running', 'lead'), turn('review', 'completed', 'reviewer')] })];
    const view = render(<TeamRoundtable />);
    const list = view.container.querySelector('[data-testid="roundtable-participants"]');
    expect(list).not.toBeNull();
    expect(view.container.textContent).toContain('teams.roundtable.participants');
    const rows = [...view.container.querySelectorAll('[data-participant]')];
    expect(rows.map((row) => row.getAttribute('data-participant'))).toEqual(['lead', 'reviewer']);
    expect(rows.map((row) => row.getAttribute('data-participant-phase'))).toEqual(['working', 'done']);
    expect(rows[0].textContent).toContain('name-lead');
    expect(rows[0].textContent).toContain('meeting.stage.proposal');
    expect(rows[1].textContent).toContain('meeting.stage.review');
    view.unmount();
  });

  it('没有记录 ⇒ 无岗位徽章、无参与名单，并且不会去 load 第二次', () => {
    mocks.loaded = false;
    const view = render(<TeamRoundtable />);
    expect(view.container.querySelectorAll('[data-position]')).toHaveLength(0);
    expect(view.container.querySelector('[data-testid="roundtable-participants"]')).toBeNull();
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('teams:roundtable'))).toHaveLength(0);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  /**
   * ⭐ 2026-10-17（T30b）：舞台不画假徽章之后，圆桌**不能只剩一个空圈**。
   *    补一条**五岗位结构行**：五个岗位名 + 职责（同一个词表 `identity.teamPosition.*`），
   *    但它描述的是**执行结构本身**，**零状态** —— 不带 `data-status` / 状态点 / 进度。
   */
  it('⭐ 五岗位结构行：五个岗位齐全、名字+职责都走共用词表，且零状态', () => {
    mocks.records = [];
    const view = render(<TeamRoundtable />);
    const structure = view.container.querySelector('[data-testid="roundtable-positions"]');
    expect(structure).not.toBeNull();
    // 标题也走词表（不是写死的中文）
    expect(view.container.textContent).toContain('teams.roundtable.positions');

    const items = [...structure!.querySelectorAll('[data-team-position]')];
    // 反空转：必须**正好**是那五个岗位、顺序也对得上（别把断言写成"空数组也算过"）
    expect(items.map((el) => el.getAttribute('data-team-position'))).toEqual([
      'researcher',
      'analyst',
      'creator',
      'producer',
      'inspector',
    ]);
    // 名字 + 职责都走 identity.teamPosition.* （唯一词表），不是另造一套键
    expect(items[0].textContent).toContain('identity.teamPosition.researcher.name');
    expect(items[0].textContent).toContain('identity.teamPosition.researcher.duty');
    expect(items[4].textContent).toContain('identity.teamPosition.inspector.duty');

    // ⭐⭐ 反例（核心）：结构行里**不许**出现任何"状态" ——
    //   data-status（相位）／data-position（归属徽章）／data-participant-phase（参与相位）一个都不许有。
    expect(structure!.querySelectorAll('[data-status]')).toHaveLength(0);
    expect(structure!.querySelectorAll('[data-position]')).toHaveLength(0);
    expect(structure!.querySelectorAll('[data-participant-phase]')).toHaveLength(0);
    view.unmount();
  });

  /**
   * ⭐ 2026-10-17（T30b）反假状态：结构行是**纯结构**，必须与会议信号**完全无关** ——
   *    有会议记录 / 没会议记录，结构行逐字节相同；任何一轮都推不出"某个岗位在工作"。
   */
  it('⭐ 反假状态：结构行不随会议信号变化（有无会议记录，结构行 DOM 逐字节相同）', () => {
    mocks.records = [];
    const empty = render(<TeamRoundtable />);
    const emptyHtml = empty.container.querySelector('[data-testid="roundtable-positions"]')!.outerHTML;
    empty.unmount();

    mocks.records = [record({ turns: [turn('proposal', 'running', 'lead'), turn('review', 'failed', 'reviewer')] })];
    const live = render(<TeamRoundtable />);
    const liveHtml = live.container.querySelector('[data-testid="roundtable-positions"]')!.outerHTML;
    // 真源没有岗位载体 ⇒ positions 恒空 ⇒ 整页没有任何假归属 / 假相位
    expect(live.container.querySelectorAll('[data-status]')).toHaveLength(0);
    expect(live.container.querySelectorAll('[data-position]')).toHaveLength(0);
    // 结构行本身也绝不因为"有一轮在跑"而多出任何状态
    expect(liveHtml).toBe(emptyHtml);
    live.unmount();
  });
});
