import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { groupTasksForSidebar, taskTimeLabel, type SidebarTaskGroupKey } from '@/lib/sidebar-tasks';
import type { Task } from '@clawwork/shared';

/**
 * 左侧栏任务列表（2026-10-17 用户按 UI 稿 `rongyu-mofu-wb-v2` 拍板：
 * 「按设计稿：任务进左栏」；同日晚补齐设计稿的四组 + 计数 + 分组折叠）。
 *
 * 口径：
 *   · 分组 = 今天 / 昨天 / 本周 / 更早（`lib/sidebar-tasks.ts` 的纯函数，自然日/自然周）；
 *   · 标题行显示总数与一个搜索入口；每组可折叠（带条数）；底部「全部任务 · N」；
 *   · 行高 32px、标题省略、右侧时间；正在跑的会话显示一个呼吸圆点；
 *   · 点一行 = 切到那条任务；底部「全部任务」进右侧全量面板（那里才有改名/删除）。
 *
 * ⚠️ 这里**只做选择**，不做管理动作：重命名/置顶/删除仍然只有右侧 TasksPanel 一处
 *    （单一 owner，避免同一任务两个地方可改）。
 */
export default function TaskList({
  tasks,
  activeTaskId,
  runningSessionKeys,
  collapsed,
  onSelect,
  onShowAll,
  onSearch,
}: {
  tasks: readonly Task[];
  activeTaskId: string | null;
  runningSessionKeys: ReadonlySet<string>;
  collapsed: boolean;
  onSelect: (taskId: string) => void;
  onShowAll: () => void;
  /** 标题行那个放大镜：把焦点送回顶部的搜索框（设计稿同款入口）。 */
  onSearch?: () => void;
}) {
  const { t } = useTranslation();
  const now = Date.now();
  // 归档任务不参与左栏的**任何**计数与分组（"归档 = 从工作列表拿掉"）。
  const visibleTasks = useMemo(() => tasks.filter((task) => task.status !== 'archived'), [tasks]);
  const groups = useMemo(() => groupTasksForSidebar(visibleTasks, now), [visibleTasks, now]);
  /** 折叠的是**组**（key），默认全部展开。 */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<SidebarTaskGroupKey>>(new Set());

  if (collapsed) return null;

  const groupLabel = (key: SidebarTaskGroupKey) =>
    t(
      key === 'today'
        ? 'leftNav.taskGroups.today'
        : key === 'yesterday'
          ? 'leftNav.taskGroups.yesterday'
          : key === 'week'
            ? 'leftNav.taskGroups.week'
            : 'leftNav.taskGroups.earlier',
    );

  const toggleGroup = (key: SidebarTaskGroupKey) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div data-testid="left-nav-tasks" className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center gap-1.5 px-3 py-2 type-support text-[var(--text-muted)]">
        <span>{t('leftNav.taskGroups.header')}</span>
        <span className="type-badge text-[var(--text-muted)]">{visibleTasks.length}</span>
        {onSearch ? (
          <button
            type="button"
            onClick={onSearch}
            aria-label={t('leftNav.searchTasks')}
            className="glow-focus ml-auto rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Search size={13} />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.length === 0 ? (
          <p className="px-2 py-3 type-support text-[var(--text-muted)]">{t('leftNav.taskGroups.empty')}</p>
        ) : (
          groups.map((group) => {
            const folded = collapsedGroups.has(group.key);
            return (
              <div key={group.key}>
                <button
                  type="button"
                  data-testid={`left-nav-group-${group.key}`}
                  aria-expanded={!folded}
                  onClick={() => toggleGroup(group.key)}
                  className="glow-focus flex w-full items-center gap-1.5 rounded px-2 pt-2 pb-1 text-left type-badge text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                >
                  <span>{groupLabel(group.key)}</span>
                  <span className="opacity-70">{group.tasks.length}</span>
                  {folded ? <ChevronRight size={12} className="ml-auto" /> : <ChevronDown size={12} className="ml-auto" />}
                </button>
                {!folded &&
                  group.tasks.map((task) => {
                    const active = task.id === activeTaskId;
                    const running = runningSessionKeys.has(task.sessionKey);
                    return (
                      <button
                        key={task.id}
                        type="button"
                        data-task-id={task.id}
                        aria-current={active ? 'true' : undefined}
                        onClick={() => onSelect(task.id)}
                        className={cn(
                          'titlebar-no-drag glow-focus flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors',
                          active
                            ? 'bg-[var(--state-selected)] text-[var(--text-primary)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate type-body">
                          {task.title || t('leftNav.taskGroups.untitled')}
                        </span>
                        {running ? (
                          <span
                            data-testid="left-nav-task-running"
                            className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--accent)] animate-pulse"
                            aria-label={t('leftNav.taskGroups.running')}
                          />
                        ) : null}
                        <span className="flex-shrink-0 type-badge text-[var(--text-muted)]">
                          {taskTimeLabel(task, now)}
                        </span>
                      </button>
                    );
                  })}
              </div>
            );
          })
        )}
      </div>

      <button
        type="button"
        onClick={onShowAll}
        className="titlebar-no-drag glow-focus mx-2 mb-1 flex flex-shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 type-support text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
      >
        <span>{t('leftNav.taskGroups.all')}</span>
        <span className="opacity-70">· {visibleTasks.length}</span>
        <ChevronRight size={13} className="ml-auto" />
      </button>
    </div>
  );
}
