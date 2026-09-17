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
  displayNames,
  definitions = PRESET_AGENT_DEFINITIONS,
  api,
  onProgress,
}: InstallPresetAgentPackParams): Promise<PresetAgentInstallResult> {
  const installed: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const knownAgentIds = new Set(currentAgentIds);
  const cleanWorkspaceRoot = workspaceRoot.replace(/[\\/]+$/, '');

  let completed = 0;
  for (const definition of definitions) {
    if (knownAgentIds.has(definition.id)) {
      skipped.push(definition.id);
      completed++;
      onProgress?.({ completed, total: definitions.length, currentId: definition.id });
      continue;
    }

    let createdAgentId = '';
    let failureMessage = '';
    try {
      const createResult = await api.createAgent(gatewayId, {
        name: definition.creationName,
        workspace: `${cleanWorkspaceRoot}/rongying-agents/${definition.id}`,
        emoji: definition.emoji,
      });
      if (!createResult.ok) throw new Error(resultError(createResult, 'agent creation failed'));

      createdAgentId = readCreatedAgentId(createResult.result);
      if (createdAgentId !== definition.id) {
        throw new Error(
          createdAgentId
            ? `gateway returned unexpected agent id: ${createdAgentId}`
            : 'gateway did not return an agent id',
        );
      }

      const updateResult = await api.updateAgent(gatewayId, {
        agentId: createdAgentId,
        name: displayNames[definition.id] ?? definition.creationName,
      });
      if (!updateResult.ok) throw new Error(resultError(updateResult, 'agent name update failed'));

      const identityResult = await api.setAgentFile(gatewayId, createdAgentId, 'IDENTITY.md', definition.identityMd);
      if (!identityResult.ok) throw new Error(resultError(identityResult, 'IDENTITY.md write failed'));

      const soulResult = await api.setAgentFile(gatewayId, createdAgentId, 'SOUL.md', definition.soulMd);
      if (!soulResult.ok) throw new Error(resultError(soulResult, 'SOUL.md write failed'));

      installed.push(definition.id);
      knownAgentIds.add(definition.id);
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : 'agent setup failed';
      if (createdAgentId) {
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
