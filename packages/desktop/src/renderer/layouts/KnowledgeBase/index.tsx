import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, FilePlus2, Loader2, NotebookPen, Pin, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import EmptyState from '@/components/semantic/EmptyState';
import InlineNotice from '@/components/semantic/InlineNotice';
import SectionCard from '@/components/semantic/SectionCard';
import WindowTitlebar from '@/components/semantic/WindowTitlebar';
import ConfirmDialog from '@/components/semantic/ConfirmDialog';
import NoteComposerDialog from './NoteComposerDialog';
import { toast } from '@/lib/toast';
import type { KbSearchHitView, KbSourceSummaryView, KbStatsView } from '../../../preload/clawwork';

/**
 * 资料库（T6）—— 工作区本地库 + **本地嵌入**检索。
 *
 * ## 这个界面要如实说清的三件事
 *
 * ① **东西存在哪**：这是本机（或 U 盘）工作区里的库，**不上云**（隐私政策 §12.2 的承诺）。
 *    §12.2 写着"文件索引保存在本机、不予收集不予上传"，所以这里不放"同步"之类的暗示。
 * ② **现在是什么检索模式**：有引擎 ⇒ 关键词 + 向量；没引擎 ⇒ 只有关键词。
 *    后者是**合法降级不是错误**（引擎可能因为模型没打进包/被杀软拦而起不来），
 *    所以用提示条说明，而不是报错弹窗 —— 用户搜东西仍然能用。
 * ③ **在花什么**：本地嵌入**不花钱**。别在这里显示积分/token 之类的东西
 *   （界面只显示积分那条红线，在这里根本不适用）。
 *
 * ⚠️ `not-ready` 跟"你还没加过资料"必须分开显示：运行时是工作区就绪后**异步**建的
 *（要读 90MB 模型），界面可能在那之前就问上来。混在一起用户会以为自己的东西丢了。
 */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-ready' }
  | { kind: 'ready'; stats: KbStatsView; engine: string | null; sources: KbSourceSummaryView[] }
  | { kind: 'error'; message: string };

