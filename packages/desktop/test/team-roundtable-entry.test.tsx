// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Team } from '@clawwork/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 保留插值，这样能断言文案里到底带了什么数字
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}|${JSON.stringify(vars)}` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('@/hooks/useResizePanel', () => ({
  useResizePanel: () => ({ isDragging: false, onResizeStart: vi.fn() }),
}));

vi.mock('../src/renderer/layouts/TeamsPanel/TeamFileTree', () => ({
  default: () => <div data-testid="file-tree" />,
}));

import TeamDetailView from '../src/renderer/layouts/TeamsPanel/TeamDetailView';
import { useUiStore } from '../src/renderer/stores/uiStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const team = (members: number): Team =>
  ({
    id: 't1',
    name: '选题小组',
    emoji: '🧩',
    description: '一起定选题',
    gatewayId: 'gw-1',
    source: 'local',
    version: '1.0.0',
    agents: Array.from({ length: members }, (_, i) => ({
      agentId: `a${i}`,
      role: i === 0 ? 'coordinator' : 'worker',
      isManager: i === 0,
      skills: [],
      position: i === 0 ? 'moderator' : 'expert',
    })),
    createdAt: '',
    updatedAt: '',
  }) as unknown as Team;

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

const button = (c: HTMLElement) => c.querySelector('[data-action="start-roundtable"]') as HTMLButtonElement | null;
const textarea = (c: HTMLElement) =>
  c.querySelector('[data-field="roundtable-question"]') as HTMLTextAreaElement | null;

function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  (window as unknown as { clawwork: unknown }).clawwork = {
    listAgentFiles: vi.fn(async () => ({ ok: true, result: { files: [] } })),
  };
  useUiStore.setState({ agentCatalogByGateway: {} });
});

/**
 * 「一起讨论」入口（2026-09-20）。
 *
 * ⚠️ 这里最重要的是**文案口径**：用户拍板"委婉一点"，所以我钉住两件事 ——
 *    提示里要有"几位助手"（让人知道为什么会贵），但**不能**出现"份积分"这种
 *    报价式说法（那会变成账单，用户开始算"那我该少放几个"）。
 */
describe('TeamDetailView — 一起讨论入口', () => {
  it('⚠️ 只有 1 位成员时不给开始（一个人不叫讨论），且说明原因', () => {
    const { container, unmount } = render(
      <TeamDetailView
        team={team(1)}
        onBack={vi.fn()}
        onStartChat={vi.fn()}
        onEdit={vi.fn()}
        onStartRoundtable={vi.fn()}
        onStopRoundtable={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('teams.roundtable.needTwo');

    // ⚠️ 必须**先填上问题**再断言禁用。空输入框时按钮本来就禁用（那是"没写问题"
    //    那条规则在拦），验不到"人数不够"这道门槛 —— 变异验证实测：去掉人数判断，
    //    空输入框版本照样全绿。
    type(textarea(container)!, '这件事该怎么办？');
    expect(button(container)!.disabled).toBe(true);
    unmount();
  });

  it('⭐ 2 位以上：提示里有"几位助手"（说明为什么贵），但**不报份数**', () => {
    const { container, unmount } = render(
      <TeamDetailView
        team={team(4)}
        onBack={vi.fn()}
        onStartChat={vi.fn()}
        onEdit={vi.fn()}
        onStartRoundtable={vi.fn()}
        onStopRoundtable={vi.fn()}
      />,
    );

    const text = container.textContent ?? '';
    expect(text).toContain('teams.roundtable.hint');
    // 说清原因：4 位助手一起做
    expect(text).toContain('"count":4');
    unmount();
  });

  it('⭐ 文案口径（直接读 locale，不看 mock）：说清几位助手、委婉、**不报价**', () => {
    // ⚠️ 这条必须读**真实文案**。上面那条用的是 mock 过的 t（只回 key），
    //    在那里断言"文案里没有份积分"是空断言 —— 它永远看不到中文（假绿）。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const zh = require('../src/renderer/i18n/locales/zh.json') as {
      teams: { roundtable: { hint: string } };
    };
    const hint = zh.teams.roundtable.hint;

    // ① 说清原因：不报"4 份"，但要让人知道是几位一起做
    expect(hint).toContain('{{count}}');
    // ② 委婉：用"稍高/略高"这类相对说法
    expect(hint).toMatch(/稍高|略高/);
    // ③ 不报价：不能出现"份积分""消耗 4 份"这类账单式措辞
    expect(hint).not.toMatch(/份积分/);
    expect(hint).not.toMatch(/消耗\s*\d+\s*份/);
  });

  it('没写问题不让开始（空议题跑一轮等于白花钱）', () => {
    const onStart = vi.fn();
    const { container, unmount } = render(
      <TeamDetailView
        team={team(3)}
        onBack={vi.fn()}
        onStartChat={vi.fn()}
        onEdit={vi.fn()}
        onStartRoundtable={onStart}
        onStopRoundtable={vi.fn()}
      />,
    );

    expect(button(container)!.disabled).toBe(true);
    act(() => button(container)!.click());
    expect(onStart).not.toHaveBeenCalled();

    type(textarea(container)!, '该不该涨价？');
    expect(button(container)!.disabled).toBe(false);
    act(() => button(container)!.click());
    expect(onStart).toHaveBeenCalledWith('该不该涨价？');
    unmount();
  });

  it('⭐ 正在跑时「开始」换成「停止」（不然能重复开一轮 —— 每轮都是真花钱）', () => {
    const onStop = vi.fn();
    const { container, unmount } = render(
      <TeamDetailView
        team={team(3)}
        onBack={vi.fn()}
        onStartChat={vi.fn()}
        onEdit={vi.fn()}
        onStartRoundtable={vi.fn()}
        onStopRoundtable={onStop}
        roundtableRunning
      />,
    );

    type(textarea(container)!, 'Q');
    // 开始按钮必须消失 —— 否则用户能再点一次，又开一轮、又花一份钱
    expect(container.querySelector('[data-action="start-roundtable"]')).toBeNull();

    const stop = container.querySelector('[data-action="stop-roundtable"]') as HTMLButtonElement | null;
    expect(stop).toBeTruthy();
    act(() => stop!.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('teams.roundtable.running');
    unmount();
  });
});
