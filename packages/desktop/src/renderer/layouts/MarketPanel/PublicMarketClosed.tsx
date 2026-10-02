import { useTranslation } from 'react-i18next';
import { Store } from 'lucide-react';

/**
 * 公开市场的**关闭态**（W07-57 / 需求 7，2026-10-03）。
 *
 * 直接视图（左侧导航/哈希路由落到市场）在关闭期间渲染这个，而不是 `MarketTab`：
 * 不发任何 `market:templates` / `market:detail` 请求，也不给安装入口。
 *
 * ⚠️ 文案必须**指明私有模板在哪**（「创作者中心 · 我的模板」）—— 只写"已关闭"
 *    会让既有创作者找不到自己的资料（P12 的纪律：为存量 MyTemplates 保留明确通路）。
 */
export default function PublicMarketClosed() {
  const { t } = useTranslation();
  return (
    <div data-testid="public-market-closed" className="flex h-full items-center justify-center px-6">
      <div className="max-w-md rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-5 py-6 text-center">
        <Store size={22} className="mx-auto mb-3 text-[var(--text-muted)]" aria-hidden />
        <p className="type-body font-medium text-[var(--text-primary)]">{t('market.publicClosedTitle')}</p>
        <p className="type-support mt-2 text-[var(--text-secondary)]">{t('market.publicClosedBody')}</p>
      </div>
    </div>
  );
}
