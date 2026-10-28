import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Search } from 'lucide-react';
import type { MainView } from '@clawwork/core';
import { PUBLIC_MARKET_CLOSED } from '@clawwork/shared';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import brandLogo from '@/assets/logo.png';
import AssistantSwitcher from './LeftNav/AssistantSwitcher';
import ProfileMenu from './LeftNav/ProfileMenu';
import SearchResults, { type SearchResult } from '@/components/SearchResults';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import { useSelectAgent } from '@/hooks/useSelectAgent';
import { useTeamStore } from '@/stores/teamStore';
import { useUiStore } from '@/stores/uiStore';
import { useMessageStore } from '@/stores/messageStore';
import { useFileStore } from '@/stores/fileStore';
import { useTaskStore } from '@/stores/taskStore';
import { isInternalBetaEnabled } from '@/features/internal-beta/beta-route';
import AgentMissingNotice from '@/components/AgentMissingNotice';
import { resolveRequestedAgent } from '@/lib/requested-agent';

interface TopBarProps {
  onOpenAssistantSettings: () => void;
  onOpenSettings: () => void;
}

interface TopNavItem {
  key: string;
  labelKey: string;
  /** 导航图标用 emoji（2026-10-28 弃用 lucide 线性图标），与欢迎屏的 emoji 图标风格统一。 */
  emoji: string;
  view?: MainView;
  onClick?: () => void;
  disabled?: boolean;
  disabledTitleKey?: string;
  muted?: boolean;
  accent?: boolean;
  badge?: string;
}

/**
 * 顶部导航栏（2026-10-28 排版重构：三栏 → 顶栏 + 左右）。
 *
 * 把原本在左侧栏里的「页面导航 / 搜索 / 新建任务 / 助手切换 / 个人资料」整体搬到顶部，
 * 左侧栏只保留「会话 + 任务」列表（见 `LeftNav`）。页面入口在顶部横向排成标签，
 * 中间留弹性搜索框，右侧是当前助手与头像 —— 类似 VSCode / Chrome 的顶栏。
 */
