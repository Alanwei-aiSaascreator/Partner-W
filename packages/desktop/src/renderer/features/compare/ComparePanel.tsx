/**
 * 多模型并排对比面板：N 列并排，各自流式输出，各自「采纳」。
 *
 * ## 布局与失败隔离
 *
 * 每一列是**独立的一格**（`flex-1`），列与列之间没有任何共享状态：一列报错只会让
 * 那一格变成红色 + 「重试」，其余格继续出字。这是刻意的 —— 任何"整轮"的错误聚合
 * 都会把局部失败渲染成整体失败。
 *
 * ## 数据来源
 *
 * 面板自己**不缓存正文**：实时内容从 `messageStore` 按会话键推导（`deriveCompareViews`）。
 * dispatcher 已经在按会话键往里写（delta/thinking/tool/error），对比只负责把它们
 * 按列摆出来 —— 少一份副本，就少一处会和真相不一致的地方。
 *
 * ⚠️ 界面上**只出现积分口径之外的东西一概不显示**（无 token、无官方价格、无倍率）：
 * 这一屏不给任何花费数字。每列的真实扣费在账本里，按各自的调用独立结算。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, RotateCcw, X } from 'lucide-react';
import type { ModelCatalogEntry } from '@clawwork/shared';
import { useMessageStore } from '@/stores/messageStore';
import { Button } from '@/components/ui/button';
import MarkdownContent from '@/components/MarkdownContent';
import ThinkingSection from '@/components/ThinkingSection';
import { resolveModelLabel } from '@/lib/model-display';
import { cn } from '@/lib/utils';
import {
  compareRuntimeForTask,
  deriveCompareViews,
  failedColumnCount,
  hasRunningColumn,
  isColumnAdoptable,
  settledColumnCount,
  type CompareColumnView,
} from './compare-plan';
import { useCompareStore } from './compare-store-instance';

interface ComparePanelProps {
  modelCatalog?: readonly ModelCatalogEntry[];
  /**
   * 当前正在看的任务 id。**必填**：面板只渲染属于自己的那一轮对比。
   *
   * `active` 是全局唯一的，而用户可以切任务 —— 不带任务身份就得靠每个调用点自觉
   *（漏掉一处的表现是：在别人的任务里看到这一屏对比、而且那个任务的消息全被拦下）。
   * 这里再守一道，判据只有一处（`compareRuntimeForTask`）。
   */
  taskId: string | null | undefined;
}

/** 列的运行状态 → 一行人类可读的说明（不显示任何费用口径的数字）。 */
function statusLabel(view: CompareColumnView, t: (key: string, opts?: Record<string, unknown>) => string): string {
  switch (view.status) {
    case 'pending':
      return t('compare.statusPending');
    case 'streaming':
      return t('compare.statusStreaming');
    case 'done':
      return t('compare.statusDone');
    case 'error':
      return t('compare.statusError');
  }
}

