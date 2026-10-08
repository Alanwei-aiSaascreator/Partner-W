import type Database from 'better-sqlite3';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  isArtifactDeliveryPageProgress,
  type ArtifactDeliveryActivity,
  type ArtifactWorkspaceScope,
  type Message,
  type ToolCall,
} from '@clawwork/shared';
import { getSqlite } from './index.js';
import { getLicenseGeneration } from '../commercial/license-generation.js';
import { readConfig, type CommercialConfig } from '../workspace/config.js';
import { collectToolSlideReceipts } from '../slidegen/tool-receipts.js';

type Binding = NonNullable<CommercialConfig['licenseBinding']>;
export interface DeliveryActivityOwner {
  database: Database.Database | null;
  binding: Binding | null;
  licenseGeneration: number | null;
}
const phases = new Set([
  'downloading-media',
  'generating-presentation',
  'generating-document',
  'generating-html',
  'saving-artifacts',
  'reconciling-artifacts',
]);
const statuses = new Set(['succeeded', 'needs-review', 'failed', 'canceled']);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const bindingKey = (binding: Binding | null) =>
  binding ? JSON.stringify([binding.userId, binding.orgId, binding.licenseId]) : null;

export function captureDeliveryActivityOwner(): DeliveryActivityOwner {
  const database = getSqlite();
  let binding: Binding | null = null;
  if (database) {
    try {
      const commercial = readConfig()?.commercial;
      const stored = commercial?.licenseBinding;
      if (
        commercial?.licenseKey &&
        stored &&
        nonempty(stored.userId) &&
        nonempty(stored.orgId) &&
        nonempty(stored.licenseId)
      )
        binding = { ...stored };
    } catch (error) {
      console.warn('[delivery-activity] account ownership unavailable:', error);
    }
  }
  return { database, binding, licenseGeneration: database ? getLicenseGeneration() : null };
}

export function isDeliveryActivityOwnerCurrent(owner: DeliveryActivityOwner): boolean {
  const current = captureDeliveryActivityOwner();
  return (
    owner.database === current.database &&
    owner.licenseGeneration === current.licenseGeneration &&
    bindingKey(owner.binding) === bindingKey(current.binding)
  );
}

function terminal(value: unknown): value is ArtifactDeliveryActivity & { endedAt: number } {
  if (
    !object(value) ||
    !nonempty(value.operationId) ||
    !nonempty(value.taskId) ||
    !nonempty(value.sessionKey) ||
    !nonempty(value.messageId) ||
    !nonempty(value.workspaceScope) ||
    !integer(value.workspaceRevision) ||
    !integer(value.sequence) ||
    value.sequence < 1 ||
    !integer(value.startedAt) ||
    !integer(value.endedAt) ||
    value.endedAt < value.startedAt ||
    !statuses.has(String(value.status)) ||
    !phases.has(String(value.phase)) ||
    (value.runId !== undefined && !nonempty(value.runId)) ||
    (value.pageProgress !== undefined && !isArtifactDeliveryPageProgress(value.pageProgress)) ||
    (value.historyTruncated !== undefined && typeof value.historyTruncated !== 'boolean')
  )
    return false;
  const { startedAt, endedAt, sequence } = value;
  return (
    value.observedPhases === undefined ||
    (Array.isArray(value.observedPhases) &&
      value.observedPhases.length <= 64 &&
      value.observedPhases.every(
        (step) =>
          object(step) &&
          phases.has(String(step.phase)) &&
          integer(step.observedAt) &&
          step.observedAt >= startedAt &&
          step.observedAt <= endedAt &&
          integer(step.sequence) &&
          step.sequence > 0 &&
          step.sequence <= sequence,
      ))
  );
}

/**
 * 产物所在的**目录**（BUG-041 ④）。
 *
 * `file_path` 是登记那一刻的绝对路径 —— **盘符一变（E: → G:）就是死路径**，而这条链
 * 要按目录去读收据证明"这轮产出了什么"。所以 `root !== 'agent'` 时改用
 * `当前工作区 + local_path` 重新解析（与 `ipc/artifact-handlers.ts` 同款词法校验）。
 *
 * ⚠️ `root === 'agent'` **不猜**：助手工作区要 RPC 问（这里是同步事务，问不了），
 *    猜错的方向恰好是"把别的目录的文件当成这个任务的产物" ⇒ 保留老行为。
 */
