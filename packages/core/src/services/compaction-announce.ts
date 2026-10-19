import type { IpcResult } from '@clawwork/shared';
import type { MessageState } from '../stores/message-store.js';

/**
 * 「会话已压缩」这句话的**唯一出口**。
 *
 * ## 为什么要有它
 *
 * 压缩有**两条来源**，而它们**不共用网关事件**（2026-09-19 读随包运行时 2026.9.3 确认）：
 *
 * | 路径 | 谁触发 | 网关发什么 |
 * | --- | --- | --- |
 * | **自动**（上下文满了） | 嵌入的 agent 运行 | agent `stream:"compaction"`（start/end + completed/willRetry） |
 * | **手动**（斜杠命令 / 右键菜单） | `sessions.compact` RPC | **不发** agent 流；发 `sessions.changed {reason:"compact", compacted}` |
 *
 * ⇒ "统一到一个事件"做不到（形状是网关定的）。但**用户看到的那句话可以统一** ——
 * 两条路都走 `announceCompaction`，文案只留一处。
 *
 * ## 三条硬规矩（都是实测/拍板来的）
 *
 * 1. **只认"真的压了"**：手动那条绝不凭 RPC 的 `ok` 就报 —— 只认返回里的 `compacted === true`。
 *    （`ok` 只代表"请求被接受"，网关自己的 `sessions.changed` 守卫也是 `result.ok && compacted`。）
 * 2. **别报两次**：两条路都可能在说同一件事 ⇒ 用**同一轮的轮次号**做幂等
 *    （`announceCompactionOnce`）。⚠️ 两条路必须落到**同一个轮次号**上：
 *    手动那条在**发 RPC 之前**就开一轮（`runManualCompaction`），事件那条读"当前轮次"
 *    （没有就现开）。⚠️ 顺序是硬要求（BUG-097）：事件与回包走同一条 ws 连接，合法的
 *    同批 FIFO 下事件可能**先**被渲染器处理 —— 等到回包才开轮次，事件就已经开过一轮了。
 *    用时间戳当标识是不行的 —— 毫秒内撞车会把**新一轮**误杀（测试抓过这个坑）。
 * 3. **自动那条的 `!willRetry` 不能少**：运行时自己就用它判"真正结束"
 *    （`if (completed && !willRetry) runBestEffortCompactionHook(ctx, "after")`），
 *    少了它"压缩→重试→再压缩"会报两条。
 */

/** 文案 key（**只此一处**；9 个语言里都有）。 */
export const COMPACTION_NOTICE_KEY = 'session.contextCompacted';

/**
 * 手动压缩的**兜底等待**：RPC 说真的压了之后，先等这么久看网关的
 * `sessions.changed` 来不来 —— 来了就用事件那次（更权威），不来才自己报。
 *
 * ⚠️ 取值权衡：太短会在事件正常送达时抢跑（等于又回到"网关还没确认就报"）；
 *    太长则用户点完要干等。3 秒是"通常事件早到了"与"用户等得起"之间的折中。
 */
export const COMPACTION_FALLBACK_MS = 3000;

type CompactionStore = Pick<
  MessageState,
  'announceCompactionOnce' | 'beginCompactionEpisode' | 'ensureCompactionEpisode'
>;

type Translate = (key: string) => string;

export interface CompactionDeps {
  /** ⚠️ 传**取值函数**而不是快照：兜底是在定时器回调里跑的，拿快照会读到过期的状态。 */
  getStore: () => CompactionStore;
  translate: Translate;
}

/**
 * 播报一次「会话已压缩」。**幂等**：本轮（`episode`）已经报过就返回 false。
 *
 * `episode` 是本轮的**轮次号**（见文件头第 2 条规矩）。
 * ⚠️ 用轮次号而不是时间戳：时间戳在毫秒内撞车时会把新一轮误杀（那个坑是测试抓出来的）。
 */
export function announceCompaction(
  deps: CompactionDeps,
  opts: { taskId: string; sessionKey: string; episode: number },
): boolean {
  return deps
    .getStore()
    .announceCompactionOnce(opts.taskId, opts.sessionKey, opts.episode, deps.translate(COMPACTION_NOTICE_KEY));
}

/** 取"当前轮次"；还没开过就开一轮（事件先到、`compaction start` 没收到时用）。 */
export function currentCompactionEpisode(deps: CompactionDeps, sessionKey: string): number {
  return deps.getStore().ensureCompactionEpisode(sessionKey);
}