export default function TopBar({ onOpenAssistantSettings, onOpenSettings }: TopBarProps) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchFocusTrigger = useUiStore((s) => s.searchFocusTrigger);

  // 任务列表标题行的放大镜（`focusSearch`）把焦点送回顶部搜索框。
  useEffect(() => {
    if (searchFocusTrigger === 0) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [searchFocusTrigger]);

  const startNewTask = useTaskStore((s) => s.startNewTask);
  const setActiveTask = useTaskStore((s) => s.setActiveTask);
  const setHighlightedMessage = useMessageStore((s) => s.setHighlightedMessage);
  const setMainView = useUiStore((s) => s.setMainView);
  const mainView = useUiStore((s) => s.mainView);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const hasUpdate = useUiStore((s) => s.hasUpdate);
  const setSelectedArtifact = useFileStore((s) => s.setSelectedArtifact);

  const { selectedGwId, agentCatalog, defaultAgentId } = useGatewaySelector();
  const teamsMap = useTeamStore((state) => state.teams);
  const loadTeams = useTeamStore((state) => state.loadTeams);
  const teams = useMemo(() => Object.values(teamsMap), [teamsMap]);
  useEffect(() => {
    const state = useTeamStore.getState();
    if (!state.loadedOnce && !state.loading) void loadTeams();
  }, [loadTeams]);

  const selectedAgentId = useUiStore((s) => s.selectedAgentByGateway[selectedGwId] ?? '');
  const currentAgentId = selectedAgentId || defaultAgentId;
  const handleSelectAgent = useSelectAgent();
  // 目录条目（带 `agents` 键）才是 `resolveRequestedAgent` 要的形状；`agentCatalog`
  // 是扁平的 `AgentInfo[]`，只用于传给切换器渲染。
  const agentCatalogEntry = useUiStore((s) => s.agentCatalogByGateway[selectedGwId]);
  const requestedState = resolveRequestedAgent(selectedAgentId, agentCatalogEntry);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    timerRef.current = setTimeout(async () => {
      const resp = await window.clawwork.globalSearch(searchQuery);
      if (resp.ok && resp.results) setSearchResults(resp.results);
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [searchQuery]);

  const handleSelectResult = (result: SearchResult): void => {
    setSearchQuery('');
    setSearchResults([]);
    if (result.type === 'artifact') {
      setSelectedArtifact(result.id);
      setMainView('files');
    } else {
      const targetId = result.type === 'task' ? result.id : result.taskId;
      if (targetId) setActiveTask(targetId);
      if (result.type === 'message') setHighlightedMessage(result.id);
      setMainView('chat');
    }
  };

  const topItems: TopNavItem[] = [
    {
      key: 'new-task',
      labelKey: 'common.newTask',
      emoji: '✨',
      onClick: () => startNewTask({ gatewayId: selectedGwId, agentId: currentAgentId }),
      accent: true,
    },
    { key: 'teams', labelKey: 'leftNav.pages.teams', emoji: '👥', view: 'teams', badge: 'Beta' },
    { key: 'skills', labelKey: 'leftNav.pages.skills', emoji: '🧩', view: 'skills' },
    { key: 'experts', labelKey: 'leftNav.pages.agentsSimple', emoji: '🎓', view: 'experts' },
    {
      key: 'agents',
      labelKey: 'leftNav.pages.agents',
      emoji: '🛒',
      view: 'market',
      disabled: PUBLIC_MARKET_CLOSED,
      disabledTitleKey: 'market.publicClosedTitle',
    },
  ];

  const moreItems: TopNavItem[] = [
    { key: 'tasks', labelKey: 'leftNav.recentTasks', emoji: '📋', view: 'tasks' },
    { key: 'identity', labelKey: 'leftNav.identityCenter', emoji: '👤', view: 'identity' },
    { key: 'kb', labelKey: 'kb.title', emoji: '📚', view: 'kb' },
    {
      key: 'bounty',
      labelKey: 'leftNav.pages.bounty',
      emoji: '🎯',
      muted: true,
      onClick: () => toast(t('leftNav.bountyComingSoon'), { id: 'bounty-coming-soon', duration: 2000 }),
    },
    { key: 'square', labelKey: 'leftNav.pages.square', emoji: '🧭', view: 'community' },
    { key: 'creator', labelKey: 'leftNav.pages.creator', emoji: '✍️', view: 'creator' },
    { key: 'usage', labelKey: 'leftNav.usageOverview', emoji: '📊', view: 'dashboard' },
    { key: 'growth', labelKey: 'leftNav.pages.growth', emoji: '🏆', view: 'growth' },
    { key: 'cron', labelKey: 'cron.title', emoji: '⏰', view: 'cron' },
    { key: 'files', labelKey: 'common.fileManager', emoji: '📁', view: 'files' },
    { key: 'archived', labelKey: 'leftNav.archivedChats', emoji: '📦', view: 'archived' },
    ...(isInternalBetaEnabled()
      ? ([{ key: 'betaHub', labelKey: 'beta.title', emoji: '🧪', view: 'betaHub' as MainView }] satisfies TopNavItem[])
      : []),
  ];

  const renderNavItem = (item: TopNavItem, after?: () => void) => {
    const active = item.view !== undefined && !settingsOpen && mainView === item.view;

    const button = (
      <button
        key={item.key}
        type="button"
        data-nav={item.key}
        aria-current={active ? 'page' : undefined}
        disabled={item.disabled}
        aria-disabled={item.disabled || undefined}
        title={item.disabled && item.disabledTitleKey ? t(item.disabledTitleKey) : undefined}
        onClick={() => {
          if (item.onClick) item.onClick();
          else if (item.view) setMainView(item.view);
          after?.();
        }}
        className={cn(
          'titlebar-no-drag glow-focus relative inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 type-label transition-colors',
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
        <span aria-hidden="true" className="emoji-sm flex-shrink-0">
          {item.emoji}
        </span>
        <span>{t(item.labelKey)}</span>
        {item.badge && (
          <span className="type-badge rounded-full bg-[var(--accent-soft)] px-1.5 text-[var(--accent)]">
            {item.badge}
          </span>
        )}
      </button>
    );

    return button;
  };

  return (
    <header
      className="titlebar-drag flex h-[var(--density-toolbar-height)] flex-shrink-0 items-center gap-1 border-b border-[var(--border)] px-3"
      /* Windows 的 titleBarOverlay（原生窗口控制按钮）画在右上角 —— 用 WCO 环境变量把
         顶栏右侧内容让开；非 overlay 环境（mac hiddenInset / 无 overlay）回退为 0。 */
      style={{
        paddingRight: 'max(12px, calc(100vw - env(titlebar-area-width, 100vw) + 12px))',
      }}
    >
      {/* 品牌（2026-10-28 用户要求：logo 用荧光态 —— 双层辉光，蓝主橙辅） */}
      <div className="titlebar-no-drag flex items-center gap-2 pr-2">
        <img
          src={brandLogo}
          alt=""
          className="h-7 w-7 rounded-lg [filter:drop-shadow(0_0_6px_var(--accent))_drop-shadow(0_0_14px_var(--brand-glow))]"
        />
      </div>

      {/* 页面导航 */}
      <nav data-testid="top-nav" className="titlebar-no-drag flex items-center gap-0.5">
        {topItems.map((item) => renderNavItem(item))}

        {/* 更多 */}
        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-nav="more"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
              className={cn(
                'titlebar-no-drag glow-focus inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 type-label transition-colors',
                moreOpen
                  ? 'bg-[var(--state-selected)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <span aria-hidden="true" className="emoji-sm">
                ⋯
              </span>
              <span>{t('leftNav.pages.more')}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={6} className="w-52 p-1">
            {moreItems.map((item) => renderNavItem(item, () => setMoreOpen(false)))}
          </PopoverContent>
        </Popover>
      </nav>

      {/* 搜索（弹性占据中间） */}
      <div className="titlebar-no-drag relative mx-2 min-w-40 max-w-sm flex-1">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('leftNav.searchTasks')}
          className="h-[var(--density-control-height-sm)] w-full rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] pl-9 pr-3 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)] glow-focus transition-all focus:border-transparent"
        />
        {searchQuery.trim() && (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-floating)]">
            <SearchResults results={searchResults} onSelect={handleSelectResult} />
          </div>
        )}
      </div>

      {/* 当前助手 + 头像 */}
      <div className="titlebar-no-drag flex items-center gap-1">
        <AssistantSwitcher
          agents={agentCatalog}
          teams={teams}
          gatewayId={selectedGwId}
          defaultAgentId={defaultAgentId}
          selectedAgentId={currentAgentId}
          onSelect={handleSelectAgent}
          onAddAssistant={onOpenAssistantSettings}
          collapsed={false}
        />
        {requestedState === 'missing' && (
          <div className="relative">
            <button
              type="button"
              data-action="agent-missing"
              aria-label={t('agent.missingTitle', { agentId: selectedAgentId })}
              className="glow-focus inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--warning)] hover:bg-[var(--bg-hover)] focus-visible:outline-none"
            >
              <AlertTriangle size={16} />
            </button>
            <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-floating)]">
              <AgentMissingNotice agentId={selectedAgentId} />
            </div>
          </div>
        )}
        <ProfileMenu
          collapsed={false}
          mainView={mainView}
          settingsOpen={settingsOpen}
          hasUpdate={hasUpdate}
          onSelectView={setMainView}
          onOpenSettings={onOpenSettings}
        />
      </div>
    </header>
  );
}
