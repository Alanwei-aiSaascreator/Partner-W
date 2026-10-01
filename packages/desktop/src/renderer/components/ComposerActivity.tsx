import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RETRY_RUN_PHASE, RUN_PHASE_IDS } from '@clawwork/core';
import { useMessageStore } from '@/stores/messageStore';
import { cn } from '@/lib/utils';
import { formatElapsed, waitingLineSuffix } from '@/lib/waiting-copy';
import { classifyToolActivity, latestAwaitingApproval, latestRunningCall } from '@/lib/tool-activity';
import type { ToolCall } from '@clawwork/shared';
import ArtifactDeliveryActivity from './ArtifactDeliveryActivity';

/**
 * 输入框上方的**活动条** —— 一轮在跑的时候，把"它在干什么"和"等了多久"摆出来。
 *
 * ## 它解决的是哪个问题
 *
 * 用户原话：「卡住好久突然跳出来，用户体验感很差」。这句里其实有两件事：
 *   ① **正文不流式**（整轮结束才一次蹦出来）—— 那是上游 openclaw 的行为，
 *      我们改不了，见 `waiting-copy.ts` 头注释里指向的结论。
 *   ② **等待期界面上什么都没有** —— 这个我们能修，而且修的是体感的大头：
 *      用户骂"卡住"，多半是**看不出它还在动**。
 *
 * 活动条区分实际收到的状态与本地等待计时：
 *   - **已等待时长**（本地计时，不是后台心跳或存活证明）
 *   - **具体在干什么**（优先用网关 `item` 流拼好的那个人话标题，例如
 *     「memory_search 游戏 爆款 创作 内容」；拿不到才退回泛化文案）
 *   - **随时长轮换的中性等待提示**，不推断后台动作或完成时间
 *
 * ⚠️ 秒数的起算点来自 store 的 `turnStartedAtBySession`，**不是**本组件自己打点 ——
 *    组件会随路由/重挂载重建，自己打点的话用户会看到计时器莫名跳回 0。
 *
 * ⚠️ 取消按钮必须是**这一轮**的取消（`onCancel` 由调用方接到 `handleAbort`），
 *    等待期用户唯一想做的事就是取消，不能让他去别处找。
 */
interface ComposerActivityProps {
  /** 当前会话键；没有活动任务时为 null（此时整条不显示）。 */
  sessionKey: string | null;
  /** 取消当前这一轮。 */
  onCancel: () => void;
}

