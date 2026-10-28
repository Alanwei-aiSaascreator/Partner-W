import { parseAgentIdFromSessionKey, resolvePerformerAgentName } from '@clawwork/shared';

/**
 * 消息头和头像区显示的"这是谁"。
 *
 * 从 `MainArea/index.tsx` 里抽出来的（2026-09-20）：原来它是个文件内的私有函数，
 * 于是「名字的优先级」这条规则**没有单元测试守着** —— T-a7 那个
 * "worker 显示裸 agentId" 的 bug 就是在这条规则里活下来的。
 */
export interface AssistantIdentity {
  agentName?: string;
  agentEmoji?: string;
  localAvatarUrl?: string;
  gatewayAvatarUrl?: string;
  agentRoleLabel?: string;
}

interface PerformerLike {
  sessionKey: string;
  agentId: string;
  agentName: string;
  emoji?: string;
}

interface CatalogAgentLike {
  id: string;
  name?: string;
  identity?: { emoji?: string; avatarUrl?: string };
}

export function buildLocalAvatarUrl(gatewayId: string | undefined, agentId: string | undefined): string | undefined {
  if (!gatewayId || !agentId) return undefined;
  return `clawwork-avatar://${gatewayId}/${agentId}`;
}

export function resolveAssistantIdentity({
  task,
  sessionKey,
  agentId,
  gatewayId,
  performerBySessionKey,
  performerByAgentId,
  catalogAgentById,
  conductorLabel,
}: {
  task?: { sessionKey: string; agentId?: string; ensemble?: boolean };
  sessionKey?: string;
  agentId?: string;
  gatewayId?: string;
  performerBySessionKey: Map<string, PerformerLike>;
  performerByAgentId: Map<string, PerformerLike>;
  catalogAgentById: Map<string, CatalogAgentLike>;
  conductorLabel: string;
}): AssistantIdentity {
  const resolvedAgentId = agentId ?? (sessionKey ? parseAgentIdFromSessionKey(sessionKey) : undefined);
  const conductorAgentId =
    task?.agentId ?? (task?.sessionKey ? parseAgentIdFromSessionKey(task.sessionKey) : undefined);
  const performer =
    (sessionKey ? performerBySessionKey.get(sessionKey) : undefined) ??
    (resolvedAgentId ? performerByAgentId.get(resolvedAgentId) : undefined);
  const catalogEntry = resolvedAgentId ? catalogAgentById.get(resolvedAgentId) : undefined;
  const conductorCatalogEntry = conductorAgentId ? catalogAgentById.get(conductorAgentId) : undefined;
  const isConductor = Boolean(
    task?.ensemble &&
    ((sessionKey && sessionKey === task.sessionKey) ||
      (!sessionKey && resolvedAgentId && conductorAgentId && resolvedAgentId === conductorAgentId)),
  );

  if (isConductor) {
    const targetId = conductorAgentId ?? resolvedAgentId;
    const agentName = conductorCatalogEntry?.name ?? catalogEntry?.name ?? conductorAgentId ?? conductorLabel;
    return {
      agentName,
      agentEmoji: conductorCatalogEntry?.identity?.emoji ?? catalogEntry?.identity?.emoji,
      localAvatarUrl: buildLocalAvatarUrl(gatewayId, targetId),
      gatewayAvatarUrl: conductorCatalogEntry?.identity?.avatarUrl ?? catalogEntry?.identity?.avatarUrl,
      agentRoleLabel: agentName === conductorLabel ? undefined : conductorLabel,
    };
  }

  return {
    // ⚠️ 目录优先 —— 见 `resolvePerformerAgentName` 的注释。这里曾经是
    // `performer?.agentName ?? catalogEntry?.name ?? resolvedAgentId`，
    // 而快照里存的正是裸 agentId ⇒ 目录里的中文名永远轮不到（T-a7）。
    // 末位仍然是 `resolvedAgentId`（与改动前一致），只是把目录提到了快照前面。
    agentName: resolvePerformerAgentName(performer, catalogEntry) || resolvedAgentId,
    agentEmoji: performer?.emoji ?? catalogEntry?.identity?.emoji,
    localAvatarUrl: buildLocalAvatarUrl(gatewayId, resolvedAgentId),
    gatewayAvatarUrl: catalogEntry?.identity?.avatarUrl,
  };
}
