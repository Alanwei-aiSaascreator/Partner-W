import { memo, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { Message } from '@clawwork/shared';
import { Check, Copy, FileCode, Loader2, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { motion as motionPresets } from '@/styles/design-tokens';
import { copyTextToClipboard } from '@/lib/clipboard';
import { ARTIFACT_FAILURE_MARKER } from '@/lib/artifact-delivery-feedback';
import { parseArtifactQualityNote } from '@/lib/artifact-quality-feedback';
import AssistantBlock from './AssistantBlock';
import { AttachmentFileCard, InlineImageBubble, MessageActionButton } from './MessageParts';
import MessageAvatar from './MessageAvatar';
import MarkdownContent from './MarkdownContent';
import ToolCallSummary from './ToolCallSummary';

interface ChatMessageProps {
  message: Message;
  agentName?: string;
  agentEmoji?: string;
  localAvatarUrl?: string;
  gatewayAvatarUrl?: string;
  agentRoleLabel?: string;
  /**
   * 这条回复**实际**由哪个模型生成（展示名，由调用方从 `message.model` + 目录解析）。
   * 没有就不传 —— 组件不会拿会话级模型/picker 补一个。
   */
  modelLabel?: string;
  highlighted?: boolean;
  onHighlightDone?: () => void;
  onImageClick?: (src: string) => void;
  onFileClick?: (file: { path: string; content: string }) => void;
  /**
   * 这条错误**重发能改变结果**（网关说 `rate_limit` / `timeout` 之类）。
   *
   * ⚠️ 由调用方从 store 的 `retryableErrorBySession` 取，**别拿正文猜** ——
   *    判据在网关给的结构化 `errorKind` 里，不在那串给人看的文案里。
   * ⚠️ 组件**同时**要求 `onRetry` 才渲染按钮：缺一个都不给，点了没反应的按钮比没有更糟。
   */
  retryable?: boolean;
  /** 点「重试」要做什么（重发上一条用户消息 —— 由调用方决定，组件不碰发送）。 */
  onRetry?: () => void;
}

function parseFileBlocks(content: string): {
  files: { path: string; content: string; lineCount: number }[];
  text: string;
} {
  const fileRegex = /<file path="([^"]+)">\n([\s\S]*?)\n<\/file>/g;
  const files: { path: string; content: string; lineCount: number }[] = [];
  let match;
  while ((match = fileRegex.exec(content)) !== null) {
    const fileContent = match[2];
    files.push({ path: match[1], content: fileContent, lineCount: fileContent.split('\n').length });
  }
  const text = content.replace(fileRegex, '').trim();
  return { files, text };
}

function FileBlockChip({
  file,
  onClick,
}: {
  file: { path: string; content: string; lineCount: number };
  onClick?: () => void;
}) {
  const fileName = file.path.split('/').pop() ?? file.path;

  return (
    <button
      onClick={onClick}
      className={cn(
        'type-support mb-1.5 mr-1.5 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5',
        'bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] transition-colors',
        'glow-focus',
      )}
    >
      <FileCode size={13} className="text-[var(--accent)] flex-shrink-0" />
      <span className="text-[var(--text-secondary)] font-medium truncate max-w-48">{fileName}</span>
      <span className="text-[var(--text-muted)] flex-shrink-0">{file.lineCount}L</span>
    </button>
  );
}

/**
 * 一条消息的渲染入口：**用户 / 系统**消息在这里，**助手**那一格交给 `AssistantBlock`。
 *
 * ⚠️ 助手分支**必须**走 `AssistantBlock`（而不是自己在外面再包一层壳）：
 *    同一个槽位还要渲染"等待中/流式"的助手块，两个组件类型换来换去 = 整块卸载重建 =
 *    头像被换节点（2026-09-20 实机报障「头像会消失一下」）。见 `AssistantBlock.tsx` 顶部注释。
 */
