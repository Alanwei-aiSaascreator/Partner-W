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
  updateAgent: (gatewayId: string, params: { agentId: string; model?: string }) => Promise<AgentMutationResult>;
  setAgentFile?: (
    gatewayId: string,
    agentId: string,
    fileName: string,
    content: string,
  ) => Promise<AgentMutationResult>;
  deleteAgent: (gatewayId: string, params: { agentId: string; deleteFiles?: boolean }) => Promise<AgentMutationResult>;
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
    name: params.name,
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
      ? await api.setAgentFile(params.gatewayId, agentId, 'IDENTITY.md', identityContent)
      : { ok: false, error: 'agent identity writer unavailable' };
    if (!fileRes.ok) return rollbackCreatedAgent(api, params.gatewayId, agentId, fileRes);
  }

  return createRes;
}
