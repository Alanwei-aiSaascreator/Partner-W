import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import type { Message } from '@clawwork/shared';
import { ToolCallCard } from './ToolCallCard';
import { ToolCallsGroup } from './ToolCallsGroup';
import { AlertCircle, Bot } from 'lucide-react';

const MarkdownContent = lazy(() => import('./MarkdownContent').then((m) => ({ default: m.MarkdownContent })));

interface ChatMessageProps {
  message: Message;
}

function MarkdownFallback({ content }: { content: string }) {
  return (
    <p className="whitespace-pre-wrap type-body" style={{ color: 'var(--text-primary)' }}>
      {content}
    </p>
  );
}

export function ChatMessage({ message }: ChatMessageProps) {
  const { t } = useTranslation();

  if (message.role === 'system') {
    return (
      <div
        role="article"
        aria-label={t('chat.systemMessage')}
        className="mb-3 flex items-start gap-2 rounded-lg px-3 py-2"
        style={{ backgroundColor: 'var(--bg-tertiary)', opacity: 0.7 }}
      >
        <AlertCircle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
        <span className="type-support" style={{ color: 'var(--text-secondary)' }}>
          {message.content}
        </span>
      </div>
    );
  }

  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div role="article" aria-label={t('chat.userMessage')} className="mb-4 flex justify-end">
        <div className="bubble-user px-4 py-2.5" style={{ maxWidth: '85%' }}>
          <p className="whitespace-pre-wrap type-body">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div role="article" aria-label={t('chat.assistantMessage')} className="mb-4 flex gap-2.5">
      {/* 与桌面端一致：助手消息带一个圆形头像 */}
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: 'var(--accent-dim)' }}
        aria-hidden="true"
      >
        <Bot size={15} style={{ color: 'var(--accent)' }} />
      </div>
      <div className="min-w-0 flex-1">
      {message.content && (
        <div className="prose-chat type-body">
          <Suspense fallback={<MarkdownFallback content={message.content} />}>
            <MarkdownContent content={message.content} />
          </Suspense>
        </div>
      )}

      {/* 定稿消息：工具调用不再有帧来收场 ⇒ settled 投影（running/declared → 未收到结果），
          否则历史同步来的消息永远显示「正在执行」（2026-10-21 真机）。 */}
      {message.toolCalls.length > 0 && <ToolCallsGroup toolCalls={message.toolCalls} settled />}
      </div>
    </div>
  );
}
