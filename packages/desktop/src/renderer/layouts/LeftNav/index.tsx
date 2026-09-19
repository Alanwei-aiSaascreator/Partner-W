import { useState, useEffect, useRef, useCallback, useMemo, type MouseEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { List, PanelLeftClose, Search, SquarePen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { runManualCompaction } from '@clawwork/core';
import { useTaskStore } from '@/stores/taskStore';
import { useMessageStore } from '@/stores/messageStore';
import { useUiStore } from '@/stores/uiStore';
import { useFileStore } from '@/stores/fileStore';
import { useTaskContextMenu, TaskContextMenuPopover, type SessionActions } from '@/components/ContextMenu';
import SearchResults, { type SearchResult } from '@/components/SearchResults';
import { splitVisibleTasks } from '@/lib/task-sort';
import { motionDuration, motion as motionPresets } from '@/styles/design-tokens';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { exportToFiles, exportToLocal } from '@/lib/export-session';
import TaskItem from './TaskItem';
import AssistantSwitcher from './AssistantSwitcher';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import { removeAssistantTaskPresetTags } from '@/lib/assistant-task-preset-tags';
import type { TaskStatus } from '@clawwork/shared';
import EmptyState from '@/components/semantic/EmptyState';
import { useSessionPreviews } from '@/hooks/useSessionPreviews';
import NavMenu from './NavMenu';

type ConfirmAction = 'reset' | 'delete' | null;

interface LeftNavProps {
  onOpenAssistantSettings: () => void;
  /** 「技能市场」不是独立页面，它在设置面板里 ⇒ 点它 = 打开设置并定位到那一节。 */
  onOpenSkills: () => void;
  /** 「设置」同理 —— 它也是覆盖层。 */
  onOpenSettings: () => void;
}

export default function LeftNav({ onOpenAssistantSettings, onOpenSkills, onOpenSettings }: LeftNavProps) {
  const { t } = useTranslation();
  const tasks = useTaskStore((s) => s.tasks);
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const startNewTask = useTaskStore((s) => s.startNewTask);
  const setPending = useTaskStore((s) => s.setPending);
  const setActiveTask = useTaskStore((s) => s.setActiveTask);
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const removeTask = useTaskStore((s) => s.removeTask);
  const clearMessages = useMessageStore((s) => s.clearMessages);
  const addMessage = useMessageStore((s) => s.addMessage);
  const setHighlightedMessage = useMessageStore((s) => s.setHighlightedMessage);
  const setMainView = useUiStore((s) => s.setMainView);
  const mainView = useUiStore((s) => s.mainView);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const hasUpdate = useUiStore((s) => s.hasUpdate);
  const setSelectedArtifact = useFileStore((s) => s.setSelectedArtifact);
  const gwStatusMap = useUiStore((s) => s.gatewayStatusMap);
  const leftNavCollapsed = useUiStore((s) => s.leftNavCollapsed);
  const toggleLeftNavCollapsed = useUiStore((s) => s.toggleLeftNavCollapsed);
  const searchFocusTrigger = useUiStore((s) => s.searchFocusTrigger);

  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [confirmTaskId, setConfirmTaskId] = useState('');
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [showAllTasks, setShowAllTasks] = useState(false);

  const findTask = (taskId: string) => useTaskStore.getState().tasks.find((t) => t.id === taskId);

  const handleCompact = useCallback(
    (taskId: string) => {
      const task = findTask(taskId);
      if (!task) return;
      // ⭐ B8：走**共享入口**（与斜杠命令同一条路）—— 这里不再自己插消息，
      //    也不再自己判断"压没压成"，那些都在统一出口里（见 compaction-announce.ts）。
      void runManualCompaction(
        {
          getStore: () => useMessageStore.getState(),
          translate: (key: string) => t(key),
          compactSession: (gw, sk) => window.clawwork.compactSession(gw, sk),
        },
        { gatewayId: task.gatewayId, sessionKey: task.sessionKey, taskId },
      ).catch(() => {});
    },
    [t],
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
  }, [confirmTaskId, clearMessages, addMessage, t]);

  const handleDeleteConfirm = useCallback(() => {
    const task = findTask(confirmTaskId);
    if (task) {
      window.clawwork.deleteSession(task.gatewayId, task.sessionKey).catch(() => {});
    }
    clearMessages(confirmTaskId);
    removeTask(confirmTaskId);
    setConfirmAction(null);
  }, [confirmTaskId, clearMessages, removeTask]);

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
    [handleCompact, gwStatusMap],
  );

  const { items, isOpen, openMenu, closeMenu } = useTaskContextMenu(updateTaskStatus, sessionActions);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
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

  const handleContextMenu = (e: MouseEvent, taskId: string, status: TaskStatus): void => {
    setMenuPos({ x: e.clientX, y: e.clientY });
    openMenu(e, taskId, status);
  };

  const { selectedGwId, agentCatalog, defaultAgentId } = useGatewaySelector();
  const selectedAgentId = useUiStore((s) => s.selectedAgentByGateway[selectedGwId] ?? '');
  const setSelectedAgent = useUiStore((s) => s.setSelectedAgent);
  const currentAgentId = selectedAgentId || defaultAgentId || agentCatalog[0]?.id || '';

  // ⚠️ 排序**不能**就地 `.sort()`：`tasks` 是 store 里的数组，就地排会改到别人。
  //    排序规则与"只显示 5 条"的裁剪统一放在 `lib/task-sort` 里（纯函数、有单测）——
  //    置顶要在最前，**且不吃那 5 个名额**，否则置顶越多、普通任务露脸越少。
  const visibleTasks = useMemo(
    () => tasks.filter((task) => task.status !== 'archived' && (!currentAgentId || task.agentId === currentAgentId)),
    [currentAgentId, tasks],
  );
  const { visible: displayedTasks, hiddenCount } = useMemo(
    () => splitVisibleTasks(visibleTasks, { limit: 5, showAll: showAllTasks }),
    [visibleTasks, showAllTasks],
  );
  const sessionPreviews = useSessionPreviews(visibleTasks);

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      setSelectedAgent(selectedGwId, agentId);
      const pending = useTaskStore.getState().pendingNewTask;
      const sameScope = pending?.gatewayId === selectedGwId && pending.agentId === agentId;
      const tags = sameScope ? pending?.tags : removeAssistantTaskPresetTags(pending?.tags ?? []);
      const { tags: _previousTags, ...pendingWithoutTags } = pending ?? {};
      setPending({
        ...(sameScope ? pending : pendingWithoutTags),
        gatewayId: selectedGwId,
        agentId,
        ...(tags && tags.length > 0 ? { tags } : {}),
      });
      setActiveTask(null);
      setMainView('chat');
    },
    [selectedGwId, setActiveTask, setMainView, setPending, setSelectedAgent],
  );

  const CollapseToggleButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={toggleLeftNavCollapsed}
          aria-label={t('leftNav.collapseNav')}
          className="titlebar-no-drag flex items-center justify-center w-8 h-8 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors focus-visible:outline-none glow-focus active:scale-95"
        >
          <PanelLeftClose size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{t('leftNav.collapseNav')}</TooltipContent>
    </Tooltip>
  );

  const overlays = (
    <>
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
    </>
  );

  return (
    <div className="relative flex h-full flex-col overflow-hidden pt-10">
      <div className="titlebar-drag absolute inset-x-0 top-0 z-[51] flex h-10 items-center justify-end px-3">
        <div className="titlebar-no-drag flex items-center gap-0.5">{CollapseToggleButton}</div>
      </div>

      <div className="flex-shrink-0 px-3 py-2">
        <div className="titlebar-no-drag relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('leftNav.searchTasks')}
            className="w-full h-[var(--density-control-height-sm)] pl-9 pr-3 rounded-md bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] type-body glow-focus focus:border-transparent transition-all"
          />
        </div>
      </div>

      {/* 页面导航（2026-09-19，按老板设计稿 + 方案 B）。
          ⚠️ 「我的助手」不再是一块常驻展开的列表 —— 它变成导航列表里**「身份中心」上面那一行**
             （`AssistantSwitcher`，点开才选角色）。用户口径：
             「把他放身份中心上面，点击后可以选择这几个角色」+「现在不好看」。
          ⚠️ 放在助手之后、最近任务之前 —— 设计稿里这一列是「搜索框 + 页面清单」，
             我们额外把助手切换与最近任务保留在这一列（否则界面上没有别的地方能切）。
          ⚠️ **必须可滚动**：去掉图标栏后这一列涨到 16 项，加上助手列表与最近任务
             会挤爆整列 —— 实测底部两项（内测中心 / 设置）被裁在视口外。
             `min-h-0 + shrink + overflow-y-auto`：让它在空间不够时自己滚，
             而不是把下面的「最近任务」挤出屏幕。 */}
      <div className="min-h-0 shrink overflow-y-auto border-b border-[var(--border-subtle)] py-2">
        <NavMenu
          mainView={mainView}
          settingsOpen={settingsOpen}
          onSelectView={setMainView}
          onOpenSkills={onOpenSkills}
          onOpenSettings={onOpenSettings}
          hasUpdate={hasUpdate}
          assistantSlot={
            <AssistantSwitcher
              agents={agentCatalog}
              selectedAgentId={currentAgentId}
              onSelect={handleSelectAgent}
              onAddAssistant={onOpenAssistantSettings}
            />
          }
        />
      </div>

      <div className="relative flex-1 min-h-0">
        <AnimatePresence>
          {searchQuery.trim() && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: motionDuration.normal }}
              className="absolute inset-0 z-10 bg-[var(--bg-elevated)] border-t border-[var(--border)]"
            >
              <SearchResults results={searchResults} onSelect={handleSelectResult} />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex h-full flex-col">
          <div className="flex flex-shrink-0 items-center gap-2 px-3 pb-1 pt-1">
            <List size={14} className="text-[var(--text-muted)]" />
            <h3 className="type-support flex-1 text-[var(--text-secondary)]">{t('leftNav.recentTasks')}</h3>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => startNewTask({ gatewayId: selectedGwId, agentId: currentAgentId })}
                  aria-label={t('common.newTask')}
                  className="titlebar-no-drag glow-focus flex h-7 w-7 items-center justify-center rounded-md text-[var(--accent)] transition-colors hover:bg-[var(--accent-dim)] active:scale-95"
                >
                  <SquarePen size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{t('common.newTask')}</TooltipContent>
            </Tooltip>
          </div>

          <ScrollArea className="flex-1">
            <motion.div
              variants={motionPresets.staggerContainer}
              initial="initial"
              animate="animate"
              className="px-3 py-1"
            >
              {visibleTasks.length === 0 && <EmptyState title={t('leftNav.emptyHint')} className="py-8" />}
              {displayedTasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  active={task.id === activeTaskId}
                  onContextMenu={(event) => handleContextMenu(event, task.id, task.status)}
                  editing={editingTaskId === task.id}
                  onEditDone={() => setEditingTaskId(null)}
                  preview={sessionPreviews[task.id]}
                />
              ))}
            </motion.div>
          </ScrollArea>
        </div>
      </div>

      {hiddenCount > 0 && (
        <div className="flex-shrink-0 border-t border-[var(--border-subtle)] px-3 py-2">
          <button
            type="button"
            onClick={() => setShowAllTasks((visible) => !visible)}
            className="titlebar-no-drag glow-focus flex w-full items-center justify-center gap-2 rounded-md py-1.5 type-support text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <List size={14} />
            {t(showAllTasks ? 'leftNav.showFewerTasks' : 'leftNav.viewAllTasks')}
          </button>
        </div>
      )}

      {overlays}
    </div>
  );
}
