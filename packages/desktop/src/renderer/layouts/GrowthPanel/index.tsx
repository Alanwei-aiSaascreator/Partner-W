import { useTranslation } from 'react-i18next';
import { Gift, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import EmptyState from '@/components/semantic/EmptyState';
import SectionCard from '@/components/semantic/SectionCard';
import { useGrowth } from './useGrowth';

/**
 * 成长中心。
 *
 * ⚠️ 成长值是**纯激励**，与计费那套「积分」（额度）没有任何通路 ——
 *    界面上必须一眼分得清，别写成"积分"（产品决定 2026-09-17）。
 */
export default function GrowthPanel() {
  const { t } = useTranslation();
  const { summary, history, loading, error, busy, checkIn } = useGrowth();
  const progress = ((200 - summary.toNextLevel) % 200) / 2;

  return (
    <div data-testid="growth-panel" className="flex h-full flex-col gap-4 overflow-hidden p-4">
      <SectionCard title={t('growth.title')} subtitle={t('growth.level', { level: summary.level })}>
        <p className="type-page-title text-[var(--text-primary)]" data-field="balance">
          {summary.balance}
        </p>
        <p className="type-support mt-1 text-[var(--text-muted)]">
          {t('growth.totalEarned', { value: summary.totalEarned })}
        </p>
        <div className="my-4 h-2 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
          <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${progress}%` }} />
        </div>
        <p className="type-body text-[var(--text-muted)]">{t('growth.toNext', { value: summary.toNextLevel })}</p>
        <Button
          className="mt-5"
          data-action="check-in"
          disabled={summary.checkedInToday || busy || loading}
          onClick={() => void checkIn()}
        >
          <Gift />
          {summary.checkedInToday ? t('growth.checkedIn') : t('growth.checkIn')}
        </Button>
      </SectionCard>

      <SectionCard title={t('growth.badges')}>
        {summary.badges.length === 0 ? (
          <p className="type-body text-[var(--text-muted)]">{t('growth.noBadges')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {summary.badges.map((badge) => (
              <span
                key={badge}
                data-badge={badge}
                className="type-badge inline-flex items-center gap-1 rounded bg-[var(--accent-soft)] px-2 py-1 text-[var(--accent)]"
              >
                <Sparkles className="size-4" />
                {t(`growth.badge_${badge}`)}
              </span>
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
                className="flex items-center justify-between border-b border-[var(--border-subtle)] py-2"
              >
                <span className="type-body text-[var(--text-primary)]">
                  {t(`growth.reason_${entry.reason}`, { defaultValue: entry.reason })}
                </span>
                <span
                  className={
                    entry.amount > 0
                      ? 'type-body font-semibold text-[var(--accent)]'
                      : 'type-body text-[var(--text-muted)]'
                  }
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
