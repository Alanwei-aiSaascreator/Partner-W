// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  ArtifactDeliveryActivity,
  ArtifactDeliveryActivitySnapshot,
  ArtifactWorkspaceScope,
} from '@clawwork/shared';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import { useDeliveryActivityStore } from '../src/renderer/stores/deliveryActivityStore';
import { useDeliveryActivitySubscription } from '../src/renderer/hooks/useDeliveryActivitySubscription';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const owner = { scope: 'workspace-a', revision: 1 };
const activity: ArtifactDeliveryActivity = {
  taskId: 'task',
  sessionKey: 'session',
  messageId: 'message',
  workspaceScope: owner.scope,
  workspaceRevision: owner.revision,
  operationId: 'operation',
  sequence: 1,
  startedAt: 100,
  phase: 'downloading-media',
  status: 'active',
};
let root: Root;
let container: HTMLDivElement;
let scopeCallback: (value: ArtifactWorkspaceScope) => void;
let activityCallback: (value: ArtifactDeliveryActivity) => void;
let complete: (value: ArtifactDeliveryActivitySnapshot) => void;
const unsubscribeScope = vi.fn(),
  unsubscribeActivity = vi.fn();
const order: string[] = [];
function Harness() {
  useDeliveryActivitySubscription();
  return null;
}
beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  useTaskStore.setState({ workspaceEpoch: 0 });
  useDeliveryActivityStore.setState({
    owner: { scope: null, revision: -1 },
    workspaceEpoch: 0,
    records: {},
    active: [],
  });
  window.clawwork = {
    onArtifactWorkspaceScopeChanged: (callback: (scope: ArtifactWorkspaceScope) => void) => {
      order.push('scope');
      scopeCallback = callback;
      return unsubscribeScope;
    },
    onArtifactDeliveryActivity: (callback: (activity: ArtifactDeliveryActivity) => void) => {
      order.push('activity');
      activityCallback = callback;
      return unsubscribeActivity;
    },
    getArtifactDeliveryActivitySnapshot: () => {
      order.push('snapshot');
      return new Promise<ArtifactDeliveryActivitySnapshot>((resolve) => {
        complete = resolve;
      });
    },
  } as unknown as typeof window.clawwork;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('subscribes before requesting the active snapshot and restores running work after reload', async () => {
  expect(order).toEqual(['scope', 'activity', 'snapshot']);
  await act(async () => complete({ owner, activities: [activity] }));
  expect(useDeliveryActivityStore.getState().active).toEqual([activity]);
});

it('a terminal event preceding the snapshot cannot be revived', async () => {
  act(() => activityCallback({ ...activity, sequence: 2, status: 'failed' }));
  await act(async () => complete({ owner, activities: [activity] }));
  expect(useDeliveryActivityStore.getState().active).toEqual([]);
});

it('a delayed snapshot cannot revive terminals after the bounded tombstone window overflows', async () => {
  act(() => {
    for (let index = 0; index < 2050; index += 1)
      activityCallback({ ...activity, operationId: `operation-${index}`, status: 'succeeded' });
  });
  await act(async () => complete({ owner, activities: [{ ...activity, operationId: 'operation-0' }] }));
  expect(useDeliveryActivityStore.getState().active).toEqual([]);
});

it('late snapshots cannot roll back a newer opaque workspace scope', async () => {
  act(() => scopeCallback({ scope: 'workspace-b', revision: 2 }));
  await act(async () => complete({ owner, activities: [activity] }));
  expect(useDeliveryActivityStore.getState().owner.scope).toBe('workspace-b');
  expect(useDeliveryActivityStore.getState().active).toEqual([]);
});

it('old epoch callbacks are rejected synchronously before React effect cleanup', async () => {
  const oldCallback = activityCallback,
    oldComplete = complete;
  act(() => {
    useTaskStore.setState({ workspaceEpoch: 1 });
    oldCallback(activity);
    expect(useDeliveryActivityStore.getState().active).toEqual([]);
  });
  await act(async () => oldComplete({ owner, activities: [activity] }));
  expect(useDeliveryActivityStore.getState().active).toEqual([]);
  expect(unsubscribeScope).toHaveBeenCalledOnce();
  expect(unsubscribeActivity).toHaveBeenCalledOnce();
});

it('unmount unsubscribes and pending snapshot/events cannot write afterward', async () => {
  act(() => root.unmount());
  await act(async () => {
    activityCallback(activity);
    complete({ owner, activities: [activity] });
  });
  expect(useDeliveryActivityStore.getState().active).toEqual([]);
  expect(unsubscribeScope).toHaveBeenCalledOnce();
  expect(unsubscribeActivity).toHaveBeenCalledOnce();
});
