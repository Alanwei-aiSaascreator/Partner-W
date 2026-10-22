import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2, Plus, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { gatewayToken, mobileFetch } from '../lib/remote-api';

interface Row {
  [key: string]: unknown;
}

function text(row: Row, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function when(value: unknown): string {
  const raw = typeof value === 'number' ? new Date(value).toISOString() : typeof value === 'string' ? value : '';
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  const minutes = Math.floor((Date.now() - d.getTime()) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

function Shell({
  title,
  subtitle,
  onClose,
  tabs,
  active,
  onTab,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  tabs?: Array<[string, string]>;
  active?: string;
  onTab?: (key: string) => void;
  children: React.ReactNode;
}) {
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
        <div className="min-w-0 flex-1">
          <p className="type-label truncate" style={{ color: 'var(--text-primary)' }}>
            {title}
          </p>
          {subtitle && (
            <p className="type-support" style={{ color: 'var(--text-muted)' }}>
              {subtitle}
            </p>
          )}
        </div>
      </header>
      {tabs && (
        <div className="flex shrink-0 gap-2 px-3 pb-2">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              onClick={() => onTab?.(key)}
              className="type-support rounded-full px-3 py-1"
              style={{
                backgroundColor: active === key ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
                color: active === key ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
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

/** 广场：广场 / 成员 / 悬赏 三个 tab（对齐桌面端 CommunityPanel）。 */
export function CommunityPanelView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'feed' | 'members' | 'bounty'>('feed');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [visibility, setVisibility] = useState<'team' | 'self'>('team');
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    const token = await gatewayToken();
    if (!token) return;
    setRows(null);
    setError(null);
    try {
      const fn = tab === 'members' ? 'members' : tab === 'bounty' ? 'bounty' : 'feed';
      const response = await mobileFetch(`/api/mobile/commercial?fn=${fn}`, token);
      const data = (await response.json()) as { rows?: Row[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setRows(data.rows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load failed');
      setRows([]);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (): Promise<void> => {
    const body = draft.trim();
    if (!body) return;
    const token = await gatewayToken();
    if (!token) return;
    setPosting(true);
    try {
      const response = await mobileFetch('/api/mobile/community/post', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, visibility }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setDraft('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'post failed');
    } finally {
      setPosting(false);
    }
  };

  return (
    <Shell
      title={t('modules.square')}
      subtitle={rows === null ? undefined : `${rows.length} 条`}
      onClose={onClose}
      tabs={[
        ['feed', '广场'],
        ['members', '成员'],
        ['bounty', '悬赏'],
      ]}
      active={tab}
      onTab={(key) => setTab(key as 'feed' | 'members' | 'bounty')}
    >
      {tab === 'feed' && (
        <div
          className="mb-2 rounded-xl px-3 py-3"
          style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="说点什么…"
            rows={3}
            className="type-body w-full resize-none rounded-lg px-3 py-2 outline-none"
            style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          />
          <div className="mt-2 flex items-center gap-2">
            {(
              [
                ['team', '团队可见'],
                ['self', '仅自己'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setVisibility(key)}
                className="type-support rounded-full px-3 py-1"
                style={{
                  backgroundColor: visibility === key ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
                  color: visibility === key ? 'var(--accent)' : 'var(--text-secondary)',
                }}
              >
                {label}
              </button>
            ))}
            <button
              onClick={() => void submit()}
              disabled={posting || !draft.trim()}
              className="type-support ml-auto flex items-center gap-1 rounded-full px-4 py-1.5 disabled:opacity-40"
              style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)' }}
            >
              {posting ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              发布
            </button>
          </div>
        </div>
      )}

      {rows === null && <Loading />}
      {error && <ErrorLine message={error} />}

      {(rows ?? []).map((row, index) => {
        const title = text(row, ['body', 'content', 'title', 'name', 'display_name', 'nickname', 'username']);
        const sub = text(row, ['description', 'note', 'role']);
        const time = when(row['created_at'] ?? row['updated_at'] ?? row['ts']);
        return (
          <div
            key={String(row['id'] ?? index)}
            className="mt-2 rounded-xl px-3 py-3"
            style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
          >
            <p className="type-body whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
              {title ?? `#${index + 1}`}
            </p>
            {sub && sub !== title && (
              <p className="type-support mt-1" style={{ color: 'var(--text-muted)' }}>
                {sub}
              </p>
            )}
            {time && (
              <p className="type-support mt-1" style={{ color: 'var(--text-muted)' }}>
                {time}
              </p>
            )}
          </div>
        );
      })}

      {rows !== null && rows.length === 0 && !error && (
        <p className="type-body py-10 text-center" style={{ color: 'var(--text-muted)' }}>
          {tab === 'feed' ? '还没有动态，发第一条吧' : t('modules.empty')}
        </p>
      )}
    </Shell>
  );
}

/** 创作者中心：市场 / 我的模板（含新建模板，对齐桌面端 MarketPanel）。 */
export function CreatorPanelView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'market' | 'mine'>('mine');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '', category: 'other', emoji: '🧩', instructions: '' });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const token = await gatewayToken();
    if (!token) return;
    setRows(null);
    setError(null);
    try {
      const path = tab === 'mine' ? '/api/mobile/market/templates' : '/api/mobile/commercial?fn=market';
      const response = await mobileFetch(path, token);
      const data = (await response.json()) as { rows?: Row[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setRows(data.rows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load failed');
      setRows([]);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (): Promise<void> => {
    if (!form.name.trim()) return;
    const token = await gatewayToken();
    if (!token) return;
    setCreating(true);
    try {
      const response = await mobileFetch('/api/mobile/market/create', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setForm({ name: '', description: '', category: 'other', emoji: '🧩', instructions: '' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create failed');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Shell
      title={t('modules.creator')}
      subtitle={rows === null ? undefined : `${rows.length} 个模板`}
      onClose={onClose}
      tabs={[
        ['market', '市场'],
        ['mine', '我的模板'],
      ]}
      active={tab}
      onTab={(key) => setTab(key as 'market' | 'mine')}
    >
      {tab === 'mine' && (
        <div
          className="mb-2 rounded-xl px-3 py-3"
          style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
        >
          <p className="type-label mb-2" style={{ color: 'var(--text-primary)' }}>
            新建模板
          </p>
          <input
            value={form.name}
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="名字（不超过 60 字）"
            className="type-body mb-2 w-full rounded-lg px-3 py-2 outline-none"
            style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          />
          <input
            value={form.description}
            onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
            placeholder="描述（不超过 300 字）"
            className="type-body mb-2 w-full rounded-lg px-3 py-2 outline-none"
            style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          />
          <div className="mb-2 flex gap-2">
            <input
              value={form.emoji}
              onChange={(event) => setForm((prev) => ({ ...prev, emoji: event.target.value }))}
              className="type-body w-16 rounded-lg px-3 py-2 text-center outline-none"
              style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
              aria-label="图标"
            />
            <select
              value={form.category}
              onChange={(event) => setForm((prev) => ({ ...prev, category: event.target.value }))}
              className="type-body flex-1 rounded-lg px-3 py-2 outline-none"
              style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
              aria-label="分类"
            >
              <option value="other">其他</option>
              <option value="writing">写作</option>
              <option value="office">办公</option>
              <option value="marketing">营销</option>
              <option value="coding">编程</option>
            </select>
          </div>
          <textarea
            value={form.instructions}
            onChange={(event) => setForm((prev) => ({ ...prev, instructions: event.target.value }))}
            placeholder="提示词（助手要做什么，选中即用）"
            rows={4}
            className="type-body mb-2 w-full resize-none rounded-lg px-3 py-2 outline-none"
            style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          />
          <button
            onClick={() => void create()}
            disabled={creating || !form.name.trim()}
            className="type-support flex items-center gap-1 rounded-full px-4 py-1.5 disabled:opacity-40"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)' }}
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            创建
          </button>
        </div>
      )}

      {rows === null && <Loading />}
      {error && <ErrorLine message={error} />}

      {(rows ?? []).map((row, index) => {
        const name = text(row, ['name', 'title', 'display_name']) ?? `#${index + 1}`;
        const desc = text(row, ['description', 'summary']);
        const emoji = text(row, ['emoji', 'icon']);
        return (
          <div
            key={String(row['id'] ?? index)}
            className="mt-2 flex items-start gap-3 rounded-xl px-3 py-3"
            style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
          >
            <span className="text-lg" aria-hidden="true">
              {emoji ?? '🧩'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="type-body truncate" style={{ color: 'var(--text-primary)' }}>
                {name}
              </p>
              {desc && (
                <p className="type-support line-clamp-2 mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {desc}
                </p>
              )}
            </div>
          </div>
        );
      })}

      {rows !== null && rows.length === 0 && !error && (
        <p className="type-body py-10 text-center" style={{ color: 'var(--text-muted)' }}>
          {tab === 'mine' ? '还没有模板，先在上面新建一个' : t('modules.empty')}
        </p>
      )}
    </Shell>
  );
}
