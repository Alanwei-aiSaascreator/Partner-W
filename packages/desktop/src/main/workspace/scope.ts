import { randomUUID } from 'node:crypto';
import type { ArtifactWorkspaceScope } from '@clawwork/shared';

let databaseOwner: object | null = null;
let current: ArtifactWorkspaceScope = { scope: null, revision: 0 };
const listeners = new Set<(scope: ArtifactWorkspaceScope) => void>();

export function getWorkspaceScope(): ArtifactWorkspaceScope {
  return { ...current };
}

/** Called only at successful database open and synchronous close boundaries. */
export function setWorkspaceDatabaseOwner(owner: object | null): void {
  if (owner === databaseOwner) return;
  databaseOwner = owner;
  current = { scope: owner ? randomUUID() : null, revision: current.revision + 1 };
  for (const listener of listeners) {
    try {
      listener(getWorkspaceScope());
    } catch (error) {
      console.error('[workspace-scope] listener failed:', error);
    }
  }
}

export function subscribeWorkspaceScope(listener: (scope: ArtifactWorkspaceScope) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
