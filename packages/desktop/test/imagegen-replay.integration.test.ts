import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { ArtifactDeliveryActivity } from '@clawwork/shared';
import type { ImagegenRelayClient } from '../src/main/imagegen/client.js';
const config = vi.hoisted(() => ({
  workspacePath: '',
  commercial: { licenseKey: 'local-fixture', licenseBinding: { userId: 'u', orgId: 'o', licenseId: 'l' } },
}));
vi.mock('../src/main/workspace/config.js', () => ({ readConfig: () => config }));
vi.mock('better-sqlite3', async () => ({ default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim }));
vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1328, height: 1328 }) }) },
}));
import { initDatabase, closeDatabase, getSqlite } from '../src/main/db/index.js';
import {
  captureDeliveryActivityOwner,
  persistDeliveryActivity,
  loadDeliveryActivities,
} from '../src/main/db/delivery-activities.js';
import { getWorkspaceScope } from '../src/main/workspace/scope.js';
import { generateImagesFromMessage } from '../src/main/imagegen/generate.js';
import { verifyImagegenBuffer } from '../src/main/imagegen/verify.js';
const content = [
  '```imagegen',
  JSON.stringify({ model: 'qwen-image-plus', operationId: 'same-operation', prompt: 'fixture', size: '1328*1328' }),
  '```',
].join('\n');
function png() {
  const chunk = (type: string, bytes: Buffer) => {
    const result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length);
    result.write(type, 4);
    bytes.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1328);
  header.writeUInt32BE(1328, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(1328 * (1328 * 3 + 1)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imagegen-replay-test-'));
  config.workspacePath = dir;
  initDatabase(dir);
  getSqlite()!.exec(
    "INSERT INTO tasks(id,session_key,created_at,updated_at) VALUES('task','session','now','now'); INSERT INTO messages(id,task_id,role,content,timestamp) VALUES('message-1','task','assistant','image request','now'),('message-2','task','assistant','image recovery','later');",
  );
});
afterEach(() => {
  closeDatabase();
  const target = resolve(dir);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('imagegen-replay-test-'))
    throw Error('unsafe cleanup');
  rmSync(target, { recursive: true, force: true });
});
function fixture() {
  const client = {
    capabilities: vi.fn(async () => true),
    create: vi.fn<ImagegenRelayClient['create']>(async () => ({ ok: true })),
    query: vi.fn<ImagegenRelayClient['query']>(async () => ({ status: 'finished' })),
    download: vi.fn<ImagegenRelayClient['download']>(async () => ({ ok: true, bytes: png() })),
  };
  const run = (messageId: string, authScope = 'license-a') =>
    generateImagesFromMessage({ workspacePath: dir, taskId: 'task', authScope, messageId, content, client });
  return { client, run };
}
it('cross-message recovery after SQLite reopen retains one row and one file', async () => {
  const f = fixture(),
    first = await f.run('message-1');
  expect(first.failed).toEqual([]);
  closeDatabase();
  initDatabase(dir);
  const second = await f.run('message-2');
  expect(second.saved[0]?.id).toBe(first.saved[0]?.id);
  expect(second.saved[0]?.messageId).toBe('message-1');
  expect(getSqlite()!.prepare('SELECT id FROM artifacts').all()).toHaveLength(1);
  expect(readdirSync(join(dir, 'task')).filter((name) => name.endsWith('.png'))).toHaveLength(1);
  expect(f.client.create).toHaveBeenCalledTimes(1);
});
it('same-length disk corruption is refused without a second remote request', async () => {
  const f = fixture(),
    first = await f.run('message-1'),
    file = first.saved[0].filePath;
  writeFileSync(file, Buffer.alloc(readFileSync(file).length, 120));
  const second = await f.run('message-2');
  expect(second.saved).toEqual([]);
  expect(second.failed).toEqual([{ code: 'imagegen-image-invalid' }]);
  expect(f.client.create).toHaveBeenCalledTimes(1);
});
it('another license never reuses the old artifact', async () => {
  const f = fixture(),
    first = await f.run('message-1'),
    second = await f.run('message-2', 'license-b');
  expect(second.saved[0]?.id).not.toBe(first.saved[0]?.id);
  expect(f.client.create).toHaveBeenCalledTimes(2);
});
it('simultaneous recovery publishes one artifact', async () => {
  const f = fixture();
  const results = await Promise.all([f.run('message-1'), f.run('message-2')]);
  expect(results.map((result) => result.failed)).toEqual([[], []]);
  expect(results[0].saved[0].id).toBe(results[1].saved[0].id);
  expect(getSqlite()!.prepare('SELECT id FROM artifacts').all()).toHaveLength(1);
  expect(f.client.create).toHaveBeenCalledTimes(1);
});
it('exact image dimensions are rechecked even when native decoder accepts bytes', () => {
  expect(verifyImagegenBuffer(png(), '1664*928')).toBe(false);
  expect(verifyImagegenBuffer(png(), '1328*1328')).toBe(true);
});
it('terminal artifact reference persists across close/reopen with original artifact row', async () => {
  const f = fixture(),
    first = await f.run('message-1');
  const id = first.saved[0].id;
  const event: ArtifactDeliveryActivity = {
    taskId: 'task',
    sessionKey: 'session',
    messageId: 'message-2',
    operationId: 'activity',
    sequence: 2,
    startedAt: 1,
    endedAt: 2,
    workspaceScope: 'old',
    workspaceRevision: 1,
    phase: 'generating-image',
    status: 'succeeded',
    artifactId: id,
  };
  persistDeliveryActivity(captureDeliveryActivityOwner(), event);
  const row = getSqlite()!.prepare('SELECT artifact_refs_json FROM artifact_delivery_activities').get() as {
    artifact_refs_json: string;
  };
  expect(JSON.parse(row.artifact_refs_json)).toEqual([expect.objectContaining({ artifactId: id })]);
  closeDatabase();
  initDatabase(dir);
  expect(loadDeliveryActivities(captureDeliveryActivityOwner(), getWorkspaceScope())).toEqual([
    expect.objectContaining({ artifactId: id, messageId: 'message-2' }),
  ]);
});
