import { describe, expect, it } from 'vitest';
import { filterTasksForPanel, type TaskPanelFilter } from '../src/renderer/lib/task-panel';

/**
 * 「最近任务」面板（导航行 → 右侧全量列表）的筛选取数。
 *
 * 与左栏原来那块的区别（用户 2026-09-20：「在最下面不好，显示也不全」）：
 * - **不限 5 条**（`splitVisibleTasks` 的 `limit` 只属于左栏那块，面板不裁剪）
 * - 能按状态筛选（全部 / 进行中 / 已归档），能按标题搜索
 * - **跨助手**：面板是"我的全部对话"，不再只看当前选中的助手
 */
type T = { id: string; title: string; status: string; updatedAt: string; sessionKey: string };

const t = (id: string, title: string, extra: Partial<T> = {}): T => ({
  id,
  title,
  status: 'active',
  updatedAt: '2026-09-20T00:00:00.000Z',
  sessionKey: `agent:partner-w-content:clawwork:dev1:task:${id}`,
  ...extra,
});

const run = (tasks: T[], opts: { query?: string; filter?: TaskPanelFilter } = {}) =>
  filterTasksForPanel(tasks, { query: opts.query ?? '', filter: opts.filter ?? 'all' }).map((x) => x.id);

describe('filterTasksForPanel', () => {
  it('默认（全部 + 空搜索）⇒ 一条不落，且**不限条数**', () => {
    const many = Array.from({ length: 23 }, (_, i) => t(`t${i}`, `任务 ${i}`));

    expect(run(many)).toHaveLength(23);
  });

  it('「进行中」⇒ 去掉归档的；「已归档」⇒ 只要归档的', () => {
    const tasks = [t('a', '甲'), t('b', '乙', { status: 'archived' }), t('c', '丙')];

    expect(run(tasks, { filter: 'active' })).toEqual(['a', 'c']);
    expect(run(tasks, { filter: 'archived' })).toEqual(['b']);
    expect(run(tasks, { filter: 'all' })).toEqual(['a', 'b', 'c']);
  });

  it('搜索按标题，忽略大小写与首尾空格', () => {
    const tasks = [t('a', 'Vlog 脚本'), t('b', '做菜先放油'), t('c', 'vlog 剪辑')];

    expect(run(tasks, { query: 'VLOG' })).toEqual(['a', 'c']);
    expect(run(tasks, { query: '  剪辑 ' })).toEqual(['c']);
  });

  it('⭐ 搜索与筛选同时生效（不是二选一）', () => {
    const tasks = [t('a', 'vlog 脚本'), t('b', 'vlog 续集', { status: 'archived' })];

    expect(run(tasks, { query: 'vlog', filter: 'active' })).toEqual(['a']);
  });

  it('搜不到 ⇒ 空数组（调用方据此显示"没有匹配"）', () => {
    expect(run([t('a', '甲')], { query: 'zzz' })).toEqual([]);
  });

  it('⭐ 跨助手：别人的助手建的任务也在（面板是"我的全部对话"）', () => {
    const tasks = [t('a', '甲'), t('b', '乙', { sessionKey: 'agent:partner-w-research:clawwork:dev1:task:b' })];

    expect(run(tasks)).toEqual(['a', 'b']);
  });

  it('不改原数组', () => {
    const tasks = [t('b', '乙'), t('a', '甲')];

    filterTasksForPanel(tasks, { query: '', filter: 'all' });

    expect(tasks.map((x) => x.id)).toEqual(['b', 'a']);
  });
});
