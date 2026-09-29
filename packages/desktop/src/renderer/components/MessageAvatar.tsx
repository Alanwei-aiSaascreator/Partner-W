import { useEffect, useState } from 'react';
import { Bot, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLocalAvatarUrl } from '@/lib/local-avatar';

interface MessageAvatarProps {
  role: 'user' | 'assistant';
  agentEmoji?: string;
  localAvatarUrl?: string;
  gatewayAvatarUrl?: string;
}

export default function MessageAvatar({ role, agentEmoji, localAvatarUrl, gatewayAvatarUrl }: MessageAvatarProps) {
  const [failCount, setFailCount] = useState(0);
  const localMatch = localAvatarUrl?.match(/^clawwork-avatar:\/\/([^/]+)\/(.+)$/);
  const verifiedLocalAvatarUrl = useLocalAvatarUrl(localMatch?.[1], localMatch?.[2]);
  useEffect(() => setFailCount(0), [gatewayAvatarUrl, verifiedLocalAvatarUrl]);
  const urls = [verifiedLocalAvatarUrl, gatewayAvatarUrl].filter(Boolean) as string[];
  const avatarUrl = urls[failCount];
  const showImg = role === 'assistant' && avatarUrl;

  return (
    <div
      // 探针/测试用：一个助手块在"等待→流式→定稿→收编"之间换的是**状态**不是节点，
      // 而肉眼能看出来的就是这颗头像。给它一个稳定的抓手，才钉得住"同一个节点"。
      data-testid="message-avatar"
      data-role={role}
      className={cn(
        'flex-shrink-0 size-[var(--density-avatar-size)] rounded-full flex items-center justify-center overflow-hidden',
        role === 'user' ? 'bg-[var(--bg-tertiary)]' : !showImg && 'bg-[var(--accent-dim)]',
      )}
    >
      {role === 'user' ? (
        <User className="size-[calc(var(--density-avatar-size)*0.6)] text-[var(--text-secondary)]" />
      ) : showImg ? (
        <img
          src={avatarUrl}
          alt=""
          className="size-[var(--density-avatar-size)] rounded-full object-cover"
          onError={() => setFailCount((c) => c + 1)}
        />
      ) : agentEmoji ? (
        <span className="emoji-md leading-none">{agentEmoji}</span>
      ) : (
        <Bot className="size-[calc(var(--density-avatar-size)*0.6)] text-[var(--accent)]" />
      )}
    </div>
  );
}
