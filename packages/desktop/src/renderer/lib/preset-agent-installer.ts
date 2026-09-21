import { PRESET_AGENT_DEFINITIONS } from '@/lib/preset-agents';
import type { AgentInstallDefinition } from '@clawwork/core';

interface MutationResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface PresetAgentInstallerApi {
  createAgent: (
    gatewayId: string,
    params: { name: string; workspace: string; emoji?: string },
  ) => Promise<MutationResult>;
  updateAgent: (gatewayId: string, params: { agentId: string; name?: string }) => Promise<MutationResult>;
  getAgentFile: (gatewayId: string, agentId: string, name: string) => Promise<MutationResult>;
  setAgentFile: (gatewayId: string, agentId: string, name: string, content: string) => Promise<MutationResult>;
  deleteAgent: (gatewayId: string, params: { agentId: string; deleteFiles?: boolean }) => Promise<MutationResult>;
}

export interface PresetAgentInstallProgress {
  completed: number;
  total: number;
  currentId: string;
}

export interface PresetAgentInstallResult {
  installed: string[];
  skipped: string[];
  failed: Array<{ id: string; error: string }>;
}

interface InstallPresetAgentPackParams {
  gatewayId: string;
  workspaceRoot: string;
  currentAgentIds: string[];
  /** 已存在但目录名称仍是稳定 ID 的半成品；只修名称，不覆盖非空用户文件。 */
  repairAgentIds?: string[];
  /** 启动内置助手时校验关键文件；市场模板沿用“ID 存在即跳过”的既有语义。 */
  verifyExisting?: boolean;
  /** U 盘预置助手保留半成品供下一轮修复，避免 exFAT 删除 tombstone。 */
  preservePartialOnFailure?: boolean;
  displayNames: Record<string, string>;
  definitions?: readonly AgentInstallDefinition[];
  api: PresetAgentInstallerApi;
  onProgress?: (progress: PresetAgentInstallProgress) => void;
}

function readCreatedAgentId(result: unknown): string {
  if (!result || typeof result !== 'object' || !('agentId' in result)) return '';
  return typeof result.agentId === 'string' ? result.agentId : '';
}

function resultError(result: MutationResult, fallback: string): string {
  return result.error?.trim() || fallback;
}

async function hasCompleteAgentFile(
  api: PresetAgentInstallerApi,
  gatewayId: string,
  agentId: string,
  name: string,
): Promise<boolean> {
  const result = await api.getAgentFile(gatewayId, agentId, name);
  if (!result.ok) throw new Error(resultError(result, `${name} read failed`));
  const payload = result.result;
  if (!payload || typeof payload !== 'object' || !('file' in payload)) {
    throw new Error(`${name} read returned an invalid payload`);
  }
  const file = payload.file;
  if (!file || typeof file !== 'object') throw new Error(`${name} read returned an invalid file`);
  if ('missing' in file && file.missing === true) return false;
  return (
    'missing' in file &&
    file.missing === false &&
    'content' in file &&
    typeof file.content === 'string' &&
    file.content.trim().length > 0
  );
}

async function rollbackNewAgent(
  api: PresetAgentInstallerApi,
  gatewayId: string,
  agentId: string,
): Promise<string | null> {
  try {
    const result = await api.deleteAgent(gatewayId, { agentId, deleteFiles: true });
    return result.ok ? null : resultError(result, 'rollback failed');
  } catch (error) {
    return error instanceof Error ? error.message : 'rollback failed';
  }
}

