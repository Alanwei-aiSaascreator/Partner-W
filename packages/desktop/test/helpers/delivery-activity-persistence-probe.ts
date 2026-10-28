import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { buildSessionKey, DB_FILE_NAME, type ArtifactDeliveryActivitySnapshot, type IpcResult } from '@clawwork/shared';
import { createTaskStore } from '../../../core/src/stores/task-store.js';
import { deleteTaskAfterAcknowledgment } from '../../src/renderer/lib/delete-task.js';
import { registerDataHandlers } from '../../src/main/ipc/data-handlers.js';
import { closeDatabase, getSqlite, initDatabase, reinitDatabase } from '../../src/main/db/index.js';
import {
  beginArtifactDeliveryActivity,
  registerDeliveryActivityHandlers,
} from '../../src/main/artifact/delivery-activity.js';
import { activateLicense, clearLicense } from '../../src/main/commercial/license.js';
import { getWorkspaceScope } from '../../src/main/workspace/scope.js';
import { writeSlideGenerationReceipt } from '../../src/main/slidegen/receipt.js';
import { events, handlers, setAccount } from './delivery-activity-persistence-environment.js';

const [, , workspacePath, scenario, account = 'account-a'] = process.argv;
const sessionKey = buildSessionKey('task-1', 'main', 'fixture-device');
const identity = { taskId: 'task-1', sessionKey, messageId: 'message-1', runId: 'run-1' };
const timestamp = '2026-10-04T00:00:00.000Z';
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
setAccount(workspacePath, account === 'unknown' ? undefined : account);
registerDeliveryActivityHandlers();
const snapshot = () => handlers.get('artifact:get-delivery-activity-snapshot')!() as ArtifactDeliveryActivitySnapshot;
const beforeInit = snapshot();

if (scenario === 'legacy') {
  const legacy = new Database(join(workspacePath, DB_FILE_NAME));
  legacy.exec(
    `CREATE TABLE tasks (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', artifact_dir TEXT NOT NULL DEFAULT '');`,
  );
  legacy.close();
}
initDatabase(workspacePath);
const sqlite = getSqlite()!;
const hasTable = () =>
  !!getSqlite()!.prepare("SELECT name FROM sqlite_master WHERE name='artifact_delivery_activities'").get();
const rows = () =>
  hasTable()
    ? (getSqlite()!.prepare('SELECT * FROM artifact_delivery_activities ORDER BY rowid').all() as Array<
        Record<string, unknown>
      >)
    : [];
