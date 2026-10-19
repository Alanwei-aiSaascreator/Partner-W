import { createHash, randomUUID } from 'node:crypto';
import { getSqlite } from '../db/index.js';
import type { VideogenRequest } from './request.js';

export const VIDEOGEN_OPERATION_KEY_VERSION = 1;

/**
 * 逻辑操作键：绑定字段的 sha256。**纯函数**（不碰 IO），所以测试能逐条钉住字段。
 */
export function videogenOperationKey(input: { taskId: string; request: VideogenRequest }): string {
  const firstFrame = input.request.firstFrameData;
  const firstFrameDigest = firstFrame
    ? createHash('sha256').update(Buffer.from(firstFrame.content, 'base64')).digest('hex')
    : '';
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: VIDEOGEN_OPERATION_KEY_VERSION,
        taskId: input.taskId,
        model: input.request.model ?? 'minimax-h3',
        prompt: input.request.prompt,
        duration: input.request.duration,
        resolution: input.request.resolution,
        aspectRatio: input.request.aspectRatio,
        firstFrameDigest,
      }),
    )
    .digest('hex');
}

interface IdentityRow {
  request_id?: unknown;
}

export function resolveVideogenRequestId(input: { taskId: string; request: VideogenRequest }): string {
  const operationKey = videogenOperationKey(input);
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('videogen-identity-unavailable');

  const read = (): string | null => {
    const row = sqlite
      .prepare('SELECT request_id FROM videogen_request_identities WHERE operation_key = ?')
      .get(operationKey) as IdentityRow | undefined;
    return typeof row?.request_id === 'string' && row.request_id ? row.request_id : null;
  };

  const existing = read();
  if (existing) return existing;

  // `INSERT OR IGNORE` + 回读：两个进程同时首铸时，先落库的那把是**唯一**答案
  // （各自返回自己那把会让"同操作两把 id"重新出现 = 重复付费的入口）。
  sqlite
    .prepare(
      'INSERT OR IGNORE INTO videogen_request_identities (operation_key, request_id, task_id, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(operationKey, randomUUID(), input.taskId, new Date().toISOString());
  const persisted = read();
  if (!persisted) throw new Error('videogen-identity-unavailable');
  return persisted;
}
