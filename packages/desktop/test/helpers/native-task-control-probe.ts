import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { nativeTaskControl } from '../../src/main/docgen/native-task-control';
const folder = mkdtempSync(join(tmpdir(), 'native-ppt-state-proof-'));
let db = new Database(join(folder, 'state.sqlite'));
try {
  let state = nativeTaskControl(db);
  state.beginUser('task-A', 'user-1');
  assert.equal(state.beginAutomatic('task-A', 'user-1', 'auto-1'), true);
  assert.equal(state.beginAutomatic('task-A', 'user-1', 'duplicate'), false);
  db.close();
  db = new Database(join(folder, 'state.sqlite'));
  state = nativeTaskControl(db);
  assert.equal(state.get('task-A')!.auto_count, 1);
  assert.equal(state.beginAutomatic('task-A', 'auto-1', 'auto-2'), true);
  assert.equal(state.beginAutomatic('task-A', 'auto-2', 'auto-3'), false);
  for (let i = 2; i <= 5; i++) state.beginUser('task-A', `user-${i}`);
  assert.equal(state.get('task-A')!.auto_count, 2);
  assert.equal(state.beginAutomatic('task-A', 'user-5', 'auto-reset-attempt'), false);
  state.beginUser('task-B', 'b-1');
  state.cancel('task-B', 'b-1');
  assert.equal(state.beginAutomatic('task-B', 'b-1', 'late'), false);
  state.beginUser('task-B', 'b-2');
  state.cancel('task-B', 'b-1');
  assert.equal(state.get('task-B')!.canceled, 0);
  state.remember('task-B', 'b-1', 'stale-receipt');
  assert.equal(state.get('task-B')!.last_receipt, null);
  state.remember('task-B', 'b-2', 'current-receipt');
  assert.equal(state.get('task-B')!.last_receipt, 'current-receipt');
  console.log(
    JSON.stringify({
      status: 'passed',
      realSqlite: true,
      restartPreservesAutoCount: true,
      userVersions: 5,
      automaticLimit: 2,
      duplicateOrLateCannotRevive: true,
    }),
  );
} finally {
  db.close();
  rmSync(folder, { recursive: true, force: true });
}
