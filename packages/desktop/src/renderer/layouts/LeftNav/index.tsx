import { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { PanelLeftClose, PanelLeftOpen, Search, SquarePen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useTaskStore } from '@/stores/taskStore';
import { useMessageStore } from '@/stores/messageStore';
import { useUiStore } from '@/stores/uiStore';
import { useFileStore } from '@/stores/fileStore';
import SearchResults, { type SearchResult } from '@/components/SearchResults';
import { motionDuration } from '@/styles/design-tokens';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import ToolbarButton from '@/components/semantic/ToolbarButton';
import AssistantSwitcher from './AssistantSwitcher';
import AgentMissingNotice from '@/components/AgentMissingNotice';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import { useSelectAgent } from '@/hooks/useSelectAgent';
import { resolveRequestedAgent } from '@/lib/requested-agent';
import NavMenu from './NavMenu';

interface LeftNavProps {
  onOpenAssistantSettings: () => void;
  /** 「设置」是覆盖层，不是 `mainView`。 */
  onOpenSettings: () => void;
}

/**
 * 左侧栏 = 「搜索框 + 页面清单 + 助手切换」。
 *
 * ## ⚠️「最近任务」**不在这里了**（2026-09-20 用户点名改的）
 *
 * 用户原话：「最近任务那一栏我看**目前在最下面不好，显示也不全**，放在身份中心上面，
 * 可以点开右侧显示一堆任务」。
 *
 * ⇒ 它变成导航里的一个入口（`NavMenu` 的 `tasks`，在「身份中心」上面），
 * 点开右侧的 `layouts/TasksPanel`（全量、可搜、可筛、跨助手）。
 * 原来那一块（只 5 条 + 「查看全部」）连同行内右键菜单一起**搬进面板**了 ——
 * **别在这里重建一个任务列表**：同一时刻只能有一个地方能改任务（重命名/置顶/删除）。
 *
 * ⇒ 搜索框旁边那个「新建任务」按钮是**从那块的标题行搬过来的**（别顺手删）。
 */
export default function LeftNav({ onOpenAssistantSettings, onOpenSettings }: LeftNavProps) {
  const { t } = useTranslation();
  const startNewTask = useTaskStore((s) => s.startNewTask);
  const setActiveTask = useTaskStore((s) => s.setActiveTask);
  const setHighlightedMessage = useMessageStore((s) => s.setHighlightedMessage);
  const setMainView = useUiStore((s) => s.setMainView);
  const mainView = useUiStore((s) => s.mainView);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const hasUpdate = useUiStore((s) => s.hasUpdate);
  const setSelectedArtifact = useFileStore((s) => s.setSelectedArtifact);
  const leftNavCollapsed = useUiStore((s) => s.leftNavCollapsed);
  const toggleLeftNavCollapsed = useUiStore((s) => s.toggleLeftNavCollapsed);
  const searchFocusTrigger = useUiStore((s) => s.searchFocusTrigger);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchFocusTrigger === 0) return;
    if (leftNavCollapsed) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [searchFocusTrigger, leftNavCollapsed]);

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

  const { selectedGwId, agentCatalog, defaultAgentId } = useGatewaySelector();
  const agentCatalogEntry = useUiStore((s) => s.agentCatalogByGateway[selectedGwId]);
  const selectedAgentId = useUiStore((s) => s.selectedAgentByGateway[selectedGwId] ?? '');
  /**
   * ⭐ 2026-09-24：持久选择不在目录里时**不拿默认助手冒充**（与欢迎屏同一条判据）。
   *
   * 旧写法 `selectedAgentId || defaultAgentId || …` 会把默认助手显示成「当前选中」，
   * 用户从那两个口进去（新建任务 / 切换器）时用的也是它 —— 静默换人，与欢迎屏同一个病。
   * 目录还没拉回来时 `resolveRequestedAgent` 判 `loading`，走老路（不误报）。
   */
  const requestedState = resolveRequestedAgent(selectedAgentId, agentCatalogEntry);
  /**
   * ⭐ 2026-09-24：**静默替换不在这条表达式里，在 `AssistantSwitcher` 的 `?? agents[0]`。**
   *
   * ⚠️ 别照下面这条错误的推理去"简化"（我一开始就是这么写错的，独立复核用变异纠正了它）：
   * 我曾经在这里加过 `missing ? '' : …`，以为它无害 —— **不是无害的**。`''` 会让切换器
   * 落进 `?? agents[0]`，把**罗盘助手冒充成当前助手**（那正是这一刀要消灭的东西，
   * 当时那条测试就是因此变红的）。所以这里**必须把原样的 id 传下去**，不能抹成空串。
   *
   * ⚠️ 也不要再把它改回 `missing ? selectedAgentId : …` 那种三元 —— 那**才是**真正的
   * no-op（缺失时 `selectedAgentId` 本就非空，`||` 不会回落，两个分支恒等），
   * 留着只会让人以为这里做了判断。空串的语义是"没有选择 ⇒ 退回第一个"，与"拒绝"不同。
   *
   * 下游拿到的就是这个**原样的 id**：切换器靠它落进中性格子（非空但找不到 ⇒ `current`
   * 为 `undefined`），「新建任务」把它原样交给待发任务 ⇒ 欢迎屏会**再次**走同一条拒绝
   * 路径并给出出口。全程没有一处换成别人。
   */
  const currentAgentId = selectedAgentId || defaultAgentId || agentCatalog[0]?.id || '';

  // ⚠️ 切助手的四步**不在这里**，在 `useSelectAgent` —— 身份中心的「应用此画像」
  //    也要切助手，两边各写一遍必然漂移（最典型是漏掉 `setPending`）。
  const handleSelectAgent = useSelectAgent();

  /**
   * 折叠/展开按钮（2026-09-29 按体验稿搬到**搜索框左边**，`侧栏收纳-方案.html` 的 `.side-top` 首元素）。
   *
   * ⚠️ 它以前在顶部那条 `titlebar-drag` 里靠右 —— 那条拖拽区**留着**（窗口还得能拖），
   * 只是不再放按钮。
   *
   * ⚠️ 沿用 `ToolbarButton`（语义组件）：`check:ui-contract` 对
   * `layouts/LeftNav/index.tsx` 有一条 component-usage 规则，要求这里出现
   * `ToolbarButton|EmptyState`；原来的裸 `<button>` 是靠旁边「新建任务」那个 `ToolbarButton`
   * 才过关的，现在自己就是合规的那种写法。
   */
  const collapseLabel = leftNavCollapsed ? t('leftNav.expandNav') : t('leftNav.collapseNav');
  const CollapseToggleButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarButton
          type="button"
          icon={leftNavCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          onClick={toggleLeftNavCollapsed}
          aria-label={collapseLabel}
          data-action="toggle-left-nav"
          className="h-[var(--density-control-height-sm)] w-8 flex-shrink-0 px-0"
        />
      </TooltipTrigger>
      <TooltipContent side="right">{collapseLabel}</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="relative flex h-full flex-col overflow-hidden pt-10">
      {/* 拖拽区照旧留着（窗口要能拖），只是它不再承载折叠按钮。 */}
      <div className="titlebar-drag absolute inset-x-0 top-0 z-[51] h-10" />

      <div className="flex-shrink-0 px-3 py-2">
        <div
          className={cn('titlebar-no-drag flex items-center gap-1', leftNavCollapsed && 'flex-col items-center gap-1')}
        >
          {CollapseToggleButton}
          {/* 收纳态隐藏搜索框（体验稿 `.fold .search{display:none}`）。
              收起后那点宽度放不下输入框；搜索入口仍在（导航第一项就是「搜索任务」），
              展开即回到这里。 */}
          {!leftNavCollapsed && (
            <div className="relative min-w-0 flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('leftNav.searchTasks')}
                className="h-[var(--density-control-height-sm)] w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] pl-9 pr-3 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)] glow-focus transition-all focus:border-transparent"
              />
            </div>
          )}
          {/* ⚠️「新建任务」原来长在下面那块「最近任务」的标题行里 —— 那块搬进面板后
              它**留在这里**（搜索框边上）。别顺手一起删：这一列是用户最顺手的入口。
              ⚠️ 走 `ToolbarButton`（语义组件）而不是裸 `<button>` ——
              `check:ui-contract` 对左栏有一条 component-usage 规则就要求这个。 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <ToolbarButton
                type="button"
                icon={<SquarePen size={15} />}
                onClick={() => startNewTask({ gatewayId: selectedGwId, agentId: currentAgentId })}
                aria-label={t('common.newTask')}
                data-action="new-task"
                className="h-[var(--density-control-height-sm)] w-8 flex-shrink-0 px-0 text-[var(--accent)] hover:bg-[var(--accent-dim)]"
              />
            </TooltipTrigger>
            <TooltipContent side="right">{t('common.newTask')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* 页面导航（2026-09-19，按老板设计稿 + 方案 B）。
          ⚠️ 「我的助手」不是常驻展开的列表 —— 它是导航列表里**「身份中心」上面那一行**
             （`AssistantSwitcher`，点开才选角色）。用户口径：
             「把他放身份中心上面，点击后可以选择这几个角色」+「现在不好看」。
          ⚠️ 「最近任务」同样是导航行（`tasks`），列表在右侧面板里（见组件注释）。
          ⚠️ **必须可滚动**：去掉图标栏后这一列涨到 17 项 —— 实测底部两项
             （内测中心 / 设置）会被裁在视口外。`min-h-0 + shrink + overflow-y-auto`
             让它在空间不够时自己滚，而不是把底下的项挤没。 */}
      <div className="min-h-0 shrink overflow-y-auto border-b border-[var(--border-subtle)] py-2">
        <NavMenu
          mainView={mainView}
          settingsOpen={settingsOpen}
          onSelectView={setMainView}
          onOpenSettings={onOpenSettings}
          hasUpdate={hasUpdate}
          collapsed={leftNavCollapsed}
          assistantSlot={
            <>
              <AssistantSwitcher
                agents={agentCatalog}
                selectedAgentId={currentAgentId}
                onSelect={handleSelectAgent}
                onAddAssistant={onOpenAssistantSettings}
                collapsed={leftNavCollapsed}
              />
              {/* 这一列太窄，只放说明不放按钮 —— 出口在欢迎屏那边（团队页入口就在本列导航里）。
                  ⚠️ 收纳态那句说明**放不下**（60px 装不下一段多行文案）⇒ 收起点在
                  `AssistantSwitcher` 的头像上，展开就回到这里。**不是删掉不说了。** */}
              {requestedState === 'missing' && !leftNavCollapsed ? (
                <AgentMissingNotice agentId={selectedAgentId} className="mx-3 mt-1" />
              ) : null}
            </>
          }
        />
      </div>

      {/* 全局搜索结果落在这块空区上（原来它盖在下面的任务列表上）。 */}
      <div className="relative min-h-0 flex-1">
        <AnimatePresence>
          {searchQuery.trim() && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: motionDuration.normal }}
              className="absolute inset-0 z-10 border-t border-[var(--border)] bg-[var(--bg-elevated)]"
            >
              <SearchResults results={searchResults} onSelect={handleSelectResult} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
