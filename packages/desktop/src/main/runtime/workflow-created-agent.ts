import {
  buildCreatedWorkflowAgentPatch,
  hasCreatedWorkflowAgentGrant,
  isSystemWorkflowAgent,
} from './workflow-tools.js';

/** Runs within the caller's existing config mutation transaction, never starts another one. */
export async function authorizeCreatedWorkflowAgent(input: {
  agentId: string;
  current: () => boolean;
  tx: {
    getConfig: () => Promise<Record<string, unknown>>;
    patchConfig: (params: { raw: string; baseHash: string }) => Promise<Record<string, unknown>>;
  };
}): Promise<boolean> {
  if (!isSystemWorkflowAgent(input.agentId) || !input.current()) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await input.tx.getConfig();
    if (!input.current()) return false;
    const patch = buildCreatedWorkflowAgentPatch(snapshot.config, input.agentId);
    if (patch) {
      if (typeof snapshot.hash !== 'string' || !snapshot.hash)
        throw new Error('Workflow configuration CAS revision is missing');
      let ack: Record<string, unknown>;
      try {
        ack = await input.tx.patchConfig({ baseHash: snapshot.hash, raw: JSON.stringify(patch) });
      } catch (error) {
        if (!input.current()) return false;
        if (
          error instanceof Error &&
          (error as Error & { code?: string }).code === 'INVALID_REQUEST' &&
          /config changed since last load|base hash|re-run config\.get and retry/iu.test(error.message) &&
          attempt < 2
        )
          continue;
        throw error;
      }
      if (!input.current()) return false;
      if (ack.ok !== true) throw new Error('Workflow configuration ACK is missing');
      const readback = await input.tx.getConfig();
      if (!input.current()) return false;
      if (!hasCreatedWorkflowAgentGrant(readback.config, input.agentId))
        throw new Error('Workflow configuration readback did not confirm the created agent grant');
      return true;
    }
    return hasCreatedWorkflowAgentGrant(snapshot.config, input.agentId);
  }
  return false;
}
