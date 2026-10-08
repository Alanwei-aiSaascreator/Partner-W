import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { ToolCall } from '@clawwork/shared';
import { Check, ChevronDown, ChevronRight, CircleAlert, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { motion as motionPresets } from '@/styles/design-tokens';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  aggregateRepeatedToolFailures,
  classifyToolActivity,
  classifyToolFailure,
  debugToolFailures,
  isOpaqueToolFailure,
  latestRunningCall,
  markUnreportedCalls,
  sanitizeToolTitle,
  summarizeToolActivity,
  visibleFailureReason,
  visibleUnreportedReason,
  type DisplayToolCall,
  type ToolActivityGroup,
  type ToolDisplayStatus,
} from '@/lib/tool-activity';
import ToolCallCard from './ToolCallCard';

function StatusIcon({ status }: { status: ToolDisplayStatus | 'warning' }) {
  if (status === 'running') return <Loader2 size={14} className="animate-spin text-[var(--accent)]" />;
  // BUG-026：任务最终成功、只是中间有失败 ⇒ 中性提醒色，不是红色警报（失败不是主视觉）。
  if (status === 'warning') return <CircleAlert size={14} className="text-[var(--text-warning)]" />;
  if (status === 'error') return <CircleAlert size={14} className="text-[var(--danger)]" />;
  // 第三态「未收到结果」（区1 体检 P1-1）：中性提醒色 —— 没收到结果不是失败，不许用红叉吓人。
  if (status === 'unreported') return <CircleAlert size={14} className="text-[var(--text-muted)]" />;
  return <Check size={14} className="text-[var(--accent)]" />;
}

