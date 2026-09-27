import { useTranslation } from 'react-i18next';
import { ArrowDownLeft, ArrowUpRight, Gift, Lock, Sparkles } from 'lucide-react';
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
  const { summary, history, loading, error, busy, checkIn } = useGrowth();

  /**
   * 每级所需成长值。
   *
   * ⚠️ **这是照抄服务端的**（迁移 46 的 `growth_summary`：`level = earned/200 + 1`）。
   *    服务端只回 `toNextLevel`，不回"本级已得" ⇒ 要显示分子就必须知道步长。
   *    改那边要同步改这里；`toNextLevel` 仍是**唯一的进度真值**（下面由它反推分子）。
   */
  const LEVEL_STEP = 200;
  const earnedInLevel = (LEVEL_STEP - summary.toNextLevel) % LEVEL_STEP;
  const progress = (earnedInLevel / LEVEL_STEP) * 100;

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
      </SectionCard>

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
                  {formatClock(entry.createdAt)}
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
 * 明细那一行的时间（`HH:mm`）。
 *
 * ⚠️ 用**数字**而不是"今天 / 昨天"：相对时间要新文案（×9 个语种），
 *    而这一轮刻意不加任何新文案。数字在所有语言里都读得懂。
 * ⚠️ 解析不出来就**空着**，不要显示 `Invalid Date`。
 */
function formatClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
