/**
 * 「存量模式任务首次采用新策略」的一次性模型/价格变化提示（2026-10-10 Cephalon 批 · Task 4）。
 *
 * ## 为什么需要它
 *
 * 三档（快速/智能/深度）任务的模型由发送路径**对着目录现解析**（`MODE_POLICY`），
 * 任务行上的 `model` 是**最新已确认采用的模型**（composer 在 `presetModel` 的会话
 * patch 成功后更新它）——对存量模式任务，切换前它仍是旧策略值。
 * 默认模型切换后，**存量模式任务**下一轮就会换一个模型跑 —— 用户没点过任何东西，
 * 却在行为与费用上"被换模型"。计划要求：首次采用新策略时**显示一次**变化提示。
 *
 * ## 判据（纯函数；错了的代价：要么用户被换模型却毫不知情，要么每轮都弹）
 *
 * - `custom`（用户显式选过模型）⇒ 不提示 —— 那一档不归模式策略管；
 * - 解析不出将运行的模型（目录没拉到 / 下架）⇒ 不提示（没有可说的变化，不许瞎说）；
 * - 任务没有记录模型（老会话 / 网关发现）⇒ 不提示（无对照，不能断言"变了"）；
 * - 记录的就是**当前商业默认**（含 `clawrouter/` 命名空间写法）⇒ 不提示 ——
 *   按当前策略创建/设置的任务，留痕即新策略值；此时与"将运行的模型"的差异
 *   只可能来自内部路由（如 PPT 钉 DeepSeek），不是策略切换；
 * - 其余（有记录、有目标、且不同）⇒ 提示一次，然后记标记。
 *
 * ⚠️ 标记存 localStorage（`rongying-cube:mode-policy-notice:v1:<taskId>`），与运行数据
 *    同目录（便携 userData）随盘走；刻意**不动 tasks 表结构**（那是数据库变更，
 *    本批不夹带）。
 *
 * ⚠️ **提示层绝不允许阻断发送**（BUG-066）：获取 `window.localStorage` 这个 getter
 *    本身在存储策略拒绝等条件下会抛 `SecurityError`（HTML 规范），所以**取存储对象、
 *    读、写三步全部各自容错**。准确口径：**取不到／读不到 ⇒ 不提示**（宁可漏一次，也不冒
 *    "每轮都弹"的风险）；**写不进 ⇒ 不记账、但不阻断发送**（该次 toast 可能已经展示，
 *    最坏是下次再提示一次）。
 */
import { COMMERCIAL_DEFAULT_MODEL_ID, modelIdMatches, type TaskModeSetting } from '@clawwork/shared';

const STORAGE_PREFIX = 'rongying-cube:mode-policy-notice:v1:';

/** 存储只需要这两只方法（与 `user-onboarding` 的 `GoalAnalysisStorage` 同一模式）。 */
export interface ModePolicyNoticeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * 取 `window.localStorage`——**getter 自身也可能抛**（SecurityError）；
 * 拿不到就返回 `null`，调用方一律降级为"不提示"。
 */
function safeLocalStorage(): ModePolicyNoticeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function modePolicyNoticeKey(taskId: string): string {
  return `${STORAGE_PREFIX}${taskId}`;
}

export function shouldNotifyModePolicyChange(args: {
  sendMode: TaskModeSetting;
  task: { id: string; model?: unknown };
  /** 这一轮模式策略**实际会跑**的模型（含 deck 路由后的最终值）；解析不出传 `undefined`。 */
  effectiveModelId: string | undefined;
  storage?: Pick<ModePolicyNoticeStorage, 'getItem'>;
}): boolean {
  const { sendMode, task, effectiveModelId } = args;
  if (sendMode === 'custom') return false;
  if (!effectiveModelId) return false;
  const recorded = typeof task.model === 'string' ? task.model.trim() : '';
  if (!recorded) return false;
  if (modelIdMatches(recorded, effectiveModelId)) return false;
  if (modelIdMatches(recorded, COMMERCIAL_DEFAULT_MODEL_ID)) return false;
  const storage = args.storage ?? safeLocalStorage();
  if (!storage) return false;
  try {
    return storage.getItem(modePolicyNoticeKey(task.id)) === null;
  } catch {
    return false;
  }
}

export function markModePolicyNotified(taskId: string, storage?: ModePolicyNoticeStorage): void {
  const target = storage ?? safeLocalStorage();
  if (!target) return;
  try {
    target.setItem(modePolicyNoticeKey(taskId), new Date().toISOString());
  } catch {
    /* 写不进就当没记 —— 最坏是下次再提示一次（比把提示吞掉更诚实） */
  }
}
