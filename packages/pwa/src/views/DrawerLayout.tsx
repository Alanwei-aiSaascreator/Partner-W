import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, LazyMotion, domMax, m } from 'framer-motion';
import { Archive, BookOpen, Bot, ChevronDown, CircleDashed, Clock, Compass, FolderOpen, ListChecks, ListOrdered, LogOut, Menu, MessageCircle, PenTool, Rocket, Search, Settings, Sparkles, SquarePen, TrendingUp, Trophy, UserRound, Users, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ArtifactsView } from './ArtifactsView';
import { AgentsView } from './GatewayModulesView';
import { SkillsMarketView } from './SkillsMarketView';
import { BountyView, GrowthView } from './CommercialViews';
import { ArchiveView, KnowledgeView } from './GatewayDataViews';
import { PersonalizeView } from './PersonalizePanelView';
import { CompassView } from './CompassView';
import { ExpertsView } from './ExpertsView';
import { TeamsPanelView } from './TeamsPanelView';
import { DashboardView } from './DashboardView';
import { CronPanelView } from './CronPanelView';
import { CommunityPanelView, CreatorPanelView } from './CommunityCreatorViews';
import { useUiStore, useTaskStore } from '../stores/hooks';
import { AgentSelector } from '../components/AgentSelector';
import { GatewayDebugLog } from '../components/GatewayDebugLog';
import { destroyAllClients } from '../gateway/client-registry';
import { clearAll } from '../persistence/db';
import { TaskList } from '../components/TaskList';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { ApprovalDialog } from '../components/ApprovalDialog';
import { GatewayStatus } from '../components/GatewayStatus';
import { ChatView } from './ChatView';
import { SettingsSheet } from '../components/SettingsSheet';
import { ensureHydrationReady } from '../stores';
import { useOverlay } from '../hooks/useOverlay';

const DRAWER_SPRING = { type: 'spring' as const, damping: 28, stiffness: 320 };
const INSTANT = { duration: 0 };

const NAV_GROUP_ORDER = ['任务', '能力', '我的', '社区', '设置'] as const;

interface NavItem {
  id: string;
  icon: LucideIcon;
  /** 抽屉里用的全名（保留给无障碍标签）。 */
  label: string;
  /** 网格里显示的短名（手机屏宽只够两三个字）。 */
  short?: string;
  /** 分组（手机抽屉按功能分区，不再是一长条电脑式列表）。 */
  group?: string;
  badge?: string;
  ready?: boolean;
}

/**
 * 与桌面端左侧导航一一对应（顺序照抄）。
 *
 * 为什么先摆全部入口：手机上缺一个模块时，用户第一反应是"功能没了"。
 * 这里把入口都列出来，已接通的能点，没接通的明确说"请在电脑端使用"，
 * 后续逐个把 `ready` 打开 —— 而不是让导航看起来少了一半。
 */
const NAV_ITEMS: NavItem[] = [
  { id: 'search', icon: Search, label: '搜索任务', short: '搜索', group: '任务' },
  { id: 'assistant', icon: Compass, label: '罗盘助手', short: '罗盘', group: '能力' },
  { id: 'tasks', icon: ListOrdered, label: '最近任务', short: '任务', group: '任务', ready: true },
  { id: 'personalize', icon: UserRound, label: '个性化中心', short: '个性化', group: '我的' },
  { id: 'team', icon: Users, label: '团队', short: '团队', group: '能力', badge: 'BETA' },
  { id: 'skills', icon: Sparkles, label: '技能市场', short: '技能', group: '能力' },
  { id: 'experts', icon: Rocket, label: '智能体', short: '专家', group: '能力' },
  { id: 'agents', icon: Bot, label: '智能体市场', short: '智能体', group: '能力' },
  { id: 'bounty', icon: CircleDashed, label: '需求悬赏', short: '悬赏', group: '社区' },
  { id: 'square', icon: Compass, label: '广场', short: '广场', group: '社区' },
  { id: 'creator', icon: PenTool, label: '创作者中心', short: '创作', group: '社区' },
  { id: 'usage', icon: TrendingUp, label: '我的 AI 使用概览', short: 'AI 概览', group: '我的' },
  { id: 'game', icon: Trophy, label: '游戏化中心', short: '游戏化', group: '我的' },
  { id: 'cron', icon: Clock, label: '定时任务', short: '定时', group: '我的' },
  { id: 'files', icon: FolderOpen, label: '文件管理', short: '文件', group: '我的' },
  { id: 'archive', icon: Archive, label: '归档对话', short: '归档', group: '我的' },
  { id: 'library', icon: BookOpen, label: '资料库', short: '资料', group: '我的' },
  { id: 'settings', icon: Settings, label: '应用设置', short: '设置', group: '设置', ready: true },
];

