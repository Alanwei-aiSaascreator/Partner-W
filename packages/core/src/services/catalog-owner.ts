export function resolveCatalogAgentId(
  catalog: { defaultId?: string; agents: ReadonlyArray<{ id: string }> } | null | undefined,
  requestedAgentId?: string,
): string | undefined {
  if (!catalog) return undefined;
  const ids = new Set(catalog.agents.map((agent) => agent.id).filter((id) => id.trim().length > 0));
  const requested = requestedAgentId?.trim();
  if (requested) return ids.has(requested) ? requested : undefined;
  const defaultId = catalog.defaultId?.trim();
  if (defaultId && ids.has(defaultId)) return defaultId;
  return ids.size === 1 ? ids.values().next().value : undefined;
}
