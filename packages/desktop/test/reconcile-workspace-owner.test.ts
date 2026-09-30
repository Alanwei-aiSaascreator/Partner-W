import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  return {
    default: class {
      private readonly inner: InstanceType<typeof DatabaseSync>;
      constructor(path: string) {
        this.inner = new DatabaseSync(path);
      }
      pragma(text: string) {
        this.inner.exec(`PRAGMA ${text}`);
      }
      exec(sql: string) {
        this.inner.exec(sql);
      }
      close() {
        this.inner.close();
      }
      prepare(sql: string) {
        const statement = this.inner.prepare(sql);
        statement.setAllowUnknownNamedParameters(true);
        return statement;
      }
      transaction<T>(run: () => T): () => T {
        return () => {
          this.exec('BEGIN');
          try {
            const result = run();
            this.exec('COMMIT');
            return result;
          } catch (error) {
            this.exec('ROLLBACK');
            throw error;
          }
        };
      }
    },
  };
});
import { closeDatabase, getSqlite, initDatabase, reinitDatabase } from '../src/main/db/index.js';
import { captureTaskArtifactBaseline, reconcileTaskArtifacts } from '../src/main/artifact/reconcile.js';
let root = '';
function seed() {
  const sqlite = getSqlite()!;
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO tasks(id, session_key, created_at, updated_at) VALUES ('task', 'session', 'now', 'now')",
    )
    .run();
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO messages(id, task_id, role, content, timestamp) VALUES ('message', 'task', 'assistant', '', 'now')",
    )
    .run();
}
beforeEach(() => {
  closeDatabase();
  root = mkdtempSync(join(tmpdir(), 'reconcile-owner-'));
  initDatabase(join(root, 'a'));
  seed();
});
afterEach(() => {
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

it.each(['new-path', 'same-path'] as const)(
  'does not register old candidates in a %s reopened real SQLite database',
  async (replacement) => {
    const workspacePath = join(root, 'a');
    const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task' });
    writeFileSync(join(workspacePath, 'task', 'answer.txt'), 'generated file');
    const switchDb = vi.fn(() => {
      reinitDatabase(join(root, replacement === 'same-path' ? 'a' : 'b'));
      seed();
    });
    let failure: unknown;
    try {
      await reconcileTaskArtifacts(
        { workspacePath, taskId: 'task', messageId: 'message', baseline },
        { beforeSecondSnapshot: switchDb, stabilityDelayMs: 0 },
      );
    } catch (error) {
      failure = error;
    }
    expect(switchDb).toHaveBeenCalledOnce();
    const count = getSqlite()!.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as { count: number };
    expect(count.count).toBe(0);
    expect(failure).toBeInstanceOf(Error);
  },
);

it('an unchanged real SQLite owner still registers a stable generated file', async () => {
  const workspacePath = join(root, 'a');
  const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task' });
  writeFileSync(join(workspacePath, 'task', 'answer.txt'), 'generated file');
  const result = await reconcileTaskArtifacts(
    { workspacePath, taskId: 'task', messageId: 'message', baseline },
    { stabilityDelayMs: 0 },
  );
  expect(result.saved).toHaveLength(1);
  const count = getSqlite()!.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as { count: number };
  expect(count.count).toBe(1);
});
