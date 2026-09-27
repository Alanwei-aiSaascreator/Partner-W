import { useTranslation } from 'react-i18next';
import { ArrowDownLeft, ArrowUpRight, Check, Circle, Flame, Gift, Lock, Sparkles } from 'lucide-react';
import { shanghaiDate } from '@clawwork/core';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import EmptyState from '@/components/semantic/EmptyState';
import SectionCard from '@/components/semantic/SectionCard';
import { cn } from '@/lib/utils';
import { useGrowth } from './useGrowth';

/**
 * 成长中心。
 *
 * ⚠️ 成长值是**纯激励**，与计费那套「积分」（额度）没有任何通路 ——
 *    界面上必须一眼分得清，别写成"积分"（产品决定 2026-09-17）。
 *
 * ## 2026-09-27：往"看得见进度"的方向丰富（**零新增文案**）
 *
 * 三处改动，每一处都只用**已有数据**，不新增后端、不新增 i18n 键：
 *
 * 1. **徽章墙**：原先只列**已点亮**的徽章，"一个都没点亮"时整块是一句灰话 ——
 *    用户根本不知道自己**还能拿什么**。现在三格全显示（点亮=彩色，未点亮=灰+锁），
 *    条件就写在徽章名里（"坚持一周" / "完成三个悬赏" / "累计 500 成长值"）。
 * 2. **等级进度**：进度条旁边补上 `已得 / 本级所需` 的数字，并加一层浅色底衬。
 * 3. **明细**：每条加方向图标（进账/出账），时间用 `HH:mm`（不引入任何文案）。
 */
