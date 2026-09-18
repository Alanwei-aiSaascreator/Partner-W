/**
 * 多模型并排对比 —— **纯编排逻辑**（没有 React、没有 IPC、没有 store）。
 *
 * 这里回答四个问题，每一个都能单独测：
 *   ① 一次对比要开哪几条网关会话（会话键怎么造、顺序怎么定）
 *   ② 每一路要发什么（同一句话 + 各自模型）
 *   ③ 每一列现在是什么状态（谁在跑、谁好了、谁挂了）
 *   ④ 采纳时构造什么（采纳的是**哪一列**、能不能采纳）
 *
 * 之所以把这层抽出来：并发、失败隔离、采纳这三件事的**对错全在逻辑里**，
 * 挂到 UI 上之后再测就得靠渲染断言去间接证明，成本高且脆。
 */
import { buildSessionKey, parseTaskIdFromSessionKey } from '@clawwork/shared';

/** 至少两个模型才叫「对比」。 */
export const MIN_COMPARE_MODELS = 2;
/** 上限 4：再多并排就挤成一条线，而且每一路都真花钱。 */
export const MAX_COMPARE_MODELS = 4;

/**
 * 对比列的伪 deviceId 前缀。
 *
 * ## 为什么要走「伪 deviceId」而不是另造一种会话键
 *
 * 网关的会话键形状是 `agent:<agentId>:clawwork:<deviceId>:task:<taskId>`（见 shared/constants）。
 * 对比的每一列**必须是独立会话**（一个会话只跑一个模型，`chat.send` 也只认会话），
 * 但事件又必须能路由回**原任务**（否则流式输出无处可去）。
 *
 * 把 `<deviceId>` 换成一个对比专用的假名，一次满足三件事：
 *   ① `parseTaskIdFromSessionKey` 照常解析出**真** taskId ⇒ dispatcher 路由到原任务；
 *   ② `isClawWorkSession(key, 真deviceId)` 为 false ⇒ 主进程 `sessions.list` 的
 *      任务发现**不会**把这些列当成新任务导进来（导入是实现"设备隔离"的那道过滤器）；
 *   ③ 键是可逆的、可解析的 —— 界面上任何一处拿到会话键都能认出它是对比列。
 */
const COMPARE_DEVICE_PREFIX = 'compare-';

interface CompareColumnPlan {
  /** 稳定序号（0 起），用于展示顺序与默认排序，**不随失败重排**。 */
  index: number;
  /** 这一列用的模型 id（逐列不同，已去重）。 */
  model: string;
  /** 这一列的网关会话键。 */
  sessionKey: string;
}

interface ComparePlan {
  taskId: string;
  /** 一次对比的标识，用于把会话键与「另一轮对比」区分开。 */
  compareId: string;
  /** 按用户选择顺序排列的列。 */
  columns: CompareColumnPlan[];
}

export type ComparePlanError = 'too-few-models' | 'too-many-models' | 'no-task';

type ComparePlanResult = { ok: true; plan: ComparePlan } | { ok: false; error: ComparePlanError };

/**
 * 去空 + **保序去重**（不截断）。
 *
 * 保序：用户勾选的顺序就是他心里的列顺序，重排会让「第 2 列是哪家」每次都变。
 * 去重：同一个模型选两次 = 同一句话问同一个模型两遍，白花一份钱还占一列。
 */
