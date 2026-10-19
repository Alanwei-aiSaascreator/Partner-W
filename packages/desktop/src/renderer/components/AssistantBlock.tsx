import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Message, ToolCall } from '@clawwork/shared';
import type { ActiveTurnActivity } from '@clawwork/core';
import { Check, Copy, Loader2, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { motion as motionPresets } from '@/styles/design-tokens';
import { copyTextToClipboard } from '@/lib/clipboard';
import { selectCurrentArtifactsForMessage, useTaskArtifacts } from '@/hooks/useTaskArtifacts';
import { requestArtifactPreview } from '@/lib/artifact-preview-navigation';
import MessageBlock, { type AssistantIdentity } from './MessageBlock';
import { AttachmentFileCard, InlineImageBubble, MessageActionButton } from './MessageParts';
import ThinkingCollapse from './ThinkingCollapse';
import ThinkingIndicator from './ThinkingIndicator';
import TurnActivityRow from './TurnActivityRow';
import { useTurnActivity } from '@/hooks/useTurnActivity';
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
  /** ⭐ BUG-075（2026-10-13）：带 messageId 的稳定引用（见 `ChatMessage` 同名字段注释）。 */
  onRetry?: (messageId: string) => void;
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
  /*
    产物卡接**真源**（2026-10-08 · Task 8）：`message.artifacts` 在桌面链路上恒为空
    （messages 表无该列、构造处一律 `[]`）——真源是任务级 `fileStore + listArtifacts`
    （与右栏同源），再**先对完整任务归并、后按 messageId 分发**（跨消息同族只有 current 留在
    它所属的消息上；旧版本绝不伪装成当前版）。
  */
  const { artifacts: taskArtifacts, pending: artifactsPending } = useTaskArtifacts(message.taskId);
  const displayArtifacts = useMemo(
    () => selectCurrentArtifactsForMessage(taskArtifacts, message.id),
    [taskArtifacts, message.id],
  );
  const hasVisibleAnswer = Boolean(
    // `artifactsPending`（首水合未回）也按"可能有内容"处理 —— 水合/交付期间不得先闪出
    // 「无回答 → 重新尝试」（那个按钮的语义是"这一轮真的什么都没产出"）。
    artifactsPending ||
    message.content.trim() ||
    attachments?.length ||
    displayArtifacts.length ||
    message.toolCalls.length,
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
      {/*
        思考折叠（2026-10-08 对话可视化改造 · Task 3）：定稿态按 `done` 渲染——
        收起成一行「深度思考」、正文惰性（展开前不进 DOM；长 CoT 性能）。
        ⚠️ 它**不算** `hasVisibleAnswer`（思考不是最终回答，见下方判据）——
        "只有思考没有正文"仍然要给出可重试的失败态。
      */}
      <ThinkingCollapse text={(message.thinkingContent ?? '').trim()} phase="done" />
      {message.content.trim() ? (
        <div className="inline-block max-w-full type-chat-body rounded-2xl px-4 py-3 text-[var(--text-primary)]">
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
      {displayArtifacts.length > 0 ? (
        <div className="mt-2 grid max-w-2xl gap-2 sm:grid-cols-2">
          {displayArtifacts.map((artifact) => (
            <ArtifactCard
              key={artifact.id}
              artifact={artifact}
              assistantLabel={agentName}
              onPreview={requestArtifactPreview}
            />
          ))}
        </div>
      ) : null}
      {/* BUG-026：把**真实**重试通道传下去 —— 工具失败"无法继续"时才有「重新尝试」按钮
          （没有回调就不给假按钮，见 ToolCallSummary 的 props 注释）。 */}
      {message.toolCalls.length > 0 && (
        <ToolCallSummary
          toolCalls={message.toolCalls}
          settled
          onRetry={onRetry ? () => onRetry(message.id) : undefined}
        />
      )}
      {/*
        整轮用时（2026-10-18）：**本地量**（发出 → 定稿），落库后重开仍在。
        ⚠️ 不显示网关的单条消息时长（4 分 46 秒的一轮只报 0.4 秒）；老数据没有 ⇒ 整行不渲染。
      */}
      {typeof message.durationMs === 'number' && message.durationMs > 0 ? (
        <div
          data-testid="assistant-turn-duration"
          className="mt-1.5 type-meta tabular-nums text-[var(--text-muted)]"
        >
          {(() => {
            const totalSeconds = Math.max(1, Math.round(message.durationMs / 1000));
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            return minutes > 0
              ? t('chatMessage.turnDurationMinutesSeconds', { minutes, seconds })
              : t('chatMessage.turnDurationSeconds', { seconds });
          })()}
        </div>
      ) : null}
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
              onClick={() => onRetry?.(message.id)}
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
  /**
   * 有它时，"什么都没到"的等待期显示**富活动行**（`TurnActivityRow`：跳动条 +
   * "正在干什么" + 已等待时长），否则退回原来的裸跳动点。
   *
   * ⚠️ 只有**会话主时间线**（MainArea）传它 —— 那里 `item.sessionKey` 现成、
   *    且正是用户盯着看的那一格。遗留调用点不传即保持旧行为（默认参数，不改语义）。
   */
  activitySessionKey?: string;
  /**
   * 本轮最新活动元数据（core `ActiveTurn.activity`，事件入口留痕）。
   * 思考折叠的 live/done 由它决定 —— **不从 props 变化猜顺序**（见 `ThinkingCollapse` 注释）。
   * 缺失（旧路径/无来源）⇒ 静态降级为 `done`（不扫光、不自动展开）。
   */
  activity?: ActiveTurnActivity;
}

export function AssistantStreamingBody({
  content,
  thinkingContent,
  toolCalls,
  activitySessionKey,
  activity,
}: AssistantStreamingBodyProps) {
  const { awaitingApproval, awaitingAnswer } = useTurnActivity(activitySessionKey ?? null);
  const waitingForUser = awaitingApproval || awaitingAnswer;
  const thinkingText = (thinkingContent ?? '').trim();
  const thinkingPhase: 'live' | 'done' = activity?.kind === 'thinking' ? 'live' : 'done';
  return (
    <>
      {/* 思考折叠（Task 3）：有推理文本就渲染；`live` 时展开+扫光、`done` 时收起一行。 */}
      <ThinkingCollapse
        text={thinkingText}
        phase={thinkingPhase}
        segment={activity?.thinkingSegment ?? 0}
        paused={waitingForUser}
      />
      {/* ⚠️ 顺序要紧：**什么都没到**时才显示跳动点。
          发出之后到第一个字之前，这一块已经在页面上（头像+名字也在），
          于是这条消息从"发出"到"结束"始终是**同一个 DOM 节点** —— 头像不会闪。
          有推理文本时由思考折叠承担"在动"的表达，不再叠一个跳动点。 */}
      {waitingForUser || (!thinkingText && !content && !toolCalls?.length) ? (
        activitySessionKey ? (
          <TurnActivityRow sessionKey={activitySessionKey} showWhenAwaiting={waitingForUser} />
        ) : (
          <ThinkingIndicator />
        )
      ) : null}
      {toolCalls?.length ? (
        <div className="mb-2">
          <ToolCallSummary toolCalls={toolCalls} waitingForUser={waitingForUser} />
        </div>
      ) : null}
      {content && (
        <div className="type-chat-body text-[var(--text-primary)]">
          <MarkdownContent content={content} showCursor={!waitingForUser} />
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
      /** 见 `AssistantStreamingBodyProps.activitySessionKey`。 */
      activitySessionKey?: string;
      /** 见 `AssistantStreamingBodyProps.activity`（core 事件入口留痕的最新活动）。 */
      activity?: ActiveTurnActivity;
    }
  | {
      /** 定稿：正文已经落在这条正式消息上。 */
      state: 'finalized';
      message: Message;
      /** ⭐ BUG-075（2026-10-13）：带 messageId 的稳定引用（见 `ChatMessage` 同名字段注释）。 */
      onRetry?: (messageId: string) => void;
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
          activitySessionKey={props.activitySessionKey}
          activity={props.activity}
        />
      )}
    </MessageBlock>
  );
});

export default AssistantBlock;
