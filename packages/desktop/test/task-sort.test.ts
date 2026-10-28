import { describe, expect, it } from 'vitest';
import { compareTasksForSidebar, splitVisibleTasks } from '../src/renderer/lib/task-sort';

/**
 * 侧边栏任务的排序与可见性。
 *
 * 置顶存在的意义不只是"排前面" —— 左侧默认**只显示 5 条**（`LeftNav/index.tsx`），
 * 所以一个被置顶的任务如果还会被这条裁剪掉，置顶就等于没用。这是本文件的核心。
 */
type T = { id: string; updatedAt: string; pinnedAt?: string };

const t = (id: string, updatedAt: string, pinnedAt?: string): T => ({
  id,
  updatedAt,
  ...(pinnedAt ? { pinnedAt } : {}),
});

describe('compareTasksForSidebar —— 置顶优先，各自内部按时间倒序', () => {
  it('⭐ 置顶的排在所有未置顶前面（哪怕未置顶的更新时间更近）', () => {
    const list = [t('a', '2026-09-18T10:00:00Z'), t('b', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')];
    expect([...list].sort(compareTasksForSidebar).map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('⭐ 多个置顶之间按"最近置顶"排（所以存时间戳而不是布尔）', () => {
    const list = [
      t('旧置顶', '2026-09-18T10:00:00Z', '2026-09-01T00:00:00Z'),
      t('新置顶', '2026-09-01T00:00:00Z', '2026-09-18T00:00:00Z'),
    ];
    expect([...list].sort(compareTasksForSidebar).map((x) => x.id)).toEqual(['新置顶', '旧置顶']);
  });

  it('未置顶的之间按 updatedAt 倒序（保持原有行为不变）', () => {
    const list = [t('旧', '2026-09-01T00:00:00Z'), t('新', '2026-09-18T00:00:00Z')];
    expect([...list].sort(compareTasksForSidebar).map((x) => x.id)).toEqual(['新', '旧']);
  });

  it('取消置顶后回到未置顶那一组，位置由 updatedAt 决定', () => {
    const pinnedThenCleared = t('x', '2026-09-01T00:00:00Z');
    const list = [t('y', '2026-09-18T00:00:00Z'), pinnedThenCleared];
    expect([...list].sort(compareTasksForSidebar).map((x) => x.id)).toEqual(['y', 'x']);
  });

  it('空串/pinnedAt 缺失都算未置顶（别把空串当"有值"）', () => {
    const list = [t('正常', '2026-09-01T00:00:00Z'), { id: '空串', updatedAt: '2026-09-18T00:00:00Z', pinnedAt: '' }];
    expect([...list].sort(compareTasksForSidebar).map((x) => x.id)).toEqual(['空串', '正常']);
  });
});

describe('splitVisibleTasks —— 置顶不吃"只显示 5 条"的配额', () => {
  const many = (): T[] => [
    t('置顶1', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
    t('置顶2', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'),
    t('n1', '2026-09-18T00:00:00Z'),
    t('n2', '2026-09-17T00:00:00Z'),
    t('n3', '2026-09-16T00:00:00Z'),
    t('n4', '2026-09-15T00:00:00Z'),
    t('n5', '2026-09-14T00:00:00Z'),
    t('n6', '2026-09-13T00:00:00Z'),
  ];

  it('⭐ 两个置顶 + 只显示 5 条 ⇒ 置顶全在，未置顶补到 5 条为止（共 7 条）', () => {
    const { visible, hiddenCount } = splitVisibleTasks(many(), { limit: 5, showAll: false });

    expect(visible.map((x) => x.id)).toEqual(['置顶2', '置顶1', 'n1', 'n2', 'n3', 'n4', 'n5']);
    expect(hiddenCount).toBe(1); // n6 被裁
  });

  it('⭐ 置顶本身**不占用**那 5 个名额（否则置顶越多、普通任务越少，等于互相挤）', () => {
    const tasks = [
      t('p', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      t('a', '2026-09-18T00:00:00Z'),
      t('b', '2026-09-17T00:00:00Z'),
    ];
    const { visible } = splitVisibleTasks(tasks, { limit: 2, showAll: false });

    // p 是置顶、不吃名额 ⇒ 未置顶还能显示满 2 条
    expect(visible.map((x) => x.id)).toEqual(['p', 'a', 'b']);
  });

  it('展开"显示全部"时一条不裁', () => {
    const { visible, hiddenCount } = splitVisibleTasks(many(), { limit: 5, showAll: true });
    expect(visible).toHaveLength(8);
    expect(hiddenCount).toBe(0);
  });

  it('总数不到上限时 hiddenCount 为 0（界面据此不显示"展开"）', () => {
    const { visible, hiddenCount } = splitVisibleTasks([t('a', '2026-09-18T00:00:00Z')], { limit: 5, showAll: false });
    expect(visible).toHaveLength(1);
    expect(hiddenCount).toBe(0);
  });

  it('全是置顶 ⇒ 全显示，不裁', () => {
    const tasks = Array.from({ length: 8 }, (_, i) =>
      t(`p${i}`, '2026-09-01T00:00:00Z', `2026-09-0${i + 1}T00:00:00Z`),
    );
    const { visible, hiddenCount } = splitVisibleTasks(tasks, { limit: 5, showAll: false });
    expect(visible).toHaveLength(8);
    expect(hiddenCount).toBe(0);
  });

  it('原数组不被就地改动（调用方还在用它算会话预览）', () => {
    const tasks = many();
    const snapshot = tasks.map((x) => x.id);
    splitVisibleTasks(tasks, { limit: 5, showAll: false });
    expect(tasks.map((x) => x.id)).toEqual(snapshot);
  });
});
