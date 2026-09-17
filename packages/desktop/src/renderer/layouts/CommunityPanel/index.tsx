import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import FeedTab from './FeedTab';
import MemberTab from './MemberTab';

type Tab = 'feed' | 'members';

/**
 * 广场 + 团队（P1）。
 *
 * 两个 tab 共用同一个"当前团队"（数据库里的 `org_members.is_primary`）：
 * 切团队会**同时**影响广场和成员列表，所以切换器放在成员 tab 里，
 * 切完两个 tab 一起变（重新进 tab 时会各自重新拉一次）。
 *
 * 数据来源：`window.clawwork.community*`（main 进程 → Supabase definer RPC）。
 * 权限、可见性一律由数据库判定，这里不做第二套判断。
 */
export default function CommunityPanel() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('feed');

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'feed', label: t('community.tabFeed') },
    { key: 'members', label: t('community.tabMembers') },
  ];

  return (
    <div data-testid="community-panel" className="flex h-full flex-col">
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

      <div className="min-h-0 flex-1">{tab === 'feed' ? <FeedTab /> : <MemberTab />}</div>
    </div>
  );
}
