import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ArtifactDeliveryActivity as DeliveryActivity } from '@clawwork/shared';
import { isArtifactDeliveryPageProgress } from '@clawwork/shared';
import { useDeliveryActivityStore } from '../stores/deliveryActivityStore';
import { useMessageStore } from '../stores/messageStore';
import { useTaskStore } from '../stores/taskStore';
import { formatElapsed } from '../lib/waiting-copy';

/**
 * 图13（2026-10-06）：纯聊天也会走 `reconciling-artifacts` 收尾阶段 ⇒ 产出
 * "检查文件 · 处理完成 · 0.0s" 这类**没有内容**的记录（真机验收现场当场被点名）。
 *
 * 展示规则：非成功终态一律可见（诚实——失败不许藏）；成功态必须"真有事发生"——
 * 除收尾阶段（reconciling-artifacts）外至少还有一个实质阶段；旧记录没有
 * observedPhases 时退回看 fallback phase。
 */
export function informativeDeliveryActivity(activity: DeliveryActivity): boolean {
  if (activity.status !== 'succeeded') return true;
  const phases = (activity.observedPhases ?? []).map((step) => step.phase);
  const substantive = phases.filter((phase) => phase !== 'reconciling-artifacts');
  if (substantive.length > 0) return true;
  return phases.length === 0 && activity.phase !== 'reconciling-artifacts';
}

