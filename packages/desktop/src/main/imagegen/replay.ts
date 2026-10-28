import { resolve } from 'node:path';
import type { Artifact } from '@clawwork/shared';
import { getSqlite } from '../db/index.js';
import { artifactFromRow } from '../artifact/row.js';
import { verifyImagegenFile } from './verify.js';
export async function findImagegenReplay(input: {
  taskId: string;
  sourceKey: string;
  workspacePath: string;
  size: string;
}): Promise<Artifact | null> {
  const database = getSqlite();
  if (!database) throw new Error('imagegen-database-unavailable');
  const row = database
    .prepare('SELECT * FROM artifacts WHERE task_id=? AND source_key=? ORDER BY created_at,id LIMIT 1')
    .get(input.taskId, input.sourceKey) as Record<string, unknown> | undefined;
  if (!row) return null;
  const artifact = artifactFromRow(row);
  if (
    artifact.root !== 'workspace' ||
    !(await verifyImagegenFile(input.workspacePath, artifact.localPath, input.size, artifact.size))
  )
    throw new Error('imagegen-image-invalid');
  return { ...artifact, filePath: resolve(input.workspacePath, artifact.localPath) };
}
// Serialize publication only; remote polling remains concurrent. No extra artifact store.
const publications = new Map<string, Promise<unknown>>();
export async function publishImagegenArtifact(key: string, publish: () => Promise<Artifact>): Promise<Artifact> {
  const previous = publications.get(key);
  const next = (previous ?? Promise.resolve()).catch(() => undefined).then(publish);
  publications.set(key, next);
  try {
    return await next;
  } finally {
    if (publications.get(key) === next) publications.delete(key);
  }
}
