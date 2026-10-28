import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Pin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn, formatRelativeTime } from '@/lib/utils';
import { useTaskStore } from '@/stores/taskStore';
import { useUiStore } from '@/stores/uiStore';
import { useMessageStore } from '@/stores/messageStore';
import { useRoomStore } from '@/stores/roomStore';
import { deriveSessionActivity, getTaskSessionKeys } from '@clawwork/core';
import type { Task } from '@clawwork/shared';
import ActivityBars from '@/components/ActivityBars';

interface TaskRowProps {
  task: Task;
  active: boolean;
  /** 这个任务归哪个助手（`resolveTaskAgentId` 的结果），用来显示归属。 */
  agentLabel?: string;
  agentEmoji?: string;
  editing?: boolean;
  onEditDone?: () => void;
  onContextMenu: (event: MouseEvent) => void;
}

/**
 * 宽面板（`TasksPanel`）里的一行：**一行装完**（标题 + 角标 + 助手 + 相对时间）。
 *
 * ## 为什么不复用 `LeftNav/TaskItem`（2026-09-20 用户截图反馈：「看着好乱」）
 *
 * `TaskItem` 是给**窄栏**（224px）设计的：标题一行、预览一行、行与行零间距。
 * 搬到宽面板后，每条预览几乎横贯整屏、一行挨着一行 ⇒ 看着"堆在一起"。
 *
 * ⚠️ **预览行是刻意去掉的**（第一版带过，被用户截图打回）：用户在草图上确认的形态
 * 就是「每行一行：标题 … 相对时间」。要加回来先问，别自己塞。
 * 现在：标题 `truncate`、右侧「助手 + 相对时间」固定宽度，行间由调用方 `space-y` 拉开。
 */
export default function TaskRow({
  task,
  active,
  agentLabel,
  agentEmoji,
  editing,
  onEditDone,
  onContextMenu,
}: TaskRowProps) {
  const { t } = useTranslation();
  const setActiveTask = useTaskStore((s) => s.setActiveTask);
  const updateTaskTitle = useTaskStore((s) => s.updateTaskTitle);
  const clearUnread = useUiStore((s) => s.clearUnread);
  const hasUnread = useUiStore((s) => s.unreadTaskIds.has(task.id));
  const setMainView = useUiStore((s) => s.setMainView);
  const room = useRoomStore((s) => s.rooms[task.id]);
  const activity = useMessageStore((s) =>
    deriveSessionActivity(getTaskSessionKeys(task, room), s.activeTurnBySession, s.processingBySession),
  );
  const isRunning = activity !== 'idle';

  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(task.title);

  useEffect(() => {
    if (editing) {
      setDraft(task.title);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, task.title]);

  const commitRename = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== task.title) updateTaskTitle(task.id, trimmed);
    onEditDone?.();
  }, [draft, task.title, task.id, updateTaskTitle, onEditDone]);

  const open = useCallback(() => {
    setActiveTask(task.id);
    clearUnread(task.id);
    setMainView('chat');
  }, [clearUnread, setActiveTask, setMainView, task.id]);

  return (
    <div
      data-task-row={task.id}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      onClick={editing ? undefined : open}
      onKeyDown={(event: KeyboardEvent) => {
        if (editing) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
      onContextMenu={onContextMenu}
      className={cn(
        'glow-focus flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
        active ? 'bg-[var(--state-selected)]' : 'hover:bg-[var(--bg-hover)]',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onEditDone?.();
                }
              }}
              className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-0.5 type-body text-[var(--text-primary)] glow-focus"
            />
          ) : (
            <>
              <span className="truncate type-body text-[var(--text-primary)]">{task.title || t('common.newTask')}</span>
              {task.pinnedAt ? <Pin size={13} className="flex-shrink-0 text-[var(--accent)]" /> : null}
              {isRunning ? <ActivityBars className="flex-shrink-0" /> : null}
              {hasUnread ? (
                <span
                  role="img"
                  aria-label={t('tasksPanel.unread')}
                  className="size-2 flex-shrink-0 rounded-full bg-[var(--accent)]"
                />
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* ⚠️ 这里**不许**写任意宽度值（`check:ui-contract` 的 layout-escape 规则只放行
          密度/内容/弹窗那几个设计变量；连注释里写出那个类的字面量都会被扫到）。
          空间不够时靠 `min-w-0` + `truncate` 让「助手名」先被压缩，
          而相对时间 `whitespace-nowrap` 永远完整。 */}
      <div className="flex min-w-0 flex-shrink items-center gap-2 type-meta text-[var(--text-muted)]">
        {agentLabel ? (
          <span className="truncate" title={agentLabel}>
            {agentEmoji ? `${agentEmoji} ` : ''}
            {agentLabel}
          </span>
        ) : null}
        <span className="whitespace-nowrap">{formatRelativeTime(new Date(task.updatedAt))}</span>
      </div>
    </div>
  );
}
