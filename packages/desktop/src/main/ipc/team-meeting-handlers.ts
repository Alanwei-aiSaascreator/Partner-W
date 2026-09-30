import { ipcMain } from 'electron';
import { and, eq } from 'drizzle-orm';
import { buildSessionKey, isTeamMeetingActive, parseTeamMeetingRecord } from '@clawwork/shared';
import type { CreateTeamMeetingInput, IpcResult, SaveTeamMeetingInput, TeamMeetingRecord } from '@clawwork/shared';
import { getDb, getSqlite } from '../db/index.js';
import { messages, tasks, teamAgents, teamMeetings, teams } from '../db/schema.js';
import { ensureDeviceId } from '../workspace/config.js';

function requireValid(condition: unknown, error: string): asserts condition {
  if (!condition) throw new Error(error);
}

function transaction<T>(action: () => T): T {
  const sqlite = getSqlite();
  requireValid(sqlite, 'Database not ready');
  return sqlite.transaction(action)();
}

function decode(row: typeof teamMeetings.$inferSelect): TeamMeetingRecord {
  try {
    const record = parseTeamMeetingRecord(JSON.parse(row.recordJson));
    requireValid(
      record.id === row.id &&
        record.ownerTaskId === row.ownerTaskId &&
        record.revision === row.revision &&
        record.createdAt === row.createdAt &&
        record.updatedAt === row.updatedAt,
      'Metadata row mismatch',
    );
    return record;
  } catch {
    throw new Error(`Invalid meeting record: ${row.id}`);
  }
}

function list(): TeamMeetingRecord[] {
  return getDb().select().from(teamMeetings).all().map(decode);
}

function validateReferences(record: TeamMeetingRecord): void {
  const db = getDb();
  for (const turn of record.turns) {
    const task = db.select().from(tasks).where(eq(tasks.id, turn.taskId)).get();
    if (record.missingTaskIds?.includes(turn.taskId)) {
      requireValid(!task, 'Missing task still exists');
      continue;
    }
    requireValid(
      task &&
        task.gatewayId === record.gatewayId &&
        task.teamId === record.teamId &&
        task.sessionKey === turn.sessionKey &&
        task.ensemble === false,
      'Meeting task ownership mismatch',
    );
    for (const id of turn.messageIds) {
      const message = db.select().from(messages).where(eq(messages.id, id)).get();
      requireValid(
        message &&
          message.role === 'assistant' &&
          message.taskId === turn.taskId &&
          message.sessionKey === turn.sessionKey &&
          message.runId === turn.runId,
        'Meeting message ownership mismatch',
      );
    }
  }
}

