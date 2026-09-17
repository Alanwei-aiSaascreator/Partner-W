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
 */
export default function MarketPanel() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('market');

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
