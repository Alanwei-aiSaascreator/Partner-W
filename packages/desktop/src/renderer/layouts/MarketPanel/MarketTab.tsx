import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Compass, Loader2, Search, X } from 'lucide-react';
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
import { useSelectAgent } from '@/hooks/useSelectAgent';
import type { TemplateInstallOutcome } from '@/lib/template-install';
import { useTemplateInstall } from './useTemplateInstall';

/**
 * 助手市场（能力入口）。
 *
 * 三条纪律：
 *   ① 列表与详情都走 `window.clawwork.market*`（服务端可见性由 definer RPC 判定）；
 *   ② 动作是**「在罗盘助手中使用」**（2026-10-06，BUG-025）：拉详情（要提示词）后交给
 *      `useTemplateInstall` 在本地网关把助手备好（**已有则幂等跳过**），再用
 *      `useSelectAgent`（**全应用唯一切助手的那条路**）直达对应罗盘助手。
 *      这里**不造**「安装 → 安装成功 → 去使用」第二套流程，也不新建页面/详情；
 *      「已安装 / 安装数」这类 Agent Store 式状态一律不上屏。
 *   ③ 失败文案走 i18n（`messageKey`/`describeTemplateErrorKey` 的产物 + 中文回落），
 *      界面里不出现机器码/英文。
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
  const { install, installingIds, beginInstall, endInstall } = useTemplateInstall();
  /** 直达罗盘助手（唯一的那条切助手动作，见 `hooks/useSelectAgent.ts`）。 */
  const selectAgent = useSelectAgent();
  /**
   * ⭐ 同步去重（2026-10-07 质检 P1-1）：`installingIds` 是 **state**，同一 tick 里的
   * 第二次点击读到的还是旧值 —— 双击会在"拉详情"窗口期发起第二条链（装两次、记两次账）。
   * 所以入口处必须用 ref 做**同步**拦截，state 只负责渲染置忙。
   */
  const inFlightRef = useRef(new Set<string>());

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

  /**
   * 拉详情（卡片点击「看提示词」与「在罗盘助手中使用」共用）。
   *
   * ⚠️ 失败**两种**（`{ok:false}` 与 IPC reject）都要有反馈且不许漏出 rejection：
   *    调用方 `onClick` 是 fire-and-forget 的，漏出去就是 unhandled rejection + 零反馈。
   *    ⇒ 文案与 toast 都收在这里；返回 null 表示"没拿到，调用方只需 return"。
   */
  const openDetail = useCallback(
    async (id: string): Promise<AgentTemplateDetail | null> => {
      let res: Awaited<ReturnType<typeof window.clawwork.marketTemplateDetail>>;
      try {
        res = await window.clawwork.marketTemplateDetail(id);
      } catch (error) {
        console.error('[market] 能力详情请求异常:', error);
        toast.error(t('market.loadFailed'));
        return null;
      }
      const parsed = res.ok ? normalizeTemplateDetail(res.result) : null;
      if (parsed) {
        setDetail(parsed);
        return parsed;
      }
      toast.error(t('market.loadFailed'));
      return null;
    },
    [t],
  );

  /**
   * 「在罗盘助手中使用」：把能力备好（幂等）**然后直接切到那个助手**。
   *
   * ⚠️ 刻意**没有**「安装中 → 安装成功 → 去助手栏看看吧」这条链：
   *    用户点完就是**已经在用**（会话页打开、助手已选中），中间不隔一层状态页/提示语。
   * ⚠️ `installTemplate` 对已存在的助手是**幂等跳过**（网关那边不重造），所以
   *    不需要先问「装过没有」——那正是 Agent Store 式状态（已安装/安装数）的来源。
   */
  const handleUseInCompass = useCallback(
    async (template: AgentTemplateSummary): Promise<void> => {
      // ⭐ ① 同步去重：同 id 已经在飞 ⇒ 第二次点击直接忽略（state 在这一 tick 还是旧值，
      //    撑不住双击；hook 层的同 id 去重只覆盖 `install()` 那后半段）。
      if (inFlightRef.current.has(template.id)) return;
      inFlightRef.current.add(template.id);
      // ⭐ ② 入口即置忙（**拉详情之前**）：从点下去那一刻按钮就禁用并显示「正在准备…」。
      beginInstall(template.id);
      try {
        // 备好助手要用提示词 ⇒ 先拿详情（顺带让用户看到它要做什么）；
        // 失败文案由 `openDetail` 自己给（见它的注释），这里只需要收手。
        const full = await openDetail(template.id);
        if (!full) return;

        let outcome: TemplateInstallOutcome;
        try {
          outcome = await install(full);
        } catch (error) {
          console.error('[market] 在罗盘助手中打开异常:', error);
          toast.error(t('market.actionFailed'));
          return;
        }
        if (!outcome.ok || !outcome.agentId) {
          if (outcome.ok) console.error('[market] 备好助手但没拿到助手标识:', template.id);
          if (outcome.diagnostic) console.error('[market] 备好助手失败:', outcome.diagnostic);
          // ⭐ 优先用 i18n 键（9 语言）；键缺失/纯函数层才回落中文 message（质检 P1-2）。
          toast.error(outcome.messageKey ? t(outcome.messageKey) : (outcome.message ?? t('market.actionFailed')));
          return;
        }
        if (outcome.recordWarning) toast.warning(t('market.recordWarning'));

        // 直达对应罗盘助手（不新建页面、不造第二套流程）。
        selectAgent(outcome.agentId);
      } finally {
        inFlightRef.current.delete(template.id);
        endInstall(template.id);
      }
    },
    [beginInstall, endInstall, install, openDetail, selectAgent, t],
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
              const busy = installingIds.has(row.id);
              return (
                <article
                  key={row.id}
                  data-template={row.id}
                  onClick={() => void openDetail(row.id)}
                  className="cursor-pointer rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4 transition-all hover:-translate-y-0.5 hover:border-[var(--border-accent)] hover:shadow-[var(--shadow-elevated)]"
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
                      {t('market.usageCount', { count: row.installCount })}
                    </span>
                    <Button
                      size="sm"
                      className="brand-action"
                      data-action="use-in-compass"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleUseInCompass(row);
                      }}
                    >
                      {busy ? (
                        <>
                          <Loader2 className="animate-spin" />
                          {t('market.preparing')}
                        </>
                      ) : (
                        <>
                          <Compass />
                          {t('market.useInCompass')}
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
