import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import { isArtifactDeliveryPageProgress } from '@clawwork/shared';
import type {
  ArtifactDeliveryActivity,
  ArtifactDeliveryPageProgress,
  ArtifactDeliveryPhase,
  ArtifactDeliveryPhaseObservation,
  ArtifactDeliveryTerminalStatus,
  ArtifactWorkspaceScope,
} from '@clawwork/shared';
import { getWorkspaceScope, subscribeWorkspaceScope } from '../workspace/scope.js';
import {
  captureDeliveryActivityOwner,
  isDeliveryActivityOwnerCurrent,
  loadDeliveryActivities,
  persistDeliveryActivity,
  type DeliveryActivityOwner,
} from '../db/delivery-activities.js';

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
const completed = new Map<string, ArtifactDeliveryActivity>();
const failedPersistence = new Map<string, string>();
const MAX_COMPLETED_OPERATIONS = 256;
const MAX_PHASE_OBSERVATIONS = 64;
let memoryOwner: DeliveryActivityOwner | null = null;
const copyActivity = (event: ArtifactDeliveryActivity): ArtifactDeliveryActivity => ({
  ...event,
  ...(event.pageProgress ? { pageProgress: { ...event.pageProgress } } : {}),
  observedPhases: event.observedPhases?.map((step) => ({ ...step })),
});
subscribeWorkspaceScope(() => {
  active.clear();
  completed.clear();
  failedPersistence.clear();
  memoryOwner = null;
});

function currentOwner(): DeliveryActivityOwner {
  if (memoryOwner && !isDeliveryActivityOwnerCurrent(memoryOwner)) {
    active.clear();
    completed.clear();
    failedPersistence.clear();
  }
  memoryOwner = captureDeliveryActivityOwner();
  return memoryOwner;
}

/**
 * ⭐ 升级忙态（2026-10-11）：还有交付操作在途（写盘/登记未走完）。
 * 消费方 = `update-handlers.isAppBusy` 的边界复查——堵住"turn 已结束但交付仍在途"的窗口：
 * 生成/文件写入期间不得退出应用、不得启动替换（评审要点：不能只靠按钮灰掉）。
 */
export function hasActiveDeliveryOperations(): boolean {
  return active.size > 0;
}

/** Called only after task deletion commits, before the same ID can be re-adopted. */
export function forgetTaskDeliveryActivities(taskId: string): void {
  currentOwner();
  for (const records of [active, completed]) {
    for (const [operationId, event] of records) {
      if (event.taskId !== taskId) continue;
      records.delete(operationId);
      failedPersistence.delete(operationId);
    }
  }
}

function taskIdentity(owner: DeliveryActivityOwner, event: Pick<ArtifactDeliveryActivity, 'taskId' | 'sessionKey'>) {
  if (!owner.database || !isDeliveryActivityOwnerCurrent(owner)) return null;
  try {
    const row = owner.database
      .prepare('SELECT rowid,created_at FROM tasks WHERE id=? AND session_key=?')
      .get(event.taskId, event.sessionKey) as { rowid: number; created_at: string } | undefined;
    return row ? JSON.stringify([row.rowid, row.created_at]) : null;
  } catch (error) {
    console.warn('[delivery-activity] task identity unavailable:', error);
    return undefined;
  }
}

function failedTerminals(owner: DeliveryActivityOwner): ArtifactDeliveryActivity[] {
  if (!owner.database || !owner.binding || !isDeliveryActivityOwnerCurrent(owner)) return [];
  const result: ArtifactDeliveryActivity[] = [];
  for (const [operationId, identity] of failedPersistence) {
    const event = completed.get(operationId);
    const currentTask = event ? taskIdentity(owner, event) : null;
    if (currentTask === undefined) continue;
    if (event && currentTask === identity) result.push(event);
    else {
      failedPersistence.delete(operationId);
      completed.delete(operationId);
    }
  }
  return result;
}

let subscribed = false;
export function registerDeliveryActivityHandlers(): void {
  ipcMain.handle('artifact:get-workspace-scope', getWorkspaceScope);
  ipcMain.handle('artifact:get-delivery-activity-snapshot', () => {
    const persistenceOwner = currentOwner();
    const owner = getWorkspaceScope();
    let history = [...completed.values()];
    if (persistenceOwner.database) {
      try {
        history = loadDeliveryActivities(persistenceOwner, owner);
      } catch (error) {
        console.warn('[delivery-activity] terminal history unavailable:', error);
        history = [];
      }
      const merged = new Map(history.map((event) => [event.operationId, event]));
      for (const event of failedTerminals(persistenceOwner))
        if (!merged.has(event.operationId)) merged.set(event.operationId, event);
      history = [...merged.values()]
        .sort((left, right) => (left.endedAt ?? left.startedAt) - (right.endedAt ?? right.startedAt))
        .slice(-MAX_COMPLETED_OPERATIONS);
    }
    return {
      owner,
      activities: [...active.values()].map(copyActivity),
      completedActivities: history.map(copyActivity),
    };
  });
  if (!subscribed) {
    subscribed = true;
    subscribeWorkspaceScope((scope) => broadcast('artifact:workspace-scope-changed', scope));
  }
}

