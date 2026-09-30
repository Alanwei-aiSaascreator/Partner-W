import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import type {
  ArtifactDeliveryActivity,
  ArtifactDeliveryPhase,
  ArtifactDeliveryTerminalStatus,
  ArtifactWorkspaceScope,
} from '@clawwork/shared';
import { getWorkspaceScope, subscribeWorkspaceScope } from '../workspace/scope.js';

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
    } catch (error) {
      console.warn('[delivery-activity] renderer unavailable:', error);
    }
  }
}

const active = new Map<string, ArtifactDeliveryActivity>();
subscribeWorkspaceScope(() => active.clear());

let subscribed = false;
export function registerDeliveryActivityHandlers(): void {
  ipcMain.handle('artifact:get-workspace-scope', getWorkspaceScope);
  ipcMain.handle('artifact:get-delivery-activity-snapshot', () => ({
    owner: getWorkspaceScope(),
    activities: [...active.values()].map((event) => ({ ...event })),
  }));
  if (!subscribed) {
    subscribed = true;
    subscribeWorkspaceScope((scope) => broadcast('artifact:workspace-scope-changed', scope));
  }
}

/** Owner must be captured before awaiting work, never recovered from IDs or paths. */
export function beginArtifactDeliveryActivity(
  input: Pick<ArtifactDeliveryActivity, 'taskId' | 'sessionKey' | 'messageId' | 'runId'> & {
    owner: ArtifactWorkspaceScope;
  },
  initialPhase: ArtifactDeliveryPhase,
): {
  operationId: string;
  phase: (phase: ArtifactDeliveryPhase) => void;
  finish: (status: ArtifactDeliveryTerminalStatus) => void;
} | null {
  const owner = { ...input.owner };
  const identity = {
    taskId: input.taskId,
    sessionKey: input.sessionKey,
    messageId: input.messageId,
    runId: input.runId,
  };
  const ownsWorkspace = (): boolean => {
    const current = getWorkspaceScope();
    return owner.scope !== null && current.scope === owner.scope && current.revision === owner.revision;
  };
  if (!ownsWorkspace() || active.size >= 2048) return null;
  const operationId = randomUUID(),
    startedAt = Date.now();
  let sequence = 0,
    terminal = false,
    phase = initialPhase;
  const emit = (status: ArtifactDeliveryActivity['status']): void => {
    if (terminal || !ownsWorkspace()) return;
    if (status !== 'active') terminal = true;
    const event: ArtifactDeliveryActivity = {
      taskId: identity.taskId,
      sessionKey: identity.sessionKey,
      messageId: identity.messageId,
      ...(identity.runId ? { runId: identity.runId } : {}),
      workspaceScope: owner.scope!,
      workspaceRevision: owner.revision,
      operationId,
      startedAt,
      sequence: ++sequence,
      phase,
      status,
    };
    if (status === 'active') active.set(operationId, event);
    else active.delete(operationId);
    broadcast('artifact:delivery-activity', event);
  };
  emit('active');
  return {
    operationId,
    phase: (next) => {
      phase = next;
      emit('active');
    },
    finish: (status) => emit(status),
  };
}
