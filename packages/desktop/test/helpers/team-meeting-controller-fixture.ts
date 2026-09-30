import { expect, vi } from 'vitest';
import type { ChatComposer, GatewayEvent, GatewayStatusEvent, RunSyncResult } from '@clawwork/core';
import type {
  CreateTeamMeetingInput,
  IpcResult,
  SaveTeamMeetingInput,
  Task,
  Team,
  TeamMeetingRecord,
} from '@clawwork/shared';
import { buildMeetingPlan } from '../../src/renderer/features/team-meeting/plan';
import {
  createTeamMeetingController,
  type MeetingControllerPorts,
} from '../../src/renderer/features/team-meeting/controller';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function nextPlan(teamId = 'team') {
  let id = 0;
  return buildMeetingPlan({
    team: { id: teamId, gatewayId: 'gateway', agents: [{ agentId: 'a' }, { agentId: 'b' }] } as Team,
    members: [
      { agentId: 'a', name: 'A', model: 'model-a' },
      { agentId: 'b', name: 'B', model: 'model-b' },
    ],
    question: 'next question',
    title: 'next meeting',
    deviceId: 'device',
    uuid: () => `next-${++id}`,
  });
}

export function setup(count = 2, overrides: Partial<MeetingControllerPorts> = {}) {
  let id = 0;
  const plan = buildMeetingPlan({
    team: { id: 'team', gatewayId: 'gateway', agents: [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }] } as Team,
    members: ['a', 'b', 'c']
      .slice(0, count)
      .map((agentId) => ({ agentId, name: agentId, model: `model-${agentId}`, thinkingLevel: 'high' })),
    question: 'question',
    title: 'meeting',
    deviceId: 'device',
    uuid: () => `id-${++id}`,
  });
  const rows = new Map<string, TeamMeetingRecord>();
  const tasks = new Map<string, Task>();
  const events = new Set<(event: GatewayEvent) => void>();
  const statuses = new Set<(event: GatewayStatusEvent) => void>();
  const create = vi.fn(async (input: CreateTeamMeetingInput): Promise<IpcResult<CreateTeamMeetingInput>> => {
    rows.set(input.record.id, structuredClone(input.record));
    return { ok: true, result: structuredClone(input) };
  });
  const save = vi.fn(async (input: SaveTeamMeetingInput): Promise<IpcResult<TeamMeetingRecord>> => {
    const current = rows.get(input.record.id);
    if (current?.revision !== input.expectedRevision) return { ok: false, error: 'revision conflict' };
    const saved = { ...structuredClone(input.record), revision: input.expectedRevision + 1 };
    rows.set(saved.id, saved);
    return { ok: true, result: saved };
  });
  const list = vi.fn(async (): Promise<IpcResult<TeamMeetingRecord[]>> => ({ ok: true, result: [...rows.values()] }));
  const send = vi.fn<ChatComposer['send']>().mockImplementation(async (taskId) => {
    expect(events.size).toBe(1);
    return { ok: true, taskId, dispatch: { sessionKey: tasks.get(taskId!)!.sessionKey, runId: `run-${taskId}` } };
  });
  const abort = vi.fn(async (_task: Task): Promise<IpcResult> => ({ ok: true, result: { aborted: true } }));
  const syncRun = vi.fn(
    async (): Promise<RunSyncResult> => ({
      kind: 'completed',
      messageIds: ['canonical'],
      content: 'real canonical text',
    }),
  );
  const preflight = vi.fn(async () => {});
  const controller = createTeamMeetingController({
    stageRequest: (stage) => `Discuss ${stage} stage.`,
    create,
    save,
    list,
    send,
    abort,
    syncRun,
    preflight,
    registerTasks: (created: Task[]) => created.forEach((task) => tasks.set(task.id, task)),
    getTask: (taskId: string) => tasks.get(taskId),
    gateway: {
      onGatewayEvent: (listener: (event: GatewayEvent) => void) => {
        events.add(listener);
        return () => events.delete(listener);
      },
      onGatewayStatus: (listener: (event: GatewayStatusEvent) => void) => {
        statuses.add(listener);
        return () => statuses.delete(listener);
      },
    },
    sleep: async () => {},
    syncAttempts: 2,
    ...overrides,
  });
  const emit = (index: number, state = 'final', extra = {}) => {
    for (const listener of events)
      listener({
        gatewayId: 'gateway',
        event: 'chat',
        payload: {
          sessionKey: plan.tasks[index].sessionKey,
          runId: `run-${plan.tasks[index].id}`,
          state,
          ...extra,
        },
      });
  };
  return { controller, plan, rows, tasks, events, statuses, create, save, list, send, abort, syncRun, preflight, emit };
}
