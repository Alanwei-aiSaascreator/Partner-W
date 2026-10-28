import { describe, expect, it } from 'vitest';
import * as shared from '../src/index.js';

function record() {
  const turns = ['proposal', 'review', 'summary'].map((stage, index) => ({
    id: `turn-${index}`,
    stage,
    taskId: `task-${index}`,
    agentId: index === 1 ? 'reviewer' : 'author',
    agentName: index === 1 ? 'Reviewer' : 'Author',
    sessionKey: shared.buildSessionKey(`task-${index}`, index === 1 ? 'reviewer' : 'author', 'device'),
    status: 'pending',
    messageIds: [],
  }));
  return {
    id: 'meeting',
    ownerTaskId: 'task-2',
    teamId: 'team',
    gatewayId: 'gateway',
    revision: 0,
    question: 'Discuss this',
    addenda: [],
    status: 'draft',
    turns,
    stopRequested: false,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  };
}

function parse(value: unknown): unknown {
  return shared.parseTeamMeetingRecord(value);
}

describe('team meeting metadata contract', () => {
  it('accepts three real sessions with two members and a summary owner', () => {
    expect(parse(record())).toEqual(record());
  });

  it('accepts three distinct members and device-free canonical session keys', () => {
    const input = record();
    input.turns[2].agentId = 'summarizer';
    input.turns.forEach((turn) => {
      turn.sessionKey = shared.buildSessionKey(turn.taskId, turn.agentId);
    });
    expect(parse(input)).toEqual(input);
  });

  it('assigns proposal and summary to the same member for two-member meetings', () => {
    const input = record();
    input.turns[1].agentId = 'author';
    input.turns[2].agentId = 'reviewer';
    input.turns.forEach((turn) => {
      turn.sessionKey = shared.buildSessionKey(turn.taskId, turn.agentId, 'device');
    });
    expect(() => parse(input)).toThrow();
  });

  it.each([
    [
      'missing stage',
      (r: ReturnType<typeof record>) => {
        r.turns.pop();
      },
    ],
    [
      'duplicate stage',
      (r: ReturnType<typeof record>) => {
        r.turns[2].stage = 'proposal';
      },
    ],
    [
      'duplicate task',
      (r: ReturnType<typeof record>) => {
        r.turns[1].taskId = r.turns[0].taskId;
      },
    ],
    [
      'duplicate turn',
      (r: ReturnType<typeof record>) => {
        r.turns[1].id = r.turns[0].id;
      },
    ],
    [
      'foreign session',
      (r: ReturnType<typeof record>) => {
        r.turns[1].sessionKey = r.turns[0].sessionKey;
      },
    ],
    [
      'one member',
      (r: ReturnType<typeof record>) => {
        r.turns[1].agentId = 'author';
      },
    ],
    [
      'wrong owner',
      (r: ReturnType<typeof record>) => {
        r.ownerTaskId = r.turns[0].taskId;
      },
    ],
    [
      'invalid revision',
      (r: ReturnType<typeof record>) => {
        r.revision = -1;
      },
    ],
    [
      'completed without receipt',
      (r: ReturnType<typeof record>) => {
        r.turns[0].status = 'completed';
      },
    ],
  ] as const)('rejects %s', (_name, mutate) => {
    const input = record();
    mutate(input);
    expect(() => parse(input)).toThrow();
  });

  it('rejects assistant bodies at either metadata level', () => {
    expect(() => parse({ ...record(), assistantBody: 'copied answer' })).toThrow();
    const input = record();
    expect(() =>
      parse({ ...input, turns: input.turns.map((turn) => ({ ...turn, content: 'copied answer' })) }),
    ).toThrow();
  });

  it('rejects array values masquerading as status strings', () => {
    expect(() => parse({ ...record(), status: ['draft'] })).toThrow();
    expect(() => parse({ ...record(), abortStatus: ['confirmed'] })).toThrow();
    const input = record();
    expect(() => parse({ ...input, turns: input.turns.map((turn) => ({ ...turn, status: ['pending'] })) })).toThrow();
  });

  it('allows only referenced missing task IDs on interrupted records', () => {
    expect(parse({ ...record(), status: 'interrupted', missingTaskIds: ['task-0'] })).toMatchObject({
      missingTaskIds: ['task-0'],
    });
    expect(() => parse({ ...record(), status: 'interrupted', missingTaskIds: ['foreign'] })).toThrow();
    expect(() => parse({ ...record(), missingTaskIds: ['task-0'] })).toThrow();
  });
});

describe('persisted meeting concurrency guards', () => {
  it.each(['requested', 'unconfirmed'] as const)('keeps %s cancellation unresolved after stop', (abortStatus) => {
    const input = shared.parseTeamMeetingRecord({ ...record(), status: 'stopped', abortStatus });
    expect(shared.hasUnresolvedTeamMeetingAbort(input)).toBe(true);
    expect(shared.isTeamMeetingActive(input)).toBe(true);
    expect(shared.isTeamMeetingActive(input, false)).toBe(true);
  });

  it.each(['confirmed', 'not-running'] as const)('releases %s cancellation', (abortStatus) => {
    const input = shared.parseTeamMeetingRecord({ ...record(), status: 'stopped', abortStatus });
    expect(shared.hasUnresolvedTeamMeetingAbort(input)).toBe(false);
    expect(shared.isTeamMeetingActive(input)).toBe(false);
  });

  it('keeps draft creation exclusive without changing idle-draft deletion', () => {
    const input = shared.parseTeamMeetingRecord(record());
    expect(shared.isTeamMeetingActive(input)).toBe(true);
    expect(shared.isTeamMeetingActive(input, false)).toBe(false);
  });

  it.each(['running', 'stopping'] as const)('blocks persisted %s regardless of draft policy', (status) => {
    const input = shared.parseTeamMeetingRecord({ ...record(), status });
    expect(shared.isTeamMeetingActive(input)).toBe(true);
    expect(shared.isTeamMeetingActive(input, false)).toBe(true);
  });

  it.each(['dispatching', 'running', 'syncing'] as const)(
    'blocks a persisted %s turn on an interrupted record',
    (status) => {
      const input = shared.parseTeamMeetingRecord(record());
      input.status = 'interrupted';
      input.turns[0].status = status;
      input.turns[0].runId = 'accepted';
      expect(shared.isTeamMeetingActive(input)).toBe(true);
      expect(shared.isTeamMeetingActive(input, false)).toBe(true);
    },
  );

  it('ignores stale cancellation only when all turns have canonical completion evidence', () => {
    const input = shared.parseTeamMeetingRecord(record());
    input.status = 'completed';
    input.abortStatus = 'unconfirmed';
    for (const turn of input.turns) {
      turn.status = 'completed';
      turn.runId = `run-${turn.id}`;
      turn.messageIds = [`message-${turn.id}`];
    }
    expect(shared.hasUnresolvedTeamMeetingAbort(input)).toBe(false);
    expect(shared.isTeamMeetingActive(input)).toBe(false);
    input.status = 'interrupted';
    input.missingTaskIds = [input.ownerTaskId];
    expect(shared.hasUnresolvedTeamMeetingAbort(input)).toBe(false);
    expect(shared.isTeamMeetingActive(input)).toBe(false);
    input.turns[0].messageIds = [];
    expect(shared.hasUnresolvedTeamMeetingAbort(input)).toBe(true);
    expect(shared.isTeamMeetingActive(input)).toBe(true);
  });
});
