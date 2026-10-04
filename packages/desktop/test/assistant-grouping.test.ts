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
});