export default function ComposerActivity({ sessionKey, onCancel }: ComposerActivityProps) {
  const { t } = useTranslation();

  const processing = useMessageStore((s) => (sessionKey ? s.processingBySession.has(sessionKey) : false));
  const startedAt = useMessageStore((s) => (sessionKey ? s.turnStartedAtBySession[sessionKey] : undefined));
  const runPhase = useMessageStore((s) => (sessionKey ? s.runPhaseBySession[sessionKey] : null));
  // 重试到第几次了（只有 `run_status` 的 `phase:"retrying"` 才有）—— 见下面的文案分支。
  const retry = useMessageStore((s) => (sessionKey ? s.runRetryBySession[sessionKey] : undefined));
  // 模型**自述**的进度（网关 item 流的 preamble）—— 正文不流式时唯一在动的东西。
  const modelProgress = useMessageStore((s) => (sessionKey ? s.progressTextBySession[sessionKey] : null));
  const toolCalls = useMessageStore((s) => (sessionKey ? s.activeTurnBySession[sessionKey]?.toolCalls : undefined));
  // 正在压缩上下文（B8 Phase 2）—— 压缩会让界面**停住一会儿**，必须有东西说明"为什么不动"。
  const compacting = useMessageStore((s) => (sessionKey ? s.compactingBySession[sessionKey] === true : false));

  // 每秒重渲染一次，只为让秒数和轮播文案往前走。不在跑的时候连定时器都不挂。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!processing) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [processing]);

  if (!sessionKey || !processing) return <ArtifactDeliveryActivity sessionKey={sessionKey} />;

  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const calls = toolCalls ?? [];
  // ⚠️ 走**唯一出口**（`latestRunningCall`）：这个推导原先在本组件与 `ToolCallSummary`
  //    各写了一遍，一字不差 ⇒ 迟早只改一处。返回 null 就是"该收掉了"（跑完/失败/取消）。
  const runningCall = latestRunningCall(calls);
  // ⭐ A2：**在等人批准**的调用 —— 排在**最前面**。它正是"为什么没有进展"的答案，
  //    而且**该谁动**在用户那边（不是我们）。
  const awaitingCall = latestAwaitingApproval(calls);
  // 已结束调用包含成功与错误，不代表成功步骤数或整个任务的完成度。
  const endedCallCount = calls.filter((call) => call.status === 'done' || call.status === 'error').length;

  // 主行要说的是"此刻在干什么"，优先级：**等人批准的工具** > 正在跑的工具 >
  // 网关报的准备阶段 > 已结束工具调用计数 / 等待响应。
  let headline: string;
  const activityLabel = (call: ToolCall): string => {
    const title = call.title?.trim();
    if (title) return title;
    const kind = classifyToolActivity(call.name);
    return kind === 'other' ? call.name : t(`toolActivity.actions.${kind}`);
  };
  if (awaitingCall) {
    // ⚠️ **不复用 `runningTool`**："执行中：X" 说的是"在动"，而这条要说的是"没动，在等人"
    //    —— 复用就等于什么都没说（A2 的口径就是不让复用）。
    headline = t('chatInput.waiting.awaitingApproval', { what: activityLabel(awaitingCall) });
  } else if (runningCall) {
    headline = t('chatInput.waiting.runningTool', { what: activityLabel(runningCall) });
  } else if (compacting) {
    // ⭐ 压缩是**此刻系统在做的事**（与"正在跑的工具"同类：都是事实），而且它正是
    //    "界面为什么停住"的答案 ⇒ 排在模型**自述**的进度前面
    //    （那句是它上一轮说的话，压缩期间已经过期了）。
    headline = t('chatInput.compacting');
  } else if (modelProgress) {
    // 工具的 `title` 是网关拼好的**事实**（工具名 + 参数），比模型的话更硬 ⇒ 排在它后面。
    // 但它比 `runPhase` 具体得多（后者只是"正在调用模型"这一档），所以排在它前面。
    headline = t('chatInput.waiting.modelProgress', { what: modelProgress });
  } else if (runPhase === RETRY_RUN_PHASE && retry) {
    // ⭐ 重试相位要说得出"**第 2/4 次**" —— 比"正在重试…"有用得多：
    //    它同时回答了"在动吗"和"还要等几轮"。
    // ⚠️ **只有同时拿到两个数字**才走这条（畸形帧没有数字 ⇒ 落回下面的泛化文案，
    //    而不是显示一句"第 / 次"）。
    headline = t('chatInput.runPhase.retrying', { attempt: retry.attempt, maxAttempts: retry.maxAttempts });
  } else if (runPhase) {
    // ⚠️ `retrying` **必须排除在这条泛化路之外**：它有自己的分支（上面那条，要两个数字），
    //    走到这里就说明**没拿到数字**（畸形帧）。而 `runPhase.retrying` 那句里有
    //    `{{attempt}}/{{maxAttempts}}` —— 没数字时 i18next 会渲染出
    //    「正在重试（第 / 次）…」这种半截话，比泛化文案更糟。
    const generic = runPhase !== RETRY_RUN_PHASE && RUN_PHASE_IDS.includes(runPhase) ? runPhase : 'unknown';
    headline = t(`chatInput.runPhase.${generic}`);
  } else if (endedCallCount > 0) {
    headline = t('chatInput.waiting.writing', { count: endedCallCount });
  } else {
    headline = t('chatInput.waiting.working');
  }

  // 中性等待提示：按已等待时长确定性轮播，不作为后台心跳。
  // ⚠️ 前缀必须**写在这个模板串里**：`scripts/lib/i18n-usage.mjs` 的扫描器
  //    只认字面 key 或「前缀 + ${变量}」，把 key 拼在辅助函数里它看不见，
  //    这些文案会被判成 unused 然后 check:i18n 失败（真踩过）。
  const quip = t(`chatInput.waiting.line.${waitingLineSuffix(elapsedMs)}`);
  const running = Boolean(runningCall);

  return (
    <>
      <div
        data-testid="composer-activity"
        data-status={running ? 'running-tool' : 'working'}
        className="mb-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2"
      >
        <div className="flex items-center gap-2.5">
          <Loader2 size={14} className="shrink-0 animate-spin text-[var(--accent)]" aria-hidden />
          <span className="type-label min-w-0 flex-1 truncate text-[var(--text-secondary)]" aria-live="polite">
            {headline}
          </span>
          <span data-testid="composer-activity-elapsed" className="type-mono-data shrink-0 text-[var(--text-muted)]">
            {formatElapsed(elapsedMs)}
          </span>
          <button
            type="button"
            data-testid="composer-activity-cancel"
            onClick={onCancel}
            aria-label={t('chatInput.stopGenerating')}
            title={t('chatInput.stopGenerating')}
            className={cn(
              'glow-focus shrink-0 rounded-lg p-1 text-[var(--text-muted)]',
              'transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            <X size={14} />
          </button>
        </div>
        <p data-testid="composer-activity-quip" className="type-support mt-0.5 pl-6 text-[var(--text-muted)]">
          {quip}
        </p>
      </div>
      <ArtifactDeliveryActivity sessionKey={sessionKey} />
    </>
  );
}
