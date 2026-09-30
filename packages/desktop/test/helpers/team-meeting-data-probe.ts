import {
  buildSessionKey,
  type CreateTeamMeetingInput,
  type MeetingStage,
  type TeamMeetingRecord,
} from '@clawwork/shared';
import { initDatabase, closeDatabase, getSqlite } from '../../src/main/db/index.js';
import { handlers } from './team-meeting-ipc.js';

const [, , workspacePath, scenario] = process.argv;
const now = '2026-09-30T00:00:00.000Z';

function fixture(prefix = '', teamId = 'team'): CreateTeamMeetingInput {
  const turns = (['proposal', 'review', 'summary'] as MeetingStage[]).map((stage, index) => {
    const agentId = index === 1 ? 'reviewer' : 'author';
    return {
      id: `${prefix}turn-${index}`,
      stage,
      taskId: `${prefix}task-${index}`,
      agentId,
      agentName: agentId,
      sessionKey: buildSessionKey(`${prefix}task-${index}`, agentId, 'test-device'),
      status: 'pending' as const,
      messageIds: [],
    };
  });
  const record = {
    id: `${prefix}meeting`,
    ownerTaskId: `${prefix}task-2`,
    teamId,
    gatewayId: 'gateway',
    revision: 0,
    question: 'Discuss this',
    addenda: [],
    status: 'draft' as const,
    turns,
    stopRequested: false,
    createdAt: now,
    updatedAt: now,
  };
  const tasks = turns.map((turn) => ({
    id: turn.taskId,
    sessionKey: turn.sessionKey,
    sessionId: '',
    title: turn.stage,
    status: 'active' as const,
    ensemble: false,
    createdAt: now,
    updatedAt: now,
    tags: [],
    artifactDir: turn.taskId,
    gatewayId: 'gateway',
    teamId,
    agentId: turn.agentId,
  }));
  return { record, tasks };
}

