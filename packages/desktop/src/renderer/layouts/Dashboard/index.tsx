import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { RefreshCw } from 'lucide-react';
import type { DashboardBreakdownEntry, DashboardModelUsage } from '@clawwork/shared';
import { PROVIDER_DISPLAY_NAMES } from '@clawwork/shared';
import { useDashboardStore } from '@/stores/dashboardStore';
import { useCommercialStore } from '@/stores/commercialStore';
import { formatCredits } from '@/lib/utils';
import { deriveQuotaDisplay } from '@/lib/quota-display';
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
}: {
  label: string;
  entries: DashboardBreakdownEntry[];
  emptyText: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
      <div className="type-label mb-4 text-[var(--text-secondary)]">{label}</div>
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
 * 模型消耗。这是全页**唯一**按「实际调用模型」统计的板块 ——
 * 数据来自服务端计费表（每次调用一行，model 是真正发到上游的那个名字）。
 *
 * 它回答的是「钱花在哪了」：用户从 qwen-plus 切到 kimi-k3，这里就分两行；
 * 网关自动回退时，出现的是**实际生效**的模型而不是界面上选的那个。
 *
 * ⚠️ 不要退回读本地 `tasks.model` —— 那是会话选中的模型，看不出切换也看不出回退。
 */
function ModelUsageRow({ entry }: { entry: DashboardModelUsage }) {
  const { t } = useTranslation();
  const providerName = PROVIDER_DISPLAY_NAMES[entry.provider] ?? entry.provider;

  return (
    <div className="border-t border-[var(--border-subtle)] py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="type-body truncate text-[var(--text-primary)]" title={`${entry.provider}/${entry.model}`}>
            {entry.model}
          </div>
          <div className="mt-1 type-meta text-[var(--text-muted)]">{providerName}</div>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className="type-label text-[var(--text-primary)]">
            {formatCredits(entry.costMicros)} {t('usage.creditsUnit')}
          </div>
          {/* ⚠️ 这里**只报积分**：token 数、官方参考价、倍率、人民币换算一律不给用户看
              （产品决定 2026-09-17）。真实字段在服务端账本与运营后台，不在用户界面。 */}
          <div className="mt-1 type-meta text-[var(--text-muted)]">
            {entry.calls} {t('dashboard.calls')}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelUsageTile({
  entries,
  emptyText,
  unavailableText,
}: {
  entries: DashboardModelUsage[] | null;
  emptyText: string;
  unavailableText: string;
}) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
      <div className="mb-5 type-support text-[var(--text-muted)]">{t('dashboard.actualModel')}</div>
      {entries === null ? (
        <div className="type-support text-[var(--text-muted)]">{unavailableText}</div>
      ) : entries.length === 0 ? (
        <div className="type-support text-[var(--text-muted)]">{emptyText}</div>
      ) : (
        <div>
          {entries.map((entry) => (
            <ModelUsageRow key={`${entry.provider} ${entry.model}`} entry={entry} />
          ))}
        </div>
      )}
      {entries && entries.length > 0 ? (
        <div className="mt-4 type-meta text-[var(--text-muted)]">{t('dashboard.ledger.settledNote')}</div>
      ) : null}
    </div>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  const data = useDashboardStore((s) => s.data);
  const loading = useDashboardStore((s) => s.loading);
  const fetchDashboard = useDashboardStore((s) => s.fetch);
  const commercialOverview = useCommercialStore((s) => s.overview);
  const loadCommercial = useCommercialStore((s) => s.load);
  const refreshCommercial = useCommercialStore((s) => s.refresh);

  useEffect(() => {
    void fetchDashboard();
    void loadCommercial();
  }, [fetchDashboard, loadCommercial]);

  const handleRefresh = useCallback(() => {
    void fetchDashboard(true);
    void refreshCommercial();
  }, [fetchDashboard, refreshCommercial]);

  const last30d = data?.last30d;
  const placeholder = '—';
  const agentEntries = (data?.breakdowns.agents ?? []).map((entry) => {
    const displayNameKey = resolveAgentDisplayNameKey(entry.name);
    return displayNameKey ? { ...entry, name: t(displayNameKey) } : entry;
  });
  const topAgent = agentEntries[0] ?? null;
  const license = commercialOverview?.license ?? null;
  const quotaMicros = license?.tokenQuotaMicros ?? null;
  const usedMicros = license?.tokenUsedMicros ?? null;
  const quotaDisplay = quotaMicros === null || usedMicros === null ? null : deriveQuotaDisplay(quotaMicros, usedMicros);
  const remainingMicros = quotaDisplay?.remaining ?? null;
  const remainingPercent = quotaDisplay?.remainingPercent ?? 0;

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

        <section>
          <SectionHeader text={t('dashboard.allTimeSection')} />
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
              label={t('dashboard.remainingCredits')}
              value={remainingMicros === null ? placeholder : formatCredits(remainingMicros)}
              hint={remainingMicros === null ? t('dashboard.unavailable') : t('dashboard.accountScope')}
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
          <SectionHeader text={t('dashboard.usageSummary')} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <BreakdownTile
              label={t('dashboard.topAgents')}
              entries={agentEntries}
              emptyText={data ? t('dashboard.noAssistantData') : t('dashboard.unavailable')}
            />
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
              <div className="type-label text-[var(--text-secondary)]">{t('dashboard.accountBalance')}</div>
              {quotaMicros === null || usedMicros === null ? (
                <div className="mt-4 type-support text-[var(--text-muted)]">{t('dashboard.unavailable')}</div>
              ) : (
                <div className="mt-4 space-y-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="type-support text-[var(--text-secondary)]">{t('dashboard.remainingCredits')}</span>
                    <span className="type-section-title text-[var(--text-primary)]">
                      {formatCredits(remainingMicros ?? 0)} {t('usage.creditsUnit')}
                    </span>
                  </div>
                  <div
                    className="h-2 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
                    role="progressbar"
                    aria-label={t('dashboard.remainingCredits')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(remainingPercent)}
                  >
                    <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${remainingPercent}%` }} />
                  </div>
                  <div className="flex items-center justify-between type-meta text-[var(--text-muted)]">
                    <span>
                      {t('usage.quotaUsed')} {formatCredits(usedMicros)}
                    </span>
                    <span>
                      {t('usage.quotaTotal')} {formatCredits(quotaMicros)}
                    </span>
                  </div>
                </div>
              )}
              <div className="mt-5 border-t border-[var(--border-subtle)] pt-4 type-support text-[var(--text-muted)]">
                {t('dashboard.totalMessages')} {data ? data.totalMessages.toLocaleString() : placeholder} ·{' '}
                {t('dashboard.totalArtifacts')} {data ? data.totalArtifacts.toLocaleString() : placeholder}
              </div>
            </div>
          </div>
        </section>

        <section>
          <SectionHeader text={t('dashboard.modelUsage')} scope={t('dashboard.accountScope')} />
          <ModelUsageTile
            entries={data?.modelUsage ?? null}
            emptyText={t('dashboard.modelUsageEmpty')}
            unavailableText={t('dashboard.modelUsageUnavailable')}
          />
        </section>

        <section>
          <SectionHeader text={t('dashboard.last30dSection')} scope={t('dashboard.accountScope')} />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            {/* ⚠️ 只给**积分**：token 明细（in/out/cached）属于运营口径，不摆给用户看
                （产品决定 2026-09-17）。真实字段在服务端账本与运营后台。 */}
            <Tile
              label={t('dashboard.credits')}
              value={last30d ? `${formatCredits(last30d.costMicros)} ${t('usage.creditsUnit')}` : placeholder}
            />
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
            <div className="type-label mb-4 text-[var(--text-secondary)]">{t('dashboard.creditsChart')}</div>
            {last30d && last30d.daily.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={last30d.daily}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
                  <YAxis
                    stroke="var(--text-muted)"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v: number) => formatCredits(v)}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--bg-primary)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      color: 'var(--text-primary)',
                    }}
                    formatter={(value) =>
                      typeof value === 'number'
                        ? `${formatCredits(value)} ${t('usage.creditsUnit')}`
                        : String(value ?? '')
                    }
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="costMicros"
                    stroke="var(--accent)"
                    name={t('dashboard.credits')}
                    dot={false}
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-40 items-center justify-center type-body text-[var(--text-muted)]">
                {t('dashboard.noData')}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