export default function KnowledgeBase(): React.JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KbSearchHitView[] | null>(null);
  const [degraded, setDegraded] = useState<'no-engine' | 'engine-error' | 'no-vectors' | null>(null);
  const [searching, setSearching] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<KbSourceSummaryView | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);

  const refresh = useCallback(async () => {
    const [statsReply, sourcesReply] = await Promise.all([window.clawwork.kbStats(), window.clawwork.kbListSources()]);
    if (!statsReply.ok || !sourcesReply.ok) {
      // 两条里有任意一条回 not-ready ⇒ 就是"还没就绪"（两条同时问的，不会一好一坏）
      const notReady =
        (!statsReply.ok && statsReply.code === 'not-ready') || (!sourcesReply.ok && sourcesReply.code === 'not-ready');
      setState(notReady ? { kind: 'not-ready' } : { kind: 'error', message: t('kb.loadFailed') });
      return;
    }
    setState({ kind: 'ready', stats: statsReply.stats, engine: statsReply.engine, sources: sourcesReply.sources });
  }, [t]);

  useEffect(() => {
    void refresh().catch(() => setState({ kind: 'error', message: t('kb.loadFailed') }));
  }, [refresh, t]);

  /** 索引是**异步**的（可能要嵌几百块）⇒ 入库后把界面状态刷一遍，别让它显示旧统计。 */
  const runIndexThenRefresh = useCallback(async () => {
    await window.clawwork.kbIndexPending().catch(() => undefined);
    await refresh().catch(() => undefined);
  }, [refresh]);

  const handleAddFiles = useCallback(async () => {
    const picked = await window.clawwork.kbPickFiles();
    if (!picked.paths.length) return;

    let added = 0;
    let skipped = 0;
    for (const path of picked.paths) {
      const reply = await window.clawwork.kbAddFile({ path });
      if (reply.ok && reply.outcome.status !== 'skipped') added += 1;
      else skipped += 1;
    }

    // 全部被跳过要说出来：多半是"不是文本文件"或"空的"，静默成功会让用户以为索引坏了
    if (added === 0) toast.warning(t('kb.addNone'));
    else if (skipped > 0) toast.success(t('kb.addPartial', { added, skipped }));
    else toast.success(t('kb.addDone', { count: added }));

    await runIndexThenRefresh();
  }, [runIndexThenRefresh, t]);

  /** 建笔记 → 关框 → 建索引 → 刷列表。顺序刻意如此：先关框让用户看到反馈，再干活。 */
  const handleCreateNote = useCallback(
    async (input: { title: string; text: string }) => {
      const reply = await window.clawwork.kbAddNote(input);
      if (!reply.ok) {
        toast.error(t('kb.loadFailed'));
        return;
      }
      setNoteOpen(false);
      toast.success(t('kb.noteAdded'));
      await runIndexThenRefresh();
    },
    [runIndexThenRefresh, t],
  );

  const handleRemove = useCallback(async () => {
    if (!pendingRemove) return;
    await window.clawwork.kbRemoveSource(pendingRemove.id);
    setPendingRemove(null);
    await refresh().catch(() => undefined);
  }, [pendingRemove, refresh]);

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits(null);
      setDegraded(null);
      return;
    }
    setSearching(true);
    try {
      const reply = await window.clawwork.kbSearch({ query: trimmed });
      if (reply.ok) {
        setHits(reply.outcome.hits);
        setDegraded(reply.outcome.degraded ? (reply.outcome.degradedReason ?? null) : null);
      } else {
        setHits([]);
        toast.error(t('kb.loadFailed'));
      }
    } finally {
      setSearching(false);
    }
  }, [query, t]);

  const pendingChunks = useMemo(
    () =>
      state.kind === 'ready' ? (state.stats.byState.pending_embedding ?? 0) + (state.stats.byState.stale ?? 0) : 0,
    [state],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WindowTitlebar center={<span className="type-label">{t('kb.title')}</span>} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-[var(--content-max-width)] flex-col gap-4 px-6 py-5">
          {state.kind === 'loading' ? (
            <div className="flex items-center gap-2 py-8 text-[var(--text-muted)]">
              <Loader2 size={16} className="animate-spin" />
              <span className="type-support">{t('kb.loading')}</span>
            </div>
          ) : state.kind === 'not-ready' ? (
            // ⚠️ 与"还没有资料"分开：这一条会自己好（运行时建完就有了），重进页面即可
            <InlineNotice tone="info">{t('kb.notReady')}</InlineNotice>
          ) : state.kind === 'error' ? (
            <InlineNotice tone="warning">{state.message}</InlineNotice>
          ) : (
            <>
              {!state.engine && <InlineNotice tone="info">{t('kb.degraded.noEngine')}</InlineNotice>}

              <SectionCard
                title={t('kb.statsTitle')}
                actions={
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => void handleAddFiles()}>
                      <FilePlus2 size={14} />
                      {t('kb.addFile')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setNoteOpen(true)}>
                      <NotebookPen size={14} />
                      {t('kb.addNote')}
                    </Button>
                    {pendingChunks > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => void runIndexThenRefresh()}>
                        <NotebookPen size={14} />
                        {t('kb.indexNow', { count: pendingChunks })}
                      </Button>
                    )}
                  </div>
                }
              >
                <div className="grid grid-cols-3 gap-3">
                  <Stat label={t('kb.statSources')} value={state.stats.sources} />
                  <Stat label={t('kb.statChunks')} value={state.stats.chunks} />
                  <Stat label={t('kb.statPending')} value={pendingChunks} />
                </div>
                <p className="type-meta mt-2 text-[var(--text-muted)]">
                  {state.engine ? t('kb.engineLocal', { model: state.engine }) : t('kb.engineKeywordOnly')}
                </p>
              </SectionCard>

              <SectionCard title={t('kb.searchTitle')}>
                <div className="flex items-center gap-2">
                  <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1.5">
                    <Search size={14} className="shrink-0 text-[var(--text-muted)]" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void handleSearch();
                      }}
                      placeholder={t('kb.searchPlaceholder')}
                      aria-label={t('kb.searchTitle')}
                      className="min-w-0 flex-1 bg-transparent type-body outline-none placeholder:text-[var(--text-muted)]"
                    />
                    {searching && <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" />}
                  </div>
                  <Button size="sm" onClick={() => void handleSearch()}>
                    {t('kb.searchAction')}
                  </Button>
                </div>

                {degraded && (
                  <p className="type-meta mt-2 text-[var(--text-muted)]">
                    {t(
                      `kb.degraded.${degraded === 'no-engine' ? 'noEngine' : degraded === 'engine-error' ? 'engineError' : 'noVectors'}`,
                    )}
                  </p>
                )}

                {hits !== null &&
                  (hits.length === 0 ? (
                    <p className="type-support mt-3 py-4 text-center text-[var(--text-muted)]">{t('kb.searchEmpty')}</p>
                  ) : (
                    <ul className="mt-3 flex flex-col gap-2">
                      {hits.map((hit) => (
                        <li key={hit.chunkId} className="rounded-lg border border-[var(--border-subtle)] p-2.5">
                          <div className="flex items-center gap-2">
                            <span className="type-label min-w-0 flex-1 truncate">{hit.sourceTitle}</span>
                            <span className="type-mono-data shrink-0 text-[var(--text-muted)]">
                              {hit.score.toFixed(2)}
                            </span>
                          </div>
                          <p className="type-support mt-1 line-clamp-3 text-[var(--text-secondary)]">{hit.snippet}</p>
                        </li>
                      ))}
                    </ul>
                  ))}
              </SectionCard>

              <SectionCard title={t('kb.sourcesTitle')}>
                {state.sources.length === 0 ? (
                  <EmptyState title={t('kb.empty')} icon={<BookOpen size={18} />} className="py-6" />
                ) : (
                  <ul className="flex flex-col">
                    {state.sources.map((source) => (
                      <li
                        key={source.id}
                        className="flex items-center gap-2 border-b border-[var(--border-subtle)] py-2 last:border-b-0"
                      >
                        {source.kind === 'note' ? (
                          <Pin size={13} className="shrink-0 text-[var(--text-muted)]" />
                        ) : (
                          <BookOpen size={13} className="shrink-0 text-[var(--text-muted)]" />
                        )}
                        <span className="type-body min-w-0 flex-1 truncate">{source.title}</span>
                        {source.pending > 0 && (
                          <span className="type-meta shrink-0 text-[var(--text-muted)]">
                            {t('kb.sourcePending', { count: source.pending })}
                          </span>
                        )}
                        <span className="type-meta shrink-0 text-[var(--text-muted)]">
                          {t('kb.sourceChunks', { count: source.chunks })}
                        </span>
                        <button
                          type="button"
                          aria-label={t('kb.remove')}
                          title={t('kb.remove')}
                          onClick={() => setPendingRemove(source)}
                          className={cn(
                            'glow-focus shrink-0 rounded-md p-1 text-[var(--text-muted)]',
                            'transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]',
                          )}
                        >
                          <Trash2 size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
            </>
          )}
        </div>
      </ScrollArea>

      <NoteComposerDialog open={noteOpen} onCancel={() => setNoteOpen(false)} onSubmit={handleCreateNote} />

      <ConfirmDialog
        open={pendingRemove !== null}
        title={t('kb.remove')}
        description={t('kb.removeConfirm', { title: pendingRemove?.title ?? '' })}
        confirmLabel={t('kb.remove')}
        variant="danger"
        onConfirm={() => void handleRemove()}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">
      <div className="type-mono-data text-[var(--text-primary)]">{value}</div>
      <div className="type-meta text-[var(--text-muted)]">{label}</div>
    </div>
  );
}
