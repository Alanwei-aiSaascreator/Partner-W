import { useEffect, useState } from 'react';
import {
  Bot,
  Compass,
  PenLine,
  Clapperboard,
  ClipboardList,
  ShoppingBag,
  Search,
  House,
  Network,
  Lightbulb,
  ShieldCheck,
  NotebookPen,
  UserRound,
} from 'lucide-react';
import type { TeamPosition } from '@clawwork/shared';
import { useLocalAvatarUrl } from '@/lib/local-avatar';

interface AgentIconProps {
  gatewayId?: string | null;
  agentId: string;
  gatewayAvatarUrl?: string;
  emoji?: string;
  role?: string;
  position?: TeamPosition;
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
  role,
  position,
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
  const presetIcons = {
    main: Compass,
    'partner-w-content': PenLine,
    'partner-w-video': Clapperboard,
    'partner-w-office': ClipboardList,
    'partner-w-ecommerce': ShoppingBag,
    'partner-w-research': Search,
    'partner-w-family': House,
  };
  const positionIcons = { moderator: Network, expert: Lightbulb, challenger: ShieldCheck, scribe: NotebookPen };
  const Icon =
    (position && Object.hasOwn(positionIcons, position) && positionIcons[position]) ||
    (Object.hasOwn(presetIcons, agentId) ? presetIcons[agentId as keyof typeof presetIcons] : undefined) ||
    (role === 'coordinator' ? Network : role === 'worker' ? UserRound : Bot);
  return <Icon size={iconSize} className={iconClass} />;
}