async function main() {
  initDatabase(workspacePath);
  const db = getSqlite()!;
  if (scenario === 'schema')
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_meetings'").all();
  const meeting = await import('../../src/main/ipc/team-meeting-handlers.js');
  meeting.registerTeamMeetingHandlers();
  function invoke(name: string, value?: unknown): Record<string, unknown> {
    const handler = handlers.get(`data:${name}-team-meeting${name === 'list' ? 's' : ''}`);
    if (!handler) return { ok: false, error: 'Endpoint missing' };
    return handler({}, value) as Record<string, unknown>;
  }
  db.prepare('INSERT INTO teams (id, name, gateway_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'team',
    'Team',
    'gateway',
    now,
    now,
  );
  for (const agent of ['author', 'reviewer', 'summarizer'])
    db.prepare('INSERT INTO team_agents (team_id, agent_id) VALUES (?, ?)').run('team', agent);
  const input = fixture();
  const count = () => ({
    tasks: db.prepare('SELECT count(*) AS n FROM tasks').get(),
    meetings: db.prepare('SELECT count(*) AS n FROM team_meetings').get(),
  });
  if (scenario === 'create')
    return {
      response: invoke('create', input),
      listed: invoke('list'),
      count: count(),
      assistantRows: db.prepare("SELECT count(*) AS n FROM messages WHERE role = 'assistant'").get(),
    };
  if (scenario === 'rollback') {
    db.exec(
      "CREATE TRIGGER refuse_meeting BEFORE INSERT ON team_meetings BEGIN SELECT RAISE(ABORT, 'fixture refuses metadata'); END;",
    );
    return { response: invoke('create', input), count: count() };
  }
  if (scenario.startsWith('invalid-')) {
    const kind = scenario.slice('invalid-'.length);
    if (kind === 'gateway') input.tasks[1].gatewayId = 'other';
    if (kind === 'agent') {
      input.record.turns[1].agentId = 'not-a-member';
      input.tasks[1].agentId = 'not-a-member';
      input.tasks[1].sessionKey = input.record.turns[1].sessionKey = buildSessionKey(
        'task-1',
        'not-a-member',
        'test-device',
      );
    }
    if (kind === 'device')
      input.tasks[0].sessionKey = input.record.turns[0].sessionKey = buildSessionKey(
        'task-0',
        'author',
        'foreign-device',
      );
    if (kind === 'ensemble') input.tasks[0].ensemble = true;
    if (kind === 'missing') input.record.missingTaskIds = ['task-0'];
    return { response: invoke('create', input), count: count() };
  }
  const created = invoke('create', input);
  if (created.ok !== true) return { created };
  if (scenario.startsWith('start:') || scenario.startsWith('delete-state:')) {
    const [action, status, abortStatus, followup] = scenario.split(':');
    const previous = structuredClone(input.record);
    if (['dispatching', 'syncing'].includes(status)) {
      previous.status = 'interrupted';
      previous.turns[0].status = status as 'dispatching' | 'syncing';
      if (status === 'syncing') previous.turns[0].runId = 'accepted';
    } else {
      previous.status = status as TeamMeetingRecord['status'];
    }
    if (abortStatus && abortStatus !== 'none') {
      previous.abortStatus = abortStatus as TeamMeetingRecord['abortStatus'];
      previous.stopRequested = true;
      previous.turns[0].status = 'stopped';
      previous.turns[0].runId = 'accepted';
    }
    if (status === 'completed') {
      for (const turn of previous.turns) {
        turn.status = 'completed';
        turn.runId = `completed-${turn.id}`;
        turn.messageIds = [`canonical-${turn.id}`];
        db.prepare(
          'INSERT INTO messages (id, task_id, role, content, timestamp, session_key, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(turn.messageIds[0], turn.taskId, 'assistant', 'canonical completion', now, turn.sessionKey, turn.runId);
      }
    }
    const saved = invoke('save', { record: previous, expectedRevision: 0 });
    if (saved.ok !== true) throw new Error(JSON.stringify(saved));
    if (action === 'delete-state') {
      let error: string | undefined;
      let removed = false;
      try {
        meeting.withTeamMeetingTaskDeletion('task-2', () => {
          removed = true;
          db.prepare("DELETE FROM messages WHERE task_id = 'task-2'").run();
          db.prepare("DELETE FROM tasks WHERE id = 'task-2'").run();
        });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const deletedCount = count();
      const nextMeeting = followup === 'create' ? invoke('create', fixture('next-')) : undefined;
      return { error, removed, deletedCount, nextMeeting, count: count(), listed: invoke('list') };
    }
    const next = fixture('next-', followup === 'unrelated' ? 'other-team' : 'team');
    if (followup === 'unrelated') {
      db.prepare('INSERT INTO teams (id, name, gateway_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        'other-team',
        'Other',
        'gateway',
        now,
        now,
      );
      for (const agent of ['author', 'reviewer'])
        db.prepare('INSERT INTO team_agents (team_id, agent_id) VALUES (?, ?)').run('other-team', agent);
    }
    const response = invoke('create', next);
    const blockedCount = count();
    if (followup === 'confirmed' || followup === 'not-running') {
      const retry = invoke('save', {
        record: { ...previous, revision: 1, status: 'stopped', abortStatus: followup },
        expectedRevision: 1,
      });
      return { response, blockedCount, retry, unlocked: invoke('create', next), count: count() };
    }
    return { response, count: count(), listed: invoke('list') };
  }
  if (scenario === 'cas') {
    const update = { ...input.record, status: 'running', updatedAt: now };
    const saved = invoke('save', { record: update, expectedRevision: 0 });
    const stale = invoke('save', { record: update, expectedRevision: 0 });
    const ownership = invoke('save', { record: { ...update, revision: 1, gatewayId: 'other' }, expectedRevision: 1 });
    return { saved, stale, ownership, listed: invoke('list') };
  }
  if (scenario === 'corrupt') {
    db.prepare("UPDATE team_meetings SET record_json = '{broken'").run();
    return invoke('list');
  }
  if (scenario === 'missing-save') {
    db.prepare("DELETE FROM tasks WHERE id = 'task-0'").run();
    return invoke('save', {
      record: { ...input.record, status: 'interrupted', missingTaskIds: ['task-0'] },
      expectedRevision: 0,
    });
  }
  if (scenario === 'receipt') {
    const running = structuredClone(input.record);
    running.status = 'running';
    running.turns[0].status = 'running';
    running.turns[0].runId = 'run-1';
    const accepted = invoke('save', { record: running, expectedRevision: 0 });
    const replaced = structuredClone(running);
    replaced.revision = 1;
    replaced.turns[0].runId = 'run-2';
    const replacement = invoke('save', { record: replaced, expectedRevision: 1 });
    const completed = structuredClone(running);
    completed.revision = 1;
    completed.turns[0].status = 'completed';
    completed.turns[0].messageIds = ['message-1'];
    const missingMessage = invoke('save', { record: completed, expectedRevision: 1 });
    db.prepare(
      'INSERT INTO messages (id, task_id, role, content, timestamp, session_key, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('message-1', 'task-0', 'assistant', 'canonical answer', now, input.record.turns[0].sessionKey, 'run-1');
    const saved = invoke('save', { record: completed, expectedRevision: 1 });
    const regressed = structuredClone(completed);
    regressed.revision = 2;
    regressed.turns[0].status = 'running';
    return {
      accepted,
      replacement,
      missingMessage,
      saved,
      regression: invoke('save', { record: regressed, expectedRevision: 2 }),
    };
  }
  if (scenario.startsWith('delete-')) {
    if (scenario === 'delete-running')
      invoke('save', { record: { ...input.record, status: 'running' }, expectedRevision: 0 });
    if (scenario === 'delete-rollback')
      db.exec(
        "CREATE TRIGGER refuse_meeting_update BEFORE UPDATE ON team_meetings BEGIN SELECT RAISE(ABORT, 'fixture refuses update'); END;",
      );
    let error: string | undefined;
    try {
      meeting.withTeamMeetingTaskDeletion('task-2', () => {
        db.prepare("DELETE FROM tasks WHERE id = 'task-2'").run();
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    return {
      error,
      count: count(),
      listed: invoke('list'),
      taskIds: db.prepare('SELECT id FROM tasks ORDER BY id').all(),
    };
  }
  throw new Error(`Unknown scenario ${scenario}`);
}

try {
  console.log(`TEAM_MEETING_RESULT=${JSON.stringify(await main())}`);
} finally {
  closeDatabase();
}
