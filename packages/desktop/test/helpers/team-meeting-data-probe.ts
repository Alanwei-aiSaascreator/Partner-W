import { buildSessionKey, type CreateTeamMeetingInput, type MeetingStage } from '@clawwork/shared';
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
  throw new Error(`Unknown scenario ${scenario}`);
}

try {
  console.log(`TEAM_MEETING_RESULT=${JSON.stringify(await main())}`);
} finally {
  closeDatabase();
}