export default function GrowthPanel() {
  const { t } = useTranslation();
  const { summary, history, myBounties, dailyTasks, streak, loading, error, busy, checkIn, claimTask } = useGrowth();

  /**
   * 每级所需成长值。
   *
   * ⚠️ **这是照抄服务端的**（迁移 46 的 `growth_summary`：`level = earned/200 + 1`）。
   *    服务端只回 `toNextLevel`，不回"本级已得" ⇒ 要显示分子就必须知道步长。
   *    改那边要同步改这里；`toNextLevel` 仍是**唯一的进度真值**（下面由它反推分子）。
   */
  const LEVEL_STEP = 200;
  /**
   * 成长中心里最多列几条悬赏。
   *
   * ⚠️ 这是**摘要**、不是列表 —— 完整列表在「广场 → 悬赏」那一屏（带六个动作）。
   *    这一块只回答"我的成长值从哪来、去哪了"；把全部悬赏铺进来会把下面的
   *    成长明细挤掉，两样都看不清。
   */
  const MAX_BOUNTIES_SHOWN = 5;
  const earnedInLevel = (LEVEL_STEP - summary.toNextLevel) % LEVEL_STEP;
  const progress = (earnedInLevel / LEVEL_STEP) * 100;
  /**
   * 今天做完了几件（**按"做过"算，不按"领过"**）。
   *
   * ⚠️ 进度条要回答的是"今天还剩多少事"，所以做完没领也算——那一件用户确实已经做了，
   *    把它算成未完成会让人以为还得再做一遍。领没领由每行自己的状态显示。
   */
  const dailyDoneCount = dailyTasks.filter((task) => task.done).length;
  /**
   * 今天的上海日期串。用来判断明细里哪些是"今天"的。
   *
   * ⚠️ 与连续签到、与**服务端** `growth_today()` 同一个时区 —— 三处必须一致，
   *    否则跨零点的那几笔会在"明细里算今天、签到里算昨天"。
   */
  const today = shanghaiDate();

  /**
   * 徽章**全集** —— 用来画"还没点亮"的格子。
   *
   * ⚠️ 服务端只回**已获得**的（`growth_summary` 里的 `v_badges`），而"墙"要显示未点亮的
   *    ⇒ 客户端必须知道全集。这份清单同样是照抄服务端的派生规则（迁移 46：
   *    `check_in >= 7` / `bounty >= 3` / `earned >= 500`）。
   *
   * ⭐ **但不会因此漏掉新徽章**：下面把"服务端回了、但不在这个清单里"的也一并渲染
   *    （渲染成已点亮）。⇒ 服务端将来加一个徽章，界面上**照样看得到**，
   *    只是它不会有"未点亮"那一格。少了这条兜底，新徽章会**静默消失**。
   */
  const KNOWN_BADGES = ['check_in_7', 'bounty_3', 'growth_500'] as const;
  const extraEarned = summary.badges.filter((badge) => !KNOWN_BADGES.includes(badge as never));
  const badgeWall = [...KNOWN_BADGES, ...extraEarned];

  return (
    <div data-testid="growth-panel" className="flex h-full flex-col gap-4 overflow-hidden p-4">
      <SectionCard title={t('growth.title')} subtitle={t('growth.level', { level: summary.level })}>
        <div className="flex items-baseline gap-2">
          <p className="type-page-title text-[var(--text-primary)]" data-field="balance">
            {summary.balance}
          </p>
          <span className="type-support text-[var(--text-muted)]">
            {t('growth.totalEarned', { value: summary.totalEarned })}
          </span>
        </div>

        <div className="mt-4">
          <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
              style={{ width: `${progress}%` }}
              data-field="level-progress"
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            {/* 光有进度条看不出"还差多少"，把分子分母也写出来 */}
            <span className="type-support tabular-nums text-[var(--text-muted)]">
              {earnedInLevel} / {LEVEL_STEP}
            </span>
            <span className="type-support text-[var(--text-muted)]">
              {t('growth.toNext', { value: summary.toNextLevel })}
            </span>
          </div>
        </div>

        <Button
          className="mt-5 w-full"
          data-action="check-in"
          disabled={summary.checkedInToday || busy || loading}
          onClick={() => void checkIn()}
        >
          <Gift />
          {summary.checkedInToday ? t('growth.checkedIn') : t('growth.checkIn')}
        </Button>

        {/**
         * 连续签到天数。
         *
         * ⚠️ **`streak < 2` 就不显示**：1 天和"今天签了"是同一件事，按钮上已经写着"今日已签到"；
         *    0 天更是没什么可说。这一行只在**真的形成连续**时才有信息量。
         * ⚠️ 取不到全量明细时 `streak` 恒为 0（见 `computeCheckInStreak`）⇒ 这一行自动消失，
         *    不会显示一个**算错的**天数。
         */}
        {streak >= 2 ? (
          <p className="mt-2.5 flex items-center gap-1.5" data-field="streak">
            <Flame className="size-3.5 text-[var(--accent)]" aria-hidden="true" />
            <span className="type-support text-[var(--text-muted)]">{t('growth.streak', { days: streak })}</span>
          </p>
        ) : null}
      </SectionCard>

      {/**
       * 每日任务（迁移 065）。
       *
       * ⭐ 三种状态**在界面上必须分得开** —— 这是整个特性的用户侧全部体验：
       *   · `todo`    没做过 ⇒ 灰点 + "未完成"，**不给按钮**
       *   · `ready`   做完了没领 ⇒ 高亮 + 「领取」
       *   · `claimed` 今天领过了 ⇒ 打勾 + "已领取"
       *
       * 🔴 `todo` **不画按钮**：点了后端会回 `task_not_done`（防白送那道闸），
       *    界面上表现成"点了没反应"。正确做法是根本不给点。
       *
       * ⭐ 一条任务都没有就**整块不出现**：不留空盒子，也就不必为此新加一句文案
       *    （服务端目录是空的、或这一路拿不到，表现都该是"今天没任务"）。
       */}
      {dailyTasks.length > 0 ? (
        // 副标题给出「今天做完了几件 / 一共几件」—— 纯数字，不需要任何新文案
        <SectionCard title={t('growth.dailyTasks')} subtitle={`${dailyDoneCount}/${dailyTasks.length}`}>
          <div data-field="daily-tasks" className="space-y-1.5">
            {dailyTasks.map((task) => {
              const state = task.claimed ? 'claimed' : task.done ? 'ready' : 'todo';
              return (
                <div
                  key={task.task}
                  data-task={task.task}
                  data-task-state={state}
                  className="flex items-center gap-2.5"
                >
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full',
                      state === 'ready'
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
                    )}
                    aria-hidden="true"
                  >
                    {state === 'claimed' ? <Check className="size-3.5" /> : <Circle className="size-3.5" />}
                  </span>
                  <span
                    className={cn(
                      'type-body min-w-0 flex-1 truncate',
                      state === 'ready' ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]',
                    )}
                  >
                    {t(`growth.task_${task.task}`, { defaultValue: task.task })}
                  </span>
                  <span className="type-support shrink-0 tabular-nums text-[var(--text-muted)]">+{task.reward}</span>
                  {state === 'ready' ? (
                    <Button
                      className="shrink-0"
                      data-action="claim-task"
                      data-task={task.task}
                      disabled={busy}
                      onClick={() => void claimTask(task.task)}
                    >
                      {t('growth.taskClaim')}
                    </Button>
                  ) : (
                    <span className="type-support w-14 shrink-0 text-right text-[var(--text-muted)]">
                      {state === 'claimed' ? t('growth.taskClaimed') : t('growth.taskTodo')}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title={t('growth.badges')} subtitle={t('growth.noBadges')}>
        <div className="flex flex-wrap gap-2">
          {badgeWall.map((badge) => {
            const earned = summary.badges.includes(badge);
            return (
              <span
                key={badge}
                data-badge={badge}
                data-earned={earned ? 'true' : 'false'}
                className={cn(
                  'type-badge inline-flex items-center gap-1 rounded px-2 py-1',
                  earned
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
                )}
              >
                {earned ? <Sparkles className="size-4" /> : <Lock className="size-4" />}
                {t(`growth.badge_${badge}`, { defaultValue: badge })}
              </span>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard title={t('bounty.tab')}>
        {myBounties.length === 0 ? (
          <p className="type-body text-[var(--text-muted)]">{t('bounty.empty')}</p>
        ) : (
          <div className="space-y-1.5">
            {myBounties.slice(0, MAX_BOUNTIES_SHOWN).map((bounty) => (
              <div key={bounty.id} data-bounty={bounty.id} className="flex items-center gap-3">
                <span className="type-body min-w-0 flex-1 truncate text-[var(--text-primary)]">{bounty.title}</span>
                {/* 复用现成的 `bounty.meta`（"奖励 {{reward}} 成长值 · {{status}}"）—— 这一轮不加新文案 */}
                <span className="type-support shrink-0 text-[var(--text-muted)]">
                  {t('bounty.meta', { reward: bounty.reward, status: t(`bounty.status_${bounty.status}`) })}
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title={t('growth.history')} className="min-h-0 flex-1" bodyClassName="h-full min-h-0">
        {error ? (
          <p className="type-body text-[var(--danger)]" data-field="error">
            {error}
          </p>
        ) : history.length === 0 ? (
          <EmptyState title={t('growth.emptyHistory')} />
        ) : (
          <ScrollArea className="h-full">
            {history.map((entry) => (
              <div
                key={entry.id}
                data-entry={entry.id}
                className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] py-2"
              >
                {/* 方向图标：一眼分得出进账还是出账（颜色之外再加一层） */}
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full',
                    entry.amount > 0
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
                  )}
                  aria-hidden="true"
                >
                  {entry.amount > 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownLeft className="size-3.5" />}
                </span>
                <span className="type-body min-w-0 flex-1 truncate text-[var(--text-primary)]">
                  {t(`growth.reason_${entry.reason}`, { defaultValue: entry.reason })}
                </span>
                <span className="type-support shrink-0 tabular-nums text-[var(--text-muted)]">
                  {formatWhen(entry.createdAt, today)}
                </span>
                <span
                  className={cn(
                    'type-body shrink-0 font-semibold tabular-nums',
                    entry.amount > 0 ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]',
                  )}
                >
                  {entry.amount > 0 ? `+${entry.amount}` : String(entry.amount)}
                </span>
              </div>
            ))}
          </ScrollArea>
        )}
      </SectionCard>
    </div>
  );
}

/**
 * 明细那一行的时间。
 *
 * ⭐ **今天的只写 `HH:mm`，更早的带上 `MM-DD`。**
 *    原先一律只写 `HH:mm` —— 同一份明细里跨越好几天时，那一列完全读不出"哪天"，
 *    一笔上周的扣款和今天的一笔长得一模一样。
 *
 * ⚠️ 用**数字**而不是"今天 / 昨天"：相对时间要新文案（×9 个语种），
 *    而这里刻意不加任何新文案。数字在所有语言里都读得懂。
 * ⚠️ 解析不出来就**空着**，不要显示 `Invalid Date`。
 */
function formatWhen(iso: string, today: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  // ⚠️ 与连续签到用**同一个时区**（Asia/Shanghai）—— 否则跨零点的那几笔会归错天。
  if (shanghaiDate(at) === today) return clock;
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
}