/** Owner must be captured before awaiting work, never recovered from IDs or paths. */
export function beginArtifactDeliveryActivity(
  input: Pick<ArtifactDeliveryActivity, 'taskId' | 'sessionKey' | 'messageId' | 'runId'> & {
    owner: ArtifactWorkspaceScope;
    /**
     * ⭐ V3-artifact：调用方已经为这次操作定好号（`captureArtifactDeliveryOperation` 在
     * **可信请求登记**那一刻生成）——活动帧与执行事件必须共用同一个 operationId，
     * 两条通道才说同一件事。缺省（老调用点/直接 begin）在这里现生成。
     */
    operationId?: string;
  },
  initialPhase: ArtifactDeliveryPhase,
  initialProgress?: ArtifactDeliveryPageProgress,
): {
  operationId: string;
  phase: (phase: ArtifactDeliveryPhase, progress?: ArtifactDeliveryPageProgress) => void;
  finish: (status: ArtifactDeliveryTerminalStatus) => void;
} | null {
  const owner = { ...input.owner };
  const persistenceOwner = currentOwner();
  const identity = {
    taskId: input.taskId,
    sessionKey: input.sessionKey,
    messageId: input.messageId,
    runId: input.runId,
  };
  const ownsWorkspace = (): boolean => {
    const current = getWorkspaceScope();
    return (
      owner.scope !== null &&
      current.scope === owner.scope &&
      current.revision === owner.revision &&
      isDeliveryActivityOwnerCurrent(persistenceOwner)
    );
  };
  if (!ownsWorkspace() || active.size >= 2048) return null;
  const originalTaskIdentity = taskIdentity(persistenceOwner, identity);
  const operationId = input.operationId ?? randomUUID(),
    startedAt = Date.now();
  let sequence = 0,
    terminal = false,
    phase = initialPhase;
  let pageProgress = isArtifactDeliveryPageProgress(initialProgress) ? { ...initialProgress } : undefined;
  const observedPhases: ArtifactDeliveryPhaseObservation[] = [];
  let historyTruncated = false;
  const emit = (status: ArtifactDeliveryActivity['status']): void => {
    if (terminal || !ownsWorkspace() || (sequence > 0 && !active.has(operationId))) return;
    if (status !== 'active') terminal = true;
    const observedAt = Date.now();
    if (status === 'active' && observedPhases.at(-1)?.phase !== phase) {
      observedPhases.push({ phase, observedAt, sequence: sequence + 1 });
      if (observedPhases.length > MAX_PHASE_OBSERVATIONS) {
        observedPhases.shift();
        historyTruncated = true;
      }
    }
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
      ...(phase === 'generating-presentation' && isArtifactDeliveryPageProgress(pageProgress)
        ? { pageProgress: { ...pageProgress } }
        : {}),
      observedPhases: observedPhases.map((step) => ({ ...step })),
      ...(historyTruncated ? { historyTruncated: true } : {}),
      ...(status !== 'active' ? { endedAt: observedAt } : {}),
    };
    if (status === 'active') active.set(operationId, event);
    else {
      active.delete(operationId);
      completed.set(operationId, event);
      if (completed.size > MAX_COMPLETED_OPERATIONS) {
        const oldest = completed.keys().next().value!;
        completed.delete(oldest);
        failedPersistence.delete(oldest);
      }
      try {
        persistDeliveryActivity(persistenceOwner, event);
      } catch (error) {
        if (originalTaskIdentity) failedPersistence.set(operationId, originalTaskIdentity);
        console.warn('[delivery-activity] terminal persistence unavailable:', error);
      }
    }
    broadcast('artifact:delivery-activity', copyActivity(event));
  };
  emit('active');
  return {
    operationId,
    phase: (next, progress) => {
      phase = next;
      pageProgress = isArtifactDeliveryPageProgress(progress) ? { ...progress } : undefined;
      emit('active');
    },
    finish: (status) => emit(status),
  };
}
