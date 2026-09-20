import { describe, expect, it } from 'vitest';
import type { InstallEvent } from '@clawwork/shared';
import { buildInstallEventView } from '../src/renderer/lib/install-event-view';

/**
 * 安装事件 → 界面视图（2026-09-20 U 盘交付实机）。
 *
 * ⚠️ 这个文件钉的是**"原因不许被丢掉"**：`team-installer` 把每一个助手的失败原因放在
 *    `warning` 事件里（`Failed to create agent "X": <网关原文>`），而「智能组建」那个
 *    进度面板的旧实现只读 `type:'error'` 的那一句，**逐助手的原因从头到尾没上过屏**
 *    —— 用户看到的就成了"四行 slug + 一句大写英文 `NO AGENTS WERE CREATED SUCCESSFULLY`"，
 *    我们也因此无法定位（截图 4 就是它）。
 */

const agents = [{ name: 'CodeArchitect' }, { name: 'FrontendEngineer' }];

function view(events: InstallEvent[]) {
  return buildInstallEventView(agents, events);
}

describe('buildInstallEventView', () => {
  it('⭐ 逐助手的 warning 原因**挂在该助手行上**，不是被吞掉', () => {
    const events: InstallEvent[] = [
      { type: 'agent_creating', agentSlug: 'codearchitect', message: 'CodeArchitect' },
      {
        type: 'warning',
        agentSlug: 'codearchitect',
        message: 'Failed to create agent "CodeArchitect": gateway not connected',
      },
    ];

    const { agentStates } = view(events);

    const row = agentStates.find((a) => a.slug === 'codearchitect');
    expect(row?.status).toBe('warning');
    expect(row?.warnings).toEqual(['Failed to create agent "CodeArchitect": gateway not connected']);
  });

  it('没有 agentSlug 的 warning ⇒ 落到全局告警里（仍然不许丢）', () => {
    const { globalWarnings } = view([{ type: 'warning', message: 'rollback failed' }]);
    expect(globalWarnings).toEqual(['rollback failed']);
  });

  it('建成功 ⇒ 状态是 created、告警为空；文件与技能各自记在行上', () => {
    const events: InstallEvent[] = [
      { type: 'agent_creating', agentSlug: 'frontendengineer' },
      { type: 'agent_created', agentSlug: 'frontendengineer', agentId: 'frontendengineer' },
      { type: 'file_set', agentSlug: 'frontendengineer', fileName: 'IDENTITY.md' },
      { type: 'skill_installed', agentSlug: 'frontendengineer', skillId: 'pdf' },
    ];

    const { agentStates, teamSaved } = view(events);
    const row = agentStates.find((a) => a.slug === 'frontendengineer');

    expect(row?.status).toBe('created');
    expect(row?.warnings).toEqual([]);
    expect(row?.files).toEqual([{ name: 'IDENTITY.md', ok: true }]);
    expect(row?.skills).toEqual([{ id: 'pdf', ok: true }]);
    expect(teamSaved).toBe(false);
  });

  it('全局 error 单独取出来（它是那句话的来源），team_persisted 置 teamSaved', () => {
    const { globalError, teamSaved } = view([
      { type: 'team_persisted' },
      { type: 'error', message: 'No agents were created successfully' },
    ]);
    expect(teamSaved).toBe(true);
    expect(globalError).toBe('No agents were created successfully');
  });

  it('事件流为空 ⇒ 每个助手都是 pending、没有任何告警', () => {
    const { agentStates, globalWarnings, globalError, teamSaved } = view([]);
    expect(agentStates.map((a) => a.status)).toEqual(['pending', 'pending']);
    expect(globalWarnings).toEqual([]);
    expect(globalError).toBeNull();
    expect(teamSaved).toBe(false);
  });
});
