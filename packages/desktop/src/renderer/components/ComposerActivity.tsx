import { Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatElapsed } from '@/lib/waiting-copy';
import { useTurnActivity } from '@/hooks/useTurnActivity';
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
 *
 * ⚠️ 2026-10-03：全套推导（计时/主行/轮换文案）已抽到 `useTurnActivity` ——
 *    会话内的 `TurnActivityRow` 复用**同一份**（唯一出口）。别在这里加回内联版本，
 *    否则两处文案迟早漂成两句不同的话。
 */
interface ComposerActivityProps {
  /** 当前会话键（主会话）；没有活动任务时为 null（此时整条不显示）。 */
  sessionKey: string | null;
  /**
   * 整条任务的全部会话（主会话在前、performers 在后，见 `getTaskSessionKeys`）。
   *
   * ⚠️ 区1 体检 P2-6：多智能体任务里主会话往往只是"派活"，真正在跑的是 performer ——
   *    只盯主会话时整条不显示，而正文里的 `TurnActivityRow` 照样在动。
   * ⚠️ 取消（`onCancel` → `composer.abort(taskId)`）本来就是**整任务**的：房间里的
   *    每个会话都会被中止，所以这里盯 performer 时那个取消按钮仍然是真的。
   */
  sessionKeys?: readonly string[];
  /** 取消当前这一轮。 */
  onCancel: () => void;
}

export default function ComposerActivity({ sessionKey, sessionKeys, onCancel }: ComposerActivityProps) {
  const { t } = useTranslation();
  const { active, elapsedMs, headline, quip, running } = useTurnActivity(sessionKey, sessionKeys);

  if (!sessionKey || !active) return <ArtifactDeliveryActivity sessionKey={sessionKey} />;

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
