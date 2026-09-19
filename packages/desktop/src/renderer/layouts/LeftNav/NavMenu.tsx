import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  BookOpen,
  ChartNoAxesCombined,
  Clock,
  Compass,
  Feather,
  FlaskConical,
  FolderOpen,
  MessageSquare,
  Settings as SettingsIcon,
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
 * ## 2026-09-19 第二刀：图标栏（`GlobalRail`）去掉了
 *
 * 图标栏里那些页面入口**和这一列基本重复**，去掉后把「别处还没有的」搬了过来：
 * 文件管理 / 归档对话 / 资料库（进主清单），内测中心 / 设置（进底部一组）。
 * ⚠️ 加载顺序：**先做这一列，再删图标栏** —— 反过来会出现"某些页面没入口"的空窗。
 *
 * ## 两个刻意的决定
 *
 * 1. ⚠️ **「角色中心」没有放进来** —— 设计稿上有这一项，但**我们没有任何对应功能**
 *    （内部把 6 个预设助手叫 `presetAgents.roles.*`，但没有"角色中心"这个页面）。
 *    放一个点不动的入口比不放更糟。**待定。**
 * 2. ⚠️ **「签到 / 教程 / 升级」也没放** —— 同样找不到对应功能。**待定。**
 *
 * ## 与图不一致的地方（有意为之）
 *
 * 图上「团队 / 智能体市场 / 游戏化中心」的文案与我们既有叫法不同
 * （我们叫「团队协作 / 助手市场 / 成长中心」）。这里用**设计稿的文案**，
 * 但**没有去改那些既有页面的标题** —— 免得一处调整牵动全应用文案。
 */
export interface NavMenuProps {
  mainView: MainView;
  settingsOpen: boolean;
  onSelectView: (view: MainView) => void;
  /** 「设置」是覆盖层，不是 `mainView`。 */
  onOpenSettings: () => void;
  /** 有更新时给「设置」挂个角标（原来在图标栏上，本刀搬过来）。 */
  hasUpdate: boolean;
  /**
   * 「我的助手」切换器 —— 渲染在**「身份中心」上面那一行**（2026-09-19 用户要求：
   * 「把他放身份中心上面，点击后可以选择这几个角色」）。
   * 它是插在列表里的一个槽位，不是 `mainView` 项。
   */
  assistantSlot?: ReactNode;
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

export default function NavMenu({
  mainView,
  settingsOpen,
  onSelectView,
  onOpenSettings,
  hasUpdate,
  assistantSlot,
}: NavMenuProps) {
  const { t } = useTranslation();

  // ⚠️ 顺序**照设计稿**排（不是按功能分组）。改顺序 = 改与设计稿的对应关系。
  const items: NavItem[] = [
    { key: 'search', labelKey: 'leftNav.pages.search', icon: MessageSquare, view: 'chat' },
    { key: 'identity', labelKey: 'leftNav.identityCenter', icon: UserRound, view: 'identity' },
    { key: 'teams', labelKey: 'leftNav.pages.teams', icon: Users, view: 'teams', badge: 'Beta' },
    // T-a2：从 `onClick`（打开设置并定位）改成**真正的主页面**。
    // ⚠️ 顺带修掉了下面那条"不显示选中态"的注释里写的缺口 —— 它当时就是因为
    //    这一项不是 `mainView` 才没有选中态。
    { key: 'skills', labelKey: 'leftNav.pages.skills', icon: Sparkles, view: 'skills' },
    { key: 'agents', labelKey: 'leftNav.pages.agents', icon: Store, view: 'market' },
    { key: 'bounty', labelKey: 'leftNav.pages.bounty', icon: Target, view: 'bounty' },
    { key: 'square', labelKey: 'leftNav.pages.square', icon: Compass, view: 'community' },
    { key: 'creator', labelKey: 'leftNav.pages.creator', icon: Feather, view: 'creator' },
    { key: 'usage', labelKey: 'leftNav.usageOverview', icon: ChartNoAxesCombined, view: 'dashboard' },
    { key: 'growth', labelKey: 'leftNav.pages.growth', icon: Trophy, view: 'growth' },
    { key: 'cron', labelKey: 'cron.title', icon: Clock, view: 'cron' },
    // ── 以下三项是从**图标栏**搬来的（本刀去掉图标栏）──
    { key: 'files', labelKey: 'common.fileManager', icon: FolderOpen, view: 'files' },
    { key: 'archived', labelKey: 'leftNav.archivedChats', icon: Archive, view: 'archived' },
    { key: 'kb', labelKey: 'kb.title', icon: BookOpen, view: 'kb' },
  ];

  /** 底部一组：设置类入口（原来在图标栏最下面）。 */
  const footItems: NavItem[] = [
    { key: 'betaHub', labelKey: 'beta.title', icon: FlaskConical, view: 'betaHub' },
    {
      key: 'settings',
      labelKey: hasUpdate ? 'leftNav.updateAvailable' : 'leftNav.appSettings',
      icon: SettingsIcon,
      onClick: onOpenSettings,
      badge: hasUpdate ? '•' : undefined,
    },
  ];

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    // ⚠️ 「设置」是覆盖层，而**这一层拿不到"设置停在哪一节"**（那是 App.tsx 的局部 state）
    //    ⇒ 它经过时不显示选中态。这是个已知的小缺口：要做对得把 settingsSection 也传下来。
    //    （「技能市场」原来是同一个缺口 —— 它已经不在这里了，见上面 items 里的说明。）
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
  };

  return (
    <nav data-testid="left-nav-menu" aria-label={t('leftNav.pages.search')} className="flex flex-col gap-0.5 px-2">
      {/* ⚠️ 助手切换器插在**「身份中心」上面**（用户点名要的位置）。
          写法是「第 0 项 + 助手槽位 + 其余项」—— 别改成 `items.map` 里塞条件，
          那样顺序会随 `items` 的增删飘掉。 */}
      {renderItem(items[0])}
      {assistantSlot}
      {items.slice(1).map(renderItem)}
      <div className="mx-2.5 my-1.5 border-t border-[var(--border-subtle)]" />
      {footItems.map(renderItem)}
    </nav>
  );
}
