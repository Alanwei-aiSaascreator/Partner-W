import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardBreakdownEntry, DashboardModelUsage } from '@clawwork/shared';
import { PROVIDER_DISPLAY_NAMES } from '@clawwork/shared';
import { useDashboardStore } from '@/stores/dashboardStore';
import { formatCredits, formatTokenCount } from '@/lib/utils';

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
      <div className="type-meta uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
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
      <div className="type-meta uppercase tracking-wider text-[var(--text-muted)] mb-4">{label}</div>
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
function ModelUsageTile({ entries, emptyText }: { entries: DashboardModelUsage[] | null; emptyText: string }) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
      <div className="type-meta uppercase tracking-wider text-[var(--text-muted)]">{t('dashboard.modelUsage')}</div>
      {/* 「实际调用模型」的副标题：这一行是**读数正确性**的说明，不是装饰 ——
          用户必须知道这里的行是按真正发出去的模型分的，而不是他选的那个。 */}
      <div className="mt-1 mb-4 type-meta text-[var(--text-muted)]">{t('dashboard.actualModel')}</div>
      {entries === null || entries.length === 0 ? (
        <div className="type-support text-[var(--text-muted)]">{emptyText}</div>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => {
            const providerName = PROVIDER_DISPLAY_NAMES[entry.provider] ?? entry.provider;
            return (
              <div key={`${entry.provider} ${entry.model}`}>
                <div className="flex items-baseline justify-between gap-2">
                  {/* 「实际调用模型」—— 括号里的 provider 是实际上游 */}
                  <span
                    className="type-body truncate text-[var(--text-primary)]"
                    title={`${entry.provider}/${entry.model}`}
                  >
                    {entry.model}
                  </span>
                  <span className="type-support flex-shrink-0 text-[var(--text-secondary)]">
                    {formatCredits(entry.costMicros)} {t('usage.creditsUnit')}
                  </span>
                </div>
                <div className="mt-0.5 flex items-baseline justify-between gap-2 type-meta text-[var(--text-muted)]">
                  <span>{providerName}</span>
                  <span>
                    {formatTokenCount(entry.totalTokens)} · {entry.calls} {t('dashboard.calls')}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  const data = useDashboardStore((s) => s.data);
  const fetchDashboard = useDashboardStore((s) => s.fetch);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const last30d = data?.last30d;
  const placeholder = '—';

  return (
    <div className="h-full w-full overflow-y-auto p-6 space-y-8">
      <section>
        <SectionHeader text={t('dashboard.allTimeSection')} scope={t('dashboard.accountScope')} />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Tile label={t('dashboard.totalTasks')} value={(data?.totalTasks ?? 0).toLocaleString()} />
          <Tile label={t('dashboard.activeDays')} value={(data?.activeDays ?? 0).toLocaleString()} />
          <Tile label={t('dashboard.totalMessages')} value={(data?.totalMessages ?? 0).toLocaleString()} />
          <Tile label={t('dashboard.totalArtifacts')} value={(data?.totalArtifacts ?? 0).toLocaleString()} />
        </div>
      </section>

      <section>
        <SectionHeader text={t('dashboard.modelUsage')} scope={t('dashboard.accountScope')} />
        <ModelUsageTile entries={data?.modelUsage ?? null} emptyText={t('dashboard.modelUsageEmpty')} />
      </section>

      <section>
        <SectionHeader text={t('dashboard.breakdownsSection')} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <BreakdownTile
            label={t('dashboard.topGateways')}
            entries={data?.breakdowns.gateways ?? []}
            emptyText={t('dashboard.noBreakdownData')}
          />
          <BreakdownTile
            label={t('dashboard.topAgents')}
            entries={data?.breakdowns.agents ?? []}
            emptyText={t('dashboard.noBreakdownData')}
          />
        </div>
      </section>

      <section>
        <SectionHeader text={t('dashboard.last30dSection')} scope={t('dashboard.accountScope')} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <Tile label={t('dashboard.inputTokens')} value={last30d ? formatTokenCount(last30d.input) : placeholder} />
          <Tile label={t('dashboard.outputTokens')} value={last30d ? formatTokenCount(last30d.output) : placeholder} />
          {/* 单位是积分（服务端计费），不再是本机网关估的美元 */}
          <Tile
            label={t('dashboard.credits')}
            value={last30d ? `${formatCredits(last30d.costMicros)} ${t('usage.creditsUnit')}` : placeholder}
          />
        </div>

        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
          <div className="type-meta uppercase tracking-wider text-[var(--text-muted)] mb-4">
            {t('dashboard.tokenChart')}
          </div>
          {last30d && last30d.daily.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={last30d.daily}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
                <YAxis
                  stroke="var(--text-muted)"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => formatTokenCount(v)}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    color: 'var(--text-primary)',
                  }}
                  formatter={(value) => (typeof value === 'number' ? formatTokenCount(value) : String(value ?? ''))}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="input"
                  stroke="var(--accent)"
                  name={t('dashboard.inputTokens')}
                  dot={false}
                  strokeWidth={2}
                />
                <Line
                  type="monotone"
                  dataKey="output"
                  stroke="var(--warning)"
                  name={t('dashboard.outputTokens')}
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
  );
}