export function artifactDirectoryFor(
  artifact: { root: string; local_path: string; file_path: string },
  workspacePath: string | null,
): string {
  const local = artifact.local_path;
  if (artifact.root !== 'agent' && workspacePath && local && !local.includes('\0') && !isAbsolute(local)) {
    const root = resolve(workspacePath);
    const absolute = resolve(root, local);
    const relation = relative(root, absolute);
    if (relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
      return dirname(absolute);
  }
  return dirname(artifact.file_path);
}

function artifactReferences(database: Database.Database, event: ArtifactDeliveryActivity): unknown[] {
  const artifacts = database
    .prepare(
      'SELECT id,root,local_path,file_path,source_key,size FROM artifacts WHERE task_id=? AND message_id=? ORDER BY id LIMIT 64',
    )
    .all(event.taskId, event.messageId) as Array<{
    id: string;
    root: string;
    local_path: string;
    file_path: string;
    source_key: string;
    size: number;
  }>;
  // 当前工作区（与 `getWorkspacePath()` 同值；走已经导入的 `readConfig`，
  // 不再多拉一个导出面进来）。
  const workspacePath = (() => {
    try {
      return readConfig()?.workspacePath ?? null;
    } catch (error) {
      console.warn('[delivery-activity] workspace path unavailable:', error);
      return null;
    }
  })();
  const messages = event.runId
    ? (database
        .prepare(
          "SELECT task_id,session_key,run_id,tool_calls FROM messages WHERE task_id=? AND session_key=? AND run_id=? AND role='assistant' ORDER BY timestamp LIMIT 256",
        )
        .all(event.taskId, event.sessionKey, event.runId) as Array<{
        task_id: string;
        session_key: string;
        run_id: string;
        tool_calls: string | null;
      }>)
    : [];
  const proofs: Array<Pick<Message, 'taskId' | 'sessionKey' | 'runId' | 'role' | 'toolCalls'>> = [];
  for (const message of messages) {
    try {
      const tools: unknown = JSON.parse(message.tool_calls ?? '[]');
      if (Array.isArray(tools))
        proofs.push({
          taskId: message.task_id,
          sessionKey: message.session_key,
          runId: message.run_id,
          role: 'assistant',
          toolCalls: tools.filter(
            (tool): tool is ToolCall =>
              object(tool) &&
              nonempty(tool.id) &&
              nonempty(tool.name) &&
              nonempty(tool.startedAt) &&
              (tool.status === 'done' || tool.status === 'error') &&
              (tool.result === undefined || typeof tool.result === 'string') &&
              (tool.args === undefined || object(tool.args)),
          ),
        });
    } catch (error) {
      console.warn('[delivery-activity] artifact proof unavailable:', error);
    }
  }
  return artifacts.map((artifact) => {
    const proof =
      artifact.local_path === basename(artifact.file_path)
        ? collectToolSlideReceipts({
            workspacePath: artifactDirectoryFor(artifact, workspacePath),
            taskId: event.taskId,
            sessionKey: event.sessionKey,
            runId: event.runId,
            messages: proofs,
            allowNative: true,
          }).receipts.find(
            (entry) => entry.receipt.fileName === basename(artifact.file_path) && entry.receipt.bytes === artifact.size,
          )
        : undefined;
    return {
      artifactId: artifact.id,
      root: artifact.root,
      localPath: artifact.local_path,
      sourceKey: artifact.source_key,
      receiptFile: proof?.receiptFile ?? null,
      sourceSha256: proof?.receipt.sourceSha256 ?? null,
      outputSha256: proof?.receipt.outputSha256 ?? null,
    };
  });
}

export function persistDeliveryActivity(owner: DeliveryActivityOwner, event: ArtifactDeliveryActivity): void {
  const database = owner.database;
  if (!database || !isDeliveryActivityOwnerCurrent(owner) || !terminal(event)) return;
  const references = artifactReferences(database, event);
  if (!isDeliveryActivityOwnerCurrent(owner)) return;
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO artifact_delivery_activities (operation_id,task_id,session_key,owner_user_id,owner_org_id,owner_license_id,ended_at,record_json,artifact_refs_json)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING`,
      )
      .run(
        event.operationId,
        event.taskId,
        event.sessionKey,
        owner.binding?.userId ?? null,
        owner.binding?.orgId ?? null,
        owner.binding?.licenseId ?? null,
        event.endedAt,
        JSON.stringify(event),
        JSON.stringify(references),
      );
    database
      .prepare(
        `DELETE FROM artifact_delivery_activities WHERE operation_id IN (
      SELECT operation_id FROM artifact_delivery_activities WHERE owner_user_id IS ? AND owner_org_id IS ? AND owner_license_id IS ? ORDER BY ended_at DESC,rowid DESC LIMIT -1 OFFSET 256
    )`,
      )
      .run(owner.binding?.userId ?? null, owner.binding?.orgId ?? null, owner.binding?.licenseId ?? null);
  })();
}

export function loadDeliveryActivities(
  owner: DeliveryActivityOwner,
  scope: ArtifactWorkspaceScope,
): ArtifactDeliveryActivity[] {
  if (!owner.database || !owner.binding || !scope.scope || !isDeliveryActivityOwnerCurrent(owner)) return [];
  const rows = owner.database
    .prepare(
      `SELECT operation_id,task_id,session_key,ended_at,record_json FROM artifact_delivery_activities
    WHERE owner_user_id=? AND owner_org_id=? AND owner_license_id=? ORDER BY ended_at DESC,rowid DESC LIMIT 256`,
    )
    .all(owner.binding.userId, owner.binding.orgId, owner.binding.licenseId) as Array<{
    operation_id: string;
    task_id: string;
    session_key: string;
    ended_at: number;
    record_json: string;
  }>;
  const result: ArtifactDeliveryActivity[] = [];
  for (const row of rows.reverse()) {
    try {
      const event: unknown = JSON.parse(row.record_json);
      if (
        terminal(event) &&
        event.operationId === row.operation_id &&
        event.taskId === row.task_id &&
        event.sessionKey === row.session_key &&
        event.endedAt === row.ended_at
      )
        result.push({ ...event, workspaceScope: scope.scope, workspaceRevision: scope.revision });
    } catch (error) {
      console.warn('[delivery-activity] stored terminal unavailable:', error);
    }
  }
  return isDeliveryActivityOwnerCurrent(owner) ? result : [];
}
