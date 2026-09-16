import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getSqlite, initDatabase } from '../../src/main/db/index.js';
import { captureTaskArtifactBaseline, reconcileTaskArtifacts } from '../../src/main/artifact/reconcile.js';
import Database from 'better-sqlite3';
import { DB_FILE_NAME } from '@clawwork/shared';

const [, , workspacePath, scenario] = process.argv;

function seedTaskAndMessage(taskId = 'task-1', messageId = 'msg-1'): void {
  const now = new Date().toISOString();
  getSqlite()!
    .prepare(
      `INSERT INTO tasks
       (id, session_key, session_id, title, status, created_at, updated_at, tags, artifact_dir, gateway_id)
       VALUES (?, ?, '', '', 'active', ?, ?, '[]', '', '')`,
    )
    .run(taskId, `session-${taskId}`, now, now);
  getSqlite()!
    .prepare(
      `INSERT INTO messages (id, task_id, role, content, timestamp, session_key)
       VALUES (?, ?, 'assistant', 'done', ?, ?)`,
    )
    .run(messageId, taskId, now, `session-${taskId}`);
}

async function main(): Promise<Record<string, unknown>> {
  if (scenario === 'legacy-artifact-upgrade') {
    const legacy = new Database(join(workspacePath, DB_FILE_NAME));
    legacy.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', artifact_dir TEXT NOT NULL DEFAULT '');
      CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        timestamp TEXT NOT NULL);
      CREATE TABLE artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, message_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'file', name TEXT NOT NULL, file_path TEXT NOT NULL, local_path TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, source_key TEXT NOT NULL DEFAULT '',
        content_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      INSERT INTO tasks VALUES ('task-1', 'session-task-1', '', '', 'active', '2026-01-01', '2026-01-01', '[]', '');
      INSERT INTO messages VALUES ('msg-old', 'task-1', 'assistant', 'old', '2026-01-01');
      INSERT INTO messages VALUES ('msg-new', 'task-1', 'assistant', 'new', '2026-01-02');
      INSERT INTO artifacts VALUES ('old-empty', 'task-1', 'msg-old', 'file', 'report.txt', '', 'task-1/report.txt',
        'text/plain', 0, '', '', '2026-01-01');
      INSERT INTO artifacts VALUES ('new-valid', 'task-1', 'msg-new', 'file', 'report.txt', '', 'task-1/report.txt',
        'text/plain', 42, 'workspace-file:report.txt:new', '', '2026-01-02');
    `);
    legacy.close();
    initDatabase(workspacePath);
    const rows = getSqlite()!.prepare('SELECT id, size, source_key FROM artifacts').all();
    return { rows };
  }

  initDatabase(workspacePath);
  seedTaskAndMessage();
  mkdirSync(join(workspacePath, 'task-1', 'inbox', '.import-staging'), { recursive: true });

  if (scenario === 'lifecycle') {
    const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    writeFileSync(join(workspacePath, 'task-1', '总结.docx'), 'document');
    writeFileSync(join(workspacePath, 'task-1', '.secret.txt'), 'secret');
    writeFileSync(join(workspacePath, 'task-1', 'draft.tmp'), 'temp');
    writeFileSync(join(workspacePath, 'task-1', 'empty.pdf'), '');
    writeFileSync(join(workspacePath, 'task-1', 'inbox', 'source.pdf'), 'source');
    const first = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline });
    const second = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline });
    const count = getSqlite()!.prepare('SELECT COUNT(*) AS count FROM artifacts').get();
    return { first, second, count };
  }

  if (scenario === 'baseline') {
    writeFileSync(join(workspacePath, 'task-1', 'original.md'), 'user file');
    const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    return {
      result: await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline }),
    };
  }

  if (scenario === 'new-task-baseline') {
    seedTaskAndMessage('task-new', 'msg-new');
    return { baseline: await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-new' }) };
  }

  if (scenario === 'task-link') {
    const outside = mkdtempSync(join(tmpdir(), 'clawwork-artifact-outside-'));
    writeFileSync(join(outside, 'stolen.pdf'), 'outside');
    rmSync(join(workspacePath, 'task-1'), { recursive: true, force: true });
    try {
      symlinkSync(outside, join(workspacePath, 'task-1'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      rmSync(outside, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return { supported: false };
      throw error;
    }
    let error = '';
    try {
      await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    rmSync(outside, { recursive: true, force: true });
    return { supported: true, error };
  }

  if (scenario === 'missing') {
    const localPath = 'task-1/deleted.pdf';
    getSqlite()!
      .prepare(
        `INSERT INTO artifacts
         (id, task_id, message_id, type, name, file_path, local_path, mime_type, size, source_key, content_text, created_at)
         VALUES ('artifact-missing', 'task-1', 'msg-1', 'file', 'deleted.pdf', '', ?, 'application/pdf', 4,
                 'workspace-file:deleted.pdf:4:1', '', ?)`,
      )
      .run(localPath, new Date().toISOString());
    return {
      result: await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} }),
    };
  }

  if (scenario === 'changing') {
    const output = join(workspacePath, 'task-1', 'changing.txt');
    writeFileSync(output, 'one');
    return {
      result: await reconcileTaskArtifacts(
        { workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} },
        { beforeSecondSnapshot: () => writeFileSync(output, 'changed while scanning') },
      ),
    };
  }

  if (scenario === 'changing-once') {
    const output = join(workspacePath, 'task-1', 'changing-once.txt');
    writeFileSync(output, 'one');
    let checks = 0;
    return {
      result: await reconcileTaskArtifacts(
        { workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} },
        {
          stabilityDelayMs: 5,
          beforeSecondSnapshot: () => {
            checks += 1;
            if (checks === 1) writeFileSync(output, 'stable-after-first-check');
          },
        },
      ),
      checks,
    };
  }

  if (scenario === 'old-files-budget') {
    for (let index = 0; index < 105; index += 1) {
      writeFileSync(join(workspacePath, 'task-1', `old-${String(index).padStart(3, '0')}.txt`), `old-${index}`);
    }
    const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    writeFileSync(join(workspacePath, 'task-1', 'z-result.txt'), 'new result');
    return {
      result: await reconcileTaskArtifacts(
        { workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline },
        { budgets: { maxResults: 2 } },
      ),
    };
  }

  if (scenario === 'truncated-baseline') {
    for (let index = 0; index < 4; index += 1) {
      writeFileSync(join(workspacePath, 'task-1', `old-${index}.txt`), `old-${index}`);
    }
    const baseline = await captureTaskArtifactBaseline(
      { workspacePath, taskId: 'task-1' },
      { budgets: { maxVisited: 2 } },
    );
    writeFileSync(join(workspacePath, 'task-1', 'result.txt'), 'new result');
    return {
      result: await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline }),
    };
  }

  if (scenario === 'budget') {
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(join(workspacePath, 'task-1', `${String(index).padStart(2, '0')}.txt`), `file-${index}`);
    }
    return {
      result: await reconcileTaskArtifacts(
        { workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} },
        { budgets: { maxVisited: 5, maxResults: 2, maxDepth: 2, maxTotalBytes: 1024 } },
      ),
    };
  }

  if (scenario === 'concurrent') {
    writeFileSync(join(workspacePath, 'task-1', 'parallel.pdf'), 'pdf');
    const input = { workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} } as const;
    const [left, right] = await Promise.all([reconcileTaskArtifacts(input), reconcileTaskArtifacts(input)]);
    const count = getSqlite()!.prepare('SELECT COUNT(*) AS count FROM artifacts').get();
    return { left, right, count };
  }

  if (scenario === 'updated') {
    const output = join(workspacePath, 'task-1', 'report.txt');
    writeFileSync(output, 'first');
    const first = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    writeFileSync(output, 'second version');
    const second = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    const count = getSqlite()!.prepare('SELECT COUNT(*) AS count FROM artifacts').get();
    const stored = getSqlite()!.prepare('SELECT size FROM artifacts WHERE id = ?').get(first.saved[0].id);
    return { first, second, count, stored };
  }

  if (scenario === 'replaced-same-metadata') {
    const output = join(workspacePath, 'task-1', 'identity.txt');
    writeFileSync(output, 'first');
    const first = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    const original = statSync(output);
    const replacement = join(workspacePath, 'task-1', 'replacement.tmp.txt');
    writeFileSync(replacement, 'other');
    utimesSync(replacement, original.atime, original.mtime);
    renameSync(replacement, output);
    const second = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    return { first, second };
  }

  if (scenario === 'attachment') {
    writeFileSync(join(workspacePath, 'task-1', 'image.png'), 'image bytes');
    getSqlite()!
      .prepare(
        `INSERT INTO artifacts
         (id, task_id, message_id, type, name, file_path, local_path, mime_type, size, source_key, content_text, created_at)
         VALUES ('attachment-artifact', 'task-1', 'msg-1', 'image', 'image.png', '', 'task-1/image.png', 'image/png',
                 11, 'attachment:0:image.png', 'preserve me', ?)`,
      )
      .run(new Date().toISOString());
    const result = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    const stored = getSqlite()!
      .prepare('SELECT source_key, content_text FROM artifacts WHERE id = ?')
      .get('attachment-artifact');
    return { result, stored };
  }

  if (scenario === 'nested-link') {
    seedTaskAndMessage('task-2', 'msg-2');
    mkdirSync(join(workspacePath, 'task-2'), { recursive: true });
    writeFileSync(join(workspacePath, 'task-2', 'other.pdf'), 'other task');
    const outside = mkdtempSync(join(tmpdir(), 'clawwork-artifact-linked-'));
    writeFileSync(join(outside, 'outside.pdf'), 'outside');
    try {
      symlinkSync(outside, join(workspacePath, 'task-1', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      rmSync(outside, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return { supported: false };
      throw error;
    }
    writeFileSync(join(workspacePath, 'task-1', 'own.pdf'), 'own task');
    const result = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    rmSync(outside, { recursive: true, force: true });
    return { supported: true, result };
  }

  throw new Error(`unknown scenario: ${scenario}`);
}

void main().then(
  (result) => {
    closeDatabase();
    process.stdout.write(`ARTIFACT_RECONCILE_RESULT=${JSON.stringify(result)}\n`);
  },
  (error: unknown) => {
    closeDatabase();
    console.error(error);
    process.exitCode = 1;
  },
);
