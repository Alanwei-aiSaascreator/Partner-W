import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  GraduationCap,
  List,
  MoreHorizontal,
  Plus,
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
  /** 2026-10-17 按设计稿：顶部第一行「新建任务」（原来是搜索框旁边的小图标）。 */
  onNewTask?: () => void;
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
  icon: typeof Plus;
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
  /** 「新建任务」这类主动作行：文字用强调色（设计稿同款）。 */
  accent?: boolean;
};

export default function NavMenu({
  mainView,
  settingsOpen,
  onSelectView,
  assistantSlot,
  onNewTask,
  collapsed = false,
}: NavMenuProps) {
  const { t } = useTranslation();
  const [moreOpen, setMoreOpen] = useState(false);

  /*
    2026-10-18：「更多」展开后**必须收得回去**。
    现场反馈：点开「更多」再切到别处（对话 / 其它页 / 任务行），它一直摊着，
    一整列二级入口把任务列表挤到看不见（用户原话"左边栏坏了"）。
    规则：① mainView 一变就复位；② 点「更多」以外的地方也收起；
         ③ 点主入口导航项也收起（点在对话页里时 mainView 不变，effect 救不到）。
  */
  const moreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMoreOpen(false);
  }, [mainView]);

  useEffect(() => {
    if (!moreOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [moreOpen]);

  /*
    2026-10-18（用户实测）：左栏顶部六行 ——
      新建任务 / 罗盘助手（助手槽位）/ 团队 / 技能库 / 智能体 / 智能体市场 / 更多，
    其余页面全部收进「更多」。底部三个入口（用量与积分 / 游戏化中心 / 应用设置）
    搬到左栏最底部的个人资料卡（`ProfileMenu`），不在这张清单里。

    「资料库」从顶部挪进「更多」（2026-10-18 用户点名）：
    顶部让位给「智能体市场」，资料库入口**保留**、只降级为次级项。
  */
  const topItems: NavItem[] = [
    {
      key: 'new-task',
      labelKey: 'common.newTask',
      icon: Plus,
      onClick: onNewTask,
      accent: true,
    },
    { key: 'teams', labelKey: 'leftNav.pages.teams', icon: Users, view: 'teams', badge: 'Beta' },
    { key: 'skills', labelKey: 'leftNav.pages.skills', icon: Sparkles, view: 'skills' },
    // 设计稿叫「智能体」；底下的真实页面是专家库（`layouts/ExpertsPanel`）。
    { key: 'experts', labelKey: 'leftNav.pages.agentsSimple', icon: GraduationCap, view: 'experts' },
    // 「智能体市场」原在「更多」里，2026-10-18 换到顶部（资料库让位）。
    // ⚠️ 公开市场关闭时**只置灰不删入口**：`disabled` + `title` 说明（见类型注释）。
    {
      key: 'agents',
      labelKey: 'leftNav.pages.agents',
      icon: Store,
      view: 'market',
      disabled: PUBLIC_MARKET_CLOSED,
      disabledTitleKey: 'market.publicClosedTitle',
    },
  ];

  /** 「更多」里的次级入口：保留全部既有页面，一个都不删。 */
  const moreItems: NavItem[] = [
    { key: 'tasks', labelKey: 'leftNav.recentTasks', icon: List, view: 'tasks' },
    { key: 'identity', labelKey: 'leftNav.identityCenter', icon: UserRound, view: 'identity' },
    // 「资料库」2026-10-18 从顶部移入「更多」（入口不丢）。
    { key: 'kb', labelKey: 'kb.title', icon: BookOpen, view: 'kb' },
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
    { key: 'files', labelKey: 'common.fileManager', icon: FolderOpen, view: 'files' },
    { key: 'archived', labelKey: 'leftNav.archivedChats', icon: Archive, view: 'archived' },
    ...(isInternalBetaEnabled()
      ? ([{ key: 'betaHub', labelKey: 'beta.title', icon: FlaskConical, view: 'betaHub' }] satisfies NavItem[])
      : []),
  ];

  const renderItem = (item: NavItem, after?: () => void) => {
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
        onClick={() => {
          // 点主入口 ⇒ 收起「更多」（2026-10-18；点在里面那一项由 `after` 负责）。
          if (!moreItems.includes(item)) setMoreOpen(false);
          if (item.onClick) item.onClick();
          else if (item.view) onSelectView(item.view);
          after?.();
        }}
        className={cn(
          'titlebar-no-drag glow-focus relative flex w-full items-center rounded-lg text-left type-body transition-colors',
          collapsed ? 'justify-center py-2' : 'gap-2.5 px-2.5 py-1.5',
          item.disabled
            ? 'cursor-not-allowed text-[var(--text-muted)] opacity-60'
            : item.muted
              ? 'text-[var(--text-muted)] opacity-60 hover:opacity-80'
              : item.accent
                ? 'text-[var(--accent)] hover:bg-[var(--accent-dim)]'
                : active
                  ? 'bg-[var(--state-selected)] font-semibold text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        )}
      >
        {active && (
          <span
            aria-hidden="true"
            className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full [background:var(--brand-gradient)]"
          />
        )}
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

  /** 「更多」触发行（设计稿最后一项，`…` 图标）。 */
  const moreButton = (
    <button
      type="button"
      data-nav="more"
      aria-haspopup="menu"
      aria-expanded={moreOpen}
      aria-label={collapsed ? t('leftNav.pages.more') : undefined}
      onClick={() => setMoreOpen((open) => !open)}
      className={cn(
        'titlebar-no-drag glow-focus relative flex w-full items-center rounded-lg text-left type-body transition-colors',
        collapsed ? 'justify-center py-2' : 'gap-2.5 px-2.5 py-1.5',
        moreOpen
          ? 'bg-[var(--state-selected)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <MoreHorizontal size={collapsed ? 18 : 15} className="flex-shrink-0" />
      <span className={cn('min-w-0 flex-1 truncate', collapsed && 'hidden')}>{t('leftNav.pages.more')}</span>
    </button>
  );

  return (
    <nav data-testid="left-nav-menu" aria-label={t('leftNav.pages.search')} className="flex flex-col gap-0.5 px-2">
      {/* 顺序：新建任务 → 罗盘助手（助手槽位）→ 团队 / 技能库 / 智能体 / 智能体市场 → 更多。 */}
      {renderItem(topItems[0])}
      {assistantSlot}
      {topItems.slice(1).map((item) => renderItem(item))}
      {/* 「更多」= 就地展开的次级清单（不弹浮层：浮层要 portal，收起态也更好操作）。
          ⚠️ 触发器与清单同在一个 ref 块里：点它自己不算"点外面"（开合是它的事）。 */}
      <div ref={moreRef} className="flex flex-col gap-0.5">
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>{moreButton}</TooltipTrigger>
            <TooltipContent side="right">{t('leftNav.pages.more')}</TooltipContent>
          </Tooltip>
        ) : (
          moreButton
        )}
        {moreOpen ? (
          <div data-testid="left-nav-more-items" className="flex flex-col gap-0.5 pb-1 pl-3">
            {moreItems.map((item) => renderItem(item, () => setMoreOpen(false)))}
          </div>
        ) : null}
      </div>
    </nav>
  );
}
