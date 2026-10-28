import { withAgentIds } from '@/layouts/TeamsPanel/utils';
import { withIdentityName } from '@clawwork/core';

interface AgentMutationResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
}

interface AgentBuilderApi {
  createAgent: (
    gatewayId: string,
    params: { name: string; workspace: string; avatar?: string },
  ) => Promise<AgentMutationResult>;
  updateAgent: (
    gatewayId: string,
    params: { agentId: string; name?: string; model?: string },
  ) => Promise<AgentMutationResult>;
  setAgentFile?: (
    gatewayId: string,
    agentId: string,
    fileName: string,
    content: string,
  ) => Promise<AgentMutationResult>;
  deleteAgent: (gatewayId: string, params: { agentId: string; deleteFiles?: boolean }) => Promise<AgentMutationResult>;
}

export function deriveAgentCreationId(
  name: string,
  existingAgents: ReadonlyArray<{ id: string; name?: string }> = [],
): string {
  return withAgentIds([
    ...existingAgents.map((agent) => ({ id: agent.id, name: agent.name ?? agent.id })),
    { name },
  ]).at(-1)!.id;
}

async function rollbackCreatedAgent(
  api: AgentBuilderApi,
  gatewayId: string,
  agentId: string,
  failure: AgentMutationResult,
): Promise<AgentMutationResult> {
  const rollbackRes = await api.deleteAgent(gatewayId, { agentId, deleteFiles: true });
  if (rollbackRes.ok) return failure;
  return {
    ...failure,
    error: `${failure.error ?? 'agent update failed'} (rollback failed: ${rollbackRes.error ?? 'unknown error'})`,
  };
}

export async function createAgentWithRollback(
  api: AgentBuilderApi,
  params: {
    gatewayId: string;
    name: string;
    workspace: string;
    avatar?: string;
    model?: string;
    identityContent?: string;
    existingAgents?: ReadonlyArray<{ id: string; name?: string }>;
  },
): Promise<AgentMutationResult> {
  const normalizedName = params.name.trim().toLocaleLowerCase();
  const existing = params.existingAgents?.find((agent) => agent.name?.trim().toLocaleLowerCase() === normalizedName);
  if (existing) return { ok: true, result: { agentId: existing.id, reused: true } };

  const createRes = await api.createAgent(params.gatewayId, {
    name: deriveAgentCreationId(params.name, params.existingAgents),
    workspace: params.workspace,
    avatar: params.avatar,
  });
  if (!createRes.ok) return createRes;

  const created = createRes.result;
  const agentId = typeof created?.agentId === 'string' ? created.agentId : '';
  const model = params.model?.trim();
  if (model && agentId) {
    const updateRes = await api.updateAgent(params.gatewayId, { agentId, model });
    if (!updateRes.ok) return rollbackCreatedAgent(api, params.gatewayId, agentId, updateRes);
  }

  const identityContent = params.identityContent?.trim();
  if (identityContent && agentId) {
    const fileRes = api.setAgentFile
      ? await api.setAgentFile(params.gatewayId, agentId, 'IDENTITY.md', withIdentityName(identityContent, params.name))
      : { ok: false, error: 'agent identity writer unavailable' };
    if (!fileRes.ok) return rollbackCreatedAgent(api, params.gatewayId, agentId, fileRes);
  }

  if (agentId) {
    const nameResult = await api.updateAgent(params.gatewayId, { agentId, name: params.name.trim() });
    if (!nameResult.ok) return rollbackCreatedAgent(api, params.gatewayId, agentId, nameResult);
  }

  return createRes;
}
