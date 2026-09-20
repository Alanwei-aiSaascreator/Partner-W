/**
 * 「最近任务」面板的筛选取数（纯函数，便于钉住）。
 *
 * ## 与左栏那块的区别（用户 2026-09-20：「在最下面不好，显示也不全」）
 *
 * - **不限 5 条** —— `splitVisibleTasks` 的 `limit: 5` 只属于左栏那块（`LeftNav`），
 *   面板不裁剪（用户要的是"点开看一堆"）。
 * - **能按状态筛**（全部 / 进行中 / 已归档）**能按标题搜**。
 * - **跨助手** —— 面板是"我的全部对话"，不再只看当前选中的助手
 *   （归属规则仍用 `resolveTaskAgentId`，但面板不拿它过滤；左栏才过滤）。
 *
 * 排序与"置顶不吃配额"的规则仍归 `lib/task-sort`（这一个函数只管**取哪些**，不管顺序）。
 */

export type TaskPanelFilter = 'all' | 'active' | 'archived';

interface PanelTaskLike {
  title: string;
  status: string;
}

export interface TaskPanelQuery {
  /** 标题搜索（忽略大小写与首尾空格；空串 = 不筛）。 */
  query: string;
  filter: TaskPanelFilter;
}

export function filterTasksForPanel<T extends PanelTaskLike>(tasks: readonly T[], options: TaskPanelQuery): T[] {
  const needle = options.query.trim().toLowerCase();

  return tasks.filter((task) => {
    if (options.filter === 'active' && task.status === 'archived') return false;
    if (options.filter === 'archived' && task.status !== 'archived') return false;
    if (needle && !task.title.toLowerCase().includes(needle)) return false;
    return true;
  });
}
