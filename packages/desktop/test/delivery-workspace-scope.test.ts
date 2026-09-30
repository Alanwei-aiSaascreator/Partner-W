import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('better-sqlite3', async () => ({ default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim }));
import { closeDatabase, initDatabase, reinitDatabase } from '../src/main/db/index.js';
import { getWorkspaceScope, subscribeWorkspaceScope } from '../src/main/workspace/scope.js';
it('tracks real temporary database lifetime, including same-path reopen and closed intervals', () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-scope-'));
  const changes: ReturnType<typeof getWorkspaceScope>[] = [];
  const unsubscribe = subscribeWorkspaceScope((scope) => changes.push(scope));
  try {
    closeDatabase();
    initDatabase(root);
    const first = getWorkspaceScope();
    expect(first.scope).toMatch(/^[0-9a-f-]{36}$/);
    initDatabase(root);
    expect(getWorkspaceScope()).toEqual(first);
    closeDatabase();
    expect(getWorkspaceScope()).toMatchObject({ scope: null, revision: first.revision + 1 });
    reinitDatabase(root);
    const next = getWorkspaceScope();
    expect(next.scope).not.toBe(first.scope);
    expect(next.revision).toBeGreaterThan(first.revision);
    expect(changes.some((change) => change.scope === null)).toBe(true);
  } finally {
    unsubscribe();
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  }
});
