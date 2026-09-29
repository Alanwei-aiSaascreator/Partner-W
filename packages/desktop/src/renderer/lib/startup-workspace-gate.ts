import type { WorkspaceFsIdentity } from '@clawwork/shared';

export interface WorkspaceGatedBootstrapDeps {
  probe: () => Promise<WorkspaceFsIdentity | null>;
  bootstrapAssistants: () => Promise<unknown>;
  ensureSkills: () => Promise<unknown>;
}

/**
 * The filesystem capability probe is the barrier in front of every automatic
 * workspace writer.  Keep this orchestration outside React so ordering and the
 * zero-write rejection path stay directly testable.
 */
export async function runWorkspaceGatedBootstrap(
  deps: WorkspaceGatedBootstrapDeps,
): Promise<WorkspaceFsIdentity | null> {
  const identity = await deps.probe();
  if (identity?.state !== 'ok') return identity;
  await Promise.all([deps.bootstrapAssistants(), deps.ensureSkills()]);
  return identity;
}
