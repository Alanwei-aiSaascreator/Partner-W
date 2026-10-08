/**
 * `saveArtifact*` 的**真索引**探针（2026-10-07 体检 P2-2 / P2-4）。
 *
 * 为什么必须这一档：唯一约束的语义只有在**真的唯一索引 + 真的磁盘**上才成立 ——
 * 单测把 drizzle 和 fs 都 mock 了，"uniqueFileNameIn 只看磁盘不看库"这条致命细节
 * 正好落在 mock 的缝里（`artifact-save.test.ts` 用的是 mock DB_ERROR，验不了它）。
 *
 * 跑法同 reconcile 探针：vite 打包 → `ELECTRON_RUN_AS_NODE` 的 electron 跑真主进程模块
 * （`better-sqlite3` 是按 Electron ABI 重建的），结果走 stdout 一行 JSON。
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { closeDatabase, getSqlite, initDatabase } from '../../src/main/db/index.js';
import { saveArtifactFromBuffer } from '../../src/main/artifact/save.js';

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
  if (scenario !== 'save-index-semantics') throw new Error(`unknown scenario: ${scenario}`);

  initDatabase(workspacePath);
  seedTaskAndMessage();
  const taskDir = join(workspacePath, 'task-1');
  const base = {
    workspacePath,
    taskId: 'task-1',
    messageId: 'msg-1',
    fileName: 'report.md',
    artifactType: 'file' as const,
  };

  // ① 重放：同一条消息 + 同一份内容（同 sourceKey）被处理两次（docgen/slidegen/htmlgen 的
  //    "同 message 重放"就是这条；auto-extract 同源）。
  const first = await saveArtifactFromBuffer({ ...base, buffer: Buffer.from('first'), sourceKey: 'docgen:md:hash1' });
  const replay = await saveArtifactFromBuffer({ ...base, buffer: Buffer.from('first'), sourceKey: 'docgen:md:hash1' });
  const afterReplay = {
    fileCount: readdirSync(taskDir).filter((name) => name.startsWith('report')).length,
    rows: getSqlite()!.prepare('SELECT id, local_path FROM artifacts ORDER BY created_at').all(),
  };

  // ② 名字被"有行无文件"的旧行占着（P2-2 原始场景）：外部删掉文件，再存一份同名的新文件。
  //    旧实现在这里必定：uniqueFileNameIn 复用同名 → INSERT 撞 artifacts_task_local_path
  //    → catch 里 unlink 掉**刚写的那份好文件** → 抛错（重试同败，名字被永久毒化）。
  rmSync(join(taskDir, first.name), { force: true });
  const fileGoneBeforeSecondSave = existsSync(join(taskDir, first.name));
  const revived = await saveArtifactFromBuffer({ ...base, buffer: Buffer.from('second-pass') });

  const rows = getSqlite()!.prepare('SELECT id, name, local_path, size FROM artifacts ORDER BY created_at, id').all();
  return {
    first,
    replay,
    afterReplay,
    fileGoneBeforeSecondSave,
    revived,
    rows,
    files: readdirSync(taskDir).sort(),
    revivedContent: readFileSync(join(taskDir, 'report.md'), 'utf8'),
  };
}

void main().then(
  (result) => {
    closeDatabase();
    process.stdout.write(`ARTIFACT_PROBE_RESULT=${JSON.stringify(result)}\n`);
  },
  (error: unknown) => {
    closeDatabase();
    console.error(error);
    process.exitCode = 1;
  },
);
