import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActiveTurn } from '@clawwork/core';
import { ToolCallCard } from './ToolCallCard';
import { ToolCallsGroup } from './ToolCallsGroup';
import { ThinkingCollapse } from './ThinkingCollapse';
import { ThinkingIndicator } from './ThinkingIndicator';

const MarkdownContent = lazy(() => import('./MarkdownContent').then((m) => ({ default: m.MarkdownContent })));

interface StreamingMessageProps {
  turn: ActiveTurn;
}

export function StreamingMessage({ turn }: StreamingMessageProps) {
  const { t } = useTranslation();
  const text = turn.streamingText || turn.content;
  // 思考内容与相位都来自 core 的 ActiveTurn（与桌面端同源）：
  // activity.kind === 'thinking' 表示"当前最新活动是思考" ⇒ 展开 + 扫光。
  const thinkingText = turn.streamingThinking || turn.thinkingContent || '';
  const thinkingLive = !turn.finalized && turn.activity?.kind === 'thinking';

  return (
    <div className="mb-4" role="article" aria-label={t('chat.assistantMessage')}>
      {thinkingText && (
        <ThinkingCollapse
          text={thinkingText}
          phase={thinkingLive ? 'live' : 'done'}
          segment={turn.activity?.thinkingSegment ?? 0}
        />
      )}

      {!text && !turn.finalized && <ThinkingIndicator />}

      <div aria-live="polite" aria-atomic="false">
        {text && (
          <div className="prose-chat type-body">
            {turn.finalized ? (
              <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
                <MarkdownContent content={text} />
              </Suspense>
            ) : (
              /*
               * 流式期间**不**解析 Markdown：每来一帧都重跑一次 Markdown 解析 + 重建 DOM，
               * 手机上长回答会越流越卡（桌面 CPU 强看不出来）。流式阶段用纯文本，
               * 定稿后再一次性转成 Markdown，视觉差异只在"边流边排版"这一下。
               */
              <p className="whitespace-pre-wrap">{text}</p>
            )}
            {!turn.finalized && (
              <span
                className="ml-0.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full align-middle"
                style={{ backgroundColor: 'var(--accent)' }}
                aria-hidden="true"
              />
            )}
          </div>
        )}
      </div>

      {turn.toolCalls.length > 0 && <ToolCallsGroup toolCalls={turn.toolCalls} />}
    </div>
  );
}
