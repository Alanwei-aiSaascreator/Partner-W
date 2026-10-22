import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Clock, FolderArchive, Loader2, Sun, Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getClient } from '../gateway/client-registry.js';
import { THEME_STORAGE_KEY } from '../lib/constants.js';
import { useUiStore } from '../stores/hooks';

function useGatewayId(): string {
  return useUiStore((s) => s.defaultGatewayId ?? 'local-runtime');
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
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
          {title}
        </p>
      </header>
      <div className="flex-1 overflow-y-auto px-3 pb-8">{children}</div>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex justify-center py-10">
      <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p className="type-body my-3 rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}>
      {message}
    </p>
  );
}

function Row({ icon, title, subtitle, trailing }: { icon?: ReactNode; title: string; subtitle?: string; trailing?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-1 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      {icon}
      <div className="min-w-0 flex-1">
        <p className="type-body truncate" style={{ color: 'var(--text-primary)' }}>
          {title}
        </p>
        {subtitle && (
          <p className="type-support truncate" style={{ color: 'var(--text-muted)' }}>
            {subtitle}
          </p>
        )}
      </div>
      {trailing}
    </div>
  );
}

function formatEvery(ms?: number): string {
  if (!ms || ms <= 0) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `每 ${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return `每 ${hours} 小时`;
}

function formatWhen(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface CronJobRow {
  id: string;
  displayName?: string;
  name?: string;
  agentId?: string;
  enabled?: boolean;
  schedule?: { kind?: string; everyMs?: number; cron?: string; expr?: string };
  state?: { lastRunStatus?: string; nextRunAtMs?: number; lastRunAtMs?: number };
  nextRunAtMs?: number;
}

/** 定时任务：直接读网关 `cron.list`（桌面端 CronPanel 同一份数据）。 */
export function CronView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const gatewayId = useGatewayId();
  const [jobs, setJobs] = useState<CronJobRow[] | null>(null);
  const [summary, setSummary] = useState<{ enabled?: boolean; jobs?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const client = getClient(gatewayId);
      if (!client?.isConnected) {
        setError(t('gateway.disconnected'));
        setJobs([]);
        return;
      }
      try {
        const [list, status] = await Promise.all([
          client.sendReq('cron.list', {}),
          client.sendReq('cron.status', {}).catch(() => ({})),
        ]);
        setJobs(((list.jobs ?? []) as CronJobRow[]).slice(0, 100));
        setSummary(status as { enabled?: boolean; jobs?: number });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'cron.list failed');
        setJobs([]);
      }
    })();
  }, [gatewayId, t]);

  return (
    <Shell title={t('modules.cron')} onClose={onClose}>
      {jobs === null && <Loading />}
      {error && <ErrorLine message={error} />}
      {summary && (
        <p className="type-support px-1 py-2" style={{ color: 'var(--text-muted)' }}>
          {summary.enabled ? t('modules.cronEnabled') : t('modules.cronDisabled')} · {summary.jobs ?? 0} {t('modules.cronJobs')}
        </p>
      )}
      {(jobs ?? []).map((job) => {
        const every = formatEvery(job.schedule?.everyMs);
        const cron = job.schedule?.cron ?? job.schedule?.expr ?? '';
        const scheduleText = every || (cron ? `cron: ${cron}` : (job.schedule?.kind ?? ''));
        const status = job.state?.lastRunStatus ?? '';
        return (
          <Row
            key={job.id}
            icon={<Clock size={16} className="mt-1 shrink-0" style={{ color: job.enabled ? 'var(--accent)' : 'var(--text-muted)' }} />}
            title={job.displayName || job.name || job.id}
            subtitle={`${scheduleText}${job.agentId ? ` · ${job.agentId}` : ''}${status ? ` · ${status}` : ''}`}
            trailing={
              <span className="type-support shrink-0" style={{ color: 'var(--text-muted)' }}>
                {formatWhen(job.state?.nextRunAtMs ?? job.nextRunAtMs)}
              </span>
            }
          />
        );
      })}
      {jobs !== null && jobs.length === 0 && !error && (
        <p className="type-body py-8 text-center" style={{ color: 'var(--text-muted)' }}>
          {t('modules.empty')}
        </p>
      )}
    </Shell>
  );
}

interface SessionRow {
  key: string;
  label?: string;
  displayName?: string;
  agentId?: string;
  updatedAt?: number;
  archived?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
}

function useSessions(gatewayId: string) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const client = getClient(gatewayId);
      if (!client?.isConnected) {
        setError('gateway not connected');
        setRows([]);
        return;
      }
      try {
        const payload = await client.sendReq('sessions.list', {});
        setRows(((payload.sessions ?? []) as SessionRow[]).slice(0, 200));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'sessions.list failed');
        setRows([]);
      }
    })();
  }, [gatewayId]);

  return { rows, error };
}

/** 归档对话：网关 `sessions.list` 里 archived 的那些。 */
export function ArchiveView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const gatewayId = useGatewayId();
  const { rows, error } = useSessions(gatewayId);

  const archived = (rows ?? []).filter((row) => row.archived === true);
  const shown = archived.length > 0 ? archived : (rows ?? []).slice(0, 40);

  return (
    <Shell title={t('modules.archive')} onClose={onClose}>
      {rows === null && <Loading />}
      {error && <ErrorLine message={error} />}
      {archived.length === 0 && rows !== null && !error && (
        <p className="type-support px-1 py-2" style={{ color: 'var(--text-muted)' }}>
          {t('modules.archiveHint')}
        </p>
      )}
      {shown.map((row) => (
        <Row
          key={row.key}
          icon={<FolderArchive size={16} className="mt-1 shrink-0" style={{ color: 'var(--text-muted)' }} />}
          title={row.displayName || row.label || row.key}
          subtitle={`${row.agentId ?? ''} · ${formatWhen(row.updatedAt)}`}
        />
      ))}
      {rows !== null && shown.length === 0 && !error && (
        <p className="type-body py-8 text-center" style={{ color: 'var(--text-muted)' }}>
          {t('modules.empty')}
        </p>
      )}
    </Shell>
  );
}

/** 我的 AI 使用概览：按 agent 汇总 sessions.list 里的 token。 */
export function UsageView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const gatewayId = useGatewayId();
  const { rows, error } = useSessions(gatewayId);

  const byAgent = new Map<string, { input: number; output: number; context: number; sessions: number }>();
  for (const row of rows ?? []) {
    const agent = row.agentId || 'main';
    const entry = byAgent.get(agent) ?? { input: 0, output: 0, context: 0, sessions: 0 };
    entry.input += row.inputTokens ?? 0;
    entry.output += row.outputTokens ?? 0;
    entry.context += row.contextTokens ?? 0;
    entry.sessions += 1;
    byAgent.set(agent, entry);
  }

  const totalInput = [...byAgent.values()].reduce((sum, v) => sum + v.input, 0);
  const totalOutput = [...byAgent.values()].reduce((sum, v) => sum + v.output, 0);

  return (
    <Shell title={t('modules.usage')} onClose={onClose}>
      {rows === null && <Loading />}
      {error && <ErrorLine message={error} />}
      {rows !== null && (
        <div className="my-3 rounded-xl px-3 py-3" style={{ backgroundColor: 'var(--bg-secondary)' }}>
          <p className="type-support" style={{ color: 'var(--text-muted)' }}>
            {t('modules.usageTotal')}
          </p>
          <p className="type-title" style={{ color: 'var(--text-primary)' }}>
            {totalInput.toLocaleString()} in / {totalOutput.toLocaleString()} out
          </p>
          <p className="type-support" style={{ color: 'var(--text-muted)' }}>
            {(rows ?? []).length} {t('modules.sessions')}
          </p>
        </div>
      )}
      {[...byAgent.entries()].map(([agent, value]) => (
        <Row
          key={agent}
          title={agent}
          subtitle={`${value.sessions} ${t('modules.sessions')}`}
          trailing={
            <span className="type-support shrink-0 tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {value.input.toLocaleString()} / {value.output.toLocaleString()}
            </span>
          }
        />
      ))}
    </Shell>
  );
}

function useMobileToken(): string | null {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const { gatewayToken } = await import('../lib/remote-api.js');
      setToken(await gatewayToken());
    })();
  }, []);
  return token;
}

interface TeamRow {
  id: string;
  name: string;
  emoji?: string;
  description?: string;
  memberCount?: number;
}

/** 团队：读桌面端 `/api/mobile/teams`（teams 表 + 成员数）。 */
export function TeamsView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const token = useMobileToken();
  const [rows, setRows] = useState<TeamRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const { mobileFetch } = await import('../lib/remote-api.js');
        const response = await mobileFetch('/api/mobile/teams', token);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { teams?: TeamRow[] };
        setRows(data.teams ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'teams failed');
        setRows([]);
      }
    })();
  }, [token]);

  return (
    <Shell title={t('modules.team')} onClose={onClose}>
      {rows === null && !error && <Loading />}
      {error && <ErrorLine message={error} />}
      {(rows ?? []).map((row) => (
        <Row
          key={row.id}
          title={`${row.emoji ?? ''} ${row.name}`.trim()}
          subtitle={`${row.description ?? ''}${row.memberCount ? ` · ${row.memberCount} 成员` : ''}`}
        />
      ))}
      {rows !== null && rows.length === 0 && !error && (
        <p className="type-body py-8 text-center" style={{ color: 'var(--text-muted)' }}>
          {t('modules.empty')}
        </p>
      )}
    </Shell>
  );
}

interface KbSource {
  id?: string;
  title?: string;
  name?: string;
  kind?: string;
  chunks?: number;
  addedAt?: string;
}

/** 资料库：读桌面端 `/api/mobile/kb`（知识库运行时统计 + 来源）。 */
export function KnowledgeView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const token = useMobileToken();
  const [state, setState] = useState<{ ready: boolean; stats: Record<string, unknown> | null; sources: KbSource[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const { mobileFetch } = await import('../lib/remote-api.js');
        const response = await mobileFetch('/api/mobile/kb', token);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { ready?: boolean; stats?: Record<string, unknown> | null; sources?: KbSource[] };
        setState({ ready: data.ready === true, stats: data.stats ?? null, sources: data.sources ?? [] });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'kb failed');
      }
    })();
  }, [token]);

  return (
    <Shell title={t('modules.library')} onClose={onClose}>
      {state === null && !error && <Loading />}
      {error && <ErrorLine message={error} />}
      {state && !state.ready && (
        <p className="type-body py-6 text-center" style={{ color: 'var(--text-muted)' }}>
          {t('modules.kbNotReady')}
        </p>
      )}
      {state?.ready && state.stats && (
        <div className="my-3 rounded-xl px-3 py-3" style={{ backgroundColor: 'var(--bg-secondary)' }}>
          <p className="type-support" style={{ color: 'var(--text-muted)' }}>
            {t('modules.kbStats')}
          </p>
          <p className="type-body" style={{ color: 'var(--text-primary)' }}>
            {Object.entries(state.stats)
              .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join(' · ')}
          </p>
        </div>
      )}
      {(state?.sources ?? []).map((source, index) => (
        <Row
          key={source.id ?? `${source.title ?? source.name ?? index}`}
          title={source.title ?? source.name ?? source.id ?? `#${index + 1}`}
          subtitle={`${source.kind ?? ''}${source.chunks ? ` · ${source.chunks} 段` : ''}`}
        />
      ))}
      {state?.ready && (state.sources ?? []).length === 0 && (
        <p className="type-body py-8 text-center" style={{ color: 'var(--text-muted)' }}>
          {t('modules.empty')}
        </p>
      )}
    </Shell>
  );
}

/** 个性化中心：主题切换（和桌面端同一套令牌）。 */
export function PersonalizeView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );

  const apply = (next: 'light' | 'dark'): void => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage unavailable */
    }
    setMode(next);
  };

  return (
    <Shell title={t('modules.personalize')} onClose={onClose}>
      <div className="mt-2 space-y-2">
        {(['light', 'dark'] as const).map((option) => (
          <button
            key={option}
            onClick={() => apply(option)}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3"
            style={{
              backgroundColor: mode === option ? 'var(--accent-dim)' : 'var(--bg-secondary)',
              color: mode === option ? 'var(--accent)' : 'var(--text-secondary)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            {option === 'light' ? <Sun size={18} /> : <Moon size={18} />}
            <span className="type-body flex-1 text-left">
              {option === 'light' ? t('modules.themeLight') : t('modules.themeDark')}
            </span>
            {mode === option && <span className="type-support">✓</span>}
          </button>
        ))}
      </div>
    </Shell>
  );
}
