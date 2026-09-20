/**
 * 侧边栏任务的排序与可见性（纯函数，便于钉住）。
 *
 * ## 为什么置顶要单独一套
 *
 * 左侧默认**只显示 5 条**（`layouts/LeftNav/index.tsx` 的 `displayedTasks`）。
 * 所以置顶如果只是"排前面"，它照样会被那条裁剪切掉 —— 那就等于没用。
 * 置顶真正要保证的是「**它一定看得见**」，于是：
 *
 *   - 置顶排在最前，且**不占用**那 5 个名额（否则置顶越多、普通任务越少，互相挤）
 *   - 未置顶的按 `updatedAt` 倒序补满配额，与原行为一致
 *
 * ## 为什么存时间戳而不是布尔
 *
 * 多个置顶之间还要有稳定顺序。存 `pinnedAt` 就能"最近置顶的排最前"，
 * 而布尔只能靠数组原顺序兜底 —— 那个顺序会随任何一次列表刷新而变。
 * 取消置顶 = 清掉字段，任务自然落回未置顶那一组。
 */

import { parseAgentIdFromSessionKey } from '@clawwork/shared';

/** 参与排序所需的字段（结构性子集，避免把 store 的类型拖进来）。 */
interface PinnableTaskLike {
  updatedAt: string;
  pinnedAt?: string;
}

/** 空串也算未置顶 —— 别把 `''` 当"有值"，那会让排序走进字符串比较的坑。 */
function pinKey(task: PinnableTaskLike): string | null {
  const value = task.pinnedAt;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 置顶优先（最近置顶在前），其余按 `updatedAt` 倒序。
 *
 * 直接当 `Array.prototype.sort` 的比较器用。
 */
export function compareTasksForSidebar(left: PinnableTaskLike, right: PinnableTaskLike): number {
  const leftPin = pinKey(left);
  const rightPin = pinKey(right);

  if (leftPin && rightPin) return rightPin.localeCompare(leftPin);
  if (leftPin) return -1;
  if (rightPin) return 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}

interface SplitVisibleTasksOptions {
  /** 未置顶最多显示几条。 */
  limit: number;
  /** 用户展开"显示全部"时为 true，一条不裁。 */
  showAll: boolean;
}

interface SplitVisibleTasksResult<T> {
  visible: T[];
  /** 被裁掉几条（界面据此决定要不要显示"展开"）。 */
  hiddenCount: number;
}

/**
 * 排序 + 按配额裁剪，**保证置顶一定可见**。
 *
 * 不就地改传入的数组：调用方还要拿原列表去算会话预览（`useSessionPreviews`）。
 */
export function splitVisibleTasks<T extends PinnableTaskLike>(
  tasks: readonly T[],
  options: SplitVisibleTasksOptions,
): SplitVisibleTasksResult<T> {
  const sorted = [...tasks].sort(compareTasksForSidebar);

  const pinned = sorted.filter((task) => pinKey(task) !== null);
  const rest = sorted.filter((task) => pinKey(task) === null);

  if (options.showAll) return { visible: sorted, hiddenCount: 0 };

  const kept = rest.slice(0, Math.max(0, options.limit));
  return {
    visible: [...pinned, ...kept],
    hiddenCount: rest.length - kept.length,
  };
}

/** 归属判定所需的字段（结构性子集）。 */
interface AgentOwnedTaskLike {
  agentId?: string;
  sessionKey: string;
}

/**
 * 这个任务**归哪个助手**。
 *
 * ## ⚠️ 为什么不能只看 `task.agentId`（2026-09-20 用户报障「聊天记录咋找不到」）
 *
 * 本地 `tasks` 表**没有 `agent_id` 列**（`db/index.ts` 的 `migrateAddColumn` 只给
 * `messages` 加过它，`CREATE_TABLES_SQL` 里 `tasks` 也没有这一列）
 * ⇒ **从库里读回来的任务 `agentId` 是 undefined**。
 * 而侧栏原来的判据是 `task.agentId === 当前助手` ⇒ 一个都匹配不上 ⇒ **侧栏整片空**。
 *
 * 实测（dev 客户端，CDP 直接读 store）：store 里 **43 个任务、43 个都没有 agentId**，
 * 而 `selectedAgentByGateway['local-runtime'] = 'rongying-content'`
 * ⇒ `visibleTasks = []`，界面上是"聊天记录没了"（**数据一直在库里**）。
 *
 * 会话键里带着真身（`agent:<agentId>:…`）且**是落库的**（`tasks.session_key`）
 * ⇒ 拿它兜底：既不用加列/迁移，也能把**老任务**正确归位。
 * 显式 `agentId` 优先（它是"当下选的"，比会话键更权威）。
 *
 * ⚠️ 会话键认不出助手时 `parseAgentIdFromSessionKey` 回 `'main'` —— 那些任务
 * 归到默认助手名下，**不会消失**。
 */
export function resolveTaskAgentId(task: AgentOwnedTaskLike): string {
  return task.agentId || parseAgentIdFromSessionKey(task.sessionKey);
}

/** 可见性判定所需的字段。 */
interface VisibleTaskLike extends AgentOwnedTaskLike {
  status: string;
}

/**
 * 侧栏里**该露脸**的任务：不属于当前助手的、已归档的，都不露脸。
 *
 * 不就地改传入的数组（调用方还要拿原列表去算会话预览）。
 */
export function visibleTasksForAgent<T extends VisibleTaskLike>(tasks: readonly T[], currentAgentId: string): T[] {
  return tasks.filter(
    (task) => task.status !== 'archived' && (!currentAgentId || resolveTaskAgentId(task) === currentAgentId),
  );
}
