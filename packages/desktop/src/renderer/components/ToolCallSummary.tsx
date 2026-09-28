import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { ToolCall } from '@clawwork/shared';
import { Check, ChevronDown, ChevronRight, CircleAlert, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { motion as motionPresets } from '@/styles/design-tokens';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  classifyToolActivity,
  latestRunningCall,
  summarizeToolActivity,
  type ToolActivityGroup,
} from '@/lib/tool-activity';
import ToolCallCard from './ToolCallCard';

function StatusIcon({ status }: { status: ToolCall['status'] }) {
  if (status === 'running') return <Loader2 size={14} className="animate-spin text-[var(--accent)]" />;
  if (status === 'error') return <CircleAlert size={14} className="text-[var(--danger)]" />;
  return <Check size={14} className="text-[var(--accent)]" />;
}

function ToolActivityGroupRow({ group }: { group: ToolActivityGroup }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(group.status === 'error');
  const label = t(`toolActivity.actions.${group.kind}`);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-testid={`tool-activity-group-${group.kind}-${group.status}`}
          data-status={group.status}
          className="glow-focus flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <StatusIcon status={group.status} />
          <span className="type-label flex-1 text-left">{label}</span>
          <span className="type-mono-data text-[var(--text-muted)]">
            {t('toolActivity.groupCount', { count: group.calls.length })}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <AnimatePresence>
          {open ? (
            <motion.div
              initial={motionPresets.collapse.initial}
              animate={motionPresets.collapse.animate}
              exit={motionPresets.collapse.exit}
              transition={motionPresets.collapse.transition}
              className="ml-4 overflow-hidden border-l border-[var(--border-subtle)] pl-2"
            >
              {group.calls.map((call) => (
                <ToolCallCard key={call.id} toolCall={call} label={label} />
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolCallSummary({ toolCalls, settled = false }: { toolCalls: ToolCall[]; settled?: boolean }) {
  const { t } = useTranslation();
  const shown = useMemo(() => {
    if (!settled) return toolCalls;
    return toolCalls.map((call) => {
      if (call.status !== 'running' && call.status !== 'awaitingApproval') return call;
      return { ...call, status: 'error' as const, result: call.result?.trim() || t('toolActivity.noResult') };
    });
  }, [settled, t, toolCalls]);
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => summarizeToolActivity(shown), [shown]);
  const failureReason = shown.find((call) => call.status === 'error' && call.result?.trim())?.result?.trim() ?? '';
  const status: ToolCall['status'] = summary.errorCount > 0 ? 'error' : summary.runningCount > 0 ? 'running' : 'done';
  // ⚠️ 走**唯一出口**（与活动条同一个判据）：两处各写一遍的话，改一处就会两处不一致。
  const currentCall = latestRunningCall(shown);
  // ⭐ "正在做什么"优先用网关拼好的 `title`（带参数摘要），拿不到才退回按工具名分类的泛化文案
  //（泛化文案是"查看文件"这种，说不出具体在看哪个文件）。
  const currentAction = currentCall
    ? (currentCall.title ?? t(`toolActivity.actions.${classifyToolActivity(currentCall.name)}`))
    : null;
  const summaryText =
    summary.errorCount > 0
      ? t('chatMessage.toolCallSummaryWithErrors', {
          count: summary.totalCount,
          errorCount: summary.errorCount,
        })
      : summary.runningCount > 0
        ? t('toolActivity.running', { count: summary.completedCount })
        : t('toolActivity.completed', { count: summary.completedCount });

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div
        className={cn(
          'my-2 overflow-hidden rounded-xl border bg-[var(--bg-secondary)]',
          status === 'error' ? 'border-[var(--danger)]' : 'border-[var(--border-subtle)]',
        )}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-testid="tool-activity-summary"
            data-status={status}
            className="glow-focus flex w-full items-center gap-2.5 px-3 py-2.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <StatusIcon status={status} />
            <span className="type-label flex-1 text-left">
              {summaryText}
              {failureReason ? (
                <span
                  data-testid="tool-failure-reason"
                  className="type-support mt-0.5 block truncate text-[var(--danger)]"
                  title={failureReason}
                >
                  {failureReason}
                </span>
              ) : null}
            </span>
            {currentAction ? (
              <span className="type-support max-w-44 truncate text-[var(--text-muted)]">{currentAction}</span>
            ) : null}
            {summary.durationMs !== null ? (
              <span className="type-mono-data text-[var(--text-muted)]">
                {t('toolActivity.duration', { seconds: (summary.durationMs / 1000).toFixed(1) })}
              </span>
            ) : null}
            <span className="type-support text-[var(--text-muted)]">{t('toolActivity.viewDetails')}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent forceMount>
          <AnimatePresence>
            {expanded ? (
              <motion.div
                initial={motionPresets.collapse.initial}
                animate={motionPresets.collapse.animate}
                exit={motionPresets.collapse.exit}
                transition={motionPresets.collapse.transition}
                className="overflow-hidden border-t border-[var(--border-subtle)] p-1.5"
              >
                {summary.groups.map((group) => (
                  <ToolActivityGroupRow key={group.key} group={group} />
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export default ToolCallSummary;
