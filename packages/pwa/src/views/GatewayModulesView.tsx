import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, Sparkles, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ports } from '../platform/index.js';
import { useUiStore } from '../stores/hooks';

interface AgentRow {
  id: string;
  name: string;
  emoji?: string;
  model?: string;
  thinking?: string;
}

interface SkillRow {
  name: string;
  description: string;
  source?: string;
  disabled?: boolean;
  eligible?: boolean;
}

function useGatewayId(): string {
  return useUiStore((s) => s.defaultGatewayId ?? 'local-runtime');
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
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
      <div className="flex-1 overflow-y-auto px-3 pb-6">{children}</div>
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

/** 智能体市场：直接读网关 `agents.list`（桌面端同一份数据）。 */
export function AgentsView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const gatewayId = useGatewayId();
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await ports.gateway.listAgents(gatewayId);
      if (!res.ok) {
        setError(res.error ?? 'agents.list failed');
        setRows([]);
        return;
      }
      const payload = (res.result ?? {}) as { agents?: Array<Record<string, unknown>> };
      setRows(
        (payload.agents ?? []).map((agent) => {
          const identity = (agent.identity ?? {}) as { name?: string; emoji?: string };
          const model = (agent.model ?? {}) as { primary?: string };
          return {
            id: String(agent.id ?? ''),
            name: identity.name || String(agent.name ?? agent.id ?? ''),
            emoji: identity.emoji,
            model: model.primary,
            thinking: typeof agent.thinkingDefault === 'string' ? agent.thinkingDefault : undefined,
          };
        }),
      );
    })();
  }, [gatewayId]);

  return (
    <Shell title={t('modules.agents')} onClose={onClose}>
      {rows === null && <Loading />}
      {error && <ErrorLine message={error} />}
      {(rows ?? []).map((row) => (
        <div
          key={row.id}
          className="flex items-start gap-3 px-1 py-3"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <div
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{ backgroundColor: 'var(--accent-dim)', color: 'var(--accent)' }}
          >
            {row.emoji ? <span style={{ fontSize: 16 }}>{row.emoji}</span> : <UserRound size={16} />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="type-body truncate" style={{ color: 'var(--text-primary)' }}>
              {row.name}
            </p>
            <p className="type-support truncate" style={{ color: 'var(--text-muted)' }}>
              {row.id}
              {row.model ? ` · ${row.model}` : ''}
              {row.thinking ? ` · ${row.thinking}` : ''}
            </p>
          </div>
        </div>
      ))}
      {rows !== null && rows.length === 0 && !error && (
        <p className="type-body py-8 text-center" style={{ color: 'var(--text-muted)' }}>
          {t('modules.empty')}
        </p>
      )}
    </Shell>
  );
}

/** 技能：直接读网关 `skills.status`。 */
export function SkillsView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const gatewayId = useGatewayId();
  const [rows, setRows] = useState<SkillRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await ports.gateway.getSkillsStatus(gatewayId);
      if (!res.ok) {
        setError(res.error ?? 'skills.status failed');
        setRows([]);
        return;
      }
      const payload = (res.result ?? {}) as { skills?: Array<Record<string, unknown>> };
      setRows(
        (payload.skills ?? []).map((skill) => ({
          name: String(skill.name ?? ''),
          description: String(skill.description ?? ''),
          source: typeof skill.source === 'string' ? skill.source : undefined,
          disabled: skill.disabled === true,
          eligible: skill.eligible !== false,
        })),
      );
    })();
  }, [gatewayId]);

  return (
    <Shell title={t('modules.skills')} onClose={onClose}>
      {rows === null && <Loading />}
      {error && <ErrorLine message={error} />}
      {(rows ?? []).map((row) => (
        <div
          key={row.name}
          className="flex items-start gap-3 px-1 py-3"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <Sparkles
            size={16}
            className="mt-1 shrink-0"
            style={{ color: row.disabled ? 'var(--text-muted)' : 'var(--accent)' }}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="type-body" style={{ color: 'var(--text-primary)' }}>
              {row.name}
            </p>
            <p className="type-support line-clamp-2" style={{ color: 'var(--text-muted)' }}>
              {row.description}
            </p>
            <p className="type-support mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {row.disabled ? t('modules.skillDisabled') : t('modules.skillEnabled')}
              {row.source ? ` · ${row.source}` : ''}
            </p>
          </div>
        </div>
      ))}
      {rows !== null && rows.length === 0 && !error && (
        <p className="type-body py-8 text-center" style={{ color: 'var(--text-muted)' }}>
          {t('modules.empty')}
        </p>
      )}
    </Shell>
  );
}
