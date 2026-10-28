import { buildSessionKey, parseAgentIdFromSessionKey, parseTaskIdFromSessionKey } from './constants.js';
import type { Task } from './types.js';

export type MeetingStage = 'proposal' | 'review' | 'summary';
export type MeetingStatus = 'draft' | 'running' | 'stopping' | 'stopped' | 'failed' | 'interrupted' | 'completed';
export type MeetingTurnStatus =
  | 'pending'
  | 'dispatching'
  | 'running'
  | 'syncing'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'stopped';

export interface MeetingTurn {
  id: string;
  stage: MeetingStage;
  taskId: string;
  agentId: string;
  agentName: string;
  sessionKey: string;
  status: MeetingTurnStatus;
  runId?: string;
  messageIds: string[];
  failure?: string;
}

export interface TeamMeetingRecord {
  id: string;
  ownerTaskId: string;
  teamId: string;
  gatewayId: string;
  revision: number;
  question: string;
  addenda: string[];
  status: MeetingStatus;
  turns: MeetingTurn[];
  stopRequested: boolean;
  abortStatus?: 'requested' | 'confirmed' | 'not-running' | 'unconfirmed';
  missingTaskIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateTeamMeetingInput {
  record: TeamMeetingRecord;
  tasks: Task[];
}
export type CreateTeamMeetingResult = CreateTeamMeetingInput;
export interface SaveTeamMeetingInput {
  record: TeamMeetingRecord;
  expectedRevision: number;
}

export function hasUnresolvedTeamMeetingAbort(record: TeamMeetingRecord): boolean {
  const completed =
    record.turns.length === 3 &&
    record.turns.every((turn) => turn.status === 'completed' && turn.runId?.trim() && turn.messageIds.length > 0);
  return !completed && (record.abortStatus === 'requested' || record.abortStatus === 'unconfirmed');
}

export function isTeamMeetingActive(record: TeamMeetingRecord, includeDraft = true): boolean {
  return (
    (includeDraft && record.status === 'draft') ||
    record.status === 'running' ||
    record.status === 'stopping' ||
    record.turns.some((turn) => ['dispatching', 'running', 'syncing'].includes(turn.status)) ||
    hasUnresolvedTeamMeetingAbort(record)
  );
}

function valid(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid team meeting metadata');
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  valid(value !== null && typeof value === 'object' && !Array.isArray(value));
  valid(Object.keys(value).every((key) => keys.includes(key)));
  return value as Record<string, unknown>;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}

export function parseTeamMeetingRecord(value: unknown): TeamMeetingRecord {
  const record = object(value, [
    'id',
    'ownerTaskId',
    'teamId',
    'gatewayId',
    'revision',
    'question',
    'addenda',
    'status',
    'turns',
    'stopRequested',
    'abortStatus',
    'missingTaskIds',
    'createdAt',
    'updatedAt',
  ]);
  for (const key of ['id', 'ownerTaskId', 'teamId', 'gatewayId', 'question', 'createdAt', 'updatedAt'])
    valid(text(record[key]));
  valid(Number.isSafeInteger(record.revision) && (record.revision as number) >= 0);
  valid(strings(record.addenda) && typeof record.stopRequested === 'boolean');
  valid(text(record.status));
  valid(
    ['draft', 'running', 'stopping', 'stopped', 'failed', 'interrupted', 'completed'].includes(String(record.status)),
  );
  valid(
    record.abortStatus === undefined ||
      (text(record.abortStatus) &&
        ['requested', 'confirmed', 'not-running', 'unconfirmed'].includes(record.abortStatus)),
  );
  valid(!Number.isNaN(Date.parse(String(record.createdAt))) && !Number.isNaN(Date.parse(String(record.updatedAt))));
  valid(Array.isArray(record.turns) && record.turns.length === 3);
  const turns = record.turns.map((value) => {
    const turn = object(value, [
      'id',
      'stage',
      'taskId',
      'agentId',
      'agentName',
      'sessionKey',
      'status',
      'runId',
      'messageIds',
      'failure',
    ]);
    for (const key of ['id', 'taskId', 'agentId', 'agentName', 'sessionKey']) valid(text(turn[key]));
    valid(text(turn.stage) && text(turn.status));
    valid(['proposal', 'review', 'summary'].includes(String(turn.stage)));
    valid(
      ['pending', 'dispatching', 'running', 'syncing', 'completed', 'failed', 'interrupted', 'stopped'].includes(
        String(turn.status),
      ),
    );
    valid(turn.runId === undefined || text(turn.runId));
    valid(turn.failure === undefined || typeof turn.failure === 'string');
    valid(strings(turn.messageIds) && new Set(turn.messageIds).size === turn.messageIds.length);
    const sessionKey = turn.sessionKey as string;
    const deviceId = /^agent:[^:]+:clawwork:([^:]+):task:/.exec(sessionKey)?.[1];
    valid(sessionKey === buildSessionKey(turn.taskId as string, turn.agentId as string, deviceId));
    valid(
      parseTaskIdFromSessionKey(sessionKey) === turn.taskId && parseAgentIdFromSessionKey(sessionKey) === turn.agentId,
    );
    valid(!['running', 'syncing', 'completed'].includes(String(turn.status)) || text(turn.runId));
    valid(turn.status !== 'completed' || turn.messageIds.length > 0);
    return turn;
  });
  for (const key of ['id', 'stage', 'taskId', 'sessionKey']) valid(new Set(turns.map((turn) => turn[key])).size === 3);
  const memberCount = new Set(turns.map((turn) => turn.agentId)).size;
  valid(memberCount >= 2);
  if (memberCount === 2)
    valid(
      turns.find((turn) => turn.stage === 'proposal')?.agentId ===
        turns.find((turn) => turn.stage === 'summary')?.agentId,
    );
  valid(turns.find((turn) => turn.stage === 'summary')?.taskId === record.ownerTaskId);
  valid(record.status !== 'completed' || turns.every((turn) => turn.status === 'completed'));
  if (record.missingTaskIds !== undefined) {
    valid(strings(record.missingTaskIds) && new Set(record.missingTaskIds).size === record.missingTaskIds.length);
    valid(record.missingTaskIds.every((id) => turns.some((turn) => turn.taskId === id)));
    valid(record.missingTaskIds.length === 0 || record.status === 'interrupted');
  }
  return value as TeamMeetingRecord;
}
