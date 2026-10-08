import { Clock } from 'lucide-react';
import ActivityBars from './ActivityBars';
import { cn } from '@/lib/utils';
import { formatElapsed } from '@/lib/waiting-copy';
import { useTurnActivity } from '@/hooks/useTurnActivity';

/**
 * 会话内（正文流里）的**运行行** —— 回复就位的那一格在"什么都没到"时，
 * 把"它在干什么 + 等了多久"直接摆在用户眼前。
 *
 * ## 为什么要有它（2026-10-03）
 *
 * 用户（老板）原话：「对话模型回复期间可视化交互体验不好，完全可以照抄主流智能体」。
 * 主流（Claude Code / ChatGPT / OpenHands / Cline 等）都把活动指示放在**回复位**，
 * 而不是离视线很远的输入框上方；我们原来的回复位只有一个光秃秃的跳动点
 * （`ThinkingIndicator`），信息量最大的一条（正在调用什么工具/模型自述进度/已等待
 * 时长）全在输入框上方的 `ComposerActivity` 里。
 *
 * ## 纪律
 *
 * - 数据源与 `ComposerActivity` 是**同一个 hook**（`useTurnActivity`，唯一出口）：
 *   两处文案/计时口径永远一致，不许各写一份推导。
 * - 只摆事实：主行文案来自网关/主进程事件或本地等待计时；秒数**不是**后台心跳，
 *   也不承诺完成时间（见 `waiting-copy.ts` 头注释）。
 * - 取消按钮**不在这里**再放一个：等待期用户唯一要做的"停"仍由输入框上方那条
 *   （`ComposerActivity`，带 `onCancel`）提供，避免同一轮出现两个停止口。
 * - ⭐ 2026-10-08（P1-3）：**"等人"是两种**（等批准 / 等回答 `ask_user`），
 *   两种都是"不是我们在动，是在等你" ⇒ 跳动条与扫光全部停下、图标换成静态时钟，
 *   只由主行文案说清在等什么。**视觉静止 = 语义静止**，不靠用户去猜。
 *   样式在 `theme.css`（`.turn-activity-row*`），组件只挂类名。
 */
export default function TurnActivityRow({ sessionKey }: { sessionKey: string }) {
  const { active, elapsedMs, headline, awaitingApproval, awaitingAnswer } = useTurnActivity(sessionKey);
  if (!active) return null;
  // 两类"等人"共用同一套静止视觉（理由见头注释）；`awaiting-approval` 在 `data-status`
  // 里与 `awaiting-answer` 分开，是为了样式/断言能各自定位，不为了两种视觉。
  const awaiting = awaitingApproval || awaitingAnswer;
  return (
    <div
      data-testid="turn-activity-row"
      data-status={awaitingApproval ? 'awaiting-approval' : awaitingAnswer ? 'awaiting-answer' : 'running'}
      role="status"
      aria-live="polite"
      className="turn-activity-row"
    >
      {awaiting ? (
        <Clock size={14} className="shrink-0 text-[var(--text-muted)]" aria-hidden />
      ) : (
        <ActivityBars className="shrink-0" />
      )}
      <span
        data-testid="turn-activity-row-headline"
        className={cn(
          'turn-activity-row__headline type-label text-[var(--text-secondary)]',
          !awaiting && 'text-shimmer',
        )}
      >
        {headline}
      </span>
      <span data-testid="turn-activity-row-elapsed" className="type-mono-data shrink-0 text-[var(--text-muted)]">
        {formatElapsed(elapsedMs)}
      </span>
    </div>
  );
}
