import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTaskStore } from '@/stores/taskStore';
import { useMessageStore } from '@/stores/messageStore';
import { useUiStore } from '@/stores/uiStore';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import ToolbarButton from '@/components/semantic/ToolbarButton';
import TaskList from './TaskList';

/**
 * 左侧栏 = 「会话 / 任务」列表（2026-10-28 排版重构）。
 *
 * 顶部导航栏（`TopBar`）接管了页面导航 / 搜索 / 新建任务 / 助手切换 / 个人资料，
 * 这一列退回到它最本职的事：**任务列表**。结构大幅简化 —— 只留「收起按钮 + 任务列表」。
 *
 * ⚠️ 别在这里重建页面导航或搜索：那些入口已统一到 `TopBar`，两份入口会漂移。
 */
export default function LeftNav() {
  const { t } = useTranslation();
  const setActiveTask = useTaskStore((s) => s.setActiveTask);
  const tasks = useTaskStore((s) => s.tasks);
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const processingBySession = useMessageStore((s) => s.processingBySession);
  const setMainView = useUiStore((s) => s.setMainView);
  const leftNavCollapsed = useUiStore((s) => s.leftNavCollapsed);
  const toggleLeftNavCollapsed = useUiStore((s) => s.toggleLeftNavCollapsed);
  const focusSearch = useUiStore((s) => s.focusSearch);

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
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* 顶部第一行：收起按钮 + 标题（同时充当窗口拖拽条）。 */}
      <div className="titlebar-drag flex flex-shrink-0 items-center gap-1 px-3 py-1.5">
        {CollapseToggleButton}
        {!leftNavCollapsed && (
          <span className="type-label truncate text-[var(--text-secondary)]">{t('leftNav.recentTasks')}</span>
        )}
      </div>

      {/* 任务列表（主体）。 */}
      <div className="min-h-0 flex-1">
        <TaskList
          tasks={tasks}
          activeTaskId={activeTaskId}
          runningSessionKeys={processingBySession}
          collapsed={leftNavCollapsed}
          onSelect={(taskId) => {
            setActiveTask(taskId);
            setMainView('chat');
          }}
          onShowAll={() => setMainView('tasks')}
          onSearch={focusSearch}
        />
      </div>
    </div>
  );
}
