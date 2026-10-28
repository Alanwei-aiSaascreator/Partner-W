import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { gatewayToken, mobileFetch } from '../lib/remote-api';

interface Row {
  [key: string]: unknown;
}

function pickText(row: Row, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function formatWhen(value: unknown): string {
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  if (typeof value === 'number') return formatWhen(new Date(value).toISOString());
  return '';
}

/**
 * 商业/社区面板（广场、需求悬赏、游戏化中心、创作者中心）的通用列表页。
 *
 * 数据来自桌面端 `/api/mobile/commercial?fn=…`，那一层用桌面已登录的
 * commercial 会话调 Supabase RPC —— 手机端不碰凭据，也不新增后端。
 */
function CommercialList({
  title,
  fn,
  emptyHint,
  onClose,
}: {
  title: string;
  fn: string;
  emptyHint?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [token, setToken] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => setToken(await gatewayToken()))();
  }, []);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const response = await mobileFetch(`/api/mobile/commercial?fn=${encodeURIComponent(fn)}`, token);
        const data = (await response.json()) as { rows?: Row[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        setRows(data.rows ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load failed');
        setRows([]);
      }
    })();
  }, [token, fn]);

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
        <span className="type-support" style={{ color: 'var(--text-muted)' }}>
          {rows === null ? '…' : rows.length}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-3 pb-8">
        {rows === null && (
          <div className="flex justify-center py-10">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        )}

        {error && (
          <p
            className="type-body my-3 rounded-lg px-3 py-2"
            style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}
          >
            {error}
          </p>
        )}

        {(rows ?? []).map((row, index) => {
          const titleText = pickText(row, ['title', 'name', 'subject', 'display_name', 'nickname', 'body', 'content']);
          const bodyText = pickText(row, ['body', 'content', 'description', 'summary', 'note']);
          const when = formatWhen(row['created_at'] ?? row['updated_at'] ?? row['ts']);
          const amount = pickText(row, ['reward', 'amount', 'points', 'price']);
          return (
            <div key={String(row['id'] ?? index)} className="py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <p className="type-body" style={{ color: 'var(--text-primary)' }}>
                {titleText ?? `#${index + 1}`}
              </p>
              {bodyText && bodyText !== titleText && (
                <p className="type-support line-clamp-3 mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {bodyText}
                </p>
              )}
              <p className="type-support mt-1" style={{ color: 'var(--text-muted)' }}>
                {[when, amount ? `${amount}` : ''].filter(Boolean).join(' · ')}
              </p>
            </div>
          );
        })}

        {rows !== null && rows.length === 0 && !error && (
          <p className="type-body py-10 text-center" style={{ color: 'var(--text-muted)' }}>
            {emptyHint ?? t('modules.empty')}
          </p>
        )}
      </div>
    </div>
  );
}

/** 广场：社区动态（community_feed）。 */
export function CommunityView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return <CommercialList title={t('modules.square')} fn="feed" onClose={onClose} />;
}

/** 需求悬赏（bounty_list）。 */
export function BountyView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return <CommercialList title={t('modules.bounty')} fn="bounty" onClose={onClose} />;
}

/** 游戏化中心：成长概览 + 每日任务。 */
export function GrowthView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    // 用 growth_summary（实测有真实数据）；daily_task_list 在数据库那边要求参数，
    // 桌面端的调用同样报 "without parameters"，所以不拿它当主数据源。
    <CommercialList
      title={t('modules.growth')}
      fn="growth"
      emptyHint={t('modules.growthEmpty')}
      onClose={onClose}
    />
  );
}

/** 创作者中心：目前读不到模板列表时的诚实空态。 */
export function CreatorView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return <CommercialList title={t('modules.creator')} fn="growth" emptyHint={t('modules.creatorHint')} onClose={onClose} />;
}
