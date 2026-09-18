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
