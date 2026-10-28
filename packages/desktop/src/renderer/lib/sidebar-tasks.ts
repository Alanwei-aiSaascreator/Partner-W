import type { Task } from '@clawwork/shared';

/**
 * 左侧栏任务分组（2026-10-17 用户拍板：按 UI 稿把任务列表放回左栏）。
 *
 * 口径（2026-10-17 晚按用户给的设计稿补「本周」）：
 *   · 按**最后活动时间**（`updatedAt`）倒序；
 *   · 分「今天 / 昨天 / 本周 / 更早」四组（本地时区的自然日/自然周，不是 24 小时窗口）——
 *     用户说的是"今天做了什么"，跨时区/跨零点时按自然日才对得上日历；
 *   · 「本周」= 本周一 00:00 起（不含今天/昨天，它们优先）；
 *   · 空组不产出（界面上不出现一个只有标题的空分组）。
 *
 * 纯函数：不读时钟、不碰 store（`now` 必须由调用方传入），这样分组边界可以钉死。
 */
export type SidebarTaskGroupKey = 'today' | 'yesterday' | 'week' | 'earlier';

export interface SidebarTaskGroup {
  key: SidebarTaskGroupKey;
  tasks: Task[];
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 本周一 00:00（本地时区）。周日算上一周的最后一天。 */
function startOfWeek(date: Date): number {
  const sinceMonday = (date.getDay() + 6) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - sinceMonday).getTime();
}

export function groupTasksForSidebar(tasks: readonly Task[], now: number): SidebarTaskGroup[] {
  const todayStart = startOfDay(new Date(now));
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const yesterdayMs = yesterdayStart.getTime();
  const weekStart = startOfWeek(new Date(now));

  const buckets: Record<SidebarTaskGroupKey, Task[]> = { today: [], yesterday: [], week: [], earlier: [] };
  for (const task of tasks) {
    // ⭐ 2026-10-19 闭环：**归档 = 从工作列表里拿掉**。
    //    此前归档只改 `status`，左栏照旧显示它（"归档了还在"），用户会以为归档没生效。
    //    归档页仍按 status 列出它们并可恢复；这里只负责"不该出现在左栏的不出现"。
    if (task.status === 'archived') continue;
    const at = Date.parse(task.updatedAt);
    const stamp = Number.isFinite(at) ? at : 0;
    const key: SidebarTaskGroupKey =
      stamp >= todayStart ? 'today' : stamp >= yesterdayMs ? 'yesterday' : stamp >= weekStart ? 'week' : 'earlier';
    buckets[key].push(task);
  }

  const groups: SidebarTaskGroup[] = [];
  for (const key of ['today', 'yesterday', 'week', 'earlier'] as const) {
    const items = buckets[key].slice().sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    if (items.length > 0) groups.push({ key, tasks: items });
  }
  return groups;
}

/** 任务行右侧的时间标签：今天/昨天只给时分，更早给「月-日」。 */
export function taskTimeLabel(task: Task, now: number): string {
  const at = new Date(Date.parse(task.updatedAt));
  if (!Number.isFinite(at.getTime())) return '';
  const todayStart = startOfDay(new Date(now));
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  if (at.getTime() >= todayStart) {
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  }
  if (at.getTime() >= yesterdayStart.getTime()) {
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  }
  return `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}