function seed(): void {
  sqlite
    .prepare('INSERT OR IGNORE INTO tasks (id,session_key,created_at,updated_at) VALUES (?,?,?,?)')
    .run(identity.taskId, sessionKey, timestamp, timestamp);
}
function start() {
  return beginArtifactDeliveryActivity({ ...identity, owner: getWorkspaceScope() }, 'downloading-media')!;
}
function complete(status: 'succeeded' | 'needs-review' | 'failed' | 'canceled') {
  const operation = start();
  operation.phase('generating-presentation', { completed: 1, total: 2 });
  operation.finish(status);
  operation.finish('failed');
  return operation;
}
let result: Record<string, unknown>;
if (scenario === 'fresh' || scenario === 'legacy') {
  closeDatabase();
  initDatabase(workspacePath);
  result = {
    beforeInit,
    snapshot: snapshot(),
    table: hasTable(),
    integrity: getSqlite()!.prepare('PRAGMA foreign_key_check').all(),
  };
} else if (scenario === 'read') {
  result = { snapshot: snapshot(), rows: rows() };
} else {
  seed();
  if (scenario === 'write') {
    for (const status of ['succeeded', 'needs-review', 'failed', 'canceled'] as const) complete(status);
    result = { snapshot: snapshot(), rows: rows() };
  } else if (scenario === 'delete-lifecycle') {
    registerDataHandlers();
    const invoke = (channel: string, params: unknown) =>
      (handlers.get(channel)! as (...args: unknown[]) => IpcResult)({}, params);
    invoke('data:delete-task', { id: identity.taskId });
    const otherIdentity = {
      ...identity,
      taskId: 'other-task',
      sessionKey: buildSessionKey('other-task', 'main', 'fixture-device'),
    };
    sqlite
      .prepare('INSERT INTO tasks(id,session_key,created_at,updated_at) VALUES(?,?,?,?)')
      .run(otherIdentity.taskId, otherIdentity.sessionKey, timestamp, timestamp);
    const deletionOrder: string[] = [];
    const store = createTaskStore({
      persistTask: async (task) => invoke('data:create-task', task),
      persistTaskUpdate: async () => ({ ok: true }),
      deleteTask: async (id) => {
        deletionOrder.push('local-task-delete');
        return invoke('data:delete-task', { id });
      },
      loadTasks: async () => ({ ok: true, rows: [] }),
      patchSession: async () => ({ ok: true }),
      getDeviceId: async () => 'fixture-device',
      getDefaultGatewayId: () => 'local-runtime',
      getAgentCatalog: () => ({ defaultId: 'main', agents: [{ id: 'main' }] }),
    });
    const remote = {
      taskId: identity.taskId,
      sessionKey,
      title: 'Gateway adopted task',
      updatedAt: timestamp,
      gatewayId: 'local-runtime',
      agentId: 'main',
    };
    store.getState().adoptTasks([remote]);
    const adopted = store.getState().tasks[0]!;
    sqlite.pragma('busy_timeout = 20');
    const competitor = new Database(join(workspacePath, DB_FILE_NAME));
    competitor.exec('BEGIN IMMEDIATE');
    const old = complete('needs-review');
    const other = beginArtifactDeliveryActivity({ ...otherIdentity, owner: getWorkspaceScope() }, 'downloading-media')!;
    other.finish('failed');
    competitor.exec('ROLLBACK');
    competitor.close();
    const late = start();
    const birthBefore = sqlite.prepare('SELECT rowid,created_at FROM tasks WHERE id=?').get(identity.taskId);
    sqlite.exec(
      `CREATE TRIGGER fixture_reject_delete BEFORE DELETE ON tasks WHEN OLD.id='task-1' BEGIN SELECT RAISE(ABORT,'controlled delete failure'); END;`,
    );
    const failedDelete = invoke('data:delete-task', { id: identity.taskId });
    const failedDeleteSnapshot = snapshot();
    sqlite.exec('DROP TRIGGER fixture_reject_delete');
    let remoteDeleteError: string | null = null;
    try {
      await deleteTaskAfterAcknowledgment(adopted, {
        removeTask: store.getState().removeTask,
        clearMessages: () => {
          deletionOrder.push('clear-local-messages');
        },
        deleteSession: async () => {
          deletionOrder.push('gateway-delete-attempt');
          return { ok: false, error: 'controlled gateway deletion failure' };
        },
      });
    } catch (error) {
      remoteDeleteError = error instanceof Error ? error.message : String(error);
    }
    // Re-adoption intentionally happens before any snapshot of the missing task.
    store.getState().adoptTasks([remote]);
    const birthAfter = sqlite.prepare('SELECT rowid,created_at FROM tasks WHERE id=?').get(identity.taskId);
    const eventCount = events.length;
    late.phase('generating-presentation');
    late.finish('succeeded');
    const afterReadoption = snapshot();
    const lateEvents = events.slice(eventCount);
    const storedBeforeNewRun = rows().length;
    const fresh = complete('succeeded');
    result = {
      birthBefore,
      birthAfter,
      sameBirth: JSON.stringify(birthBefore) === JSON.stringify(birthAfter),
      oldOperationId: old.operationId,
      otherOperationId: other.operationId,
      lateOperationId: late.operationId,
      failedDelete,
      failedDeleteSnapshot,
      remoteDeleteError,
      deletionOrder,
      afterReadoption,
      lateEvents,
      storedBeforeNewRun,
      newOperationId: fresh.operationId,
      afterNewRun: snapshot(),
      newRows: rows(),
    };
  } else if (scenario === 'write-lock') {
    complete('succeeded');
    sqlite.pragma('busy_timeout = 20');
    const competitor = new Database(join(workspacePath, DB_FILE_NAME));
    const failedWrite = () => {
      competitor.exec('BEGIN IMMEDIATE');
      const operation = complete('needs-review');
      const locked = snapshot();
      competitor.exec('ROLLBACK');
      return { operation, locked, released: snapshot() };
    };
    const first = failedWrite();
    sqlite.exec('ALTER TABLE tasks RENAME TO temporarily_unavailable_tasks');
    const unreadableTask = snapshot();
    sqlite.exec('ALTER TABLE temporarily_unavailable_tasks RENAME TO tasks');
    const readableTask = snapshot();
    const storedCount = rows().length;
    sqlite.prepare('DELETE FROM tasks WHERE id=?').run(identity.taskId);
    const deleted = snapshot();
    seed();
    const recreated = snapshot();
    failedWrite();
    sqlite.prepare('DELETE FROM tasks WHERE id=?').run(identity.taskId);
    sqlite
      .prepare('INSERT INTO tasks (id,session_key,created_at,updated_at) VALUES (?,?,?,?)')
      .run(identity.taskId, sessionKey, '2026-10-04T00:00:01.000Z', timestamp);
    const replaced = snapshot();
    failedWrite();
    clearLicense();
    setAccount(workspacePath, 'account-b');
    const accountB = snapshot();
    clearLicense();
    setAccount(workspacePath, 'account-a');
    const accountA = snapshot();
    failedWrite();
    clearLicense();
    setAccount(workspacePath, 'account-b');
    clearLicense();
    setAccount(workspacePath, 'account-a');
    const accountCycle = snapshot();
    failedWrite();
    reinitDatabase(join(workspacePath, 'other-db'));
    const otherDb = snapshot();
    reinitDatabase(workspacePath);
    const reopened = snapshot();
    competitor.close();
    result = {
      operationId: first.operation.operationId,
      observed: events.find(
        (event) =>
          event.channel === 'artifact:delivery-activity' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          'operationId' in event.payload &&
          event.payload.operationId === first.operation.operationId &&
          'status' in event.payload &&
          event.payload.status === 'needs-review',
      )?.payload,
      locked: first.locked,
      released: first.released,
      unreadableTask,
      readableTask,
      storedCount,
      deleted,
      recreated,
      replaced,
      accountB,
      accountA,
      accountCycle,
      otherDb,
      reopened,
    };
  } else if (scenario === 'bounds') {
    start();
    const first = complete('succeeded').operationId;
    for (let i = 0; i < 256; i++) complete('needs-review');
    result = { first, snapshot: snapshot(), rows: rows() };
  } else if (scenario === 'delete') {
    complete('succeeded');
    sqlite.prepare('DELETE FROM tasks WHERE id=?').run(identity.taskId);
    result = { snapshot: snapshot(), rows: rows(), foreignKeys: sqlite.prepare('PRAGMA foreign_key_check').all() };
  } else if (scenario === 'corrupt') {
    complete('succeeded');
    const records = rows();
    if (records[0]) sqlite.prepare('UPDATE artifact_delivery_activities SET record_json=?').run('{invalid');
    closeDatabase();
    initDatabase(workspacePath);
    result = { table: hasTable(), snapshot: snapshot() };
  } else if (scenario === 'bad-proof') {
    sqlite
      .prepare(
        'INSERT INTO messages (id,task_id,role,content,timestamp,session_key,run_id,tool_calls) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        identity.messageId,
        identity.taskId,
        'assistant',
        'fixture',
        timestamp,
        sessionKey,
        identity.runId,
        '[null]',
      );
    sqlite
      .prepare(
        'INSERT INTO artifacts (id,task_id,message_id,name,file_path,local_path,root,source_key,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'unknown-proof',
        identity.taskId,
        identity.messageId,
        'missing.pptx',
        join(workspacePath, 'missing.pptx'),
        'missing.pptx',
        'agent',
        'original-source',
        timestamp,
      );
    complete('needs-review');
    result = { rows: rows(), snapshot: snapshot() };
  } else if (scenario === 'account') {
    complete('needs-review');
    const late = start();
    clearLicense();
    setAccount(workspacePath, 'account-b');
    const other = snapshot();
    clearLicense();
    setAccount(workspacePath, 'account-a');
    const activation = await activateLicense('fixture');
    const count = events.length;
    late.phase('saving-artifacts');
    late.finish('succeeded');
    result = { other, lateEvents: events.slice(count), activation, snapshot: snapshot(), rows: rows() };
  } else if (scenario === 'switch') {
    const oldOwner = getWorkspaceScope();
    const late = start();
    const otherPath = join(workspacePath, 'other-db');
    reinitDatabase(otherPath);
    const count = events.length;
    late.finish('succeeded');
    const other = snapshot();
    reinitDatabase(workspacePath);
    late.finish('succeeded');
    result = {
      oldOwner,
      other,
      snapshot: snapshot(),
      lateEvents: events.slice(count).filter((event) => event.channel === 'artifact:delivery-activity'),
    };
  } else if (scenario === 'references') {
    const root = join(workspacePath, 'agent');
    mkdirSync(root);
    const source = '```slidegen\n// title: Report\n<Slide><Text>One</Text></Slide>\n```';
    writeFileSync(join(root, 'report.slidegen'), source);
    const pptx = new PptxGenJS();
    pptx.addSlide().addText('One', { x: 1, y: 1, w: 5, h: 1 });
    const output = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
    writeFileSync(join(root, 'report.pptx'), output);
    const receipt = writeSlideGenerationReceipt(root, {
      sourceFile: 'report.slidegen',
      sourceSha256: digest(source),
      fileName: 'report.pptx',
      outputSha256: digest(output),
      bytes: output.length,
      pages: 1,
      resources: [],
      warnings: [],
    });
    sqlite
      .prepare(
        'INSERT INTO messages (id,task_id,role,content,timestamp,session_key,run_id,tool_calls) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        identity.messageId,
        identity.taskId,
        'assistant',
        'fixture',
        timestamp,
        sessionKey,
        identity.runId,
        JSON.stringify([
          {
            id: 'proof-tool',
            name: 'exec',
            status: 'done',
            startedAt: timestamp,
            result: JSON.stringify({
              schemaVersion: 1,
              status: 'file-generated',
              fileCreated: true,
              artifactIndexed: false,
              visualReview: 'not-performed',
              receiptStatus: 'ready',
              receiptFile: basename(receipt),
              sourceSha256: digest(source),
              fileName: 'report.pptx',
              outputSha256: digest(output),
              bytes: output.length,
              pages: 1,
            }),
          },
        ]),
      );
    sqlite
      .prepare(
        'INSERT INTO artifacts (id,task_id,message_id,name,file_path,local_path,root,source_key,size,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'artifact-1',
        identity.taskId,
        identity.messageId,
        'report.pptx',
        join(root, 'report.pptx'),
        'report.pptx',
        'agent',
        'agent-proven-version',
        output.length,
        timestamp,
      );
    complete('needs-review');
    result = { rows: rows(), sourceSha256: digest(source), outputSha256: digest(output), receipt: basename(receipt) };
  } else throw new Error('unknown-scenario');
}
result.integrity = getSqlite()!.prepare('PRAGMA foreign_key_check').all();
result.messageDuplicates = getSqlite()!
  .prepare(
    "SELECT task_id,session_key,role,timestamp,COUNT(*) AS n FROM messages WHERE role <> 'system' GROUP BY task_id,session_key,role,timestamp HAVING COUNT(*)>1",
  )
  .all();
console.log('DELIVERY_ACTIVITY_RESULT=' + JSON.stringify(result));
closeDatabase();
