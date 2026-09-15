import { useState, useEffect, useRef, useCallback, useMemo, type MouseEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { List, PanelLeftClose, Plus, Search, SquarePen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTaskStore } from '@/stores/taskStore';
import { useMessageStore } from '@/stores/messageStore';
import { useUiStore } from '@/stores/uiStore';
import { useFileStore } from '@/stores/fileStore';
import { useTaskContextMenu, TaskContextMenuPopover, type SessionActions } from '@/components/ContextMenu';
import SearchResults, { type SearchResult } from '@/components/SearchResults';
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
import AssistantList from './AssistantList';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import type { TaskStatus } from '@clawwork/shared';
import EmptyState from '@/components/semantic/EmptyState';
import { useSessionPreviews } from '@/hooks/useSessionPreviews';

type ConfirmAction = 'reset' | 'delete' | null;

interface LeftNavProps {
  onOpenAssistantSettings: () => void;
}

export default function LeftNav({ onOpenAssistantSettings }: LeftNavProps) {
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
      window.clawwork
        .compactSession(task.gatewayId, task.sessionKey)
        .then((res) => {
          if (res.ok) addMessage(taskId, 'system', t('session.contextCompacted'));
        })
        .catch(() => {});
    },
    [addMessage, t],
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

  const visibleTasks = useMemo(
    () =>
      tasks
        .filter((task) => task.status !== 'archived' && (!currentAgentId || task.agentId === currentAgentId))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [currentAgentId, tasks],
  );
  const displayedTasks = showAllTasks ? visibleTasks : visibleTasks.slice(0, 5);
  const sessionPreviews = useSessionPreviews(visibleTasks);

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      setSelectedAgent(selectedGwId, agentId);
      const pending = useTaskStore.getState().pendingNewTask;
      setPending({ ...pending, gatewayId: selectedGwId, agentId });
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
      <div className="titlebar-drag absolute inset-x-0 top-0 z-[51] flex h-10 items-center justify-between px-3">
        <h2 className="type-label truncate text-[var(--text-primary)]">{t('leftNav.myAssistants')}</h2>
        <div className="titlebar-no-drag flex items-center gap-0.5">
          {CollapseToggleButton}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={onOpenAssistantSettings}
                aria-label={t('leftNav.addAssistant')}
                className="h-7 w-7"
              >
                <Plus />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('leftNav.addAssistant')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex-shrink-0 border-b border-[var(--border-subtle)] px-2 pb-2">
        {agentCatalog.length > 0 ? (
          <AssistantList agents={agentCatalog} selectedAgentId={currentAgentId} onSelect={handleSelectAgent} />
        ) : (
          <p className="type-support px-2 py-3 text-[var(--text-muted)]">{t('leftNav.noAgents')}</p>
        )}
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

      {visibleTasks.length > 5 && (
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
