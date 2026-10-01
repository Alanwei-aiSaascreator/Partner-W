import { memo, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronRight, Clock, Loader2, Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isSlidegenToolProgress, type ToolCall } from '@clawwork/shared';
import { cn } from '@/lib/utils';
import { motion as motionPresets } from '@/styles/design-tokens';
import { getToolColor } from '@/lib/getToolFamily';
import { toolCallDurationMs } from '@/lib/tool-activity';
import { formatElapsed } from '@/lib/waiting-copy';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';

function StatusIcon({ status }: { status: ToolCall['status'] }) {
  return (
    <AnimatePresence mode="wait">
      <motion.span key={status} {...motionPresets.crossfade} className="inline-flex">
        {status === 'running' && <Loader2 size={14} className="animate-spin text-[var(--accent)]" />}
        {/*
          ⭐ A2「等待批准」：**不转圈** —— 转圈说的"在动"，而这条恰恰是"没动，在等人"。
          用现成的 `Clock`（lucide 图标集里已有的，不是新造的视觉件）。
        */}
        {status === 'awaitingApproval' && <Clock size={14} className="text-[var(--text-muted)]" />}
        {status === 'done' && <Check size={14} className="text-[var(--accent)]" />}
        {status === 'error' && <X size={14} className="text-[var(--danger)]" />}
      </motion.span>
    </AnimatePresence>
  );
}

interface ToolCallCardProps {
  toolCall: ToolCall;
  defaultOpen?: boolean;
  label?: string;
}

