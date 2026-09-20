import { useCallback, useMemo, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { runManualCompaction } from '@clawwork/core';
import { useTaskStore } from '@/stores/taskStore';
import { useMessageStore } from '@/stores/messageStore';
import { useUiStore } from '@/stores/uiStore';
import { compareTasksForSidebar } from '@/lib/task-sort';
import { filterTasksForPanel, type TaskPanelFilter } from '@/lib/task-panel';
import { exportToFiles, exportToLocal } from '@/lib/export-session';
import { useTaskContextMenu, TaskContextMenuPopover, type SessionActions } from '@/components/ContextMenu';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import EmptyState from '@/components/semantic/EmptyState';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import { resolveTaskAgentId } from '@/lib/task-sort';
import TaskRow from './TaskRow';

type ConfirmAction = 'reset' | 'delete' | null;

const FILTERS: TaskPanelFilter[] = ['all', 'active', 'archived'];

/**
 * 「最近任务」——**全量**任务列表（导航入口 `tasks`，在「身份中心」上面）。
 *
 * ## 为什么它取代了左列最下面那一块（用户 2026-09-20 原话）
 *
 * 「最近任务那一栏我看目前在最下面不好，**显示也不全**，放在身份中心上面，
 *   可以点开右侧显示一堆任务」。
 *
 * 与那块的区别：**不限 5 条**（`splitVisibleTasks` 的 `limit: 5` 只属于左栏）、
 * 能按状态筛、能搜标题、**跨助手**（面板是"我的全部对话"）。
 *
 * ## 功能对等（搬过来时一条都不能少）
 *
 * 右键菜单（置顶/压缩/重置/删除/导出）、"重置/删除"确认框、行内重命名，
 * 以及点击打开会话/清未读 —— 全部从 `LeftNav` 原样搬过来，
 * 撤掉左栏那块**不能**顺手把这些能力一起撤掉。
 *
 * ⚠️ 行是**宽版** `./TaskRow`，不是窄栏的 `LeftNav/TaskItem`（用户截图打回过一次：
 *    窄栏行带着整条预览横贯宽屏 ⇒ 看着堆成一团）。为什么、以及别加什么，写在 `TaskRow` 里。
 */
export default function TasksPanel() {
  const { t } = useTranslation();
  const tasks = useTaskStore((s) => s.tasks);
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const removeTask = useTaskStore((s) => s.removeTask);
  const clearMessages = useMessageStore((s) => s.clearMessages);
  const addMessage = useMessageStore((s) => s.addMessage);
  const gwStatusMap = useUiStore((s) => s.gatewayStatusMap);
  const { agentCatalog } = useGatewaySelector();
  const agentById = useMemo(() => new Map(agentCatalog.map((agent) => [agent.id, agent])), [agentCatalog]);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TaskPanelFilter>('all');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [confirmTaskId, setConfirmTaskId] = useState('');
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  // 排序与左栏同一套（置顶优先 + updatedAt 倒序）；面板**不**裁剪条数。
  const visibleTasks = useMemo(
    () => filterTasksForPanel(tasks, { query, filter }).slice().sort(compareTasksForSidebar),
    [tasks, query, filter],
  );

  const findTask = useCallback((taskId: string) => useTaskStore.getState().tasks.find((t2) => t2.id === taskId), []);

  const handleCompact = useCallback(
    (taskId: string) => {
      const task = findTask(taskId);
      if (!task) return;
      // ⭐ 走**共享入口**（与斜杠命令、左栏同一路），不自己插消息、不自己判断成败。
      void runManualCompaction(
        {
          getStore: () => useMessageStore.getState(),
          translate: (key: string) => t(key),
          compactSession: (gw, sk) => window.clawwork.compactSession(gw, sk),
        },
        { gatewayId: task.gatewayId, sessionKey: task.sessionKey, taskId },
      ).catch(() => {});
    },
    [findTask, t],
  );

  const handleResetConfirm = useCallback(() => {
    const task = findTask(confirmTaskId);
    if (!task) {
      setConfirmAction(null);
      return;
    }
    window.clawwork
      .resetSession(task.gatewayId, task.sessionKey, 'reset')
      .then((res) => {
        if (res.ok) {
          clearMessages(confirmTaskId);
          addMessage(confirmTaskId, 'system', t('session.contextReset'));
        }
      })
      .catch(() => {});
    setConfirmAction(null);
  }, [addMessage, clearMessages, confirmTaskId, findTask, t]);

  const handleDeleteConfirm = useCallback(() => {
    const task = findTask(confirmTaskId);
    if (task) {
      window.clawwork.deleteSession(task.gatewayId, task.sessionKey).catch(() => {});
    }
    clearMessages(confirmTaskId);
    removeTask(confirmTaskId);
    setConfirmAction(null);
  }, [clearMessages, confirmTaskId, findTask, removeTask]);

  const sessionActions: SessionActions = useMemo(
    () => ({
      rename: (taskId: string) => setEditingTaskId(taskId),
      togglePin: (taskId: string, pinned: boolean) => useTaskStore.getState().setTaskPinned(taskId, pinned),
      compact: handleCompact,
      reset: (taskId: string) => {
        setConfirmTaskId(taskId);
        setConfirmAction('reset');
      },
      deleteTask: (taskId: string) => {
        setConfirmTaskId(taskId);
        setConfirmAction('delete');
      },
      exportMarkdown: exportToFiles,
      exportMarkdownAs: exportToLocal,
      isConnected: (taskId: string) => {
        const task = findTask(taskId);
        return task ? gwStatusMap[task.gatewayId] === 'connected' : false;
      },
    }),
    [findTask, gwStatusMap, handleCompact],
  );

  const { items, isOpen, openMenu, closeMenu } = useTaskContextMenu(updateTaskStatus, sessionActions);

  const handleContextMenu = (event: MouseEvent, taskId: string, status: string): void => {
    setMenuPos({ x: event.clientX, y: event.clientY });
    openMenu(event, taskId, status as Parameters<typeof openMenu>[2]);
  };

  const searchActive = query.trim().length > 0;

  return (
    <div data-testid="tasks-panel" className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-3 px-5 pb-3 pt-4">
        <h2 className="type-page-title text-[var(--text-primary)]">{t('leftNav.recentTasks')}</h2>
        <span className="type-support text-[var(--text-muted)]" data-field="count">
          {t('tasksPanel.count', { count: visibleTasks.length })}
        </span>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label={t('tasksPanel.filterLabel')}>
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              data-filter={value}
              data-selected={filter === value ? 'true' : undefined}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                'glow-focus rounded-md px-2.5 py-1 type-support transition-colors',
                filter === value
                  ? 'bg-[var(--state-selected)] font-semibold text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              {t(`tasksPanel.filter_${value}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-shrink-0 px-5 pb-3">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('tasksPanel.searchPlaceholder')}
            aria-label={t('tasksPanel.searchPlaceholder')}
            className="h-[var(--density-control-height-sm)] w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] pl-9 pr-3 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)] glow-focus transition-all focus:border-transparent"
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 px-4 pb-6">
          {visibleTasks.length === 0 && (
            <EmptyState title={t(searchActive ? 'tasksPanel.emptySearch' : 'tasksPanel.empty')} className="py-10" />
          )}
          {visibleTasks.map((task) => {
            const owner = agentById.get(resolveTaskAgentId(task));
            return (
              <TaskRow
                key={task.id}
                task={task}
                active={task.id === activeTaskId}
                agentLabel={owner?.name}
                agentEmoji={owner?.identity?.emoji}
                onContextMenu={(event) => handleContextMenu(event, task.id, task.status)}
                editing={editingTaskId === task.id}
                onEditDone={() => setEditingTaskId(null)}
              />
            );
          })}
        </div>
      </ScrollArea>

      <TaskContextMenuPopover open={isOpen} position={menuPos} items={items} onClose={closeMenu} />

      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction === 'reset' ? t('dialog.resetSessionTitle') : t('dialog.deleteTaskTitle')}
            </DialogTitle>
            <DialogDescription>
              {confirmAction === 'reset' ? t('dialog.resetSessionDesc') : t('dialog.deleteTaskDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setConfirmAction(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={confirmAction === 'delete' ? 'danger' : 'default'}
              onClick={confirmAction === 'reset' ? handleResetConfirm : handleDeleteConfirm}
            >
              {t('dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
