import { describe, expect, it } from 'vitest';
import type { Artifact } from '@clawwork/shared';

import { ARTIFACT_HISTORY_LIMIT, buildArtifactHistory } from '../src/renderer/lib/artifact-history';

/**
 * 右侧「产物」面板的**历史产物**分组（2026-09-26，用户点名的"产物列表跨对话记忆"）。
 *
 * 现状（改之前）：右侧面板只查 `activeTaskId` ⇒ **新会话里看不到上一个会话产出的东西**，
 * 而数据层其实早就能全库查（`listArtifacts()` 不传参 = 全库，主视图「文件」就是这么用的）。
 * 补的是"**人在会话里也看得到**"，不是"数据丢了"。
 *
 * ⚠️ 判据是"分组、排序、上限"三件事都**可单测**：组件只负责画和折叠。
 */

const artifact = (id: string, taskId: string, createdAt: string): Artifact =>
  ({
    id,
    taskId,
    messageId: `m-${id}`,
    type: 'file',
    name: `${id}.txt`,
    filePath: '',
    localPath: `${taskId}/${id}.txt`,
    mimeType: 'text/plain',
    size: 1,
    createdAt,
    availability: 'available',
  }) as Artifact;

describe('buildArtifactHistory', () => {
  it('⭐ 当前会话的产物**不进历史区**（它们在主列表里，进来就是重复）', () => {
    const all = [artifact('a1', 'task-1', '2026-09-26T10:00:00Z'), artifact('b1', 'task-2', '2026-09-26T09:00:00Z')];

    const history = buildArtifactHistory(all, 'task-1');

    expect(history.groups.map((g) => g.taskId)).toEqual(['task-2']);
    expect(history.groups[0].artifacts.map((a) => a.id)).toEqual(['b1']);
  });

  it('按来源会话分组，组内与组间都按时间倒序', () => {
    const all = [
      artifact('old', 'task-2', '2026-09-20T10:00:00Z'),
      artifact('newest', 'task-3', '2026-09-26T10:00:00Z'),
      artifact('mid', 'task-2', '2026-09-24T10:00:00Z'),
    ];

    const history = buildArtifactHistory(all, 'task-1');

    expect(history.groups.map((g) => g.taskId)).toEqual(['task-3', 'task-2']);
    expect(history.groups[1].artifacts.map((a) => a.id)).toEqual(['mid', 'old']);
  });

  it('没有当前会话（新会话还没 id）⇒ 全部按历史显示', () => {
    const all = [artifact('a', 'task-1', '2026-09-26T10:00:00Z')];

    expect(buildArtifactHistory(all, null).groups[0].taskId).toBe('task-1');
  });

  it('⭐ 上限：只显示最近 50 条，并**如实报出**还有多少条没显示', () => {
    const all = Array.from({ length: ARTIFACT_HISTORY_LIMIT + 7 }, (_, i) =>
      artifact(`a${String(i).padStart(3, '0')}`, 'task-9', new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString()),
    );

    const history = buildArtifactHistory(all, null);
    const shown = history.groups.reduce((sum, g) => sum + g.artifacts.length, 0);

    expect(shown).toBe(ARTIFACT_HISTORY_LIMIT);
    expect(history.hidden).toBe(7);
    // 截断要**从最旧的一头截**：留下的必须是最近的那些
    expect(history.groups[0].artifacts[0].id).toBe(`a${String(ARTIFACT_HISTORY_LIMIT + 6).padStart(3, '0')}`);
  });

  it('没有历史 ⇒ 空分组、hidden 0（界面据此整块不渲染）', () => {
    const only = [artifact('a', 'task-1', '2026-09-26T10:00:00Z')];

    const history = buildArtifactHistory(only, 'task-1');

    expect(history.groups).toEqual([]);
    expect(history.hidden).toBe(0);
  });
});
