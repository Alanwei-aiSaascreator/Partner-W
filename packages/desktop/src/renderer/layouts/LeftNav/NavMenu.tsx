import { useTranslation } from 'react-i18next';
import {
  ChartNoAxesCombined,
  Clock,
  Compass,
  Feather,
  MessageSquare,
  Sparkles,
  Store,
  Target,
  Trophy,
  UserRound,
  Users,
} from 'lucide-react';
import type { MainView } from '@clawwork/core';
import { cn } from '@/lib/utils';

/**
 * 左侧栏的**页面导航清单**（2026-09-19）。
 *
 * ## 来历
 *
 * 老板给的设计稿把这一列做成了「页面导航」（搜索任务 / 身份中心 / 团队 / …），
 * 而这一列原本装的是「我的助手 + 最近任务」。按拍板口径（方案 B）改成这样：
 * 页面导航按图排，助手切换保留在顶部（见 `LeftNav/index.tsx`）。
 *
 * ## 两个刻意的决定
 *
 * 1. ⚠️ **「角色中心」没有放进来** —— 设计稿上有这一项，但**我们没有任何对应功能**
 *    （内部把 6 个预设助手叫 `presetAgents.roles.*`，但没有"角色中心"这个页面）。
 *    放一个点不动的入口比不放更糟。**待定。**
 * 2. ⚠️ **「签到 / 教程 / 升级」也没放** —— 同样找不到对应功能（成长中心里有签到，
 *    但不是这三个）。**待定。**
 *
 * ## 与图不一致的地方（有意为之）
 *
 * 图上「团队 / 智能体市场 / 游戏化中心」的文案与我们既有叫法不同
 * （我们叫「团队协作 / 助手市场 / 成长中心」）。这里用**设计稿的文案**，
 * 但**没有去改那些既有页面的标题** —— 免得一处调整牵动全应用文案。
 * ⚠️ 后果：同一功能在导航里和页面标题里可能叫法不同。**要不要统一，待定。**
 */
export interface NavMenuProps {
  mainView: MainView;
  settingsOpen: boolean;
  onSelectView: (view: MainView) => void;
  /** 「技能市场」不是独立页面，它在设置面板里 —— 点它 = 打开设置并定位到该节。 */
  onOpenSkills: () => void;
}

type NavItem = {
  key: string;
  labelKey: string;
  icon: typeof MessageSquare;
  /** 点击后落到哪个 `mainView`；不给则用 `onClick`。 */
  view?: MainView;
  onClick?: () => void;
  badge?: string;
};

export default function NavMenu({ mainView, settingsOpen, onSelectView, onOpenSkills }: NavMenuProps) {
  const { t } = useTranslation();

  // ⚠️ 顺序**照设计稿**排（不是按功能分组）。改顺序 = 改与设计稿的对应关系。
  const items: NavItem[] = [
    { key: 'search', labelKey: 'leftNav.pages.search', icon: MessageSquare, view: 'chat' },
    { key: 'identity', labelKey: 'leftNav.identityCenter', icon: UserRound, view: 'identity' },
    { key: 'teams', labelKey: 'leftNav.pages.teams', icon: Users, view: 'teams', badge: 'Beta' },
    { key: 'skills', labelKey: 'leftNav.pages.skills', icon: Sparkles, onClick: onOpenSkills },
    { key: 'agents', labelKey: 'leftNav.pages.agents', icon: Store, view: 'market' },
    { key: 'bounty', labelKey: 'leftNav.pages.bounty', icon: Target, view: 'bounty' },
    { key: 'square', labelKey: 'leftNav.pages.square', icon: Compass, view: 'community' },
    { key: 'creator', labelKey: 'leftNav.pages.creator', icon: Feather, view: 'creator' },
    { key: 'usage', labelKey: 'leftNav.usageOverview', icon: ChartNoAxesCombined, view: 'dashboard' },
    { key: 'growth', labelKey: 'leftNav.pages.growth', icon: Trophy, view: 'growth' },
    { key: 'cron', labelKey: 'cron.title', icon: Clock, view: 'cron' },
  ];

  return (
    <nav data-testid="left-nav-menu" aria-label={t('leftNav.pages.search')} className="flex flex-col gap-0.5 px-2">
      {items.map((item) => {
        const Icon = item.icon;
        // ⚠️ 「技能市场」落在设置面板里，而**这一层拿不到"设置停在哪一节"**
        //    （那是 App.tsx 的局部 state）⇒ 它**不会显示选中态**。
        //    这是个已知的小缺口：要做对得把 settingsSection 也传下来。见文件头"待定"。
        const active = item.view !== undefined && !settingsOpen && mainView === item.view;

        return (
          <button
            key={item.key}
            type="button"
            data-nav={item.key}
            aria-current={active ? 'page' : undefined}
            onClick={() => (item.onClick ? item.onClick() : item.view && onSelectView(item.view))}
            className={cn(
              'titlebar-no-drag glow-focus flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left type-body transition-colors',
              active
                ? 'bg-[var(--state-selected)] font-semibold text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            <Icon size={15} className="flex-shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
            {item.badge && (
              <span className="type-badge flex-shrink-0 rounded-full bg-[var(--accent-soft)] px-1.5 text-[var(--accent)]">
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