export function dedupeCompareModels(models: readonly (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of models) {
    const model = typeof raw === 'string' ? raw.trim() : '';
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

/** 清洗用户选的模型列表：去空、保序去重、超限截断。 */
export function normalizeCompareModels(models: readonly (string | undefined | null)[]): string[] {
  return dedupeCompareModels(models).slice(0, MAX_COMPARE_MODELS);
}

/**
 * 现在能不能发起一轮对比（UI 据此禁用发送键）。
 *
 * ⚠️ 判据用**去重后、截断前**的数量：用户勾了 5 个模型时该说的是
 *    「最多 4 个」，而不是"悄悄丢掉第 5 个然后照常开跑" —— 那会让他以为跑的是 5 路。
 */
export function validateCompareModels(models: readonly (string | undefined | null)[]): ComparePlanError | null {
  const deduped = dedupeCompareModels(models);
  if (deduped.length < MIN_COMPARE_MODELS) return 'too-few-models';
  if (deduped.length > MAX_COMPARE_MODELS) return 'too-many-models';
  return null;
}

/**
 * 造出这一轮对比的全部列。
 *
 * `compareId` 由调用方生成（一次对比一个），保证**第二轮对比不会复用第一轮的会话** ——
 * 复用的话第二列的上下文里会带着上一轮的问答，看起来像"模型记得"，实际是串台。
 */
export function buildComparePlan(params: {
  taskId: string;
  agentId: string;
  compareId: string;
  models: readonly (string | undefined | null)[];
}): ComparePlanResult {
  const { taskId, agentId, compareId } = params;
  if (!taskId) return { ok: false, error: 'no-task' };

  // ⚠️ 上下界**只判一次**（复用 validateCompareModels），而不是"先截断再看长度"：
  //    后者在勾了 5 个的时候会把第 5 个悄悄砍掉、照常开 4 路 —— 用户以为跑了 5 个模型。
  //    校验通过之后 normalizeCompareModels 只剩"去空去重"的收尾作用（不会再截断）。
  const invalid = validateCompareModels(params.models);
  if (invalid) return { ok: false, error: invalid };
  const models = normalizeCompareModels(params.models);

  return {
    ok: true,
    plan: {
      taskId,
      compareId,
      columns: models.map((model, index) => ({
        index,
        model,
        // 第 n 列的伪设备 id：`compare-<这一轮的 id>-<列号>`。
        sessionKey: buildSessionKey(taskId, agentId, `${COMPARE_DEVICE_PREFIX}${compareId}-${index}`),
      })),
    },
  };
}

/** 这个会话键是不是对比列（任何一轮、任何一列）。 */
export function isCompareSessionKey(sessionKey: string): boolean {
  const m = /^agent:[^:]+:clawwork:([^:]+):task:(.+)$/.exec(sessionKey);
  return m !== null && m[1].startsWith(COMPARE_DEVICE_PREFIX);
}

/** 对比列所属的任务 id（认不出来返回 null）。 */
export function compareSessionTaskId(sessionKey: string): string | null {
  return isCompareSessionKey(sessionKey) ? parseTaskIdFromSessionKey(sessionKey) : null;
}

// ---------------------------------------------------------------------------
// 列的运行时状态（**推导**，不是另存一份）
// ---------------------------------------------------------------------------

/**
 * 一列的状态。
 *
 * `error` 是**终态**：出错的那一列不再接流，界面在那一列上给「重试」。
 * 其余列不受影响 —— 这正是「失败隔离」要的形状：状态存在**列**上，不存在对比这一层。
 */
export type CompareColumnStatus = 'pending' | 'streaming' | 'done' | 'error';

export interface CompareRuntime {
  taskId: string;
  compareId: string;
  prompt: string;
  columns: { index: number; sessionKey: string; model: string }[];
  startedAt: number;
}

/**
 * 「**属于这个任务的**那一轮对比」——不属于（或本轮对比没在跑）时返回 `null`。
 *
 * 为什么界面每条判据都要过这个函数：对比的 `active` 是**全局唯一**的，而任务可以切。
 * 用户在前一个任务里发起对比、然后切到另一个任务时，`active` 仍然非空 ——
 * 界面若拿 `active` 当判据，新任务里会出现：①前一个任务的对比面板占着这一屏
 *（甚至能看到另一个任务的对话内容）；②这一转发的消息一律被拦下（"上一轮对比还在跑"），
 * 用户在自己的任务里一个字都发不出去。判据必须带上任务身份。
 *
 * ⚠️ 返回的是**非空 runtime**（调用方不用再判一次空）：`null` 已经包含"没有在跑的那一轮"。
 */
export function compareRuntimeForTask(
  active: CompareRuntime | null | undefined,
  taskId: string | null | undefined,
): CompareRuntime | null {
  if (!active || !taskId) return null;
  return active.taskId === taskId ? active : null;
}

/** 一列现在长什么样（界面用的视图，由计划 + 实时字段推导出来）。 */
export interface CompareColumnView {
  index: number;
  sessionKey: string;
  model: string;
  status: CompareColumnStatus;
  text: string;
  thinking: string;
  /** 失败原因（已过 error-classify 的可读文案）。 */
  error?: string;
  runPhase?: string | null;
}

/**
 * 推导一列的实时状态所需的**输入**，全部来自 `messageStore` 那四个按会话键索引的字段。
 *
 * ⚠️ 刻意**不再另存一份**流式正文：正文的唯一真源是 `activeTurnBySession`
 *（dispatcher 往里写）。对比若自己再存一份 `column.text`，两边一定会漂移
 *（事件顺序、竞态、清空时机），而漂移的表现是"某一列的字数比真实少一段"这种极难查的 bug。
 */
interface CompareLiveState {
  activeTurnBySession: Record<
    string,
    { finalized: boolean; content: string; streamingText: string; thinkingContent?: string; streamingThinking: string }
  >;
  processingBySession: Set<string>;
  errorBySession: Record<string, string>;
  runPhaseBySession: Record<string, string | null>;
}

/**
 * 一列现在是什么状态。判据优先级是**刻意的**：
 *
 *   1. 有错就是错 —— 即使还残留着一个 activeTurn：界面要立刻变成「重试」，
 *      而不能看起来还在跑（用户会一直等一个已经死掉的列）。
 *   2. `finalized` 就是好了 —— 正文在 `content`（流式那份已被 `finalizeStream` 搬走并清空）。
 *   3. 有 turn 或标了 processing 就是在跑。
 *   4. 都没有 = 还没轮到它回话（刚开跑时 N 列都长这样）。
 */
function deriveColumnView(
  column: { index: number; sessionKey: string; model: string },
  live: CompareLiveState,
): CompareColumnView {
  const error = live.errorBySession[column.sessionKey];
  const turn = live.activeTurnBySession[column.sessionKey];
  const text = turn ? (turn.finalized ? turn.content : turn.streamingText) : '';
  const thinking = turn ? (turn.finalized ? (turn.thinkingContent ?? '') : turn.streamingThinking) : '';

  let status: CompareColumnStatus;
  if (error) status = 'error';
  else if (turn?.finalized) status = 'done';
  else if (turn || live.processingBySession.has(column.sessionKey)) status = 'streaming';
  else status = 'pending';

  return {
    index: column.index,
    sessionKey: column.sessionKey,
    model: column.model,
    status,
    text,
    thinking,
    error: error || undefined,
    runPhase: live.runPhaseBySession[column.sessionKey] ?? null,
  };
}

/** 整轮的列视图，**顺序与用户选的一致**（不因谁先跑完而重排）。 */
export function deriveCompareViews(runtime: CompareRuntime, live: CompareLiveState): CompareColumnView[] {
  return runtime.columns.map((c) => deriveColumnView(c, live));
}

/**
 * 一列现在能不能被采纳：跑完了 + 有正文。
 *
 * 「跑完了但正文为空」（模型只出了推理、或什么都没出）也要挡住 ——
 * 采纳一条空消息，用户会以为采纳动作没生效。
 */
export function isColumnAdoptable(column: CompareColumnView): boolean {
  return column.status === 'done' && column.text.trim().length > 0;
}

/** 还有列在跑吗（决定「取消对比」还要不要显示）。 */
export function hasRunningColumn(views: CompareColumnView[]): boolean {
  return views.some((c) => c.status === 'pending' || c.status === 'streaming');
}

/** 已落定的列数（跑完的 + 挂掉的），用于「3/4 已完成」这类进度。 */
export function settledColumnCount(views: CompareColumnView[]): number {
  return views.filter((c) => c.status === 'done' || c.status === 'error').length;
}

/** 有列挂掉了吗（用于在面板头部给一条汇总提示；**不改变**任何单列的状态）。 */
export function failedColumnCount(views: CompareColumnView[]): number {
  return views.filter((c) => c.status === 'error').length;
}