const ChatMessage = memo(function ChatMessage({
  message,
  agentName,
  agentEmoji,
  localAvatarUrl,
  gatewayAvatarUrl,
  agentRoleLabel,
  modelLabel,
  highlighted,
  onHighlightDone,
  onImageClick,
  onFileClick,
  retryable = false,
  onRetry,
}: ChatMessageProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const ref = useRef<HTMLDivElement>(null);
  const parsedFiles = isUser ? parseFileBlocks(message.content) : null;
  const [copied, setCopied] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    if (!highlighted || !ref.current) return;
    ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timer = setTimeout(() => onHighlightDone?.(), 2000);
    return () => clearTimeout(timer);
  }, [highlighted, onHighlightDone]);

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

  if (
    !isUser &&
    !isSystem &&
    !message.content &&
    !attachments?.length &&
    message.toolCalls.length === 0 &&
    !message.thinkingContent
  ) {
    return null;
  }

  if (isSystem) {
    const quality = parseArtifactQualityNote(message);
    if (quality) {
      return (
        <div className="py-3">
          <div
            role="status"
            className="type-support break-words rounded-xl border border-[var(--border-warning)] bg-[var(--bg-warning)] px-3 py-2 text-[var(--text-primary)]"
          >
            <p className="font-medium">{t('slidegen.warnedTitle')}</p>
            <p className="mt-1">{t('slidegen.warn.head')}</p>
            <ul className="mt-2 space-y-2">
              {quality.warnings.map((warning, index) => (
                <li key={index}>
                  {warning.artifactName && <p className="font-medium">{warning.artifactName}</p>}
                  <p>
                    {t(
                      {
                        'layout-text-occluded': 'slidegen.warn.occluded',
                        'layout-out-of-bounds': 'slidegen.warn.outOfBounds',
                        'layout-footer-overlap': 'slidegen.warn.footerOverlap',
                        'layout-text-low-contrast': 'slidegen.warn.lowContrast',
                      }[warning.code],
                      { page: warning.page },
                    )}
                  </p>
                  <p className="whitespace-pre-wrap">{`#${warning.element}: ${warning.detail}`}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    }
    if (message.content.startsWith(ARTIFACT_FAILURE_MARKER)) {
      return (
        <div className="py-3">
          <div
            role="alert"
            className="type-support whitespace-pre-wrap break-words rounded-xl border border-[var(--danger)] bg-[var(--danger-bg)] px-3 py-2 text-[var(--text-primary)]"
          >
            {message.content.slice(ARTIFACT_FAILURE_MARKER.length).trimStart()}
          </div>
        </div>
      );
    }
    // ⚠️ 两个条件**都**要满足才给按钮：`retryable` 是网关的判断（重发有没有意义），
    //    `onRetry` 是调用方能不能真的发出去。只满足一个就渲染，等于给一个点了没反应、
    //    或者点一下白花一次钱的按钮。
    const showRetry = retryable && Boolean(onRetry);
    return (
      <div className="flex justify-center py-3">
        <span className="type-support inline-flex items-center gap-2 rounded-full bg-[var(--bg-tertiary)] px-3 py-1 text-[var(--text-muted)]">
          {message.content}
          {showRetry ? (
            <button
              type="button"
              data-testid="chat-message-retry"
              // 重试 = 重新发一条消息，跟正常发送一样计费 —— 必须说出来
              title={t('chatMessage.retryHint')}
              className={cn(
                'type-support shrink-0 rounded-full px-2 py-0.5 font-medium',
                'text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors glow-focus',
              )}
              onClick={() => onRetry?.()}
            >
              {t('common.retry')}
            </button>
          ) : null}
        </span>
      </div>
    );
  }

  if (!isUser) {
    return (
      <AssistantBlock
        state="finalized"
        message={message}
        identity={{
          agentName,
          agentRoleLabel,
          modelLabel,
          modelTitle: message.model,
          agentEmoji,
          localAvatarUrl,
          gatewayAvatarUrl,
        }}
        highlighted={highlighted}
        onHighlightDone={onHighlightDone}
        onImageClick={onImageClick}
      />
    );
  }

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
    <motion.div
      ref={ref}
      initial={motionPresets.messageEnter.initial}
      animate={motionPresets.messageEnter.animate}
      transition={motionPresets.messageEnter.transition}
      className={cn(
        'group/message flex gap-3.5 py-4',
        'flex-row-reverse mt-5',
        highlighted && 'animate-highlight rounded-lg',
      )}
    >
      <MessageAvatar
        role="user"
        agentEmoji={agentEmoji}
        localAvatarUrl={localAvatarUrl}
        gatewayAvatarUrl={gatewayAvatarUrl}
      />

      <div className="min-w-0 flex-1 text-right">
        {parsedFiles && (parsedFiles.files.length > 0 || parsedFiles.text) ? (
          <div
            className={cn(
              'inline-block max-w-full text-left leading-relaxed rounded-2xl px-4 py-3',
              'bg-[var(--bg-tertiary)] text-[var(--text-primary)]',
            )}
          >
            <div className="flex flex-wrap">
              {parsedFiles.files.map((f, i) => (
                <FileBlockChip
                  key={`${f.path}-${i}`}
                  file={f}
                  onClick={() => onFileClick?.({ path: f.path, content: f.content })}
                />
              ))}
            </div>
            {parsedFiles.text && <p className="whitespace-pre-wrap">{parsedFiles.text}</p>}
          </div>
        ) : message.content || !attachments?.length ? (
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
          <div className="flex gap-2 mt-2 flex-wrap justify-end">
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
        {message.toolCalls.length > 0 && <ToolCallSummary toolCalls={message.toolCalls} settled />}
        {message.content.trim() && (
          <div className="mt-1.5 flex justify-end gap-1 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
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
      </div>
    </motion.div>
  );
});

export default ChatMessage;
