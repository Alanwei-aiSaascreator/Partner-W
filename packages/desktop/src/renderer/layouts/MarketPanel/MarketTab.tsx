import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Search, Sparkles, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { normalizeTemplateDetail, normalizeTemplateList } from '@clawwork/core';
import {
  TEMPLATE_CATEGORIES,
  type AgentTemplateDetail,
  type AgentTemplateSummary,
  type TemplateCategory,
} from '@clawwork/shared';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import EmptyState from '@/components/semantic/EmptyState';
import { useTemplateInstall } from './useTemplateInstall';

/**
 * 助手市场。
 *
 * 三条纪律：
 *   ① 列表与详情都走 `window.clawwork.market*`（服务端可见性由 definer RPC 判定）；
 *   ② **安装是真安装** —— 拉详情（要提示词）后交给 `useTemplateInstall`，
 *      它会在本地网关真建一个助手；这里只负责界面反馈；
 *   ③ 失败一律中文（`describeTemplateError` 的产物），界面里不出现机器码/英文。
 *
 * ⚠️ 分类文案用带前缀的模板串取键（`market.category${suffix}`）——
 *    `check-i18n` 的扫描器认这种写法，映射表那种它看不见会报 unused。
 */
const CATEGORY_SUFFIX: Record<TemplateCategory, 'Content' | 'Ecommerce' | 'Research' | 'Office' | 'Other'> = {
  content: 'Content',
  ecommerce: 'Ecommerce',
  research: 'Research',
  office: 'Office',
  other: 'Other',
};

const SEARCH_DEBOUNCE_MS = 300;

export default function MarketTab() {
  const { t } = useTranslation();
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all');
  const [pendingQuery, setPendingQuery] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<AgentTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [detail, setDetail] = useState<AgentTemplateDetail | null>(null);
  const [installedLocally, setInstalledLocally] = useState<ReadonlySet<string>>(new Set());
  const { install, installingId } = useTemplateInstall();

  // 输入防抖 ⇒ 交给下面的统一加载路径
  useEffect(() => {
    const handle = setTimeout(() => setQuery(pendingQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [pendingQuery]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setFailed(false);
    const res = await window.clawwork.marketTemplates({
      category: category === 'all' ? null : category,
      query: query || null,
    });
    if (!res.ok) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setRows(normalizeTemplateList(res.result));
    setLoading(false);
  }, [category, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(async (id: string): Promise<AgentTemplateDetail | null> => {
    const res = await window.clawwork.marketTemplateDetail(id);
    const parsed = res.ok ? normalizeTemplateDetail(res.result) : null;
    if (parsed) setDetail(parsed);
    return parsed;
  }, []);

  const handleInstall = useCallback(
    async (template: AgentTemplateSummary): Promise<void> => {
      // 安装要用提示词 ⇒ 先拿详情（顺带让用户看到他要装的是什么）
      let full: AgentTemplateDetail | null;
      try {
        full = await openDetail(template.id);
      } catch (error) {
        console.error('[market] 助手安装请求异常:', error);
        toast.error(t('market.installFailed'));
        return;
      }
      if (!full) {
        toast.error(t('market.loadFailed'));
        return;
      }

      let outcome;
      try {
        outcome = await install(full);
      } catch (error) {
        console.error('[market] 助手安装请求异常:', error);
        toast.error(t('market.installFailed'));
        return;
      }
      if (!outcome.ok) {
        if (outcome.diagnostic) console.error('[market] 助手安装失败:', outcome.diagnostic);
        toast.error(outcome.message ?? t('market.installFailed'));
        return;
      }
      if (outcome.alreadyInstalled) toast.info(t('market.alreadyInstalled'));
      else toast.success(t('market.installDone', { name: full.name }));
      if (outcome.recordWarning) toast.warning(t('market.recordWarning'));

      setInstalledLocally((current) => new Set([...current, template.id]));
      await load();
    },
    [install, load, openDetail, t],
  );

  const categoryButtons = useMemo(
    () =>
      [
        { key: 'all' as const, label: t('market.categoryAll') },
        ...TEMPLATE_CATEGORIES.map((value) => ({
          key: value,
          label: t(`market.category${CATEGORY_SUFFIX[value]}`),
        })),
      ] satisfies Array<{ key: TemplateCategory | 'all'; label: string }>,
    [t],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 space-y-2 border-b border-[var(--border-subtle)] p-4">
        <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3">
          <Search size={15} className="text-[var(--text-muted)]" />
          <input
            type="search"
            value={pendingQuery}
            onChange={(event) => setPendingQuery(event.target.value)}
            placeholder={t('market.searchPlaceholder')}
            className="h-[var(--density-control-height-sm)] flex-1 bg-transparent type-body text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {categoryButtons.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={category === item.key}
              onClick={() => setCategory(item.key)}
              className="glow-focus rounded-md px-2 py-1 type-support text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] aria-pressed:bg-[var(--state-selected)] aria-pressed:text-[var(--accent)]"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-4">
          {detail && (
            <section
              data-testid="market-detail"
              className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4"
            >
              <header className="flex items-start gap-2">
                <span className="type-section-title">{detail.emoji}</span>
                <div className="flex-1">
                  <h3 className="type-section-title text-[var(--text-primary)]">{detail.name}</h3>
                  <p className="type-support text-[var(--text-muted)]">{detail.description}</p>
                </div>
                <button
                  type="button"
                  aria-label={t('market.close')}
                  onClick={() => setDetail(null)}
                  className="glow-focus rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                >
                  <X size={16} />
                </button>
              </header>
              <h4 className="mt-3 type-label text-[var(--text-secondary)]">{t('market.prompt')}</h4>
              <p className="mt-1 whitespace-pre-wrap type-body text-[var(--text-primary)]">{detail.instructions}</p>
            </section>
          )}

          {loading && rows.length === 0 && (
            <p className="type-support text-[var(--text-muted)]">{t('market.loading')}</p>
          )}

          {failed && (
            <div className="flex items-center gap-2">
              <p className="type-support text-[var(--text-secondary)]">{t('market.loadFailed')}</p>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                {t('market.retry')}
              </Button>
            </div>
          )}

          {!loading && !failed && rows.length === 0 && <EmptyState title={t('market.empty')} />}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((row) => {
              const installed = row.installedByMe || installedLocally.has(row.id);
              const busy = installingId === row.id;
              return (
                <article
                  key={row.id}
                  data-template={row.id}
                  onClick={() => void openDetail(row.id)}
                  className="cursor-pointer rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4 transition-colors hover:border-[var(--border)]"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span className="type-section-title">{row.emoji}</span>
                    <h3 className="type-label flex-1 text-[var(--text-primary)]">{row.name}</h3>
                    {row.isOfficial && (
                      <span className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 type-support text-[var(--accent)]">
                        {t('market.official')}
                      </span>
                    )}
                  </div>
                  <p className="mb-3 min-h-10 type-support text-[var(--text-muted)]">{row.description}</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="type-support text-[var(--text-muted)]">
                      {t('market.byAuthor', { name: row.authorName })} ·{' '}
                      {t('market.installCount', { count: row.installCount })}
                    </span>
                    <Button
                      size="sm"
                      data-action="install"
                      disabled={installed || busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleInstall(row);
                      }}
                    >
                      {installed ? (
                        <>
                          <Sparkles />
                          {t('market.installed')}
                        </>
                      ) : busy ? (
                        <>
                          <Loader2 className="animate-spin" />
                          {t('market.installing')}
                        </>
                      ) : (
                        <>
                          <Download />
                          {t('market.install')}
                        </>
                      )}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
