import { describe, expect, it } from 'vitest';
import { meetingCatalog } from '../src/renderer/features/team-meeting/catalog';
import type { Team } from '@clawwork/shared';
const team = { agents: [{ agentId: 'a' }, { agentId: 'b' }] } as Team;
describe('meeting catalog', () => {
  it('only offers available configured relay models and real team members', () => {
    const result = meetingCatalog(
      team,
      [
        { id: 'a', name: 'A', model: { primary: 'model' } },
        { id: 'outsider', name: 'Other' },
      ],
      [
        { id: 'model', provider: 'clawrouter' },
        { id: 'other', provider: 'unconfigured' },
        { id: 'retired', provider: 'clawrouter', available: false },
      ],
    );
    expect(result.models).toEqual(['clawrouter/model']);
    expect(result.members).toEqual([{ agentId: 'a', name: 'A', model: 'clawrouter/model' }]);
  });
  it('does not remap a named different provider or missing model by suffix', () => {
    const result = meetingCatalog(
      team,
      [
        { id: 'a', model: { primary: 'other/model' } },
        { id: 'b', model: { primary: 'retired' } },
      ],
      [{ id: 'model', provider: 'clawrouter' }],
    );
    expect(result.members.map((member) => member.model)).toEqual(['other/model', 'retired']);
  });
});