function CompareColumn({
  view,
  modelLabel,
  adopting,
  onAdopt,
  onRetry,
}: {
  view: CompareColumnView;
  modelLabel: string;
  /** 有采纳在飞（**任意**一列）：所有「采纳」按钮一起禁用 —— 见 store 的 `adoptingKey`。 */
  adopting: boolean;
  onAdopt: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const adoptable = isColumnAdoptable(view) && !adopting;
  const empty = view.status === 'done' && !view.text.trim() && !view.thinking.trim() && !view.error;

  return (
    <section
      className={cn(
        'flex min-w-0 flex-1 flex-col rounded-lg border bg-[var(--bg-primary)]',
        view.status === 'error' ? 'border-[var(--danger)]' : 'border-[var(--border-subtle)]',
      )}
      aria-label={t('compare.columnLabel', { model: modelLabel })}
      data-testid="compare-column"
      data-column-status={view.status}
      data-column-model={view.model}
    >
      <header className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="min-w-0">
          <div className="type-label truncate text-[var(--text-primary)]" title={modelLabel}>
            {modelLabel}
          </div>
          <div
            className={cn(
              'type-meta truncate',
              view.status === 'error' ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]',
            )}
          >
            {view.status === 'error' && view.error ? view.error : statusLabel(view, t)}
          </div>
        </div>
        {view.status === 'error' ? (
          <Button type="button" variant="ghost" size="sm" onClick={onRetry} data-testid="compare-retry">
            <RotateCcw size={14} className="mr-1" />
            {t('compare.retry')}
          </Button>
        ) : (
          <Button
            type="button"
            variant={adoptable ? 'secondary' : 'ghost'}
            size="sm"
            onClick={onAdopt}
            disabled={!adoptable}
            data-testid="compare-adopt"
          >
            <Check size={14} className="mr-1" />
            {t('compare.adopt')}
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {view.error ? (
          <div className="type-support flex items-start gap-2 text-[var(--danger)]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{view.error}</span>
          </div>
        ) : (
          <>
            {view.thinking && (
              <ThinkingSection
                content={view.thinking}
                streaming={view.status === 'streaming'}
                showCursor={!view.text}
              />
            )}
            {view.text ? (
              <div className="leading-relaxed text-[var(--text-primary)]">
                <MarkdownContent content={view.text} showCursor={view.status === 'streaming'} />
              </div>
            ) : null}
            {empty && <div className="type-support text-[var(--text-muted)]">{t('compare.emptyAnswer')}</div>}
            {!view.text && !view.thinking && !empty && view.status !== 'done' && (
              <div className="type-support text-[var(--text-muted)]">
                {view.runPhase ? t('compare.statusPreparing') : t('compare.statusPending')}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export default function ComparePanel({ modelCatalog, taskId }: ComparePanelProps) {
  const { t } = useTranslation();
  const active = useCompareStore((s) => s.active);
  const adoptingKey = useCompareStore((s) => s.adoptingKey);
  const adopt = useCompareStore((s) => s.adopt);
  const retry = useCompareStore((s) => s.retry);
  const dismiss = useCompareStore((s) => s.dismiss);

  // 只认**属于当前任务**的那一轮：别的任务在跑对比时，这一屏不是它的位置（见 props 说明）。
  const runtime = compareRuntimeForTask(active, taskId);

  // 订阅**四个按会话键索引的字段**：正文、processing、错误、相位。
  // 分开订阅是因为 zustand 的相等判断是按字段做的，合起来订阅会让每次 delta 都重渲整棵面板树。
  const activeTurnBySession = useMessageStore((s) => s.activeTurnBySession);
  const processingBySession = useMessageStore((s) => s.processingBySession);
  const errorBySession = useMessageStore((s) => s.errorBySession);
  const runPhaseBySession = useMessageStore((s) => s.runPhaseBySession);

  const views = useMemo(
    () =>
      runtime
        ? deriveCompareViews(runtime, {
            activeTurnBySession: activeTurnBySession as never,
            processingBySession,
            errorBySession,
            runPhaseBySession,
          })
        : [],
    [runtime, activeTurnBySession, processingBySession, errorBySession, runPhaseBySession],
  );

  if (!runtime) return null;

  const failed = failedColumnCount(views);
  const running = hasRunningColumn(views);

  return (
    <div className="flex h-full flex-col" data-testid="compare-panel">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-3">
        <div className="min-w-0">
          <div className="type-section-title text-[var(--text-primary)]">{t('compare.title')}</div>
          <div className="type-meta text-[var(--text-muted)]">
            {t('compare.progress', { settled: settledColumnCount(views), total: views.length })}
            {failed > 0 ? ` · ${t('compare.failedColumns', { count: failed })}` : ''}
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={dismiss} data-testid="compare-dismiss">
          <X size={14} className="mr-1" />
          {running ? t('compare.cancel') : t('compare.close')}
        </Button>
      </div>

      {/* 用户问的是什么，必须一直看得见 —— 否则并排的几列像在自说自话。 */}
      <div className="border-b border-[var(--border-subtle)] px-5 py-2">
        <div className="type-support whitespace-pre-wrap text-[var(--text-secondary)]">{runtime.prompt}</div>
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto px-5 py-3">
        <div className="flex h-full min-w-0 gap-3">
          {views.map((view) => (
            <CompareColumn
              key={view.sessionKey}
              view={view}
              // 展示名走网关目录；目录里没有就退回 id（与消息徽章同一条规则，绝不显示空白）。
              modelLabel={resolveModelLabel(view.model, modelCatalog) ?? view.model}
              adopting={adoptingKey !== null}
              onAdopt={() => adopt(view.sessionKey)}
              onRetry={() => retry(view.sessionKey)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
