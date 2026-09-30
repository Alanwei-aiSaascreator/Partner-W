import { memo, useEffect, useRef, useState } from 'react';
import type { Message, ToolCall } from '@clawwork/shared';
import { Check, Copy, Loader2, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { motion as motionPresets } from '@/styles/design-tokens';
import { copyTextToClipboard } from '@/lib/clipboard';
import MessageBlock, { type AssistantIdentity } from './MessageBlock';
import { AttachmentFileCard, InlineImageBubble, MessageActionButton } from './MessageParts';
import ThinkingIndicator from './ThinkingIndicator';
import ToolCallSummary from './ToolCallSummary';
import MarkdownContent from './MarkdownContent';
import ArtifactCard from './ArtifactCard';

/**
 * 助手那**一格**（时间线里的一个槽位）的全部渲染。
 *
 * 为什么是一个组件而不是两个：同一个槽位在一轮对话里要经历
 * **等待 → 流式 → 定稿 → 收编成正式消息**。只要这几步落在**不同的组件类型**上，
 * React 就会在最外层把整块卸载重建 —— 头像是新节点，用户看到"闪一下"
 * （2026-09-20 实机报障；现场日志 `debug-2026-09-20.1.ndjson` 实测：定稿后 +85ms 就
 * 拉 `chat.history`、+95ms 收到并把这轮答复**收编成正式消息** ⇒ 只差 95ms 就换第二刀）。
 *
 * 所以：外壳（`MessageBlock`）与**组件类型**从头到尾不变，变的只有身体。
 */

/** 定稿后那条正式答复的身体（原 `ChatMessage` 的助手分支）。 */
export interface AssistantFinalizedBodyProps {
  message: Message;
  agentName?: string;
  onImageClick?: (src: string) => void;
  onRetry?: () => void;
}

export function AssistantFinalizedBody({ message, agentName, onImageClick, onRetry }: AssistantFinalizedBodyProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (saveState !== 'saved' && saveState !== 'error') return;
    const timer = window.setTimeout(() => setSaveState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [saveState]);

  const attachments = message.attachments;
  const hasVisibleAnswer = Boolean(
    message.content.trim() || attachments?.length || message.artifacts.length || message.toolCalls.length,
  );
  const canSaveMessage = Boolean(message.content.trim()) && Boolean(message.taskId) && Boolean(message.id);

  const handleCopy = (): void => {
    void copyTextToClipboard(message.content).then(() => setCopied(true));
  };

  const handleSaveMessage = (): void => {
    if (!canSaveMessage || saveState === 'saving') return;
    setSaveState('saving');
    window.clawwork
      .saveCodeBlock({
        taskId: message.taskId,
        messageId: message.id,
        content: message.content,
        language: 'md',
      })
      .then((r) => {
        if (!r.ok) throw new Error(r.error);
        setSaveState('saved');
      })
      .catch(() => setSaveState('error'));
  };

  return (
    <>
      {message.content.trim() ? (
        <div className="inline-block max-w-full leading-relaxed rounded-2xl px-4 py-3 text-[var(--text-primary)]">
          <MarkdownContent
            content={message.content}
            onImageClick={onImageClick}
            taskId={message.taskId}
            messageId={message.id}
          />
        </div>
      ) : null}
      {attachments?.length ? (
        <div className="flex gap-2 mt-2 flex-wrap justify-start">
          {attachments.map((attachment, i) => {
            const isImage = !attachment.mimeType || attachment.mimeType.startsWith('image/');
            return isImage ? (
              <InlineImageBubble
                key={`${attachment.fileName}-${i}`}
                attachment={attachment}
                single={attachments.length === 1}
                onOpen={onImageClick}
              />
            ) : (
              <AttachmentFileCard key={`${attachment.fileName}-${i}`} attachment={attachment} />
            );
          })}
        </div>
      ) : null}
      {message.artifacts.length > 0 ? (
        <div className="mt-2 grid max-w-2xl gap-2 sm:grid-cols-2">
          {message.artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} assistantLabel={agentName} />
          ))}
        </div>
      ) : null}
      {message.toolCalls.length > 0 && <ToolCallSummary toolCalls={message.toolCalls} settled />}
      {!hasVisibleAnswer ? (
        <div
          data-testid="assistant-no-visible-answer"
          role="status"
          className="type-support mt-2 flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-3 text-[var(--text-secondary)]"
        >
          <span>{t('chatMessage.noVisibleAnswer')}</span>
          {onRetry ? (
            <button
              type="button"
              data-testid="assistant-empty-retry"
              title={t('chatMessage.retryHint')}
              onClick={onRetry}
              className="font-medium text-[var(--accent)] underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {t('common.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
      {message.content.trim() && (
        <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
          {canSaveMessage && (
            <MessageActionButton
              title={t('contextMenu.saveToMarkdown')}
              onClick={handleSaveMessage}
              disabled={saveState === 'saving'}
              tone={saveState === 'saved' ? 'accent' : saveState === 'error' ? 'danger' : 'default'}
            >
              {saveState === 'saving' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : saveState === 'saved' ? (
                <Check size={14} />
              ) : (
                <Save size={14} />
              )}
            </MessageActionButton>
          )}
          <MessageActionButton
            title={copied ? t('chatMessage.copied') : t('chatMessage.copyMessage')}
            onClick={handleCopy}
            tone={copied ? 'accent' : 'default'}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </MessageActionButton>
        </div>
      )}
    </>
  );
}

/** 流式那一段的身体（原 `StreamingMessage` 的身体）。 */
export interface AssistantStreamingBodyProps {
  content: string;
  thinkingContent?: string;
  toolCalls?: ToolCall[];
}

export function AssistantStreamingBody({ content, toolCalls }: AssistantStreamingBodyProps) {
  return (
    <>
      {/* ⚠️ 顺序要紧：**什么都没到**时才显示跳动点。
          发出之后到第一个字之前，这一块已经在页面上（头像+名字也在），
          于是这条消息从"发出"到"结束"始终是**同一个 DOM 节点** —— 头像不会闪。 */}
      {!content && !toolCalls?.length ? <ThinkingIndicator /> : null}
      {toolCalls?.length ? (
        <div className="mb-2">
          <ToolCallSummary toolCalls={toolCalls} />
        </div>
      ) : null}
      {content && (
        <div className="leading-relaxed text-[var(--text-primary)]">
          <MarkdownContent content={content} showCursor />
        </div>
      )}
    </>
  );
}

export type AssistantBlockProps = {
  identity: AssistantIdentity;
  onImageClick?: (src: string) => void;
  /** 跳到某条消息时的高亮：滚到屏幕中间，2 秒后自己褪掉。 */
  highlighted?: boolean;
  onHighlightDone?: () => void;
} & (
  | {
      /** 还在跑（含"什么都没到"的等待态）。 */
      state: 'streaming';
      content: string;
      thinkingContent?: string;
      toolCalls?: ToolCall[];
    }
  | {
      /** 定稿：正文已经落在这条正式消息上。 */
      state: 'finalized';
      message: Message;
      onRetry?: () => void;
    }
);

const AssistantBlock = memo(function AssistantBlock(props: AssistantBlockProps) {
  const { identity, onImageClick, highlighted, onHighlightDone } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlighted || !ref.current) return;
    ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timer = setTimeout(() => onHighlightDone?.(), 2000);
    return () => clearTimeout(timer);
  }, [highlighted, onHighlightDone]);

  return (
    <MessageBlock
      identity={identity}
      rootRef={ref}
      preset={props.state === 'finalized' ? motionPresets.messageEnter : motionPresets.fadeIn}
      className={cn(highlighted && 'animate-highlight rounded-lg')}
    >
      {props.state === 'finalized' ? (
        <AssistantFinalizedBody
          message={props.message}
          agentName={identity.agentName}
          onImageClick={onImageClick}
          onRetry={props.onRetry}
        />
      ) : (
        <AssistantStreamingBody
          content={props.content}
          thinkingContent={props.thinkingContent}
          toolCalls={props.toolCalls}
        />
      )}
    </MessageBlock>
  );
});

export default AssistantBlock;
