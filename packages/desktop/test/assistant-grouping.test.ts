import { describe, expect, it } from 'vitest';
import type { Team } from '@clawwork/shared';
import { groupAssistants } from '../src/renderer/lib/assistant-grouping';

function team(id: string, ids: string[], gatewayId = 'gw'): Team {
  return {
    id,
    name: `Team ${id}`,
    gatewayId,
    emoji: '',
    description: '',
    source: 'local',
    version: '1',
    createdAt: '2026-09-30',
    updatedAt: '2026-09-30',
    agents: ids.map((agentId) => ({ agentId, role: 'worker', isManager: false, skills: [] })),
  };
}

describe('assistant grouping', () => {
  it('pins the gateway default and groups only available members for this gateway', () => {
    const result = groupAssistants({
      agents: [{ id: 'solo' }, { id: 'worker' }, { id: 'main' }, { id: 'other' }],
      teams: [team('one', ['main', 'worker', 'missing']), team('remote', ['other'], 'another')],
      gatewayId: 'gw',
      defaultAgentId: 'main',
    });
    expect(result.defaultAgent?.id).toBe('main');
    expect(result.teams.map((group) => [group.team.id, group.agents.map((agent) => agent.id)])).toEqual([
      ['one', ['worker']],
    ]);
    expect(result.independent.map((agent) => agent.id)).toEqual(['solo', 'other']);
  });

  it('never duplicates agents even across several teams or duplicate catalog entries', () => {
    const result = groupAssistants({
      agents: [{ id: 'worker', name: 'First' }, { id: 'worker', name: 'Duplicate' }, { id: 'solo' }],
      teams: [team('b', ['worker', 'worker']), team('a', ['worker'])],
      gatewayId: 'gw',
      defaultAgentId: 'absent',
    });
    expect(result.defaultAgent).toBeUndefined();
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0].team.id).toBe('a');
    expect(result.teams[0].agents).toEqual([{ id: 'worker', name: 'First' }]);
    expect(result.independent.map((agent) => agent.id)).toEqual(['solo']);
  });

  /**
   * ⭐ 2026-10-07（质检 P2-2）：`defaultAgentId` 是**空串**（网关没给默认值）时，
   *    老写法 `catalog.get('' ?? 'main')` 得 `catalog.get('')` ⇒ 主罗盘**不会**被钉成
   *    默认行，反而掉进「技能与能力」折叠组（`'' ?? 'main'` 的空串 bug）。
   */
  it('⭐ 空串默认值也把主罗盘钉成默认行（不落进「技能与能力」组）', () => {
    const result = groupAssistants({
      agents: [{ id: 'rongying-content' }, { id: 'main' }],
      teams: [],
      gatewayId: 'gw',
      defaultAgentId: '',
    });
    expect(result.defaultAgent?.id).toBe('main');
    expect(result.independent.map((agent) => agent.id)).toEqual(['rongying-content']);
  });

  it('⭐ 目录里没有主罗盘时默认行留空（不拿"目录第一个"顶替）', () => {
    const result = groupAssistants({
      agents: [{ id: 'rongying-content' }, { id: 'worker' }],
      teams: [],
      gatewayId: 'gw',
      defaultAgentId: '',
    });
    expect(result.defaultAgent).toBeUndefined();
    expect(result.independent.map((agent) => agent.id)).toEqual(['rongying-content', 'worker']);
  });
});
