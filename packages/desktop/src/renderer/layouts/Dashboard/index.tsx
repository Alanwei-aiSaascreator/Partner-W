import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import type { DashboardBreakdownEntry } from '@clawwork/shared';
import { useDashboardStore } from '@/stores/dashboardStore';
import { Button } from '@/components/ui/button';
import { resolveAgentDisplayNameKey } from '@/lib/preset-agents';

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
      <div className="type-label text-[var(--text-secondary)]">{label}</div>
      <div className="mt-2 type-page-title text-[var(--text-primary)]">{value}</div>
      {hint ? <div className="mt-1 type-meta text-[var(--text-muted)]">{hint}</div> : null}
    </div>
  );
}

function SectionHeader({ text, scope }: { text: string; scope?: string }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <span className="type-section-title text-[var(--text-secondary)]">{text}</span>
      {scope ? (
        <span className="type-meta rounded border border-[var(--border-subtle)] px-1.5 py-0.5 text-[var(--text-muted)]">
          {scope}
        </span>
      ) : null}
    </div>
  );
}

function BreakdownTile({
  label,
  entries,
  emptyText,
  scope,
}: {
  label: string;
  entries: DashboardBreakdownEntry[];
  emptyText: string;
  /** 口径标记（"本机"）—— 与 `SectionHeader` 同一个样式。 */
  scope?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
      <div className="mb-4 flex items-baseline gap-2">
        <div className="type-label text-[var(--text-secondary)]">{label}</div>
        {scope ? (
          <span className="type-meta rounded border border-[var(--border-subtle)] px-1.5 py-0.5 text-[var(--text-muted)]">
            {scope}
          </span>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <div className="type-support text-[var(--text-muted)]">{emptyText}</div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div key={entry.name}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="type-body truncate text-[var(--text-primary)]">{entry.name}</span>
                <span className="type-support flex-shrink-0 text-[var(--text-muted)]">{entry.count}</span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-[var(--border)]">
                <div className="h-full bg-[var(--accent)]" style={{ width: `${entry.percent}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 工作台概览（私有化 / 开源版）：**只统计本机（这块盘）**。
 *
 * 商业版的「账号积分 / 余额 / 服务端计费 / 近 30 天积分曲线」整段移除 ——
 * 开源版没有商业账户，那些账号口径在这里永远是「不可用」，摆着就是商业痕迹。
 * 保留的是纯本地口径：任务数、活跃天数、消息/工件数、常用助手。
 */
export default function Dashboard() {
  const { t } = useTranslation();
  const data = useDashboardStore((s) => s.data);
  const loading = useDashboardStore((s) => s.loading);
  const error = useDashboardStore((s) => s.error);
  const fetchDashboard = useDashboardStore((s) => s.fetch);

  useEffect(() => {
    void fetchDashboard();
  }, [fetchDashboard]);

  const handleRefresh = useCallback(() => {
    void fetchDashboard(true);
  }, [fetchDashboard]);

  const placeholder = '—';
  const agentEntries = (data?.breakdowns.agents ?? []).map((entry) => {
    const displayNameKey = resolveAgentDisplayNameKey(entry.name);
    return displayNameKey ? { ...entry, name: t(displayNameKey) } : entry;
  });
  const topAgent = agentEntries[0] ?? null;

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl space-y-8 p-6 pb-10">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="type-page-title text-[var(--text-primary)]">{t('dashboard.title')}</h1>
            <p className="mt-1 max-w-2xl type-body text-[var(--text-muted)]">{t('dashboard.description')}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={loading}
            aria-label={t('dashboard.refresh')}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
            {t('dashboard.refresh')}
          </Button>
        </header>

        {error && (
          <p role="alert" className="type-support text-[var(--text-danger)]">
            {t('errors.requestFailed')}
          </p>
        )}

        <section>
          <SectionHeader text={t('dashboard.allTimeSection')} scope={t('dashboard.localScope')} />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Tile
              label={t('dashboard.totalTasks')}
              value={data ? data.totalTasks.toLocaleString() : placeholder}
              hint={t('dashboard.localScope')}
            />
            <Tile
              label={t('dashboard.activeDays')}
              value={data ? data.activeDays.toLocaleString() : placeholder}
              hint={t('dashboard.localScope')}
            />
            <Tile
              label={t('dashboard.totalMessages')}
              value={data ? data.totalMessages.toLocaleString() : placeholder}
              hint={t('dashboard.localScope')}
            />
            <Tile
              label={t('dashboard.favoriteAssistant')}
              value={topAgent?.name ?? placeholder}
              hint={
                topAgent
                  ? `${t('dashboard.taskCount', { count: topAgent.count })} · ${t('dashboard.localScope')}`
                  : data
                    ? t('dashboard.noAssistantData')
                    : t('dashboard.unavailable')
              }
            />
          </div>
        </section>

        <section>
          <SectionHeader text={t('dashboard.usageSummary')} scope={t('dashboard.localScope')} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <BreakdownTile
              label={t('dashboard.topAgents')}
              entries={agentEntries}
              emptyText={data ? t('dashboard.noAssistantData') : t('dashboard.unavailable')}
              scope={t('dashboard.localScope')}
            />
            <Tile
              label={t('dashboard.totalArtifacts')}
              value={data ? data.totalArtifacts.toLocaleString() : placeholder}
              hint={t('dashboard.localScope')}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
