import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PUBLIC_MARKET_CLOSED } from '@clawwork/shared';
import {
  Archive,
  BookOpen,
  ChartNoAxesCombined,
  Clock,
  Compass,
  Feather,
  FlaskConical,
  FolderOpen,
  List,
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
import { toast } from '@/lib/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isInternalBetaEnabled } from '@/features/internal-beta/beta-route';

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
  /**
   * 收纳态（2026-09-29，按体验稿 `侧栏收纳-方案.html`）：整列缩成图标条。
   *
   * ⚠️ **必须带默认值 `false`** —— 既有测试直接渲染这个组件、不传新 prop。
   *
   * 收起时三件事一起做，缺一件都会退化：
   * 1. 标签/角标**用 CSS 隐藏**（`hidden`），**不是**条件渲染 —— 从 DOM 里删掉，
   *    既有的 `textContent` 断言会红，读屏也读不出；
   * 2. 补 `aria-label`（标签 `display:none` 之后可访问名会变空）；
   * 3. 挂 `Tooltip` 说名字。
   * ⚠️ 气泡**只在收起时挂**：Radix 的 `Tooltip.Root` 没有 `TooltipProvider` 会**直接抛**，
   *    而 `left-nav-menu.test.tsx` 正是在没有 provider 的情况下渲染展开态的。
   */
  collapsed?: boolean;
}

type NavItem = {
  key: string;
  labelKey: string;
  icon: typeof MessageSquare;
  /** 点击后落到哪个 `mainView`；不给则用 `onClick`。 */
  view?: MainView;
  onClick?: () => void;
  badge?: string;
  /**
   * 置灰不可点（2026-10-03，公开市场关闭期间用）：入口**保留可见**，
   * 但挡住点击、给说明气泡 —— 直接删掉入口会让用户猜"功能没了还是藏了"。
   */
  disabled?: boolean;
  /** 置灰项的说明气泡文案键（`title`）。 */
  disabledTitleKey?: string;
  /**
   * 视觉置灰但**仍可点击**（2026-10-06，用户拍板：「需求悬赏」暂不可用）：
   * 与 `disabled` 同样是灰样式，但不吞点击——点击由 `onClick` 弹「敬请期待」提示。
   * （`button[disabled]` 会吞掉 onClick，所以这类占位入口不能用 `disabled`。）
   */
  muted?: boolean;
};

export default function NavMenu({
  mainView,
  settingsOpen,
  onSelectView,
  onOpenSettings,
  hasUpdate,
  assistantSlot,
  collapsed = false,
}: NavMenuProps) {
  const { t } = useTranslation();

  // ⚠️ 顺序**照设计稿**排（不是按功能分组）。改顺序 = 改与设计稿的对应关系。
  const items: NavItem[] = [
    { key: 'search', labelKey: 'leftNav.pages.search', icon: MessageSquare, view: 'chat' },
    // ⚠️ 位置是**用户点名**的：「最近任务」放在「身份中心」上面（2026-09-20，
    //    原话「在最下面不好，显示也不全」）⇒ 顺序断言在 `left-nav-menu.test.tsx` 里钉着。
    { key: 'tasks', labelKey: 'leftNav.recentTasks', icon: List, view: 'tasks' },
    { key: 'identity', labelKey: 'leftNav.identityCenter', icon: UserRound, view: 'identity' },
    { key: 'teams', labelKey: 'leftNav.pages.teams', icon: Users, view: 'teams', badge: 'Beta' },
    // T-a2：从 `onClick`（打开设置并定位）改成**真正的主页面**。
    // ⚠️ 顺带修掉了下面那条"不显示选中态"的注释里写的缺口 —— 它当时就是因为
    //    这一项不是 `mainView` 才没有选中态。
    { key: 'skills', labelKey: 'leftNav.pages.skills', icon: Sparkles, view: 'skills' },
    // ⚠️ 公开市场关闭期间（W07-57 / 需求 7）：入口置灰不可点，说明气泡指路私有模板。
    //    重开时把 `PUBLIC_MARKET_CLOSED` 改回 false 即可，入口本身不删。
    {
      key: 'agents',
      labelKey: 'leftNav.pages.agents',
      icon: Store,
      view: 'market',
      disabled: PUBLIC_MARKET_CLOSED,
      disabledTitleKey: 'market.publicClosedTitle',
    },
    // 2026-10-06（用户拍板）：需求悬赏暂不可用——置灰 + 点击弹「敬请期待」。
    // 不删入口（直接删会让用户猜"没了还是藏了"——同 disabled 项的既有纪律）。
    {
      key: 'bounty',
      labelKey: 'leftNav.pages.bounty',
      icon: Target,
      muted: true,
      onClick: () => toast(t('leftNav.bountyComingSoon'), { id: 'bounty-coming-soon', duration: 2000 }),
    },
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
    ...(isInternalBetaEnabled()
      ? ([{ key: 'betaHub', labelKey: 'beta.title', icon: FlaskConical, view: 'betaHub' }] satisfies NavItem[])
      : []),
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

    /**
     * 气泡/可访问名。
     *
     * ⚠️ `'•'` 是「有新版本」的**状态点**，不是一个词 —— 把它念进名字里（"有新版本可用 · •"）
     * 只会添乱，所以只把**有词义的**角标（`Beta`）接上去。
     */
    const name = t(item.labelKey);
    const spoken = item.badge && item.badge !== '•' ? `${name} · ${item.badge}` : name;

    const button = (
      <button
        key={item.key}
        type="button"
        data-nav={item.key}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? spoken : undefined}
        disabled={item.disabled}
        aria-disabled={item.disabled || undefined}
        title={item.disabled && item.disabledTitleKey ? t(item.disabledTitleKey) : undefined}
        onClick={() => (item.onClick ? item.onClick() : item.view && onSelectView(item.view))}
        className={cn(
          'titlebar-no-drag glow-focus relative flex w-full items-center rounded-md text-left type-body transition-colors',
          collapsed ? 'justify-center py-2' : 'gap-2.5 px-2.5 py-1.5',
          item.disabled
            ? 'cursor-not-allowed text-[var(--text-muted)] opacity-60'
            : item.muted
              ? 'text-[var(--text-muted)] opacity-60 hover:opacity-80'
              : active
                ? 'bg-[var(--state-selected)] font-semibold text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        )}
      >
        <Icon size={collapsed ? 18 : 15} className="flex-shrink-0" />
        <span className={cn('min-w-0 flex-1 truncate', collapsed && 'hidden')}>{t(item.labelKey)}</span>
        {item.badge && (
          <span
            className={cn(
              'type-badge flex-shrink-0 rounded-full bg-[var(--accent-soft)] px-1.5 text-[var(--accent)]',
              collapsed && 'hidden',
            )}
          >
            {item.badge}
          </span>
        )}
        {/* ⭐ 收起时文字角标藏了，但**信息不许丢**：落成一个角落圆点
            （图标栏 `GlobalRail` 当年就是这么做的），文字部分进气泡/可访问名。
            体验稿这里写的是 `.badge{display:none}`，我们比它多留一个点。 */}
        {collapsed && item.badge && (
          <span
            data-testid="nav-badge-dot"
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--accent)]"
          />
        )}
      </button>
    );

    if (!collapsed) return button;

    return (
      <Tooltip key={item.key}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">{spoken}</TooltipContent>
      </Tooltip>
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