export async function installPresetAgentPack({
  gatewayId,
  workspaceRoot,
  currentAgentIds,
  repairAgentIds = [],
  verifyExisting = false,
  preservePartialOnFailure = false,
  displayNames,
  definitions = PRESET_AGENT_DEFINITIONS,
  api,
  onProgress,
}: InstallPresetAgentPackParams): Promise<PresetAgentInstallResult> {
  const installed: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const knownAgentIds = new Set(currentAgentIds);
  const repairAgentIdSet = new Set(repairAgentIds);
  const cleanWorkspaceRoot = workspaceRoot.replace(/[\\/]+$/, '');

  let completed = 0;
  for (const definition of definitions) {
    let createdAgentId = '';
    let createdNewAgent = false;
    let shouldRollbackUnexpectedId = false;
    let failureMessage = '';
    try {
      const alreadyExists = knownAgentIds.has(definition.id);
      let identityComplete = false;
      let soulComplete = false;

      if (alreadyExists) {
        if (!verifyExisting && !repairAgentIdSet.has(definition.id)) {
          skipped.push(definition.id);
          completed++;
          onProgress?.({ completed, total: definitions.length, currentId: definition.id });
          continue;
        }
        createdAgentId = definition.id;
        identityComplete = await hasCompleteAgentFile(api, gatewayId, definition.id, 'IDENTITY.md');
        soulComplete = await hasCompleteAgentFile(api, gatewayId, definition.id, 'SOUL.md');
        if (identityComplete && soulComplete && !repairAgentIdSet.has(definition.id)) {
          skipped.push(definition.id);
          completed++;
          onProgress?.({ completed, total: definitions.length, currentId: definition.id });
          continue;
        }
      } else {
        const createResult = await api.createAgent(gatewayId, {
          name: definition.creationName,
          workspace: `${cleanWorkspaceRoot}/rongying-agents/${definition.id}`,
          emoji: definition.emoji,
        });
        if (!createResult.ok) throw new Error(resultError(createResult, 'agent creation failed'));

        createdAgentId = readCreatedAgentId(createResult.result);
        createdNewAgent = Boolean(createdAgentId);
        if (createdAgentId !== definition.id) {
          shouldRollbackUnexpectedId = Boolean(createdAgentId);
          throw new Error(
            createdAgentId
              ? `gateway returned unexpected agent id: ${createdAgentId}`
              : 'gateway did not return an agent id',
          );
        }
      }

      // 新建项要设置本地化显示名；现有项只有明确仍是稳定 raw ID 时才修名称。
      // 单纯补 IDENTITY/SOUL 缺文件时不得碰名称，否则 OpenClaw 的 agents.update
      // 会连带重写用户已有的 IDENTITY.md。
      if (createdNewAgent || repairAgentIdSet.has(definition.id)) {
        const updateResult = await api.updateAgent(gatewayId, {
          agentId: createdAgentId,
          name: displayNames[definition.id] ?? definition.creationName,
        });
        if (!updateResult.ok) throw new Error(resultError(updateResult, 'agent name update failed'));
      }

      if (!identityComplete) {
        const identityResult = await api.setAgentFile(gatewayId, createdAgentId, 'IDENTITY.md', definition.identityMd);
        if (!identityResult.ok) throw new Error(resultError(identityResult, 'IDENTITY.md write failed'));
      }

      if (!soulComplete) {
        const soulResult = await api.setAgentFile(gatewayId, createdAgentId, 'SOUL.md', definition.soulMd);
        if (!soulResult.ok) throw new Error(resultError(soulResult, 'SOUL.md write failed'));
      }

      installed.push(definition.id);
      knownAgentIds.add(definition.id);
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : 'agent setup failed';
      // 普通半成品保留给下一次幂等修复；只清理网关返回的意外 ID。
      // exFAT 上 deleteFiles 会留下 deletion tombstone，反而让重试永久失败。
      if (createdAgentId && (shouldRollbackUnexpectedId || (createdNewAgent && !preservePartialOnFailure))) {
        const rollbackError = await rollbackNewAgent(api, gatewayId, createdAgentId);
        if (rollbackError) failureMessage = `${failureMessage} (rollback failed: ${rollbackError})`;
      }
      failed.push({ id: definition.id, error: failureMessage });
    }

    completed++;
    onProgress?.({ completed, total: definitions.length, currentId: definition.id });
  }

  return { installed, skipped, failed };
}
