import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';

/** 同一批头像同时挂载时只问主进程一次；完成即清，上传/删除后不会留下陈旧缓存。 */
const localAvatarQueries = new Map<string, Promise<Set<string>>>();

function listLocalAvatarIds(gatewayId: string): Promise<Set<string>> {
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
  const [hasLocalAvatar, setHasLocalAvatar] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailCount(0);
    setHasLocalAvatar(false);
    if (!gatewayId || typeof window.clawwork.listLocalAvatars !== 'function') return () => undefined;
    void listLocalAvatarIds(gatewayId).then((ids) => {
      if (!cancelled) {
        setFailCount(0);
        setHasLocalAvatar(ids.has(agentId));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, gatewayId]);

  // 先查清本地是否真有文件，再拼协议 URL。这样没有头像的助手不会每次重渲染都打一条 404。
  const localUrl = gatewayId && hasLocalAvatar ? `clawwork-avatar://${gatewayId}/${agentId}` : undefined;
  const urls = [localUrl, gatewayAvatarUrl].filter(Boolean) as string[];
  const resolved = urls[failCount];

  if (resolved) {
    return <img src={resolved} alt="" className={imgClass} onError={() => setFailCount((c) => c + 1)} />;
  }
  if (emoji) return <span className={emojiClass}>{emoji}</span>;
  return <Bot size={iconSize} className={iconClass} />;
}
