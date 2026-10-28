import { describe, expect, it } from 'vitest';
import type { Task } from '@clawwork/shared';
import { groupTasksForSidebar, taskTimeLabel } from '../src/renderer/lib/sidebar-tasks.js';

/**
 * 左侧栏任务分组（2026-10-17 用户拍板：任务进左栏）。
 *
 * 判据：自然日分组（不是 24 小时窗口）、组内按最后活动倒序、空组不产出。
 */
function task(id: string, iso: string): Task {
  return {
    id,
    sessionKey: `s-${id}`,
    sessionId: `sid-${id}`,
    title: id,
    status: 'active',
    createdAt: iso,
    updatedAt: iso,
    tags: [],
    artifactDir: '',
    gatewayId: 'gw',
  } as Task;
}

// 固定"现在" = 2026-10-17 15:00 本地时间
const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();
const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0, 0).toISOString();

describe('groupTasksForSidebar：归档', () => {
  /**
   * 2026-10-19 闭环缺口：归档只是把 `status` 改了，左栏仍把归档任务列出来 ——
   * "归档 = 隐藏"在左栏根本不成立（右键归档后任务还在原地）。
   */
  it('⭐ 归档任务不许出现在左栏分组里', () => {
    const archived = { ...task('arch', at(17, 10)), status: 'archived' as const };
    const groups = groupTasksForSidebar([task('live', at(17, 11)), archived], NOW);
    const ids = groups.flatMap((group) => group.tasks.map((item) => item.id));
    expect(ids).toContain('live');
    expect(ids).not.toContain('arch');
  });
});

describe('groupTasksForSidebar', () => {
  it('今天 / 昨天 / 本周 / 更早 四组，组内按最后活动倒序', () => {
    const groups = groupTasksForSidebar(
      [
        task('a', at(17, 9)),
        task('b', at(17, 14)),
        task('c', at(16, 23)),
        task('w', at(15, 10)), // 本周三
        task('d', at(10, 8)), // 上周六
      ],
      NOW,
    );
    expect(groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'week', 'earlier']);
    expect(groups[0].tasks.map((t) => t.id)).toEqual(['b', 'a']);
    expect(groups[1].tasks.map((t) => t.id)).toEqual(['c']);
    expect(groups[2].tasks.map((t) => t.id)).toEqual(['w']);
    expect(groups[3].tasks.map((t) => t.id)).toEqual(['d']);
  });

  it('本周边界：本周一 00:00 属"本周"，上周日 23:59 属"更早"', () => {
    const groups = groupTasksForSidebar([task('mon', at(12, 0)), task('sun', at(11, 23))], NOW);
    expect(groups.find((g) => g.key === 'week')?.tasks.map((t) => t.id)).toEqual(['mon']);
    expect(groups.find((g) => g.key === 'earlier')?.tasks.map((t) => t.id)).toEqual(['sun']);
  });

  it('空组不产出（不出现只有标题的分组）', () => {
    const groups = groupTasksForSidebar([task('a', at(17, 9))], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('today');
  });

  it('边界：昨天 00:00 属"昨天"，上周日 23:59 属"更早"', () => {
    const groups = groupTasksForSidebar([task('y', at(16, 0)), task('o', at(11, 23))], NOW);
    expect(groups.find((g) => g.key === 'yesterday')?.tasks.map((t) => t.id)).toEqual(['y']);
    expect(groups.find((g) => g.key === 'earlier')?.tasks.map((t) => t.id)).toEqual(['o']);
  });

  it('坏时间戳不炸：落到"更早"', () => {
    const broken = { ...task('bad', at(17, 9)), updatedAt: 'not-a-date' } as Task;
    const groups = groupTasksForSidebar([broken], NOW);
    expect(groups[0].key).toBe('earlier');
  });
});

describe('taskTimeLabel', () => {
  it('今天/昨天给时分，更早给月-日', () => {
    expect(taskTimeLabel(task('a', at(17, 9)), NOW)).toMatch(/^\d{2}:\d{2}$/);
    expect(taskTimeLabel(task('b', at(16, 21)), NOW)).toMatch(/^\d{2}:\d{2}$/);
    expect(taskTimeLabel(task('c', at(10, 8)), NOW)).toMatch(/^\d{2}-\d{2}$/);
  });
});
