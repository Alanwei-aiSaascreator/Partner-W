import { createHash, randomUUID } from 'node:crypto';
import { getSqlite } from '../db/index.js';
import type { ImagegenRequest } from './request.js';
interface ImagegenIdentityInput {
  taskId: string;
  authScope: string;
  request: ImagegenRequest;
}
export function imagegenOperationKey(input: ImagegenIdentityInput): string {
  return createHash('sha256')
    .update(JSON.stringify([2, input.authScope, input.taskId, input.request.operationId]))
    .digest('hex');
}
function fingerprint(request: ImagegenRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([request.model, request.prompt, request.size]))
    .digest('hex');
}
export function findImagegenRequestId(input: ImagegenIdentityInput): string | null {
  const db = getSqlite();
  if (!db) throw new Error('imagegen-identity-unavailable');
  const row = db
    .prepare('SELECT request_id, request_fingerprint FROM imagegen_request_identities WHERE operation_key = ?')
    .get(imagegenOperationKey(input)) as { request_id?: unknown; request_fingerprint?: unknown } | undefined;
  if (!row) return null;
  if (row.request_fingerprint !== fingerprint(input.request)) throw new Error('imagegen-request-conflict');
  if (typeof row.request_id !== 'string') throw new Error('imagegen-identity-unavailable');
  return row.request_id;
}
export function resolveImagegenRequestId(input: ImagegenIdentityInput): string {
  const db = getSqlite();
  if (!db) throw new Error('imagegen-identity-unavailable');
  const existing = findImagegenRequestId(input);
  if (existing) return existing;
  db.prepare(
    'INSERT OR IGNORE INTO imagegen_request_identities (operation_key, request_id, task_id, request_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(imagegenOperationKey(input), randomUUID(), input.taskId, fingerprint(input.request), new Date().toISOString());
  const saved = findImagegenRequestId(input);
  if (!saved) throw new Error('imagegen-identity-unavailable');
  return saved;
}
