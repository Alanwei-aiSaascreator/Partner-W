import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  badSend: vi.fn(),
  twoWindows: false,
  handlers: new Map<string, () => unknown>(),
}));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      ...(mocks.twoWindows ? [{ webContents: { send: mocks.badSend, isDestroyed: () => false } }] : []),
      { webContents: { send: mocks.send, isDestroyed: () => false } },
    ],
  },
  ipcMain: { handle: (channel: string, handler: () => unknown) => mocks.handlers.set(channel, handler) },
}));
import { getWorkspaceScope, setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';
import {
  beginArtifactDeliveryActivity,
  registerDeliveryActivityHandlers,
} from '../src/main/artifact/delivery-activity.js';
const identity = { taskId: 'task', sessionKey: 'session', messageId: 'message', runId: 'run' };
beforeEach(() => {
  mocks.twoWindows = false;
  setWorkspaceDatabaseOwner(null);
  mocks.send.mockClear();
});

it('does not let a closing first window block another window or the producer', () => {
  setWorkspaceDatabaseOwner({});
  mocks.send.mockClear();
  mocks.twoWindows = true;
  mocks.badSend.mockImplementation(() => {
    throw new Error('window closed');
  });
  const input = { ...identity, owner: getWorkspaceScope() };
  expect(() => {
    const operation = beginArtifactDeliveryActivity(input, 'saving-artifacts')!;
    operation.phase('reconciling-artifacts');
    operation.finish('succeeded');
  }).not.toThrow();
  expect(mocks.send).toHaveBeenCalledTimes(3);
});
it('snapshots current active operations for reload and removes terminal or replaced workspace activity', () => {
  registerDeliveryActivityHandlers();
  setWorkspaceDatabaseOwner({});
  const owner = getWorkspaceScope();
  const operation = beginArtifactDeliveryActivity({ ...identity, owner }, 'generating-presentation')!;
  operation.phase('saving-artifacts');
  const snapshot = mocks.handlers.get('artifact:get-delivery-activity-snapshot')!;
  expect(snapshot()).toMatchObject({
    owner,
    activities: [{ operationId: operation.operationId, phase: 'saving-artifacts', sequence: 2 }],
  });
  operation.finish('succeeded');
  expect(snapshot()).toMatchObject({ activities: [] });
  beginArtifactDeliveryActivity({ ...identity, owner }, 'saving-artifacts');
  setWorkspaceDatabaseOwner({});
  expect(snapshot()).toMatchObject({ owner: getWorkspaceScope(), activities: [] });
});
it('emits scoped monotonic facts and one terminal event without percentages', () => {
  setWorkspaceDatabaseOwner({});
  const owner = getWorkspaceScope();
  const operation = beginArtifactDeliveryActivity({ ...identity, owner }, 'downloading-media');
  expect(operation).not.toBeNull();
  operation!.phase('saving-artifacts');
  operation!.finish('succeeded');
  operation!.finish('failed');
  operation!.phase('downloading-media');
  const events = mocks.send.mock.calls
    .filter((call) => call[0] === 'artifact:delivery-activity')
    .map((call) => call[1]);
  expect(events).toHaveLength(3);
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  expect(events.map((event) => event.status)).toEqual(['active', 'active', 'succeeded']);
  expect(events[0]).toMatchObject({
    ...identity,
    workspaceScope: owner.scope,
    workspaceRevision: owner.revision,
    phase: 'downloading-media',
  });
  expect(new Set(events.map((event) => event.operationId)).size).toBe(1);
  expect(events.every((event) => !Object.hasOwn(event, 'percent'))).toBe(true);
});
it('refuses an old owner even when task, session and message ids are reused', () => {
  setWorkspaceDatabaseOwner({});
  const old = getWorkspaceScope();
  const operation = beginArtifactDeliveryActivity({ ...identity, owner: old }, 'generating-presentation')!;
  setWorkspaceDatabaseOwner(null);
  setWorkspaceDatabaseOwner({});
  operation.phase('saving-artifacts');
  operation.finish('succeeded');
  expect(beginArtifactDeliveryActivity({ ...identity, owner: old }, 'generating-presentation')).toBeNull();
  expect(mocks.send.mock.calls.filter((call) => call[0] === 'artifact:delivery-activity')).toHaveLength(1);
});
it('separates two operations for the same message and broadcasts scope before snapshots are queried', () => {
  registerDeliveryActivityHandlers();
  setWorkspaceDatabaseOwner({});
  const owner = getWorkspaceScope();
  const first = beginArtifactDeliveryActivity({ ...identity, owner }, 'saving-artifacts')!;
  const second = beginArtifactDeliveryActivity({ ...identity, owner }, 'saving-artifacts')!;
  expect(first.operationId).not.toBe(second.operationId);
  expect(mocks.send.mock.calls[0]).toEqual(['artifact:workspace-scope-changed', owner]);
  expect(mocks.handlers.get('artifact:get-workspace-scope')!()).toEqual(owner);
});
it('keeps captured message ownership when caller objects mutate and does not fail work on a closed renderer', () => {
  setWorkspaceDatabaseOwner({});
  const input = { ...identity, owner: getWorkspaceScope() };
  const operation = beginArtifactDeliveryActivity(input, 'saving-artifacts')!;
  input.taskId = 'replacement-task';
  operation.phase('reconciling-artifacts');
  expect(mocks.send.mock.calls.at(-1)![1].taskId).toBe('task');
  mocks.send.mockImplementationOnce(() => {
    throw new Error('renderer closed');
  });
  expect(() => operation.finish('succeeded')).not.toThrow();
});
