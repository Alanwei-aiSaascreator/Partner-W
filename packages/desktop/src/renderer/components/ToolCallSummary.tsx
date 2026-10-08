import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { ToolCall } from '@clawwork/shared';
import { Check, ChevronDown, ChevronRight, CircleAlert, Clock, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { motion as motionPresets } from '@/styles/design-tokens';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  aggregateRepeatedToolFailures,
  classifyToolActivity,
  classifyToolFailure,
  debugToolFailures,
  latestAwaitingApproval,
  latestRunningCall,
  markUnreportedCalls,
  sanitizeToolTitle,
  summarizeToolActivity,
  visibleFailureReason,
  visibleUnreportedReason,
  type RepeatedToolFailure,
  type ToolDisplayStatus,
  namedToolFailureKind,
} from '@/lib/tool-activity';
import { resolveDisplayKind } from '@/lib/tool-display-kind';
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

interface ToolCallSummaryProps {
  toolCalls: ToolCall[];
  settled?: boolean;
  /**
   * 真实重试通道（`retryLastTurn`）。**有才给「重新尝试」按钮** ——
   * 点了没反应的按钮是假承诺（本仓对按钮的纪律见 ChatMessage 的 `retryable && onRetry`）。
   */
  onRetry?: () => void;
  waitingForUser?: boolean;
}

