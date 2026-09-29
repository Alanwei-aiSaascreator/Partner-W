import { useEffect, useState } from 'react';

/** 同一批头像同时挂载时只问主进程一次；完成即清，上传/删除后不会留下陈旧缓存。 */
const localAvatarQueries = new Map<string, Promise<Set<string>>>();

export function listLocalAvatarIds(gatewayId: string): Promise<Set<string>> {
  if (typeof window.clawwork?.listLocalAvatars !== 'function') return Promise.resolve(new Set<string>());
  const pending = localAvatarQueries.get(gatewayId);
  if (pending) return pending;
  const query = window.clawwork
    .listLocalAvatars(gatewayId)
    .then((result) => new Set(result.ok && Array.isArray(result.result) ? result.result : []))
    .catch(() => new Set<string>())
    .finally(() => localAvatarQueries.delete(gatewayId));
  localAvatarQueries.set(gatewayId, query);
  return query;
}

export function useLocalAvatarUrl(gatewayId: string | undefined | null, agentId: string | undefined) {
  const [localUrl, setLocalUrl] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLocalUrl(undefined);
    if (!gatewayId || !agentId || typeof window.clawwork?.listLocalAvatars !== 'function') return () => undefined;
    void listLocalAvatarIds(gatewayId).then((ids) => {
      if (!cancelled && ids.has(agentId)) setLocalUrl(`clawwork-avatar://${gatewayId}/${agentId}`);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, gatewayId]);

  return localUrl;
}
