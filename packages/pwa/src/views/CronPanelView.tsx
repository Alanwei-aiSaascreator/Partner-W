import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, Play, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getClient } from '../gateway/client-registry.js';
import { gatewayToken, mobileFetch } from '../lib/remote-api';
import { useUiStore } from '../stores/hooks';

interface CronJob {
  id: string;
  displayName?: string;
  name?: string;
  agentId?: string;
  enabled?: boolean;
  schedule?: { kind?: string; everyMs?: number; cron?: string; expr?: string; at?: string };
  sessionTarget?: string;
  payload?: { kind?: string; message?: string; text?: string };
  state?: { nextRunAtMs?: number; lastRunAtMs?: number; lastRunStatus?: string; lastError?: string };
  nextRunAtMs?: number;
}

function describeSchedule(schedule?: CronJob['schedule']): string {
  if (!schedule) return '';
  if (schedule.kind === 'every' && schedule.everyMs) {
    const minutes = Math.round(schedule.everyMs / 60000);
    if (minutes < 60) return `每 ${minutes} 分钟`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `每 ${hours} 小时`;
    return `每 ${Math.round(hours / 24)} 天`;
  }
  if (schedule.kind === 'cron') return `定时 ${schedule.cron ?? schedule.expr ?? ''}`;
  if (schedule.kind === 'at' && schedule.at) return `一次 ${schedule.at}`;
  return schedule.kind ?? '';
}

function relativeTime(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const diff = Date.now() - ms;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60000);
  const text =
    minutes < 60
      ? `${minutes} 分钟`
      : minutes < 1440
        ? `${Math.round(minutes / 60)} 小时`
        : `${Math.round(minutes / 1440)} 天`;
  return future ? `${text}后` : `${text}前`;
}

/**
 * 定时任务（手机端）—— 对齐桌面端 CronPanel：
 * 全部/已启用/已停用 三档筛选、搜索、开关、立即运行、删除。
 *
 * 列表读网关 `cron.list`；开关/运行/删除走桌面端 `/api/mobile/cron/action`
 * （同一份网关实现，手机和电脑操作的是同一批任务）。
 */
export function CronPanelView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const gatewayId = useUiStore((s) => s.defaultGatewayId ?? 'local-runtime');
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const client = getClient(gatewayId);
    if (!client?.isConnected) {
      setError(t('gateway.disconnected'));
      setJobs([]);
      return;
    }
    try {
      const payload = await client.sendReq('cron.list', {});
      setJobs(((payload.jobs ?? []) as CronJob[]).slice(0, 200));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'cron.list failed');
      setJobs([]);
    }
  }, [gatewayId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (job: CronJob, action: 'run' | 'remove' | 'toggle') => {
      const token = await gatewayToken();
      if (!token) return;
      setBusy(job.id);
      try {
        const response = await mobileFetch('/api/mobile/cron/action', token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: job.id, action, enabled: !(job.enabled !== false) }),
        });
        const data = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${response.status}`);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'action failed');
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const shown = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (jobs ?? []).filter((job) => {
      const enabled = job.enabled !== false;
      if (filter === 'enabled' && !enabled) return false;
      if (filter === 'disabled' && enabled) return false;
      if (!keyword) return true;
      return `${job.displayName ?? ''} ${job.name ?? ''} ${job.agentId ?? ''}`.toLowerCase().includes(keyword);
    });
  }, [jobs, filter, query]);

  const enabledCount = (jobs ?? []).filter((job) => job.enabled !== false).length;

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
        <div className="min-w-0 flex-1">
          <p className="type-label truncate" style={{ color: 'var(--text-primary)' }}>
            {t('modules.cron')}
          </p>
          <p className="type-support" style={{ color: 'var(--text-muted)' }}>
            {(jobs ?? []).length} 个任务 · 已启用 {enabledCount}
          </p>
        </div>
        <button
          onClick={() => void load()}
          aria-label={t('skills.refresh')}
          className="rounded-lg p-2"
          style={{ color: 'var(--text-secondary)', minHeight: 44, minWidth: 44 }}
        >
          <RefreshCw size={18} />
        </button>
      </header>

      <div className="shrink-0 px-3 pb-2">
        <div className="mb-2 flex gap-2">
          {(
            [
              ['all', '全部'],
              ['enabled', '已启用'],
              ['disabled', '已停用'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className="type-support rounded-full px-3 py-1"
              style={{
                backgroundColor: filter === key ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
                color: filter === key ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
          <Search size={16} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('files.search')}
            className="type-body w-full bg-transparent outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-8">
        {jobs === null && (
          <div className="flex justify-center py-10">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        )}

        {error && (
          <p className="type-body my-3 rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}>
            {error}
          </p>
        )}

        {shown.map((job) => {
          const enabled = job.enabled !== false;
          const next = job.state?.nextRunAtMs ?? job.nextRunAtMs;
          const last = job.state?.lastRunAtMs;
          return (
            <div
              key={job.id}
              className="mt-2 rounded-xl px-3 py-3"
              style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="flex items-start gap-2.5">
                <button
                  onClick={() => void act(job, 'toggle')}
                  disabled={busy === job.id}
                  aria-label={enabled ? '停用' : '启用'}
                  className="mt-0.5 flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors"
                  style={{ backgroundColor: enabled ? 'var(--accent)' : 'var(--bg-hover)' }}
                >
                  <span
                    className="h-5 w-5 rounded-full transition-transform"
                    style={{
                      backgroundColor: 'var(--bg-primary)',
                      transform: enabled ? 'translateX(20px)' : 'translateX(0)',
                    }}
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="type-body truncate" style={{ color: 'var(--text-primary)' }}>
                    {job.displayName || job.name || job.id}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span
                      className="type-support rounded px-1"
                      style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                    >
                      {describeSchedule(job.schedule)}
                    </span>
                    <span className="type-support" style={{ color: 'var(--text-muted)' }}>
                      {job.sessionTarget === 'isolated' ? '独立会话' : '主会话'}
                    </span>
                  </div>
                  {(job.payload?.message || job.payload?.text) && (
                    <p className="type-support mt-1 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                      {job.payload.message ?? job.payload.text}
                    </p>
                  )}
                  <p className="type-support mt-1" style={{ color: 'var(--text-muted)' }}>
                    {enabled ? (next ? `下次执行 ${relativeTime(next)}` : '未排期') : '已停用'}
                    {last ? ` · 上次 ${relativeTime(last)}` : ''}
                  </p>
                </div>
                <span
                  className="mt-1 h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: enabled ? 'var(--accent)' : 'var(--text-muted)' }}
                />
              </div>

              <div className="mt-2 flex gap-2 pl-1">
                <button
                  onClick={() => void act(job, 'run')}
                  disabled={busy === job.id}
                  className="type-support flex items-center gap-1 rounded-lg px-3 py-1.5"
                  style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                >
                  {busy === job.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  立即运行
                </button>
                <button
                  onClick={() => void act(job, 'remove')}
                  disabled={busy === job.id}
                  className="type-support flex items-center gap-1 rounded-lg px-3 py-1.5"
                  style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--danger)' }}
                >
                  <Trash2 size={12} />
                  删除
                </button>
              </div>
            </div>
          );
        })}

        {jobs !== null && shown.length === 0 && !error && (
          <p className="type-body py-10 text-center" style={{ color: 'var(--text-muted)' }}>
            {query ? '没有匹配的任务' : t('modules.empty')}
          </p>
        )}
      </div>
    </div>
  );
}
