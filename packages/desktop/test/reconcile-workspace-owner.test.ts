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
import { makeZip } from './helpers/make-zip.js';

/**
 * 最小**合法** PPTX（M1 门的夹具，2026-10-06）。
 *
 * ⚠️ 本档的 `invalid.pptx` 用例钉的是**候选有效性**检查点（isCandidateCurrent）——
 *    夹具必须是结构完整的包，否则会在 `verify.ts` 的登记前置门就被 skip，
 *    用例还会"绿"，但绿的是**另一条**判据（绿错了理由）。
 */
function minimalPptx(): Buffer {
  return makeZip([
    { name: '[Content_Types].xml', content: Buffer.from('<?xml version="1.0"?><Types/>') },
    { name: 'ppt/presentation.xml', content: Buffer.from('<?xml version="1.0"?><p:presentation/>') },
    { name: 'ppt/slides/slide1.xml', content: Buffer.from('<?xml version="1.0"?><p:sld/>') },
  ]);
}
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

it.each([1, 2])(
  'skips or rolls back the SQLite row when candidate validity fails at checkpoint %i',
  async (checkpoint) => {
    const workspacePath = join(root, 'a');
    const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task' });
    writeFileSync(join(workspacePath, 'task', 'answer.txt'), 'generated file');
    let checks = 0;
    const isCandidateCurrent = vi.fn(() => ++checks < checkpoint);
    const result = await reconcileTaskArtifacts(
      { workspacePath, taskId: 'task', messageId: 'message', baseline, isCandidateCurrent },
      { stabilityDelayMs: 0 },
    );
    expect(isCandidateCurrent).toHaveBeenCalledTimes(checkpoint);
    expect(result.saved).toEqual([]);
    expect(result.skipped).toContain('answer.txt');
    const count = getSqlite()!.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as { count: number };
    expect(count.count).toBe(0);
  },
);
it('continues indexing unaffected candidates when another final version is invalid', async () => {
  const workspacePath = join(root, 'a');
  const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task' });
  writeFileSync(join(workspacePath, 'task', 'answer.txt'), 'generated file');
  // 合法 pptx + "候选不再有效" ⇒ 必须走 isCandidateCurrent 那条路被 skip（见 minimalPptx 注释）。
  writeFileSync(join(workspacePath, 'task', 'invalid.pptx'), minimalPptx());
  const result = await reconcileTaskArtifacts(
    {
      workspacePath,
      taskId: 'task',
      messageId: 'message',
      baseline,
      isCandidateCurrent: (file) => file !== 'invalid.pptx',
    },
    { stabilityDelayMs: 0 },
  );
  expect(result.saved.map((artifact) => artifact.name)).toEqual(['answer.txt']);
  expect(result.skipped).toContain('invalid.pptx');
});