function create(input: CreateTeamMeetingInput): CreateTeamMeetingInput {
  const record = parseTeamMeetingRecord(input?.record);
  requireValid(
    record.revision === 0 &&
      record.status === 'draft' &&
      !record.stopRequested &&
      !record.abortStatus &&
      !record.missingTaskIds?.length &&
      record.turns.every((turn) => turn.status === 'pending' && !turn.runId && !turn.messageIds.length),
    'Meeting must start as an undispatched draft',
  );
  requireValid(
    Array.isArray(input.tasks) && input.tasks.length === 3 && new Set(input.tasks.map((task) => task?.id)).size === 3,
    'Meeting requires three unique tasks',
  );
  const deviceId = ensureDeviceId();
  return transaction(() => {
    const db = getDb();
    const team = db.select().from(teams).where(eq(teams.id, record.teamId)).get();
    requireValid(team?.gatewayId === record.gatewayId, 'Meeting team gateway mismatch');
    requireValid(
      !list().some((existing) => existing.teamId === record.teamId && isTeamMeetingActive(existing)),
      'Team already has an active meeting',
    );
    const members = new Set(
      db
        .select()
        .from(teamAgents)
        .where(eq(teamAgents.teamId, record.teamId))
        .all()
        .map((agent) => agent.agentId),
    );
    for (const turn of record.turns) {
      const task = input.tasks.find((task) => task.id === turn.taskId);
      requireValid(
        task &&
          members.has(turn.agentId) &&
          task.agentId === turn.agentId &&
          task.sessionKey === turn.sessionKey &&
          task.sessionKey === buildSessionKey(task.id, turn.agentId, deviceId) &&
          task.gatewayId === record.gatewayId &&
          task.teamId === record.teamId &&
          task.ensemble === false &&
          task.status === 'active' &&
          task.sessionId === '',
        'Invalid meeting task',
      );
      for (const key of ['title', 'createdAt', 'updatedAt', 'artifactDir'] as const)
        requireValid(typeof task[key] === 'string', 'Invalid task metadata');
      requireValid(Array.isArray(task.tags) && task.tags.every((tag) => typeof tag === 'string'), 'Invalid task tags');
      for (const key of ['model', 'modelProvider', 'thinkingLevel', 'pinnedAt'] as const)
        requireValid(task[key] === undefined || typeof task[key] === 'string', 'Invalid task option');
      for (const key of ['inputTokens', 'outputTokens', 'contextTokens'] as const)
        requireValid(task[key] === undefined || Number.isFinite(task[key]), 'Invalid task usage');
      requireValid(
        !db.select({ id: tasks.id }).from(tasks).where(eq(tasks.sessionKey, task.sessionKey)).get(),
        'Meeting session already exists',
      );
      const { agentId: _agentId, tags, ...fields } = task;
      db.insert(tasks)
        .values({ ...fields, tags: JSON.stringify(tags) })
        .run();
    }
    db.insert(teamMeetings)
      .values({
        id: record.id,
        ownerTaskId: record.ownerTaskId,
        revision: 0,
        recordJson: JSON.stringify(record),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .run();
    return { record, tasks: input.tasks };
  });
}

function save(input: SaveTeamMeetingInput): TeamMeetingRecord {
  const record = parseTeamMeetingRecord(input?.record);
  requireValid(
    Number.isSafeInteger(input.expectedRevision) &&
      input.expectedRevision >= 0 &&
      record.revision === input.expectedRevision,
    'Invalid expected revision',
  );
  return transaction(() => {
    const db = getDb();
    const row = db.select().from(teamMeetings).where(eq(teamMeetings.id, record.id)).get();
    requireValid(row && row.revision === input.expectedRevision, 'Meeting revision conflict');
    const previous = decode(row);
    for (const key of ['id', 'ownerTaskId', 'teamId', 'gatewayId', 'question', 'createdAt'] as const)
      requireValid(previous[key] === record[key], 'Meeting ownership is immutable');
    requireValid(
      JSON.stringify(previous.missingTaskIds ?? []) === JSON.stringify(record.missingTaskIds ?? []),
      'Missing task metadata is managed by deletion',
    );
    requireValid(
      previous.addenda.every((value, index) => record.addenda[index] === value),
      'Meeting addenda cannot be removed',
    );
    for (const old of previous.turns) {
      const turn = record.turns.find((turn) => turn.id === old.id);
      requireValid(turn, 'Meeting turns are immutable');
      for (const key of ['stage', 'taskId', 'agentId', 'agentName', 'sessionKey'] as const)
        requireValid(old[key] === turn[key], 'Meeting turn ownership is immutable');
      requireValid(!old.runId || old.runId === turn.runId, 'Accepted run receipt is immutable');
      requireValid(
        old.messageIds.every((id, index) => turn.messageIds[index] === id),
        'Canonical message references cannot be removed',
      );
      if (old.status === 'completed')
        requireValid(
          turn.status === 'completed' &&
            turn.messageIds.length === old.messageIds.length &&
            turn.failure === old.failure,
          'Completed meeting turns are immutable',
        );
    }
    validateReferences(record);
    const saved = { ...record, revision: row.revision + 1, updatedAt: new Date().toISOString() };
    const result = db
      .update(teamMeetings)
      .set({ revision: saved.revision, recordJson: JSON.stringify(saved), updatedAt: saved.updatedAt })
      .where(and(eq(teamMeetings.id, record.id), eq(teamMeetings.revision, input.expectedRevision)))
      .run();
    requireValid(result.changes === 1, 'Meeting revision conflict');
    return saved;
  });
}

function result<T>(action: () => T): IpcResult<T> {
  try {
    return { ok: true, result: action() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Meeting persistence failed' };
  }
}

export function registerTeamMeetingHandlers(): void {
  ipcMain.handle('data:create-team-meeting', (_event, input: CreateTeamMeetingInput) => result(() => create(input)));
  ipcMain.handle('data:save-team-meeting', (_event, input: SaveTeamMeetingInput) => result(() => save(input)));
  ipcMain.handle('data:list-team-meetings', () => result(list));
}
