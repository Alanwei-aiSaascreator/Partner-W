import { getWorkspaceScope } from '../workspace/scope.js';

/** Ownership follows the DB generation, including close/reopen at the same path. */
export function captureArtifactWorkspaceOwner(): { current: () => boolean; assertCurrent: () => void } {
  const owner = getWorkspaceScope();
  const current = (): boolean => {
    const next = getWorkspaceScope();
    return owner.scope !== null && owner.scope === next.scope && owner.revision === next.revision;
  };
  return {
    current,
    assertCurrent: () => {
      if (!current()) throw new Error('artifact workspace changed before persistence');
    },
  };
}
