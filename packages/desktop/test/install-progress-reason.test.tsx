// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallEvent } from '@clawwork/shared';

import { InstallProgress } from '../src/renderer/components/TeamBuilderDialog/index';
import InstallStep from '../src/renderer/layouts/TeamsPanel/InstallStep';

/**
 * 「智能组建」的进度面板：**失败原因必须上屏**（2026-09-20 U 盘交付实机，截图 4）。
 *
 * ⚠️ 这个用例是**先有实机、后有断言**：同事那台机器上四个助手全建失败，面板只显示了
 *    四行 slug + 一句大写英文 `NO AGENTS WERE CREATED SUCCESSFULLY`；而
 *    `team-installer` 其实把每个助手的网关原文放进了 `warning` 事件 ——
 *    旧实现的渲染里没有它。断言先钉"原文在屏幕上"，再靠变异（删掉那段渲染）证明它真的会红。
 */

const agents = [{ name: 'CodeArchitect' }, { name: 'FrontendEngineer' }];

const events: InstallEvent[] = [
  { type: 'agent_creating', agentSlug: 'codearchitect', message: 'CodeArchitect' },
  {
    type: 'warning',
    agentSlug: 'codearchitect',
    message: 'Failed to create agent "CodeArchitect": gateway not connected',
  },
  { type: 'error', message: 'No agents were created successfully' },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => {
    root.render(<InstallProgress status="error" events={events} progressPercent={50} agents={agents} />);
  });
  return container.textContent ?? '';
}

describe('InstallProgress —— 失败原因上屏', () => {
  it.each(['ai', 'manual'])('shows partial counts and preserves warnings in the %s result panel', (entry) => {
    const partialEvents: InstallEvent[] = [
      { type: 'agent_created', agentSlug: 'codearchitect', agentId: 'codearchitect' },
      { type: 'warning', agentSlug: 'frontendengineer', message: 'quota exceeded' },
      {
        type: 'warning',
        agentSlug: 'codearchitect',
        skillId: 'absent',
        message: 'Skill "absent" install failed: not found',
      },
      { type: 'team_persisted' },
      { type: 'degraded', summary: { agentsSucceeded: 1, agentsFailed: 1, skillsSucceeded: 0, skillsFailed: 1 } },
    ];
    act(() => {
      root.render(
        entry === 'ai' ? (
          <InstallProgress status="degraded" events={partialEvents} progressPercent={100} agents={agents} />
        ) : (
          <InstallStep
            status="degraded"
            events={partialEvents}
            teamInfo={{ name: 'Team', emoji: '', description: '' }}
            agents={agents.map((agent) => ({
              ...agent,
              uid: agent.name,
              role: 'worker',
              description: '',
              model: '',
              agentMd: '',
              soulMd: '',
              skills: [],
            }))}
          />
        ),
      );
    });
    expect(container.textContent).toContain('quota exceeded');
    expect(container.textContent).toContain('absent');
    const summary = container.querySelector('[role="status"]');
    expect(summary?.textContent).toMatch(/1.*1.*0.*1/);
    expect(summary?.getAttribute('data-install-outcome')).toBe('degraded');
  });

  it('⭐ 逐助手的网关原文出现在面板上（不再是"只有 slug + 一句英文"）', () => {
    const text = render();

    expect(text).toContain('Failed to create agent "CodeArchitect": gateway not connected');
    expect(container.querySelectorAll('[class*="text-warning"]').length).toBeGreaterThan(0);
  });

  it('没有 agentSlug 的告警也不许丢（落全局行）', () => {
    act(() => {
      root.render(
        <InstallProgress
          status="error"
          events={events.concat([{ type: 'warning', message: 'rollback failed' }])}
          progressPercent={50}
          agents={agents}
        />,
      );
    });

    expect(container.textContent ?? '').toContain('rollback failed');
  });
});
