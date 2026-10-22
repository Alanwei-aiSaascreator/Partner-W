import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, FileText, Loader2, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { gatewayToken, mobileFetch } from '../lib/remote-api';
import { useTaskStore } from '../stores/hooks';

interface ArtifactRow {
  id: string;
  name: string;
  size: number;
  mimeType?: string;
  createdAt?: string;
  taskTitle?: string;
  taskId?: string;
}

function formatSize(bytes: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function relativeTime(iso?: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const d = new Date(then);
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toUpperCase() : '';
}

/**
 * 文件管理（手机端）—— 对齐桌面端 FileBrowser：列的是**任务产物**（artifacts 表），
 * 不是工作区目录树。数据走 `/api/mobile/artifacts`，下载走同一接口的 download。
 */
export function ArtifactsView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [token, setToken] = useState<string | null>(null);
  const [rows, setRows] = useState<ArtifactRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => setToken(await gatewayToken()))();
  }, []);

  /**
   * 拉产物列表。
   * ⚠️ 只在挂载时拉一次是不够的：AI 刚写完的文件要靠桌面端 reconcile 才进 artifacts 表，
   *    用户停在产物页时什么都看不到，体验就是"产物怎么还不出来"。
   *    页面打开期间每 8 秒刷一次（SQLite 查询，毫秒级，不心疼）。
   */
  const load = useCallback(async (): Promise<void> => {
    if (!token) return;
    try {
      const response = await mobileFetch('/api/mobile/artifacts?limit=200', token);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { artifacts?: ArtifactRow[] };
      setRows(data.artifacts ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load failed');
      setRows((prev) => prev ?? []);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    // 打开产物页先让桌面对一次账：手机跑的任务没人点桌面面板，
    // 文件写出来了也进不了 artifacts 表（真机表现：产物页一直是空的）。
    const sync = async (): Promise<void> => {
      const { tasks, activeTaskId } = useTaskStore.getState();
      const sessionKey = tasks.find((task) => task.id === activeTaskId)?.sessionKey;
      if (!sessionKey) return;
      await mobileFetch('/api/mobile/artifacts/sync', token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionKey }),
      }).catch(() => undefined);
    };
    void sync().then(() => load());
    const timer = setInterval(() => void load(), 8_000);
    return () => clearInterval(timer);
  }, [token, load]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return rows ?? [];
    return (rows ?? []).filter(
      (row) => row.name.toLowerCase().includes(keyword) || (row.taskTitle ?? '').toLowerCase().includes(keyword),
    );
  }, [rows, query]);

  const download = async (row: ArtifactRow): Promise<void> => {
    if (!token) return;
    setBusy(row.id);
    try {
      const response = await mobileFetch(`/api/mobile/artifacts/download?id=${encodeURIComponent(row.id)}`, token);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = row.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'download failed');
    } finally {
      setBusy(null);
    }
  };

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
            {t('files.title')}
          </p>
          <p className="type-support" style={{ color: 'var(--text-muted)' }}>
            {rows === null ? '…' : `${filtered.length} 个产物`}
          </p>
        </div>
      </header>

      <div className="shrink-0 px-3 pb-2">
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
        {rows === null && (
          <div className="flex justify-center py-10">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        )}

        {error && (
          <p className="type-body my-3 rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}>
            {error}
          </p>
        )}

        {filtered.map((row) => {
          const ext = extensionOf(row.name);
          return (
            <button
              key={row.id}
              onClick={() => void download(row)}
              className="mt-2 flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left"
              style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
            >
              <div
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg"
                style={{ backgroundColor: 'var(--bg-tertiary)' }}
              >
                {busy === row.id ? (
                  <Loader2 size={18} className="animate-spin" style={{ color: 'var(--accent)' }} />
                ) : (
                  <FileText size={18} style={{ color: 'var(--accent)' }} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="type-body min-w-0 flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                    {row.name}
                  </p>
                  {ext && (
                    <span
                      className="type-support shrink-0 rounded px-1"
                      style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                    >
                      {ext}
                    </span>
                  )}
                </div>
                <p className="type-support mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {formatSize(row.size)}
                </p>
                <p className="type-support mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>
                  {row.taskTitle ?? row.taskId ?? ''}
                </p>
                <p className="type-support" style={{ color: 'var(--text-muted)' }}>
                  {relativeTime(row.createdAt)}
                </p>
              </div>
              <Download size={16} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
            </button>
          );
        })}

        {rows !== null && filtered.length === 0 && !error && (
          <p className="type-body py-10 text-center" style={{ color: 'var(--text-muted)' }}>
            {query ? t('files.noMatch') : t('files.empty')}
          </p>
        )}
      </div>
    </div>
  );
}