const ToolCallCard = memo(function ToolCallCard({ toolCall, defaultOpen, label }: ToolCallCardProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen ?? false);
  const toolColor = getToolColor(toolCall.name);
  const [now, setNow] = useState(() => Date.now());
  const start = Date.parse(toolCall.startedAt);
  const waiting = toolCall.status === 'running' || toolCall.status === 'awaitingApproval';

  useEffect(() => {
    if (!waiting || !Number.isFinite(start)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting, start]);

  const waited = waiting && Number.isFinite(start) && now >= start ? now - start : null;

  const duration = useMemo(() => {
    if (toolCall.status === 'running' || toolCall.status === 'awaitingApproval') return null;
    const elapsed = toolCallDurationMs(toolCall);
    if (elapsed === null) return null;
    return elapsed < 100 ? '<0.1s' : `${(elapsed / 1000).toFixed(1)}s`;
  }, [toolCall]);

  /** 失败原因：**运行时给的原文**，空/纯空白一律当没有（不渲染空行，也不编一句话顶上）。 */
  const errorText = toolCall.status === 'error' ? toolCall.result?.trim() : '';
  const pageProgress = isSlidegenToolProgress(toolCall.slideProgress) ? toolCall.slideProgress : undefined;
  const pagePending = toolCall.status === 'running';
  const pageLabel = pageProgress
    ? t('chatInput.deliveryPageProgress', { completed: pageProgress.completed, total: pageProgress.total })
    : '';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        data-testid="tool-call-card"
        data-status={toolCall.status}
        className={cn(
          'my-1.5 rounded-lg overflow-hidden flex',
          'glass-card',
          toolCall.status === 'running' && 'glow-running tool-scan',
        )}
      >
        <div className="w-0.5 flex-shrink-0 rounded-l-lg" style={{ backgroundColor: toolColor }} />
        <div className="flex-1 min-w-0">
          <CollapsibleTrigger asChild>
            <button
              className={cn(
                'type-label flex w-full items-center gap-2 px-3 py-2.5',
                'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors',
                'glow-focus',
              )}
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <StatusIcon status={toolCall.status} />
              <span className="min-w-0 flex-1 text-left">
                <span className="flex min-w-0 items-center gap-2">
                  {label ? <span className="type-label text-[var(--text-secondary)]">{label} · </span> : null}
                  {/*
                    ⭐ 优先显示网关拼好的 `title`（形如「memory_search 游戏 爆款 创作 内容」）——
                    这才是用户要的"做了什么操作"。只有工具名（`name`）时说明拿不到 item 流，退回原名。
                  */}
                  <span className="type-mono-data truncate text-[var(--text-muted)]" title={toolCall.title}>
                    {toolCall.title ?? toolCall.name}
                  </span>
                </span>
                {/*
                  ⭐ 2026-09-24：失败时**把原因摊在行上**。同事的真机截图里，
                  这一行只有一个红叉 + 工具名 —— 用户唯一能得出的结论是"无法操作"。
                  而原因本来就在 `result` 里（运行时自己的原文：审批路径是 dispatcher 拼的
                  `explanation`，工具结果路径是 `extractToolResultText(...) ?? meta`）。
                  ⚠️ 这里**不翻译、不补话**：原文照登，行上截断、`title` 与展开区都能看全。
                     与 `gateway-error-message.ts` 的规矩一致 —— 认不出来的宁可给英文，
                     也不要给一句编出来的中文（那会把用户指错方向）。
                  ⚠️ 只有 `error` 才摊：成功的调用一闪就过，每行都拖一段正文等于把折叠废掉。
                */}
                {errorText ? (
                  <span
                    data-testid="tool-call-error"
                    className="type-support mt-0.5 block truncate text-[var(--danger)]"
                    title={errorText}
                  >
                    {errorText}
                  </span>
                ) : null}
              </span>
              {/*
                ⭐ A2：**说一句**「等待批准」—— 光换图标不够（用户得知道
                "没进展是因为在等人"、"该谁动"）。走 `t()`，不写死文案：
                写死的话这条 key 会变成 unused，`check:i18n` 直接红。
              */}
              {toolCall.status === 'awaitingApproval' && (
                <span className="type-label shrink-0 text-[var(--text-muted)]" data-testid="awaiting-approval-label">
                  {t('toolCall.awaitingApproval')}
                </span>
              )}
              {waited !== null ? (
                <span className="type-mono-data shrink-0 text-[var(--text-muted)]" data-testid="tool-call-waiting-time">
                  {t('toolActivity.waitingElapsed', { time: waited < 100 ? '<0.1s' : formatElapsed(waited) })}
                </span>
              ) : duration ? (
                <span className="text-[var(--text-muted)]">{duration}</span>
              ) : null}
            </button>
          </CollapsibleTrigger>

          {pageProgress && (
            <div
              className="px-3 pb-2.5 space-y-1"
              data-generation-state={pagePending ? 'pending' : 'settled'}
              aria-live={pagePending ? 'polite' : 'off'}
            >
              <p className="type-caption text-[var(--text-secondary)]">{pageLabel}</p>
              {pagePending && (
                <progress
                  value={pageProgress.completed}
                  max={pageProgress.total}
                  aria-label={pageLabel}
                  className="h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-[var(--bg-hover)] [&::-webkit-progress-value]:bg-[var(--accent)] [&::-moz-progress-bar]:bg-[var(--accent)]"
                />
              )}
            </div>
          )}
          <CollapsibleContent forceMount>
            <AnimatePresence>
              {open && (
                <motion.div
                  initial={motionPresets.slideUp.initial}
                  animate={motionPresets.slideUp.animate}
                  exit={motionPresets.slideUp.exit}
                  transition={motionPresets.slideUp.transition}
                  className="type-code-block px-3 pb-2.5"
                >
                  {toolCall.args && (
                    <div className="mb-1">
                      <p className="text-[var(--text-muted)] mb-0.5">{t('toolCall.args')}</p>
                      <pre
                        className={cn(
                          'whitespace-pre-wrap text-[var(--text-secondary)]',
                          'bg-[var(--bg-primary)] p-2 rounded overflow-x-auto',
                        )}
                      >
                        {JSON.stringify(toolCall.args, null, 2)}
                      </pre>
                    </div>
                  )}
                  {toolCall.result && (
                    <div>
                      <p className="text-[var(--text-muted)] mb-0.5">{t('toolCall.result')}</p>
                      <pre
                        className={cn(
                          'whitespace-pre-wrap text-[var(--text-secondary)]',
                          'bg-[var(--bg-primary)] p-2 rounded overflow-x-auto',
                          'max-h-40 overflow-y-auto',
                        )}
                      >
                        {toolCall.result}
                      </pre>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </CollapsibleContent>
        </div>
      </div>
    </Collapsible>
  );
});

export default ToolCallCard;
