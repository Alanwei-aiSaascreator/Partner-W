/**
 * 右侧「产物」面板的**历史产物**（2026-09-26）。
 *
 * 为什么要有它：数据层一直能全库查（`listArtifacts()` 不传参 = 全库，「文件」主视图就是这么用的），
 * 但**右侧面板只查当前会话** ⇒ 开一个新会话，上一个会话产出的东西在这一页就"消失了"
 * （东西没丢，丢的是路）。这一层补的是"**人在会话里也看得到**"。
 *
 * ⚠️ 纯函数：分组、排序、上限都在这里，组件只负责画与折叠 —— 于是"跨对话"这件事**可单测**。
 */
import type { Artifact } from '@clawwork/shared';

/** 历史区最多列这么多条（再多就该去「文件」主视图里看，那里才是全量）。 */
export const ARTIFACT_HISTORY_LIMIT = 50;

export interface ArtifactHistoryGroup {
  taskId: string;
  /** 该会话的产物，**时间倒序**。 */
  artifacts: Artifact[];
}

export interface ArtifactHistory {
  /** 按"最近一条的时间"倒序的会话分组。 */
  groups: ArtifactHistoryGroup[];
  /** 显示出来的条数。 */
  shown: number;
  /** 因为上限没显示出来的条数（界面要说出来，不许让它悄悄消失）。 */
  hidden: number;
}

const timeOf = (artifact: Artifact): number => new Date(artifact.createdAt).getTime();

/**
 * 把全库产物整理成"历史产物"。
 *
 * ⚠️ **当前会话的产物要排除**：它们在主列表里，再出现一次就是重复，用户会以为有两份。
 */
export function buildArtifactHistory(
  all: readonly Artifact[],
  activeTaskId: string | null,
  limit: number = ARTIFACT_HISTORY_LIMIT,
): ArtifactHistory {
  const others = all.filter((a) => a.taskId !== activeTaskId).sort((a, b) => timeOf(b) - timeOf(a));
  const kept = others.slice(0, limit);

  const groups: ArtifactHistoryGroup[] = [];
  const byTask = new Map<string, ArtifactHistoryGroup>();
  for (const artifact of kept) {
    let group = byTask.get(artifact.taskId);
    if (!group) {
      group = { taskId: artifact.taskId, artifacts: [] };
      byTask.set(artifact.taskId, group);
      groups.push(group);
    }
    group.artifacts.push(artifact);
  }

  return { groups, shown: kept.length, hidden: others.length - kept.length };
}
