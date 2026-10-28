import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { gatewayToken, mobileFetch } from '../lib/remote-api';

interface ModelUsage {
  provider?: string;
  model: string;
  calls: number;
  costMicros?: number;
  totalTokens?: number;
}

interface DashboardData {
  totalTasks: number;
  activeDays: number;
  totalMessages: number;
  totalArtifacts: number;
  breakdowns?: {
    agents?: Array<{ name: string; count: number; percent: number }>;
  };
  modelUsage?: ModelUsage[] | null;
}

function formatCredits(micros?: number): string {
  if (!micros || micros <= 0) return '0';
  return (micros / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      className="ui-card rounded-xl px-3 py-3"
    >
      <p className="type-support" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>
      <p className="type-title mt-1" style={{ color: 'var(--text-primary)' }}>
        {value}
      </p>
      {hint && (
        <p className="type-support mt-0.5" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * 我的 AI 使用概览（手机端）—— 对齐桌面端 Dashboard 的 usageSummary。
 *
 * 数据直接来自桌面端的 `collectDashboardData`（`/api/mobile/dashboard`），
 * 所以口径与电脑上完全一致：任务数/活跃天数来自本机 SQLite，模型消耗来自
 * 服务端计费表（`modelUsage`）。
 */
export function DashboardView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const token = await gatewayToken();
      if (!token) {
        setError(t('gateway.disconnected'));
        return;
      }
      try {
        const response = await mobileFetch('/api/mobile/dashboard', token);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setData((await response.json()) as DashboardData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'dashboard failed');
      }
    })();
  }, [t]);

  const models = data?.modelUsage ?? null;
  const totalCredits = (models ?? []).reduce((sum, row) => sum + (row.costMicros ?? 0), 0);
  const topAgent = data?.breakdowns?.agents?.[0];

  return (
    <div className="module-sheet fixed inset-0 z-[60] flex flex-col" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <header className="safe-area-top flex shrink-0 items-center gap-2 px-3 py-2">
        <button
          onClick={onClose}
          aria-label={t('files.close')}
          className="rounded-lg p-2"
          style={{ color: 'var(--text-secondary)', minHeight: 44, minWidth: 44 }}
        >
          <ArrowLeft size={20} />
        </button>
        <p className="type-label flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
          {t('modules.usage')}
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-3 pb-8">
        {!data && !error && (
          <div className="flex justify-center py-10">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        )}

        {error && (
          <p className="type-body my-3 rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}>
            {error}
          </p>
        )}

        {data && (
          <>
            <p className="type-section-title mb-2 mt-1" style={{ color: 'var(--text-secondary)' }}>
              {t('dashboard.cumulative')}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Tile label={t('dashboard.totalTasks')} value={data.totalTasks.toLocaleString()} hint={t('dashboard.local')} />
              <Tile label={t('dashboard.activeDays')} value={data.activeDays.toLocaleString()} hint={t('dashboard.local')} />
              <Tile label={t('dashboard.totalMessages')} value={data.totalMessages.toLocaleString()} hint={t('dashboard.local')} />
              <Tile label={t('dashboard.totalArtifacts')} value={data.totalArtifacts.toLocaleString()} hint={t('dashboard.local')} />
            </div>

            <p className="type-section-title mb-2 mt-4" style={{ color: 'var(--text-secondary)' }}>
              {t('dashboard.usageOverview')}
            </p>
            <div className="space-y-2">
              <div
                className="ui-card rounded-xl px-3 py-3"
              >
                <p className="type-support" style={{ color: 'var(--text-muted)' }}>
                  {t('dashboard.topAgent')}
                </p>
                <p className="type-body mt-1" style={{ color: 'var(--text-primary)' }}>
                  {topAgent ? `${topAgent.name} · ${topAgent.count}` : '—'}
                </p>
                {topAgent && (
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.min(100, Math.max(4, topAgent.percent))}%`, backgroundColor: 'var(--accent)' }}
                    />
                  </div>
                )}
              </div>

              <div
                className="ui-card rounded-xl px-3 py-3"
              >
                <p className="type-support" style={{ color: 'var(--text-muted)' }}>
                  {t('dashboard.modelCredits')}
                </p>
                <p className="type-title mt-1" style={{ color: 'var(--text-primary)' }}>
                  {formatCredits(totalCredits)} {t('dashboard.credits')}
                </p>
                <p className="type-support mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {models === null ? t('dashboard.noAccountData') : `${models.length} ${t('dashboard.models')}`}
                </p>
              </div>
            </div>

            <p className="type-section-title mb-2 mt-4" style={{ color: 'var(--text-secondary)' }}>
              {t('dashboard.modelUsage')}
            </p>
            {models === null && (
              <p className="type-support px-1" style={{ color: 'var(--text-muted)' }}>
                {t('dashboard.noAccountData')}
              </p>
            )}
            {(models ?? []).map((row) => (
              <div
                key={`${row.provider ?? ''}-${row.model}`}
                className="mt-2 flex items-start gap-3 rounded-xl px-3 py-3"
                style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
              >
                <div className="min-w-0 flex-1">
                  <p className="type-body truncate" style={{ color: 'var(--text-primary)' }}>
                    {row.model}
                  </p>
                  <p className="type-support" style={{ color: 'var(--text-muted)' }}>
                    {(row.provider ?? '').toUpperCase()}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="type-body" style={{ color: 'var(--text-primary)' }}>
                    {formatCredits(row.costMicros)} {t('dashboard.credits')}
                  </p>
                  <p className="type-support" style={{ color: 'var(--text-muted)' }}>
                    {row.calls} {t('dashboard.calls')}
                  </p>
                </div>
              </div>
            ))}
            {models !== null && models.length === 0 && (
              <p className="type-support px-1" style={{ color: 'var(--text-muted)' }}>
                {t('modules.empty')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
