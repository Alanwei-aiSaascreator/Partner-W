import type { ArtifactDeliveryTerminalStatus } from '@clawwork/shared';
import { getWorkspaceScope } from '../workspace/scope.js';
import { beginArtifactDeliveryActivity } from './delivery-activity.js';
import type { ArtifactActivityCallback } from './activity-callback.js';

/** Capture ownership now; create an operation only when a producer actually starts. */
export function captureArtifactDeliveryOperation(identity: {
  taskId: string;
  sessionKey: string;
  messageId: string;
  runId?: string;
}): { phase: ArtifactActivityCallback; finish: (status: ArtifactDeliveryTerminalStatus) => void } {
  const owner = getWorkspaceScope();
  const captured = { ...identity };
  let operation: ReturnType<typeof beginArtifactDeliveryActivity>;
  let ended = false;
  return {
    phase: (phase, progress) => {
      if (ended) return;
      if (operation) operation.phase(phase, progress);
      else operation = beginArtifactDeliveryActivity({ ...captured, owner }, phase, progress);
    },
    finish: (status) => {
      if (ended) return;
      ended = true;
      operation?.finish(status);
    },
  };
}