function ObservedPhases({ activity }: { activity: DeliveryActivity }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 space-y-2">
      {activity.historyTruncated && (
        <p className="type-caption text-[var(--text-muted)]">{t('chatInput.deliveryHistory.truncated')}</p>
      )}
      <ol
        className="max-h-40 space-y-1.5 overflow-y-auto"
        tabIndex={0}
        aria-label={t('chatInput.deliveryHistory.details')}
      >
        {(activity.observedPhases ?? []).map((step) => (
          <li key={step.sequence} className="flex items-start justify-between gap-3">
            <span className="type-caption min-w-0 break-words text-[var(--text-secondary)]">
              {t(`chatInput.deliveryHistory.phaseTypes.${step.phase}`)}
            </span>
            <time
              dateTime={new Date(step.observedAt).toISOString()}
              className="type-mono-data shrink-0 text-[var(--text-muted)]"
            >
              {new Date(step.observedAt).toLocaleTimeString()}
            </time>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PageProgress({ activity }: { activity: DeliveryActivity }) {
  const { t } = useTranslation();
  if (activity.phase !== 'generating-presentation' || !isArtifactDeliveryPageProgress(activity.pageProgress))
    return null;
  const { completed, total } = activity.pageProgress;
  const label = t('chatInput.deliveryPageProgress', { completed, total });
  return (
    <div className="mt-2 space-y-1">
      <p className="type-caption text-[var(--text-secondary)]">{label}</p>
      <progress
        value={completed}
        max={total}
        aria-label={label}
        className="h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-[var(--bg-hover)] [&::-webkit-progress-value]:bg-[var(--accent)] [&::-moz-progress-bar]:bg-[var(--accent)]"
      />
    </div>
  );
}

export default function ArtifactDeliveryActivity({ sessionKey }: { sessionKey: string | null }) {
  const { t } = useTranslation();
  /**
   * 失败记录的「回到这条消息」（区1 体检 P3-12）—— 与文件面板/右侧栏的"跳转到源消息"
   * **同一个动作**（`setHighlightedMessage`：切回对话并高亮那一条），不是新造通道。
   */
  const jumpToMessage = useMessageStore((state) => state.setHighlightedMessage);
  const active = useDeliveryActivityStore((state) => state.active);
  const records = useDeliveryActivityStore((state) => state.records);
  const ownerEpoch = useDeliveryActivityStore((state) => state.workspaceEpoch);
  const epoch = useTaskStore((state) => state.workspaceEpoch);
  const taskId = useTaskStore((state) => state.activeTaskId);
  const currentWorkspace = ownerEpoch === epoch && useTaskStore.getState().workspaceEpoch === epoch;
  const activities = currentWorkspace
    ? active.filter((activity) => activity.taskId === taskId && activity.sessionKey === sessionKey)
    : [];
  const completed = currentWorkspace
    ? Object.values(records)
        .filter(
          (activity) =>
            activity.status !== 'active' &&
            activity.taskId === taskId &&
            activity.sessionKey === sessionKey &&
            informativeDeliveryActivity(activity),
        )
        .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
        .slice(0, 5)
    : [];
  const running = activities.length > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!sessionKey || (!running && completed.length === 0)) return null;
  return (
    <div className="mb-2 space-y-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2">
      {activities.map((activity) => (
        <div key={activity.operationId}>
          <div
            data-testid="artifact-delivery-activity"
            data-phase={activity.phase}
            className="flex items-center gap-2.5"
          >
            <Loader2 size={14} className="shrink-0 animate-spin text-[var(--accent)]" aria-hidden />
            <span className="type-label min-w-0 flex-1 truncate text-[var(--text-secondary)]" aria-live="polite">
              {t(`chatInput.deliveryActivity.${activity.phase}`)}
            </span>
            <span className="type-mono-data shrink-0 text-[var(--text-muted)]">
              {formatElapsed(Math.max(0, now - activity.startedAt))}
            </span>
          </div>
          <PageProgress activity={activity} />
          {Boolean(activity.observedPhases?.length) && (
            <details className="mt-1">
              <summary className="type-caption cursor-pointer text-[var(--text-muted)]">
                {t('chatInput.deliveryHistory.details')}
              </summary>
              <ObservedPhases activity={activity} />
            </details>
          )}
        </div>
      ))}
      {completed.length > 0 && (
        <section
          className="max-h-48 space-y-2 overflow-y-auto"
          tabIndex={0}
          aria-label={t('chatInput.deliveryHistory.recent')}
        >
          <p className="type-caption text-[var(--text-muted)]">{t('chatInput.deliveryHistory.recent')}</p>
          {completed.map((activity) => (
            <details key={activity.operationId} data-testid="artifact-delivery-history">
              <summary className="type-label cursor-pointer text-[var(--text-secondary)]">
                <span>
                  {/*
                    区1 体检 P3-12：摘要取**最后**观测到的阶段（原来固定取 `[0]`）——
                    失败记录原来显示"第一个阶段 · 失败"，真正的失败点藏在展开里；
                    成功记录同理，用户想看的是"最后做到哪一步"。
                    ⚠️ 仍然只认**实际观测到**的阶段（`observedPhases`），不看 `phase` 这个可能过期的字段。
                  */}
                  {t(
                    `chatInput.deliveryHistory.phaseTypes.${activity.observedPhases?.at(-1)?.phase ?? activity.phase}`,
                  )}
                  {' · '}
                  {t(`chatInput.deliveryHistory.${activity.status}`)}
                </span>
                {/* 图13（2026-10-06）：取消对用户展示耗时——"0.0s" 曾被当场当成"假流程"。
                    真实耗时语义保留在展开的阶段时间线里（observedAt）。 */}
              </summary>
              {/* 失败记录给一个真实入口（P3-12）：跳回那条消息，用户能在那里看到重试/下一步。 */}
              {activity.status === 'failed' ? (
                <button
                  type="button"
                  data-testid="artifact-delivery-jump"
                  onClick={() => jumpToMessage(activity.messageId)}
                  className="glow-focus type-caption mt-1 cursor-pointer rounded-md px-1 text-[var(--accent)] hover:underline"
                >
                  {t('chatInput.deliveryHistory.jumpToMessage')}
                </button>
              ) : null}
              <ObservedPhases activity={activity} />
            </details>
          ))}
        </section>
      )}
    </div>
  );
}
