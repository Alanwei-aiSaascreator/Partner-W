import { beforeEach, expect, it } from 'vitest';
import type { ArtifactDeliveryActivity } from '@clawwork/shared';
import { useDeliveryActivityStore } from '../src/renderer/stores/deliveryActivityStore';

const owner = { scope: 'workspace-a', revision: 1 };
const event = (patch: Partial<ArtifactDeliveryActivity> = {}): ArtifactDeliveryActivity => ({
  taskId: 'task',
  sessionKey: 'session',
  messageId: 'message',
  runId: 'run',
  workspaceScope: owner.scope,
  workspaceRevision: owner.revision,
  operationId: 'operation',
  sequence: 1,
  startedAt: 100,
  phase: 'downloading-media',
  status: 'active',
  ...patch,
});
beforeEach(() =>
  useDeliveryActivityStore.setState({
    owner: { scope: null, revision: -1 },
    workspaceEpoch: 0,
    records: {},
    active: [],
  }),
);

it('records independent task/run operations without replacing unrelated active work', () => {
  const store = useDeliveryActivityStore.getState();
  store.record(event(), 0);
  store.record(event({ operationId: 'retry', runId: 'run-new' }), 0);
  expect(useDeliveryActivityStore.getState().active).toHaveLength(2);
  store.record(event({ sequence: 2, status: 'succeeded' }), 0);
  expect(useDeliveryActivityStore.getState().active.map((item) => item.operationId)).toEqual(['retry']);
});

it('rejects stale sequence and terminal operations cannot be revived by snapshots', () => {
  const store = useDeliveryActivityStore.getState();
  store.record(event({ sequence: 3, phase: 'saving-artifacts' }), 0);
  store.record(event({ sequence: 2 }), 0);
  expect(useDeliveryActivityStore.getState().active[0]?.phase).toBe('saving-artifacts');
  store.record(event({ sequence: 4, status: 'failed' }), 0);
  store.hydrate({ owner, activities: [event({ sequence: 99 })] }, 0);
  expect(useDeliveryActivityStore.getState().active).toEqual([]);
});

it('accepts reload active snapshots but rejects an older owner snapshot arriving later', () => {
  const store = useDeliveryActivityStore.getState();
  store.hydrate({ owner, activities: [event()] }, 0);
  expect(useDeliveryActivityStore.getState().active).toHaveLength(1);
  store.setOwner({ scope: 'workspace-b', revision: 2 }, 0);
  store.hydrate({ owner, activities: [event()] }, 0);
  expect(useDeliveryActivityStore.getState().owner.scope).toBe('workspace-b');
  expect(useDeliveryActivityStore.getState().active).toEqual([]);
});

it('does not hydrate frames with an owner different from the snapshot owner', () => {
  useDeliveryActivityStore.getState().hydrate({ owner, activities: [event({ workspaceScope: 'wrong' })] }, 0);
  expect(useDeliveryActivityStore.getState().active).toEqual([]);
});

it('workspace clear rejects old epoch callbacks even when task/session/message identities repeat', () => {
  const store = useDeliveryActivityStore.getState();
  store.record(event(), 0);
  store.clear(1);
  store.record(event({ sequence: 2 }), 0);
  store.hydrate({ owner, activities: [event()] }, 0);
  expect(useDeliveryActivityStore.getState().active).toEqual([]);
});

it('an equal revision with a different opaque scope cannot replace the current owner', () => {
  const store = useDeliveryActivityStore.getState();
  store.record(event(), 0);
  store.record(event({ workspaceScope: 'replacement' }), 0);
  expect(useDeliveryActivityStore.getState().owner).toEqual(owner);
  expect(useDeliveryActivityStore.getState().active[0]?.workspaceScope).toBe(owner.scope);
});

it('closing the database immediately hides activity and rejects old frames in the same renderer epoch', () => {
  const store = useDeliveryActivityStore.getState();
  store.record(event(), 0);
  store.setOwner({ scope: null, revision: 2 }, 0);
  store.record(event({ sequence: 10 }), 0);
  expect(useDeliveryActivityStore.getState().active).toEqual([]);
});

it('does not let caller mutation change stored evidence', () => {
  const frame = event();
  useDeliveryActivityStore.getState().record(frame, 0);
  frame.taskId = 'replacement';
  frame.status = 'failed';
  expect(useDeliveryActivityStore.getState().active[0]?.taskId).toBe('task');
  expect(useDeliveryActivityStore.getState().active[0]?.status).toBe('active');
});
