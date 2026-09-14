import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChevronDown, RefreshCw } from 'lucide-react';
import type { DashboardBreakdownEntry, DashboardModelUsage } from '@clawwork/shared';
import { PROVIDER_DISPLAY_NAMES } from '@clawwork/shared';
import { useDashboardStore } from '@/stores/dashboardStore';
import { useCommercialStore } from '@/stores/commercialStore';
import { formatCredits, formatRmb, formatTokenCount } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { resolveAgentDisplayNameKey } from '@/lib/preset-agents';

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
      <div className="type-label text-[var(--text-secondary)]">{label}</div>
      <div className="mt-2 type-page-title text-[var(--text-primary)]">{value}</div>
      {hint ? <div className="mt-1 type-meta text-[var(--text-muted)]">{hint}</div> : null}
    </div>
  );
}

function SectionHeader({ text, scope }: { text: string; scope?: string }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <span className="type-section-title text-[var(--text-secondary)]">{text}</span>
      {scope ? (
        <span className="type-meta rounded border border-[var(--border-subtle)] px-1.5 py-0.5 text-[var(--text-muted)]">
          {scope}
        </span>
      ) : null}
    </div>
  );
}

function BreakdownTile({
  label,
  entries,
  emptyText,
}: {
  label: string;
  entries: DashboardBreakdownEntry[];
  emptyText: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
      <div className="type-label mb-4 text-[var(--text-secondary)]">{label}</div>
      {entries.length === 0 ? (
        <div className="type-support text-[var(--text-muted)]">{emptyText}</div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div key={entry.name}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="type-body truncate text-[var(--text-primary)]">{entry.name}</span>
                <span className="type-support flex-shrink-0 text-[var(--text-muted)]">{entry.count}</span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-[var(--border)]">
                <div className="h-full bg-[var(--accent)]" style={{ width: `${entry.percent}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 价格数字的显示格式：**去掉无意义的尾零**，但保留有效精度。
 * `Number(x.toFixed(4))` 之后再 String() —— 1.6 不会变成 "1.6000"，
 * 0.3333333 也不会因为取整变成 0。
 */
function fmtNum(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return String(Number(value.toFixed(4)));
}

function DetailRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex-shrink-0 text-[var(--text-muted)]" title={hint}>
        {label}
      </span>
      <span className="text-right tabular-nums text-[var(--text-secondary)]">{value}</span>
    </div>
  );
}

/**
 * 透明计费明细（M4）。全部来自**落账时的快照**，不是拿今天的价目回算的。
 *
 * ⚠️ 文案红线（用户 2026-09-12 明确要求）：
 *   · 「官方参考价 / 官方参考费用」**不是**供应商实际成本 —— 我们没做供应商
 *     账单对账，也没有阶梯折扣/返点/税的数据。所以**不许**写「供应商账单」
 *     「供应商实付」「官方实付」。
 *   · 「目标倍率 1.6×」**不表示每次结算都精确 1.6×** —— 售价经过 ceil，
 *     跨档重定价与 greatest 不退款都会让实际结算倍率偏离。想表达实际值，
 *     只能用 `effectiveMultiplier`（并且要跟覆盖率一起看）。
 *   · 历史行没有快照时显示「历史记录未保存官方价格快照」，**不许显示 0 元**。
 */
function BillingDetail({ entry }: { entry: DashboardModelUsage }) {
  const { t } = useTranslation();

  const hasSnapshot = entry.settledCalls > 0;
  const priceUnavailable = entry.pricingMixed
    ? t('dashboard.ledger.multiTier')
    : hasSnapshot
      ? t('dashboard.ledger.notRecorded')
      : t('dashboard.ledger.historicalNoSnapshot');

  // ⚠️ 单位只跟在**真的有数字**的时候 —— 否则会渲染成「未记录 元/百万 token」，
  //    读起来像「未记录」是一种单位。
  const hasOfficialPrice =
    !entry.pricingMixed && (entry.officialInputYuanPerMtok !== null || entry.officialOutputYuanPerMtok !== null);
  const hasSaleRate =
    !entry.pricingMixed && (entry.saleInputYuanPerMtok !== null || entry.saleOutputYuanPerMtok !== null);

  const priceText = !hasOfficialPrice
    ? priceUnavailable
    : `${[
        `in ${fmtNum(entry.officialInputYuanPerMtok)}`,
        // mode=none ⇒ 本来就没有缓存价，显示 N/A 而不是 0
        entry.officialCachePricingMode === 'none'
          ? `cached ${t('dashboard.ledger.cachedNa')}`
          : `cached ${fmtNum(entry.officialCachedYuanPerMtok)}`,
        `out ${fmtNum(entry.officialOutputYuanPerMtok)}`,
      ].join(' · ')} ${t('dashboard.ledger.perMtok')}`;

  const saleText = !hasSaleRate
    ? entry.pricingMixed
      ? t('dashboard.ledger.multiTier')
      : t('dashboard.ledger.notRecorded')
    : `${[
        `in ${fmtNum(entry.saleInputYuanPerMtok)}`,
        entry.saleCachedYuanPerMtok === null
          ? `cached ${t('dashboard.ledger.cachedNa')}`
          : `cached ${fmtNum(entry.saleCachedYuanPerMtok)}`,
        `out ${fmtNum(entry.saleOutputYuanPerMtok)}`,
      ].join(' · ')} ${t('dashboard.ledger.perMtok')}`;

  // 官方参考费用：算不出就是算不出（不是 0）；覆盖不全时如实标注覆盖条数
  const officialCostText =
    entry.officialReferenceCostMicros === null
      ? t('dashboard.ledger.notAvailable')
      : entry.officialReferenceComplete
        ? `${formatCredits(entry.officialReferenceCostMicros)} ${t('usage.creditsUnit')}`
        : `${formatCredits(entry.officialReferenceCostMicros)} ${t('usage.creditsUnit')} (${t(
            'dashboard.ledger.covered',
          )} ${entry.officialReferenceCoveredCalls}/${entry.settledCalls})`;

  return (
    <div className="mt-2 space-y-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2.5 py-2 type-meta">
      <DetailRow
        label={t('dashboard.ledger.actualTokens')}
        value={`in ${formatTokenCount(entry.inputTokens)} · cached ${formatTokenCount(entry.cachedTokens)} · out ${formatTokenCount(entry.outputTokens)}`}
      />
      {/* 实际扣费：账本事实。人民币是等值换算（1 元 = 100 积分）。 */}
      <DetailRow
        label={t('dashboard.ledger.actualCharge')}
        value={`${formatCredits(entry.costMicros)} ${t('usage.creditsUnit')} ≈ ¥${formatRmb(entry.costMicros)}`}
      />
      <DetailRow
        label={t('dashboard.ledger.officialPrice')}
        value={priceText}
        hint={t('dashboard.ledger.officialPriceHint')}
      />
      <DetailRow
        label={t('dashboard.ledger.officialCost')}
        value={officialCostText}
        hint={t('dashboard.ledger.officialCostHint')}
      />
      <DetailRow
        label={t('dashboard.ledger.targetMultiplier')}
        value={fmtNum(entry.targetMultiplier) === '—' ? '—' : `${fmtNum(entry.targetMultiplier)}×`}
        hint={t('dashboard.ledger.targetMultiplierHint')}
      />
      <DetailRow label={t('dashboard.ledger.saleRate')} value={saleText} />
      {/* 实际结算倍率：只在**覆盖完整**时才有值（分子分母必须是同一批记录） */}
      {entry.effectiveMultiplier !== null ? (
        <DetailRow
          label={t('dashboard.ledger.effectiveMultiplier')}
          value={`${fmtNum(entry.effectiveMultiplier)}×`}
          hint={t('dashboard.ledger.effectiveMultiplierHint')}
        />
      ) : null}
    </div>
  );
}

/**
 * 模型消耗。这是全页**唯一**按「实际调用模型」统计的板块 ——
 * 数据来自服务端计费表（每次调用一行，model 是真正发到上游的那个名字）。
 *
 * 它回答的是「钱花在哪了」：用户从 qwen-plus 切到 kimi-k3，这里就分两行；
 * 网关自动回退时，出现的是**实际生效**的模型而不是界面上选的那个。
 *
 * ⚠️ 不要退回读本地 `tasks.model` —— 那是会话选中的模型，看不出切换也看不出回退。
 */
function ModelUsageRow({ entry }: { entry: DashboardModelUsage }) {
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const providerName = PROVIDER_DISPLAY_NAMES[entry.provider] ?? entry.provider;

  return (
    <div className="border-t border-[var(--border-subtle)] py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="type-body truncate text-[var(--text-primary)]" title={`${entry.provider}/${entry.model}`}>
            {entry.model}
          </div>
          <div className="mt-1 type-meta text-[var(--text-muted)]">{providerName}</div>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className="type-label text-[var(--text-primary)]">
            {formatCredits(entry.costMicros)} {t('usage.creditsUnit')}
          </div>
          <div className="mt-1 type-meta text-[var(--text-muted)]">
            {formatTokenCount(entry.totalTokens)} · {entry.calls} {t('dashboard.calls')}
          </div>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="mt-2 -ml-3"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        {detailsOpen ? t('dashboard.hideBillingDetails') : t('dashboard.showBillingDetails')}
        <ChevronDown size={14} className={detailsOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
      </Button>
      {detailsOpen ? <BillingDetail entry={entry} /> : null}
    </div>
  );
}

function ModelUsageTile({
  entries,
  emptyText,
  unavailableText,
}: {
  entries: DashboardModelUsage[] | null;
  emptyText: string;
  unavailableText: string;
}) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
      <div className="mb-5 type-support text-[var(--text-muted)]">{t('dashboard.actualModel')}</div>
      {entries === null ? (
        <div className="type-support text-[var(--text-muted)]">{unavailableText}</div>
      ) : entries.length === 0 ? (
        <div className="type-support text-[var(--text-muted)]">{emptyText}</div>
      ) : (
        <div>
          {entries.map((entry) => (
            <ModelUsageRow key={`${entry.provider} ${entry.model}`} entry={entry} />
          ))}
        </div>
      )}
      {entries && entries.length > 0 ? (
        <div className="mt-4 type-meta text-[var(--text-muted)]">{t('dashboard.ledger.settledNote')}</div>
      ) : null}
    </div>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  const data = useDashboardStore((s) => s.data);
  const loading = useDashboardStore((s) => s.loading);
  const fetchDashboard = useDashboardStore((s) => s.fetch);
  const commercialOverview = useCommercialStore((s) => s.overview);
  const loadCommercial = useCommercialStore((s) => s.load);
  const refreshCommercial = useCommercialStore((s) => s.refresh);

  useEffect(() => {
    void fetchDashboard();
    void loadCommercial();
  }, [fetchDashboard, loadCommercial]);

  const handleRefresh = useCallback(() => {
    void fetchDashboard(true);
    void refreshCommercial();
  }, [fetchDashboard, refreshCommercial]);

  const last30d = data?.last30d;
  const placeholder = '—';
  const agentEntries = (data?.breakdowns.agents ?? []).map((entry) => {
    const displayNameKey = resolveAgentDisplayNameKey(entry.name);
    return displayNameKey ? { ...entry, name: t(displayNameKey) } : entry;
  });
  const topAgent = agentEntries[0] ?? null;
  const license = commercialOverview?.license ?? null;
  const quotaMicros = license?.tokenQuotaMicros ?? null;
  const usedMicros = license?.tokenUsedMicros ?? null;
  const remainingMicros = quotaMicros === null || usedMicros === null ? null : Math.max(0, quotaMicros - usedMicros);
  const remainingPercent =
    quotaMicros && remainingMicros !== null ? Math.min(100, (remainingMicros / quotaMicros) * 100) : 0;

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl space-y-8 p-6 pb-10">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="type-page-title text-[var(--text-primary)]">{t('dashboard.title')}</h1>
            <p className="mt-1 max-w-2xl type-body text-[var(--text-muted)]">{t('dashboard.description')}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={loading}
            aria-label={t('dashboard.refresh')}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
            {t('dashboard.refresh')}
          </Button>
        </header>

        <section>
          <SectionHeader text={t('dashboard.allTimeSection')} />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Tile
              label={t('dashboard.totalTasks')}
              value={data ? data.totalTasks.toLocaleString() : placeholder}
              hint={t('dashboard.localScope')}
            />
            <Tile
              label={t('dashboard.activeDays')}
              value={data ? data.activeDays.toLocaleString() : placeholder}
              hint={t('dashboard.localScope')}
            />
            <Tile
              label={t('dashboard.remainingCredits')}
              value={remainingMicros === null ? placeholder : formatCredits(remainingMicros)}
              hint={remainingMicros === null ? t('dashboard.unavailable') : t('dashboard.accountScope')}
            />
            <Tile
              label={t('dashboard.favoriteAssistant')}
              value={topAgent?.name ?? placeholder}
              hint={
                topAgent
                  ? `${t('dashboard.taskCount', { count: topAgent.count })} · ${t('dashboard.localScope')}`
                  : data
                    ? t('dashboard.noAssistantData')
                    : t('dashboard.unavailable')
              }
            />
          </div>
        </section>

        <section>
          <SectionHeader text={t('dashboard.usageSummary')} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <BreakdownTile
              label={t('dashboard.topAgents')}
              entries={agentEntries}
              emptyText={data ? t('dashboard.noAssistantData') : t('dashboard.unavailable')}
            />
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
              <div className="type-label text-[var(--text-secondary)]">{t('dashboard.accountBalance')}</div>
              {quotaMicros === null || usedMicros === null ? (
                <div className="mt-4 type-support text-[var(--text-muted)]">{t('dashboard.unavailable')}</div>
              ) : (
                <div className="mt-4 space-y-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="type-support text-[var(--text-secondary)]">{t('dashboard.remainingCredits')}</span>
                    <span className="type-section-title text-[var(--text-primary)]">
                      {formatCredits(remainingMicros ?? 0)} {t('usage.creditsUnit')}
                    </span>
                  </div>
                  <div
                    className="h-2 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
                    role="progressbar"
                    aria-label={t('dashboard.remainingCredits')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(remainingPercent)}
                  >
                    <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${remainingPercent}%` }} />
                  </div>
                  <div className="flex items-center justify-between type-meta text-[var(--text-muted)]">
                    <span>
                      {t('usage.quotaUsed')} {formatCredits(usedMicros)}
                    </span>
                    <span>
                      {t('usage.quotaTotal')} {formatCredits(quotaMicros)}
                    </span>
                  </div>
                </div>
              )}
              <div className="mt-5 border-t border-[var(--border-subtle)] pt-4 type-support text-[var(--text-muted)]">
                {t('dashboard.totalMessages')} {data ? data.totalMessages.toLocaleString() : placeholder} ·{' '}
                {t('dashboard.totalArtifacts')} {data ? data.totalArtifacts.toLocaleString() : placeholder}
              </div>
            </div>
          </div>
        </section>

        <section>
          <SectionHeader text={t('dashboard.modelUsage')} scope={t('dashboard.accountScope')} />
          <ModelUsageTile
            entries={data?.modelUsage ?? null}
            emptyText={t('dashboard.modelUsageEmpty')}
            unavailableText={t('dashboard.modelUsageUnavailable')}
          />
        </section>

        <section>
          <SectionHeader text={t('dashboard.last30dSection')} scope={t('dashboard.accountScope')} />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <Tile label={t('dashboard.inputTokens')} value={last30d ? formatTokenCount(last30d.input) : placeholder} />
            <Tile
              label={t('dashboard.outputTokens')}
              value={last30d ? formatTokenCount(last30d.output) : placeholder}
            />
            {/* 单位是积分（服务端计费），不再是本机网关估的美元 */}
            <Tile
              label={t('dashboard.credits')}
              value={last30d ? `${formatCredits(last30d.costMicros)} ${t('usage.creditsUnit')}` : placeholder}
            />
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
            <div className="type-label mb-4 text-[var(--text-secondary)]">{t('dashboard.tokenChart')}</div>
            {last30d && last30d.daily.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={last30d.daily}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
                  <YAxis
                    stroke="var(--text-muted)"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v: number) => formatTokenCount(v)}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--bg-primary)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      color: 'var(--text-primary)',
                    }}
                    formatter={(value) => (typeof value === 'number' ? formatTokenCount(value) : String(value ?? ''))}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="input"
                    stroke="var(--accent)"
                    name={t('dashboard.inputTokens')}
                    dot={false}
                    strokeWidth={2}
                  />
                  <Line
                    type="monotone"
                    dataKey="output"
                    stroke="var(--warning)"
                    name={t('dashboard.outputTokens')}
                    dot={false}
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-40 items-center justify-center type-body text-[var(--text-muted)]">
                {t('dashboard.noData')}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