/**
 * **手动**压缩那条：RPC 回来了。
 *
 * - 只认 `compacted === true`（`ok` 不算，缺字段也不算）；
 * - 身份（轮次号）由 `runManualCompaction` 在**发 RPC 之前**开好并传进来（BUG-097），
 *   这里只**复用它**；只有直接调用、没传身份时才现开一轮。
 *   随后安排兜底：`COMPACTION_FALLBACK_MS` 之后若**这个身份**还没被播报过，就自己报。
 *   （"事件先到 ⇒ 不报"由 `announceCompactionOnce` 的幂等保证，不需要额外的标记。）
 *
 * @returns 是否安排了兜底（便于测试与调用方判断）
 */
/**
 * **手动压缩的共享入口** —— 两条 UI 路径（斜杠命令 / 右键菜单）都走它。
 *
 * 为什么不各自写一遍：两处逻辑一字不差（发 RPC → 看结论 → 交给统一出口），
 * 分开写迟早只改一处。抽出来以后它**可以被单测直接覆盖**，
 * 而"某个 UI 组件忘了改"这种漏也少一半。
 *
 * ⚠️ 返回值是"命令成功与否"（RPC 的 `ok`），**不是**"压没压成" ——
 *    后者的判断只认 `compacted === true`，在下面交给统一出口。
 */
export async function runManualCompaction(
  deps: CompactionDeps & { compactSession: (gatewayId: string, sessionKey: string) => Promise<IpcResult> },
  opts: { gatewayId: string; sessionKey: string; taskId: string },
): Promise<boolean> {
  // ⭐⭐ **身份必须在请求发出之前定下来**（BUG-097，勿回退）。
  //
  // 网关的 `sessions.changed {reason:'compact'}` 与 `sessions.compact` 的回包走**同一条
  // ws 连接**；合法的同批 FIFO 收包下，渲染器**可能先处理事件、后恢复这个 await**
  // （可达性已由真实 ws Receiver + Electron IPC 夹具证明）。
  //
  // 从前的顺序是"先 await 回包，再开轮次"：事件那条 `currentCompactionEpisode` 现开
  // **第 1 轮**并播报，回包回来又开**第 2 轮** ⇒ 兜底那次算在新身份上、**再播一次**
  // （一次压缩，用户看到两条）。
  //
  // 现在：轮次在发 RPC 前就开好 ⇒ 事件那条读到的"当前轮次"**就是它**，回包也复用它，
  // 兜底只在"这个身份还没被播报过"时才发（幂等由 `announceCompactionOnce` 保证）。
  //
  // ⚠️ 轮次只是"这次压缩的编号"，开它**不代表判定"压成了"** —— 一句都不会上屏，
  //    仍然只认回包里的 `compacted === true`。
  const episode = deps.getStore().beginCompactionEpisode(opts.sessionKey);

  const res = await deps.compactSession(opts.gatewayId, opts.sessionKey);
  if (!res.ok) return false;

  noteManualCompactionResult(deps, {
    taskId: opts.taskId,
    sessionKey: opts.sessionKey,
    compacted: (res.result as { compacted?: unknown } | null | undefined)?.compacted,
    episode,
  });
  return true;
}

export function noteManualCompactionResult(
  deps: CompactionDeps,
  opts: {
    taskId: string;
    sessionKey: string;
    compacted: unknown;
    delayMs?: number;
    /**
     * 这次压缩的**身份**（轮次号）。`runManualCompaction` 在**发 RPC 之前**开好并传进来
     * （BUG-097）⇒ 回包与事件落在同一个身份上。不传才现开一轮（直接调用方的兼容路径）。
     */
    episode?: number;
  },
): boolean {
  if (opts.compacted !== true) return false;

  // 手动这条也要有身份：传进来的就复用（与事件那条同一个），没传才现开一轮。
  const episode = opts.episode ?? deps.getStore().beginCompactionEpisode(opts.sessionKey);

  setTimeout(() => {
    // ⚠️ 轮次号在**安排时**就捕获好 —— 3 秒后若已经开了新一轮，不能把话算到新一轮头上。
    announceCompaction(deps, { taskId: opts.taskId, sessionKey: opts.sessionKey, episode });
  }, opts.delayMs ?? COMPACTION_FALLBACK_MS);
  return true;
}