interface ToolActivityGroupRowProps {
  group: ToolActivityGroup;
  /**
   * 开合态由**摘要**持有（区1 体检 P3-11）：摘要收起会把这一整棵子树卸载，
   * 组件自己的 `useState` 会跟着丢 —— 用户"收起再展开"就得重新一层层点开。
   * 单卡同理（`cardOpen`），两层都提升上来。
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cardOpen: Record<string, boolean>;
  onCardOpenChange: (id: string, open: boolean) => void;
}

function ToolActivityGroupRow({ group, open, onOpenChange, cardOpen, onCardOpenChange }: ToolActivityGroupRowProps) {
  const { t } = useTranslation();
  const label = t(`toolActivity.actions.${group.kind}`);
  /*
    BUG-026：详情里也**只摊一条**——同一工具 + 同一原因的重复失败合并展示
    （代表条目在外面，其余折叠进"重复失败 ×N"）。数据一条没丢：折叠项展开仍逐条可查。
  */
  const failureEntries = useMemo(
    () => (group.status === 'error' ? aggregateRepeatedToolFailures(group.calls) : null),
    [group],
  );
  const card = (call: DisplayToolCall) => (
    <ToolCallCard
      key={call.id}
      toolCall={call}
      label={label}
      open={cardOpen[call.id] ?? false}
      onOpenChange={(next) => onCardOpenChange(call.id, next)}
    />
  );

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
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
              {failureEntries
                ? failureEntries.map((entry) => (
                    <div key={entry.call.id}>
                      {card(entry.call)}
                      {entry.repeats.length > 0 ? (
                        <details data-testid="tool-failure-repeats">
                          <summary className="type-caption cursor-pointer px-3 py-1 text-[var(--text-muted)]">
                            {t('toolActivity.repeatedFailure', { count: entry.count })}
                          </summary>
                          {entry.repeats.map((repeat) => card(repeat))}
                        </details>
                      ) : null}
                    </div>
                  ))
                : group.calls.map((call) => card(call))}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ToolCallSummaryProps {
  toolCalls: ToolCall[];
  settled?: boolean;
  /**
   * 真实重试通道（`retryLastTurn`）。**有才给「重新尝试」按钮** ——
   * 点了没反应的按钮是假承诺（本仓对按钮的纪律见 ChatMessage 的 `retryable && onRetry`）。
   */
  onRetry?: () => void;
}

function ToolCallSummary({ toolCalls, settled = false, onRetry }: ToolCallSummaryProps) {
  const { t } = useTranslation();
  /*
    ⚠️ 已定稿的消息里还停在 running/awaitingApproval 的调用 ⇒ **第三态「未收到结果」**（区1 体检 P1-1）。
    这里原来把它硬写成 `error`（再配一句"没有返回结果"），结果是：用户中途取消/历史截断的一轮，
    重启后看到「这一步暂时无法完成」+「重新尝试」——**从未失败的一轮被写成失败并要求重试
    （重试 = 重发 = 计费）**。没收到结果 ≠ 失败，我们只是不知道结果。
    ⚠️ 这是**展示副本**：原始 `toolCalls` 一个字段不改（落库/日志仍以它为准）。
  */
  const shown = useMemo(
    () => markUnreportedCalls(toolCalls, settled, t('toolActivity.noResult')),
    [settled, t, toolCalls],
  );
  const [expanded, setExpanded] = useState(false);
  // BUG-026：「跳过这个失败」= 用户选择不再等这一步 ⇒ 失败降为次要位置（事实仍可展开查到）。
  const [acknowledged, setAcknowledged] = useState(false);
  // 组/单卡的开合态（P3-11）：收起摘要会卸载整棵子树，状态放在这里才不会丢。
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const [cardOpen, setCardOpen] = useState<Record<string, boolean>>({});
  const setGroupOpenFor = useCallback((key: string, open: boolean) => {
    setGroupOpen((prev) => (prev[key] === open ? prev : { ...prev, [key]: open }));
  }, []);
  const setCardOpenFor = useCallback((id: string, open: boolean) => {
    setCardOpen((prev) => (prev[id] === open ? prev : { ...prev, [id]: open }));
  }, []);
  const summary = useMemo(() => summarizeToolActivity(shown), [shown]);
  // BUG-026：同一工具 + 同一原始原因的重复失败聚合（首个为代表，其余折叠进详情）。
  const failures = useMemo(() => aggregateRepeatedToolFailures(shown), [shown]);
  // 开发日志（BUG-026 契约）：原始失败载荷（含 stack）完整进 console —— 用户面看不到，排查拿得到。
  // ⚠️ 传**原始** `toolCalls`，不是 `shown`（区1 体检 P3-10）：展示副本会给"未收到结果"补一句
  //    产品文案，拿副本去写日志就等于把伪造载荷当原文，"一个字段不删"当场失效。
  useEffect(() => {
    debugToolFailures(toolCalls);
  }, [toolCalls]);
  // ⚠️ 运行时安全样板（EXTERNAL_UNTRUSTED_CONTENT / SECURITY NOTICE）不进摘要行——2026-10-03
  // 真机事故；图12（2026-10-06）再进一步：整段产品化（剥样板/遮路径/常见原始错误映射中文）。
  const failureReason = visibleFailureReason(shown, t);
  // 第三态的原因行：有真实文本就摊原文（清洗后），没有才是"这一步没有返回结果"。
  const unreportedReason =
    summary.unreportedCount > 0 ? visibleUnreportedReason(shown) || t('toolActivity.noResult') : '';
  const doneCount = summary.completedCount - summary.errorCount;
  const hasFailures = summary.errorCount > 0;
  const hasUnreported = summary.unreportedCount > 0;
  /*
    BUG-026 三态 + 区1 第三态（判据都来自这一轮的真实数据，不猜）：
    - **弱化**（softened）：已结束且真有步骤成功过（中间失败非致命），或用户点过
      「跳过这个失败」⇒ 失败不占主视觉，降为次要位置（仍可展开查到，不隐藏事实）。
    - **无法继续**（stopped）：已结束且一步都没成功 ⇒ 失败就是这一轮的全部事实，
      保持主视觉，并给出「重新尝试 / 跳过这个失败」两个下一步。
    - **未收到结果**（unreported）：已结束、没有失败，但有调用没拿到结果 ⇒ 如实说一句，
      不给"无法继续"也不给重试（我们不知道它到底怎么了）。
    - 其余（还在跑）：维持原状 —— 不能提前弱化"可能还会重试"的失败。
  */
  const softened = hasFailures && (acknowledged || (settled && doneCount > 0));
  const stopped = hasFailures && settled && !softened;
  const status: ToolDisplayStatus | 'warning' = softened
    ? 'warning'
    : hasFailures
      ? 'error'
      : hasUnreported
        ? 'unreported'
        : !settled || summary.runningCount > 0
          ? 'running'
          : 'done';
  // ⚠️ 走**唯一出口**（与活动条同一个判据）：两处各写一遍的话，改一处就会两处不一致。
  const currentCall = latestRunningCall(shown);
  // ⭐ "正在做什么"优先用网关拼好的 `title`（带参数摘要），拿不到才退回按工具名分类的泛化文案
  //（泛化文案是"查看文件"这种，说不出具体在看哪个文件）。
  const currentAction = currentCall
    ? (sanitizeToolTitle(currentCall.title, currentCall.name) ??
      t(`toolActivity.actions.${classifyToolActivity(currentCall.name)}`))
    : null;
  const summaryText =
    summary.errorCount > 0
      ? t('chatMessage.toolCallSummaryWithErrors', {
          count: summary.totalCount,
          errorCount: summary.errorCount,
        })
      : hasUnreported
        ? t('toolActivity.unreported', { count: summary.unreportedCount })
        : !settled || summary.runningCount > 0
          ? t('toolActivity.running', { count: summary.completedCount })
          : t('toolActivity.completed', { count: summary.completedCount });
  const firstFailure = failures[0] ?? null;
  /*
    可降级继续（BUG-026）：失败形态认得出来（网络/限流/超时 = 在线资料暂时不可用）
    就说产品化文案；认不出来的**内核英文**同样给产品兜底句（`productizedToolFailure`，
    2026-10-08 口径反转：不再原样上屏）；只有**含中文**的认不出原因才摊原文。
  */
  const degradedNote =
    softened && firstFailure
      ? classifyToolFailure(firstFailure.call.result ?? '') === 'unknown'
        ? failureReason
        : t('toolActivity.failure.degradedContinue')
      : '';
  /*
    「无法继续」态下，下方动作行已经说了同一句「这一步暂时无法完成。」——
    主行不再重复它（一句话只说一次；pre6b 的"描述渲染两次"是同类教训）。
    判据用**语义**（这段原因是不是走了英文兜底），不比较 9 语言翻译串。
  */
  const opaqueFailureReason = firstFailure ? isOpaqueToolFailure(firstFailure.call.result ?? '') : false;
  const showFailureReason = Boolean(failureReason) && !(stopped && opaqueFailureReason);
  /*
    重复失败计数（区1 体检 P3-7）：原来只看 `firstFailure`（第一组）——它一旦成立，
    后面几组的重复就全部隐形，总数被报低。这里改成**所有重复组求和**：
    "重复失败 ×N" 说的是"N 次失败是重复发生的"（N 是真实次数，不是估算）。
  */
  const repeatCount = failures.reduce((sum, entry) => sum + (entry.count > 1 ? entry.count : 0), 0);
  const repeatCopy = repeatCount > 1 ? t('toolActivity.repeatedFailure', { count: repeatCount }) : '';

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
              {/* 弱化态：失败原因从主行移走（下移到次要位置），主视觉只剩"做完了，有几个失败可查"。 */}
              {!softened && (showFailureReason || repeatCopy) ? (
                <span
                  data-testid="tool-failure-reason"
                  className="type-support mt-0.5 block truncate text-[var(--danger)]"
                  title={showFailureReason ? failureReason : undefined}
                >
                  {showFailureReason ? failureReason : null}
                  {repeatCopy ? (
                    <span data-testid="tool-failure-repeat" className="ml-1 text-[var(--text-muted)]">
                      {repeatCopy}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {/*
                第三态的原因行：**中性色**（不是红字）—— 没收到结果不是失败，
                认出来是红的就等于又把它写成了失败。有真实文本就摊原文（P1-2）。
              */}
              {!softened && unreportedReason ? (
                <span
                  data-testid="tool-unreported-reason"
                  className="type-support mt-0.5 block truncate text-[var(--text-muted)]"
                  title={unreportedReason}
                >
                  {unreportedReason}
                </span>
              ) : null}
            </span>
            {currentAction ? (
              <span className="type-support max-w-44 truncate text-[var(--text-muted)]">{currentAction}</span>
            ) : null}
            {settled && summary.durationMs !== null ? (
              <span className="type-mono-data text-[var(--text-muted)]">
                {t('toolActivity.duration', {
                  seconds: summary.durationMs < 100 ? '<0.1' : (summary.durationMs / 1000).toFixed(1),
                })}
              </span>
            ) : null}
            <span className="type-support text-[var(--text-muted)]">{t('toolActivity.viewDetails')}</span>
          </button>
        </CollapsibleTrigger>
        {/* 原因句没了（例如走了英文兜底而被说明为"未收到/无原因"）时，重复计数仍要如实展示。 */}
        {softened && (degradedNote || repeatCopy) ? (
          <p data-testid="tool-failure-degraded" className="type-support px-3 pb-2.5 text-[var(--text-muted)]">
            {degradedNote}
            {repeatCopy ? (
              <span data-testid="tool-failure-repeat" className="ml-1">
                {repeatCopy}
              </span>
            ) : null}
          </p>
        ) : null}
        {stopped ? (
          <div data-testid="tool-failure-actions" className="flex flex-wrap items-center gap-2 px-3 pb-2.5">
            <p
              data-testid="tool-failure-cannot-continue"
              className="type-support min-w-0 flex-1 text-[var(--text-secondary)]"
            >
              {t('toolActivity.failure.cannotContinue')}
            </p>
            {onRetry ? (
              <button
                type="button"
                data-testid="tool-failure-retry"
                // 重试 = 重发上一条消息，跟正常发送一样计费 —— 必须说出来（与 ChatMessage 同口径）。
                title={t('chatMessage.retryHint')}
                onClick={onRetry}
                className="glow-focus type-label shrink-0 rounded-lg border border-[var(--accent)] px-2.5 py-1 text-[var(--accent)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                {t('toolActivity.failure.retryAction')}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="tool-failure-continue"
              onClick={() => setAcknowledged(true)}
              className="glow-focus type-label shrink-0 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              {t('toolActivity.failure.continueWithMaterials')}
            </button>
          </div>
        ) : null}
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
                  <ToolActivityGroupRow
                    key={group.key}
                    group={group}
                    // 失败组默认摊开（原来的行为）；开过/关过之后以用户的选择为准（P3-11）。
                    open={groupOpen[group.key] ?? group.status === 'error'}
                    onOpenChange={(next) => setGroupOpenFor(group.key, next)}
                    cardOpen={cardOpen}
                    onCardOpenChange={setCardOpenFor}
                  />
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