function ToolCallSummary({ toolCalls, settled = false, onRetry, waitingForUser = false }: ToolCallSummaryProps) {
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
  /*
    BUG-026：「跳过这个失败」= 用户选择不再等这一步 ⇒ 失败降为次要位置（事实仍可展开查到）。
    ⚠️ 2026-10-08 总审（R6）：确认**只对点下去那一刻的那批失败**有效 —— 新失败到来必须重新
    强制可见（旧确认不得遮住新失败）。所以这里记的是**失败集合指纹**，不是布尔：
    集合一变，下面推导出的 `acknowledged` 自动失效（派生值，不用 effect，避免"先渲染一帧旧确认"）。
  */
  const failureFingerprint = useMemo(
    () =>
      shown
        .filter((call) => call.status === 'error')
        .map((call) => `${call.id}:${call.status}`)
        .join('|'),
    [shown],
  );
  const [acknowledgedFingerprint, setAcknowledgedFingerprint] = useState<string | null>(null);
  const acknowledged = acknowledgedFingerprint !== null && acknowledgedFingerprint === failureFingerprint;
  /*
    单卡开合态（P3-11）：收起摘要会卸载整棵子树，状态放在这里才不会丢。
    （2026-10-08 平铺改造：组行消失，`groupOpen` 一并删除 —— 不再有二级分组折叠。）
  */
  const [cardOpen, setCardOpen] = useState<Record<string, boolean>>({});
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
  /*
    平铺列表（2026-10-08 对话可视化改造）：不再按 kind 分组、组行不再可折叠 ——
    工具行**按原始调用顺序**排。重复失败聚合保留（`aggregateRepeatedToolFailures` 语义不动）：
    代表条目占**首次出现的位置**，其余重复进代表行的 `<details data-testid="tool-failure-repeats">`。
  */
  const rows = useMemo(() => {
    const repeatedByCallId = new Map<string, RepeatedToolFailure>();
    const repeatIds = new Set<string>();
    for (const entry of failures) {
      repeatedByCallId.set(entry.call.id, entry);
      for (const repeat of entry.repeats) repeatIds.add(repeat.id);
    }
    return shown
      .filter((call) => !repeatIds.has(call.id))
      .map((call) => ({ call, repeated: repeatedByCallId.get(call.id) ?? null }));
  }, [failures, shown]);
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
  /*
    ⭐ 2026-10-08 对话可视化改造（Codex 复审 v2 定稿）——**运行期强制平铺**：
    旧形态三层（摘要收起 → 组行收起 → 卡收起），运行中要点三次才看得到"在做什么"。

    `forcedOpen = !settled || hasUnreported || (hasFailures && !acknowledged)`：
      - 未定稿（还在跑）/ 有「未收到结果」/ **有失败且用户没明确确认** ⇒ 强制可见；
      - ⚠️ 判据里**不得出现 `softened`/`doneCount`**：别的步骤成功**不能**清除未确认失败的可见性
        （复审反例：ls 成功 + render 失败、settled、未确认 —— softened=true 也不能折叠）。
        `softened/stopped` 仍只服务状态色与动作区，语义不动。
      - forcedOpen 时触发器**不再提供"收起"**：渲染为不可交互的表头行（附带的"查看详情"提示一并收掉，
        不然是假承诺）。
      - settled 且全成功（或用户已 acknowledged/跳过）⇒ 才允许默认折叠为**一层**（点展开 = 平铺全见）。
  */
  const forcedOpen = !settled || hasUnreported || (hasFailures && !acknowledged);
  const open = forcedOpen || expanded;
  // ⚠️ 走**唯一出口**（与活动条同一个判据）：两处各写一遍的话，改一处就会两处不一致。
  const currentCall = latestRunningCall(shown);
  // ⭐ 等待批准且**没有在跑**的动作（"没动，在等人"）—— 表头图标换静态 Clock（区1/A2 口径）。
  const awaitingOnly = waitingForUser || latestAwaitingApproval(shown) !== null;
  // ⭐ "正在做什么"优先用网关拼好的 `title`（带参数摘要），拿不到才退回按工具名分类的泛化文案
  //（泛化文案是"查看文件"这种，说不出具体在看哪个文件）；2026-10-08 起分类先走显示映射补位
  //（`read`/`process` 这类精确工具名不再落"使用工具"）。
  const currentAction = currentCall
    ? (sanitizeToolTitle(currentCall.title, currentCall.name) ??
      t(`toolActivity.actions.${resolveDisplayKind(currentCall.name, classifyToolActivity(currentCall.name))}`))
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
    ⚠️ 2026-10-08 总审（R5）第 4 条：**具名命中 ⇒ 显示具名句**（`failureReason`），不是
    "已跳过"的泛化句 —— 与 `ToolCallCard` 的错误块同一套判据（`namedToolFailureKind`），两处必须一致。
  */
  const firstFailureNamed = firstFailure ? namedToolFailureKind(firstFailure.call.result ?? '') !== null : false;
  const degradedNote =
    softened && firstFailure
      ? firstFailureNamed || classifyToolFailure(firstFailure.call.result ?? '') === 'unknown'
        ? failureReason
        : t('toolActivity.failure.degradedContinue')
      : '';
  /*
    「无法继续」态下，下方动作行已经说了同一句「这一步暂时无法完成。」——
    主行不再重复它（一句话只说一次；pre6b 的"描述渲染两次"是同类教训）。
    ⚠️ 2026-10-08 总审（R5）：判据从"是不是认不出的英文"（`isOpaqueToolFailure`，代理量）
    改为**这句原因就是动作区那句兜底句**（同一个 i18n key）——具名说明（缺参/工具不可用/本地传输）
    与已知家族（网络/限流/超时）都是**另一句话**，不该被兜底句连坐隐掉；
    card 的错误块一直显示这些句子，summary 隐掉它们就是"两处说明不一致"。
    比较的是同一个 key 的渲染结果（跨 9 语言成立），不是硬编码翻译串。
  */
  const opaqueFailureReason = failureReason === t('toolActivity.failure.cannotContinue');
  const showFailureReason = Boolean(failureReason) && !(stopped && opaqueFailureReason);
  /*
    R6（2026-10-08 总审）：**所有 settled 且未确认的失败**都要给「跳过这个失败」确认入口 ——
    原来这个入口只长在 stopped（一步都没成功）分支里，于是「成功 + 失败 + 已结束」被
    `forcedOpen` 永久展开却没有任何确认路径（用户收不起来）。
    重试按钮**沿用既有条件**（stopped && onRetry），不加不减。
  */
  const canAcknowledge = hasFailures && settled && !acknowledged;
  /*
    重复失败计数（区1 体检 P3-7）：原来只看 `firstFailure`（第一组）——它一旦成立，
    后面几组的重复就全部隐形，总数被报低。这里改成**所有重复组求和**：
    "重复失败 ×N" 说的是"N 次失败是重复发生的"（N 是真实次数，不是估算）。
  */
  const repeatCount = failures.reduce((sum, entry) => sum + (entry.count > 1 ? entry.count : 0), 0);
  const repeatCopy = repeatCount > 1 ? t('toolActivity.repeatedFailure', { count: repeatCount }) : '';

  const headerContent = (
    <>
      {/* 收起能力只在可交互态出现（forcedOpen 是表头行，没有"收起"这个动作）。 */}
      {!forcedOpen ? expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} /> : null}
      {awaitingOnly ? <Clock size={14} className="text-[var(--text-muted)]" /> : <StatusIcon status={status} />}
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
      {!forcedOpen ? (
        <span className="type-support text-[var(--text-muted)]">{t('toolActivity.viewDetails')}</span>
      ) : null}
    </>
  );

  return (
    <Collapsible open={open} onOpenChange={setExpanded}>
      {/* 2026-10-08：容器不再是卡片（去 `rounded-xl border bg-*`），只留外边距（样式在 theme.css）。 */}
      <div className="my-2">
        {forcedOpen ? (
          // 强制展开：不可交互的表头行（testid/data-status 保留 —— 样式与调试仍靠它）。
          <div data-testid="tool-activity-summary" data-status={status} className="tool-summary__trigger">
            {headerContent}
          </div>
        ) : (
          <CollapsibleTrigger asChild>
            <button
              type="button"
              data-testid="tool-activity-summary"
              data-status={status}
              className="tool-summary__trigger glow-focus"
            >
              {headerContent}
            </button>
          </CollapsibleTrigger>
        )}
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
        {/*
          R6：动作区按**确认入口**的存在与否渲染（`canAcknowledge` = settled 且未确认的失败）——
          「无法继续」提示与重试按钮仍只属于 stopped（一步都没成功）分支，条件不加不减。
        */}
        {canAcknowledge ? (
          <div data-testid="tool-failure-actions" className="flex flex-wrap items-center gap-2 px-3 pb-2.5">
            {stopped ? (
              <p
                data-testid="tool-failure-cannot-continue"
                className="type-support min-w-0 flex-1 text-[var(--text-secondary)]"
              >
                {t('toolActivity.failure.cannotContinue')}
              </p>
            ) : null}
            {stopped && onRetry ? (
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
              onClick={() => setAcknowledgedFingerprint(failureFingerprint)}
              className="glow-focus type-label shrink-0 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              {t('toolActivity.failure.continueWithMaterials')}
            </button>
          </div>
        ) : null}
        <CollapsibleContent forceMount>
          <AnimatePresence>
            {open ? (
              <motion.div
                initial={motionPresets.collapse.initial}
                animate={motionPresets.collapse.animate}
                exit={motionPresets.collapse.exit}
                transition={motionPresets.collapse.transition}
                className="overflow-hidden"
              >
                {/* 按原始调用顺序平铺（无分组行）；重复失败只在代表行下附一个可展开的 details。 */}
                {rows.map(({ call: current, repeated }) => (
                  <div key={current.id}>
                    <ToolCallCard
                      waitingForUser={awaitingOnly}
                      toolCall={current}
                      open={cardOpen[current.id] ?? false}
                      onOpenChange={(next) => setCardOpenFor(current.id, next)}
                    />
                    {repeated && repeated.repeats.length > 0 ? (
                      <details data-testid="tool-failure-repeats">
                        <summary className="type-caption cursor-pointer px-3 py-1 text-[var(--text-muted)]">
                          {t('toolActivity.repeatedFailure', { count: repeated.count })}
                        </summary>
                        {repeated.repeats.map((repeat) => (
                          <ToolCallCard
                            key={repeat.id}
                            waitingForUser={awaitingOnly}
                            toolCall={repeat}
                            open={cardOpen[repeat.id] ?? false}
                            onOpenChange={(next) => setCardOpenFor(repeat.id, next)}
                          />
                        ))}
                      </details>
                    ) : null}
                  </div>
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
