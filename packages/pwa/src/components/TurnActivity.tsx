import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ActiveTurn } from '@clawwork/core';
import { composer } from '../stores';

/** 5 根跳动的竖条（与桌面端 ActivityBars 同形态）。 */
function ActivityBars() {
  return (
    <div className="flex shrink-0 items-end gap-0.5" style={{ height: 16 }} aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className="activity-bar"
          style={{ animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface TurnActivityProps {
  turn: ActiveTurn | undefined;
  processing: boolean;
  taskId: string;
}

/**
 * 输入框上方的活动条（对齐桌面端 `ComposerActivity`）。
 *
 * 解决的是「发完消息以后界面一动不动、只有一个小点」的体感问题：
 * 把「它在干什么」（调用模型 / 深度思考 / 执行某个工具）和「等了多久」摆出来，
 * 并且就地给取消入口。
 */
export function TurnActivity({ turn, processing, taskId }: TurnActivityProps) {
  const { t } = useTranslation();
  const [elapsedMs, setElapsedMs] = useState(0);

  const active = Boolean(turn) || processing;

  useEffect(() => {
    if (!active) {
      setElapsedMs(0);
      return;
    }
    const startedAt = turn?.timestamp ? Date.parse(turn.timestamp) : Date.now();
    const tick = () => setElapsedMs(Date.now() - (Number.isFinite(startedAt) ? startedAt : Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active, turn?.timestamp]);

  if (!active) return null;

  const runningTool = turn?.toolCalls.find((call) => call.status === 'running');
  const headline = runningTool
    ? t('chat.activityTool', { name: runningTool.name })
    : turn?.streamingThinking
      ? t('chat.activityThinking')
      : t('chat.activityModel');

  return (
    <div
      data-testid="turn-activity"
      className="mx-3 mb-1 flex items-center gap-2.5 rounded-xl px-3 py-2"
      style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
    >
      <ActivityBars />
      <span
        className="type-label min-w-0 flex-1 truncate"
        style={{ color: 'var(--text-secondary)' }}
        aria-live="polite"
      >
        {headline}
      </span>
      <span className="type-support shrink-0 tabular-nums" style={{ color: 'var(--text-muted)' }}>
        {formatElapsed(elapsedMs)}
      </span>
      <button
        type="button"
        onClick={() => void composer.abort(taskId).catch(() => undefined)}
        aria-label={t('chat.abortButton')}
        className="shrink-0 rounded-lg p-1"
        style={{ color: 'var(--text-muted)' }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