interface DrawerLayoutProps {
  onSignedOut: () => void;
}

export function DrawerLayout({ onSignedOut }: DrawerLayoutProps) {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [module, setModule] = useState<
    | null
    | 'agents'
    | 'skills'
    | 'cron'
    | 'archive'
    | 'usage'
    | 'personalize'
    | 'team'
    | 'library'
    | 'square'
    | 'bounty'
    | 'game'
    | 'creator'
    | 'compass'
    | 'experts'
  >(null);
  const [agentSelectorOpen, setAgentSelectorOpen] = useState(false);

  // 首屏的「看看它能做什么」= 打开罗盘助手（跨组件不引 store 依赖，走一个轻量事件桥）
  useEffect(() => {
    const openCompass = (): void => setModule('compass');
    window.addEventListener('clawwork:open-compass', openCompass);
    return () => window.removeEventListener('clawwork:open-compass', openCompass);
  }, []);
  const [debugLogOpen, setDebugLogOpen] = useState(false);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const pendingNewTask = useTaskStore((s) => s.pendingNewTask);
  const tasks = useTaskStore((s) => s.tasks);
  const activeTask = tasks.find((tk) => tk.id === activeTaskId);
  const edgeTouchRef = useRef<number | null>(null);

  const { portalTarget, containerRef, reducedMotion, handleKeyDown } = useOverlay(drawerOpen, () =>
    setDrawerOpen(false),
  );
  const drawerTransition = reducedMotion ? INSTANT : DRAWER_SPRING;

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const handleSignOut = useCallback(async () => {
    if (!window.confirm(t('drawer.signOutConfirm'))) return;
    destroyAllClients();
    await clearAll();
    closeDrawer();
    onSignedOut();
  }, [closeDrawer, onSignedOut, t]);

  const handleNewTask = useCallback(async () => {
    await ensureHydrationReady();
    useTaskStore.getState().startNewTask();
    closeDrawer();
  }, [closeDrawer]);

  const handleNav = useCallback(
    (item: NavItem) => {
      if (item.id === 'settings') {
        useUiStore.getState().setSettingsOpen(true);
        closeDrawer();
        return;
      }
      if (item.id === 'tasks') {
        // 任务列表就在这一屏下面，关掉抽屉即可回到列表
        return;
      }
      if (item.id === 'files') {
        setFilesOpen(true);
        closeDrawer();
        return;
      }
      if (item.id === 'experts') {
        setModule('experts');
        closeDrawer();
        return;
      }
      if (item.id === 'skills') {
        setModule('skills');
        closeDrawer();
        return;
      }
      if (item.id === 'agents') {
        setModule('agents');
        closeDrawer();
        return;
      }
      if (item.id === 'cron') {
        setModule('cron');
        closeDrawer();
        return;
      }
      if (item.id === 'archive') {
        setModule('archive');
        closeDrawer();
        return;
      }
      if (item.id === 'usage') {
        setModule('usage');
        closeDrawer();
        return;
      }
      if (item.id === 'personalize') {
        setModule('personalize');
        closeDrawer();
        return;
      }
      if (item.id === 'search') {
        // 抽屉顶部就是搜索框：打开它并立刻聚焦
        setDrawerOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 120);
        return;
      }
      if (item.id === 'assistant') {
        // 罗盘助手 = 桌面端首页那四张起步卡片
        setModule('compass');
        closeDrawer();
        return;
      }
      if (item.id === 'team') {
        setModule('team');
        closeDrawer();
        return;
      }
      if (item.id === 'library') {
        setModule('library');
        closeDrawer();
        return;
      }
      if (item.id === 'square') {
        setModule('square');
        closeDrawer();
        return;
      }
      if (item.id === 'bounty') {
        setModule('bounty');
        closeDrawer();
        return;
      }
      if (item.id === 'game') {
        setModule('game');
        closeDrawer();
        return;
      }
      if (item.id === 'creator') {
        setModule('creator');
        closeDrawer();
        return;
      }
      toast.info(`${item.label}：手机端正在接入，先请在电脑端使用`);
    },
    [closeDrawer],
  );

  const handleAgentSelect = useCallback(async (agentId: string) => {
    await ensureHydrationReady();
    const gatewayId = useUiStore.getState().defaultGatewayId ?? undefined;
    useTaskStore.getState().startNewTask({ gatewayId, agentId });
    setAgentSelectorOpen(false);
  }, []);

  return (
    <LazyMotion features={domMax}>
      <div className="flex h-full flex-col" style={{ backgroundColor: 'var(--bg-primary)' }}>
        <header className="safe-area-top flex shrink-0 items-center gap-2 px-3 py-2">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label={t('drawer.menuButton')}
            className="rounded-lg p-1.5 transition-colors"
            style={{ color: 'var(--text-secondary)', minHeight: 44, minWidth: 44 }}
          >
            <Menu size={22} />
          </button>
          <button
            onClick={() => setAgentSelectorOpen(true)}
            className="flex flex-1 items-center gap-1 truncate"
            aria-label={t('agents.selectTitle')}
          >
            <span className="type-label truncate" style={{ color: 'var(--text-primary)' }}>
              {activeTask?.title || (pendingNewTask ? t('tasks.newTask') : t('app.name'))}
            </span>
            <ChevronDown size={16} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
          </button>
          <GatewayStatusCompact onTap={() => setDebugLogOpen(true)} />
        </header>

        {/* 断线横幅：连上就自己消失，掉了立刻给出口（重连 / 收起） */}
        <ConnectionBanner />

        {/* 执行授权弹层：任意页面都可能来审批，挂在最外层（全局 z-50，不依赖 activeTask） */}
        <ApprovalDialog />

        <main className="flex-1 overflow-hidden">
          <ChatView />
        </main>

        {/*
          底部导航：手机上顶栏那个汉堡在状态栏下面、又小又难按，主入口必须放在拇指区。
          三个 tab 分别对应「对话 / 任务（打开任务抽屉）/ 设置」。
        */}
        <nav
          className="safe-area-bottom flex shrink-0 items-stretch"
          style={{ backgroundColor: 'var(--bg-secondary)', borderTop: '1px solid var(--border)' }}
          aria-label={t('nav.primary')}
        >
          <button
            onClick={() => {
              // 「对话」不是"关抽屉"，而是**回首页**：清掉当前任务与待发态，
              // 让主区回到首屏（否则开了任务之后没有任何途径回到主页面）。
              closeDrawer();
              setModule(null);
              setSearchQuery('');
              useTaskStore.setState({ activeTaskId: null, pendingNewTask: null });
            }}
            className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2"
            style={{ color: 'var(--accent)', minHeight: 56 }}
          >
            <MessageCircle size={20} aria-hidden="true" />
            <span className="type-support">{t('nav.chat')}</span>
          </button>
          <button
            onClick={() => setDrawerOpen(true)}
            className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2"
            style={{ color: 'var(--text-muted)', minHeight: 56 }}
          >
            <ListChecks size={20} aria-hidden="true" />
            <span className="type-support">{t('nav.tasks')}</span>
          </button>
          <button
            onClick={() => setModule('compass')}
            className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2"
            style={{ color: 'var(--text-muted)', minHeight: 56 }}
          >
            <Sparkles size={20} aria-hidden="true" />
            <span className="type-support">{t('nav.assistant')}</span>
          </button>
          <button
            onClick={() => {
              useUiStore.getState().setSettingsOpen(true);
              closeDrawer();
            }}
            className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2"
            style={{ color: 'var(--text-muted)', minHeight: 56 }}
          >
            <Settings size={20} aria-hidden="true" />
            <span className="type-support">{t('nav.settings')}</span>
          </button>
        </nav>

        {!drawerOpen && (
          <div
            className="fixed inset-y-0 left-0 z-30"
            style={{ width: 12 }}
            onTouchStart={(e) => {
              edgeTouchRef.current = e.touches[0]!.clientX;
            }}
            onTouchMove={(e) => {
              if (edgeTouchRef.current !== null && e.touches[0]!.clientX - edgeTouchRef.current > 50) {
                edgeTouchRef.current = null;
                setDrawerOpen(true);
              }
            }}
            onTouchEnd={() => {
              edgeTouchRef.current = null;
            }}
          />
        )}
      </div>

      {createPortal(
        <AnimatePresence>
          {drawerOpen && (
            <>
              <m.div
                key="backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-40 surface-overlay"
                onClick={closeDrawer}
                aria-hidden="true"
              />
              <m.div
                key="drawer"
                ref={containerRef}
                role="dialog"
                aria-modal="true"
                aria-label={t('drawer.title')}
                tabIndex={-1}
                onKeyDown={handleKeyDown}
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={drawerTransition}
                drag="x"
                dragConstraints={{ right: 0 }}
                dragElastic={0.1}
                onDragEnd={(_e, info) => {
                  if (info.offset.x < -80 || info.velocity.x < -300) closeDrawer();
                }}
                className="fixed inset-y-0 left-0 z-50 flex w-80 flex-col outline-none"
                style={{ backgroundColor: 'var(--bg-secondary)', maxWidth: '80vw' }}
              >
                <div className="safe-area-top flex items-center gap-2 px-4 py-3">
                  <div
                    className="flex flex-1 items-center gap-2 rounded-lg px-3 py-2"
                    style={{ backgroundColor: 'var(--bg-tertiary)' }}
                  >
                    <Search size={16} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
                    <input
                      ref={searchInputRef}
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder={t('drawer.search')}
                      className="type-body w-full bg-transparent outline-none"
                      style={{ color: 'var(--text-primary)' }}
                    />
                  </div>
                  <button
                    onClick={handleNewTask}
                    aria-label={t('drawer.newTaskButton')}
                    className="flex shrink-0 items-center justify-center rounded-lg transition-colors"
                    style={{ color: 'var(--accent)', minHeight: 44, minWidth: 44 }}
                  >
                    <SquarePen size={20} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto">
                  {/*
                    与桌面端左侧导航一一对应的入口（顺序、图标、BETA 徽章都照抄）。
                    已接通的直接跳转；还没接通的给一句"请在电脑端使用"，不假装能用。
                  */}
                  {/*
                    手机不是电脑：一长条左侧列表在 6 寸屏上又长又难点（原来 18 行，
                    得滚两屏）。这里按功能分五组、铺成三列图标网格 —— 一屏看全、拇指可及。
                  */}
                  <nav className="px-2 pb-1" aria-label={t('nav.primary')}>
                    {NAV_GROUP_ORDER.map((group) => {
                      const items = NAV_ITEMS.filter((item) => item.group === group);
                      if (items.length === 0) return null;
                      return (
                        <div key={group} className="mb-2">
                          <p className="px-1 pb-1 type-support" style={{ color: 'var(--text-muted)' }}>
                            {t(`nav.group.${group}`, { defaultValue: group })}
                          </p>
                          <div className="grid grid-cols-3 gap-1.5">
                            {items.map((item) => (
                              <button
                                key={item.id}
                                onClick={() => handleNav(item)}
                                className="relative flex flex-col items-center gap-1 rounded-xl py-2.5 transition-colors active:bg-[var(--bg-hover)]"
                                style={{
                                  backgroundColor: 'var(--bg-secondary)',
                                  color: item.ready === false ? 'var(--text-muted)' : 'var(--text-secondary)',
                                  minHeight: 64,
                                }}
                                aria-label={item.label}
                              >
                                <item.icon size={19} aria-hidden="true" />
                                <span className="type-support">{item.short ?? item.label}</span>
                                {item.badge && (
                                  <span
                                    className="absolute right-1 top-1 rounded-full px-1 text-[9px]"
                                    style={{ backgroundColor: 'var(--accent-dim)', color: 'var(--accent)' }}
                                  >
                                    {item.badge}
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </nav>

                  <div style={{ borderTop: '1px solid var(--border)' }} className="my-1" />
                  <p className="type-support px-4 py-1" style={{ color: 'var(--text-muted)' }}>
                    {t('nav.recentTasks')}
                  </p>
                  <TaskList onSelect={closeDrawer} filter={searchQuery} />
                </div>

                <div className="px-4 py-3">
                  <GatewayStatus />
                  <button
                    onClick={() => {
                      useUiStore.getState().setSettingsOpen(true);
                      closeDrawer();
                    }}
                    aria-label={t('drawer.settings')}
                    className="mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 type-body transition-colors"
                    style={{ color: 'var(--text-secondary)', minHeight: 44 }}
                  >
                    <Settings size={16} aria-hidden="true" />
                    {t('drawer.settings')}
                  </button>
                  <button
                    onClick={handleSignOut}
                    aria-label={t('drawer.signOut')}
                    className="mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 type-body transition-colors"
                    style={{ color: 'var(--danger)', minHeight: 44 }}
                  >
                    <LogOut size={16} aria-hidden="true" />
                    {t('drawer.signOut')}
                  </button>
                </div>
                <div className="safe-area-bottom" />
              </m.div>
            </>
          )}
        </AnimatePresence>,
        portalTarget,
      )}

      <AgentSelector
        open={agentSelectorOpen}
        onClose={() => setAgentSelectorOpen(false)}
        onSelect={handleAgentSelect}
      />

      <GatewayDebugLog open={debugLogOpen} onClose={() => setDebugLogOpen(false)} />

      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} onSignOut={handleSignOut} />

      {filesOpen && <ArtifactsView onClose={() => setFilesOpen(false)} />}
      {module === 'skills' && <SkillsMarketView onClose={() => setModule(null)} />}
      {module === 'agents' && <AgentsView onClose={() => setModule(null)} />}
      {module === 'cron' && <CronPanelView onClose={() => setModule(null)} />}
      {module === 'archive' && <ArchiveView onClose={() => setModule(null)} />}
      {module === 'usage' && <DashboardView onClose={() => setModule(null)} />}
      {module === 'personalize' && <PersonalizeView onClose={() => setModule(null)} />}
      {module === 'team' && <TeamsPanelView onClose={() => setModule(null)} />}
      {module === 'library' && <KnowledgeView onClose={() => setModule(null)} />}
      {module === 'square' && <CommunityPanelView onClose={() => setModule(null)} />}
      {module === 'bounty' && <BountyView onClose={() => setModule(null)} />}
      {module === 'game' && <GrowthView onClose={() => setModule(null)} />}
      {module === 'creator' && <CreatorPanelView onClose={() => setModule(null)} />}
      {module === 'experts' && <ExpertsView onClose={() => setModule(null)} />}
      {module === 'compass' && (
        <CompassView
          onClose={() => setModule(null)}
          onOpenAgentSelector={() => {
            setModule(null);
            setAgentSelectorOpen(true);
          }}
        />
      )}
    </LazyMotion>
  );
}

function GatewayStatusCompact({ onTap }: { onTap?: () => void }) {
  const { t } = useTranslation();
  const statusMap = useUiStore((s) => s.gatewayStatusMap);
  const entries = Object.entries(statusMap);
  if (entries.length === 0) return null;

  const allConnected = entries.every(([, s]) => s === 'connected');
  const anyConnecting = entries.some(([, s]) => s === 'connecting');

  const color = allConnected ? 'var(--accent)' : anyConnecting ? 'var(--warning)' : 'var(--danger)';
  const label = allConnected
    ? t('gateway.connected')
    : anyConnecting
      ? t('gateway.connecting')
      : t('gateway.disconnected');

  return (
    <button
      onClick={onTap}
      className="flex items-center justify-center rounded-lg p-2 transition-colors"
      style={{ minHeight: 44, minWidth: 44 }}
      aria-label={`${label} — tap for log`}
      role="status"
    >
      <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
    </button>
  );
}
