import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RUN_PHASE_IDS } from '@clawwork/core';
import { useMessageStore } from '@/stores/messageStore';
import { cn } from '@/lib/utils';
import { formatElapsed, waitingLineSuffix } from '@/lib/waiting-copy';

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
 * 所以这条上有三样东西，每一样都在回答"它活着吗"：
 *   - **一直在走的秒数**（最有效的一件 —— 数字在变就证明没死）
 *   - **具体在干什么**（优先用网关 `item` 流拼好的那个人话标题，例如
 *     「memory_search 游戏 爆款 创作 内容」；拿不到才退回泛化文案）
 *   - **一句随秒数换的俏皮话**，越等越自嘲（见 `lib/waiting-copy.ts`）
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
  const toolCalls = useMessageStore((s) => (sessionKey ? s.activeTurnBySession[sessionKey]?.toolCalls : undefined));

  // 每秒重渲染一次，只为让秒数和轮播文案往前走。不在跑的时候连定时器都不挂。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!processing) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [processing]);

  if (!sessionKey || !processing) return null;

  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const calls = toolCalls ?? [];
  const runningCall = [...calls].reverse().find((call) => call.status === 'running');
  const doneCount = calls.filter((call) => call.status === 'done' || call.status === 'error').length;

  // 主行要说的是"此刻在干什么"，优先级：正在跑的工具 > 网关报的准备阶段 > 写回答。
  let headline: string;
  if (runningCall) {
    headline = t('chatInput.waiting.runningTool', { what: runningCall.title ?? runningCall.name });
  } else if (runPhase) {
    headline = t(`chatInput.runPhase.${RUN_PHASE_IDS.includes(runPhase) ? runPhase : 'unknown'}`);
  } else if (doneCount > 0) {
    headline = t('chatInput.waiting.writing', { count: doneCount });
  } else {
    headline = t('chatInput.waiting.working');
  }

  // 趣味文案：确定性轮播（同一个秒数永远给同一句），越久越自嘲。
  // ⚠️ 前缀必须**写在这个模板串里**：`scripts/lib/i18n-usage.mjs` 的扫描器
  //    只认字面 key 或「前缀 + ${变量}」，把 key 拼在辅助函数里它看不见，
  //    这些文案会被判成 unused 然后 check:i18n 失败（真踩过）。
  const quip = t(`chatInput.waiting.line.${waitingLineSuffix(elapsedMs)}`);
  const running = Boolean(runningCall);

  return (
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
  );
}
