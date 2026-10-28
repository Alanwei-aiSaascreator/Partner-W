/**
 * 请求的助手在本机目录里吗？
 *
 * 三种结果里 `loading` 是**硬要求**：目录还没拉回来时**不许**判缺失，否则
 * 「正在拉目录」会被说成「这个助手不在本机」—— 那是用新的误报换掉旧的静默。
 * 依据是 `IdentityCenter/index.tsx` 里那条既有注释（刻意不查目录，怕误报失败）。
 *
 * 判据收在这里，是为了三处消费者（欢迎屏 / 左栏切换器 / 身份中心）共用一份实现，
 * 而不是各写一遍必然漂移。
 */
export type RequestedAgentState = 'ok' | 'missing' | 'loading';

export function resolveRequestedAgent(
  requestedAgentId: string | undefined,
  catalog: { agents: readonly { id: string }[] } | undefined,
): RequestedAgentState {
  if (!catalog) return 'loading';
  const requested = requestedAgentId ?? '';
  if (!requested) return 'ok';
  return catalog.agents.some((agent) => agent.id === requested) ? 'ok' : 'missing';
}

export type RequestedAgentActionState = 'ok' | 'missing' | 'unavailable';

/**
 * 动作入口不能拿 `loading` 当放行证：强制刷新一次，再读权威目录。
 * 刷新失败或刷新后仍无目录时返回 `unavailable`，调用方必须保持零副作用。
 */
export async function resolveRequestedAgentForAction(input: {
  requestedAgentId: string | undefined;
  readCatalog: () => { agents: readonly { id: string }[] } | undefined;
  refresh: () => Promise<void>;
}): Promise<RequestedAgentActionState> {
  const first = resolveRequestedAgent(input.requestedAgentId, input.readCatalog());
  if (first !== 'loading') return first;

  try {
    await input.refresh();
  } catch {
    return 'unavailable';
  }

  const refreshed = resolveRequestedAgent(input.requestedAgentId, input.readCatalog());
  return refreshed === 'loading' ? 'unavailable' : refreshed;
}
