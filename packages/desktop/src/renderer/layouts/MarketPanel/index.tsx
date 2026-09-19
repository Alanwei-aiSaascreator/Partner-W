import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import MarketTab from './MarketTab';
import MyTemplatesTab from './MyTemplatesTab';

type Tab = 'market' | 'mine';

/**
 * 助手市场 + 创作者中心（P2）。
 *
 * 两个 tab 是同一件事的两面：市场里"装"的那些模板，就是创作者中心"发"的那些。
 * 安装动作在 `useTemplateInstall`（真在本地网关建 agent），这一层只管切 tab。
 *
 * ⚠️ `initialTab` 是给**左侧导航**用的（2026-09-19）：导航里「智能体市场」与
 *    「创作者中心」是两个独立入口，但都落到这个面板 —— 靠初始 tab 区分。
 *    只有**首次挂载**时生效（`useState` 的初值）；用户在里面手动切 tab 不会被拉回去。
 *    调用方要在两个入口之间切换时给出**不同的 `key`**，否则 React 会复用实例、tab 不重置。
 */
export default function MarketPanel({ initialTab = 'market' }: { initialTab?: Tab } = {}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(initialTab);

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'market', label: t('market.tabMarket') },
    { key: 'mine', label: t('market.tabMine') },
  ];

  return (
    <div data-testid="market-panel" className="flex h-full flex-col">
      <div className="flex flex-shrink-0 gap-1 border-b border-[var(--border-subtle)] px-4 pt-4">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
            className={cn(
              'glow-focus rounded-t-md px-3 py-2 type-body transition-colors',
              tab === item.key
                ? 'bg-[var(--state-selected)] text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">{tab === 'market' ? <MarketTab /> : <MyTemplatesTab />}</div>
    </div>
  );
}
