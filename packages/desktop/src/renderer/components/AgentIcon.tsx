import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';

/** 同一批头像同时挂载时只问主进程一次；完成即清，上传/删除后不会留下陈旧缓存。 */
const localAvatarQueries = new Map<string, Promise<Set<string>>>();

export function listLocalAvatarIds(gatewayId: string): Promise<Set<string>> {
  if (typeof window.clawwork.listLocalAvatars !== 'function') return Promise.resolve(new Set<string>());
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
    if (!gatewayId || !agentId || typeof window.clawwork.listLocalAvatars !== 'function') return () => undefined;
    void listLocalAvatarIds(gatewayId).then((ids) => {
      if (!cancelled && ids.has(agentId)) setLocalUrl(`clawwork-avatar://${gatewayId}/${agentId}`);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, gatewayId]);

  return localUrl;
}

interface AgentIconProps {
  gatewayId?: string | null;
  agentId: string;
  gatewayAvatarUrl?: string;
  emoji?: string;
  imgClass?: string;
  emojiClass?: string;
  iconSize?: number;
  iconClass?: string;
}

export default function AgentIcon({
  gatewayId,
  agentId,
  gatewayAvatarUrl,
  emoji,
  imgClass = 'w-4 h-4 rounded-full object-cover',
  emojiClass = 'emoji-sm',
  iconSize = 14,
  iconClass = 'text-[var(--accent)]',
}: AgentIconProps) {
  const [failCount, setFailCount] = useState(0);
  const localUrl = useLocalAvatarUrl(gatewayId, agentId);

  useEffect(() => {
    setFailCount(0);
  }, [agentId, gatewayId, localUrl]);

  // 先查清本地是否真有文件，再拼协议 URL。这样没有头像的助手不会每次重渲染都打一条 404。
  const urls = [localUrl, gatewayAvatarUrl].filter(Boolean) as string[];
  const resolved = urls[failCount];

  if (resolved) {
    return <img src={resolved} alt="" className={imgClass} onError={() => setFailCount((c) => c + 1)} />;
  }
  if (emoji) return <span className={emojiClass}>{emoji}</span>;
  return <Bot size={iconSize} className={iconClass} />;
}
