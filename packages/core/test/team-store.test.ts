import { describe, expect, it, vi } from 'vitest';
import type { Team } from '@clawwork/shared';
import { createTeamStore } from '../src/stores/team-store';

function team(): Team {
  return {
    id: 'team-cold',
    name: '中文增长团队',
    emoji: '🚀',
    description: '',
    gatewayId: 'gw-1',
    source: 'local',
    version: '1',
    agents: [{ agentId: 'main', role: 'coordinator', isManager: true, skills: [], position: 'moderator' }],
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
  };
}

describe('team store cold-start load', () => {
  it('按 id 补读持久化团队并写入缓存，后续不重复请求', async () => {
    const persisted = team();
    const getTeam = vi.fn(async () => ({ ok: true as const, result: persisted }));
    const store = createTeamStore({
      listTeams: vi.fn(async () => ({ ok: true as const, result: [] })),
      getTeam,
      persistTeam: vi.fn(async () => ({ ok: true as const })),
      deleteTeam: vi.fn(async () => ({ ok: true as const })),
    });

    await expect(store.getState().loadTeam('team-cold')).resolves.toEqual(persisted);
    expect(store.getState().teams['team-cold']).toEqual(persisted);
    await expect(store.getState().loadTeam('team-cold')).resolves.toEqual(persisted);
    expect(getTeam).toHaveBeenCalledTimes(1);
  });
});
