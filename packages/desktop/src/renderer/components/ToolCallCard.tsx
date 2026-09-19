import { memo, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronRight, Clock, Loader2, Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ToolCall } from '@clawwork/shared';
import { cn } from '@/lib/utils';
import { motion as motionPresets } from '@/styles/design-tokens';
import { getToolColor } from '@/lib/getToolFamily';
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

  const duration = useMemo(() => {
    if (!toolCall.completedAt) return null;
    const elapsed = new Date(toolCall.completedAt).getTime() - new Date(toolCall.startedAt).getTime();
    return `${(elapsed / 1000).toFixed(1)}s`;
  }, [toolCall.completedAt, toolCall.startedAt]);

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
              <span className="min-w-0 flex-1 truncate text-left">
                {label ? <span className="type-label text-[var(--text-secondary)]">{label} · </span> : null}
                {/*
                  ⭐ 优先显示网关拼好的 `title`（形如「memory_search 游戏 爆款 创作 内容」）——
                  这才是用户要的"做了什么操作"。只有工具名（`name`）时说明拿不到 item 流，退回原名。
                */}
                <span className="type-mono-data text-[var(--text-muted)]" title={toolCall.title}>
                  {toolCall.title ?? toolCall.name}
                </span>
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
              {duration && <span className="text-[var(--text-muted)]">{duration}</span>}
            </button>
          </CollapsibleTrigger>

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
