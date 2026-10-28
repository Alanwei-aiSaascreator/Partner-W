import { useTranslation } from 'react-i18next';
import { useTaskStore, useUiStore } from '../stores/hooks';
import { ensureHydrationReady } from '../stores';

interface TaskListProps {
  onSelect: () => void;
  /** 关键词过滤（抽屉顶部的搜索框）。空串 = 不过滤。 */
  filter?: string;
}

const MS_PER_DAY = 86_400_000;

interface TaskGroup {
  label: string;
  tasks: Array<{ id: string; title: string; updatedAt: string }>;
}

function groupByTime(
  tasks: Array<{ id: string; title: string; updatedAt: string }>,
  labels: { today: string; yesterday: string; thisWeek: string; older: string },
): TaskGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - MS_PER_DAY);
  const weekAgo = new Date(today.getTime() - 7 * MS_PER_DAY);

  const groups: TaskGroup[] = [
    { label: labels.today, tasks: [] },
    { label: labels.yesterday, tasks: [] },
    { label: labels.thisWeek, tasks: [] },
    { label: labels.older, tasks: [] },
  ];

  for (const task of tasks) {
    const updated = new Date(task.updatedAt);
    if (updated >= today) groups[0].tasks.push(task);
    else if (updated >= yesterday) groups[1].tasks.push(task);
    else if (updated >= weekAgo) groups[2].tasks.push(task);
    else groups[3].tasks.push(task);
  }

  return groups.filter((g) => g.tasks.length > 0);
}

export function TaskList({ onSelect, filter = '' }: TaskListProps) {
  const { t } = useTranslation();
  const tasks = useTaskStore((s) => s.tasks);
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const setActiveTask = useTaskStore((s) => s.setActiveTask);
  const unreadTaskIds = useUiStore((s) => s.unreadTaskIds);
  const clearUnread = useUiStore((s) => s.clearUnread);

  const keyword = filter.trim().toLowerCase();
  const visibleTasks = keyword
    ? tasks.filter((task) => (task.title ?? '').toLowerCase().includes(keyword))
    : tasks;

  const groupedTasks = groupByTime(visibleTasks, {
    today: t('tasks.today'),
    yesterday: t('tasks.yesterday'),
    thisWeek: t('tasks.thisWeek'),
    older: t('tasks.older'),
  });

  return (
    <nav className="py-2" role="navigation" aria-label={t('tasks.navigationLabel')}>
      {groupedTasks.map((group) => (
        <div key={group.label} className="mb-2 px-2">
          <div className="px-2 py-1.5">
            <span className="type-meta" style={{ color: 'var(--text-muted)' }}>
              {group.label}
            </span>
          </div>
          {group.tasks.map((task) => {
            const isActive = task.id === activeTaskId;
            const isUnread = unreadTaskIds.has(task.id);
            return (
              <button
                key={task.id}
                onClick={async () => {
                  // 先确保消息已从本地库灌进 store，否则切过去是一片空白，
                  // 看起来就像"点了没反应"（真机反馈）。
                  await ensureHydrationReady();
                  setActiveTask(task.id);
                  clearUnread(task.id);
                  onSelect();
                }}
                aria-label={task.title || t('tasks.newTask')}
                aria-current={isActive ? 'true' : undefined}
                className="list-item-card mb-1 flex w-full items-center gap-2 px-3 py-3 text-left"
                style={{
                  backgroundColor: isActive ? 'var(--bg-hover)' : undefined,
                  borderColor: isActive ? 'var(--accent)' : undefined,
                }}
              >
                <span
                  className="type-body flex-1 truncate"
                  style={{
                    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: isUnread ? 600 : 400,
                  }}
                >
                  {task.title || t('tasks.newTask')}
                </span>
                {isUnread && (
                  <div
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: 'var(--accent)' }}
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>
      ))}
      {tasks.length === 0 && (
        <div className="px-4 py-8 text-center">
          <p className="type-support" style={{ color: 'var(--text-muted)' }}>
            {t('tasks.empty')}
          </p>
        </div>
      )}
    </nav>
  );
}
