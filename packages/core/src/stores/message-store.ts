import { createStore } from 'zustand/vanilla';
import {
  isSlidegenToolProgress,
  mergeGatewayStreamText,
  mergeThinkingSnapshot,
  renderThinkingSegments,
  sealThinkingSegment,
  parseAgentIdFromSessionKey,
  parseTaskIdFromSessionKey,
} from '@clawwork/shared';
import type { Message, MessageRole, MessageAttachment, ToolCall, IpcResult, ThinkingSegments } from '@clawwork/shared';
import { splitInlineThinking } from '../protocol/normalize-history.js';
import {
  createExecutionProjection,
  reduceExecutionProjection,
  type ExecutionProjection,
} from './execution-projection.js';
import type { ExecutionEvent } from '../protocol/execution-events.js';

const EMPTY_MESSAGES: Message[] = [];

export interface ActiveTurn {
  id: string;
  streamingText: string;
  /**
   * 思考的**显示文本**（= `renderThinkingSegments(已完成段 + 当前段最新快照)`）。
   * 分段状态本体在下面两个字段；这个字段只是渲染结果。
   */
  streamingThinking: string;
  /**
   * 思考分段的**显式状态**（2026-10-13 第二次独立复审整改）：已完成段 + 当前段最新快照
   * + 刚归档段（回声守卫基线）。
   *
   * 为什么要有它：跨工具边界后的"当前段"没有任何可靠的字符串特征（最长后缀/全历史
   * includes 都会猜错——见 `mergeThinkingSnapshot` 的注释与复审反例）。工具调用落地
   * （新 id 的 `upsertToolCall`）= 前一段结束 ⇒ `sealThinkingSegment` 归档。
   *
   * 可选：老字面量 / 迁移中的内存对象没有它们 —— 读取时按"显示文本 = 当前段"兜底。
   */
  thinkingCompleted?: string;
  thinkingCurrent?: string;
  thinkingLastSealed?: string;
  toolCalls: ToolCall[];
  finalized: boolean;
  content: string;
  thinkingContent?: string;
  runId?: string;
  timestamp: string;
  /**
   * 本轮**最新活动**（仅展示 · 2026-10-08 对话可视化改造）。
   *
   * 为什么必须在事件入口留痕：思考折叠块的展开/扫光判据是"最新活动是不是思考"
   *（真实 WorkBuddy 的 `expand = isLastContent`）。而同一批 React 提交里，
   * `thinking→tool` 与 `tool→thinking` 可以产生完全相同的最终文本与工具数组 ——
   * **顺序信息只在写入那一刻存在**，props 侧再也推不出来。
   *
   * ⚠️ 契约：这是**瞬态展示元数据**。不落库、不进重试证据、不影响内容合并/计费；
   *    `finalizeStream` 后的定稿视图不依赖它（历史一律按"已结束"渲染）。
   */
  activity?: ActiveTurnActivity;
}

/**
 * 最新活动的瞬态元数据（见 `ActiveTurn.activity`）。
 *
 * - `kind`：`thinking`=推理输出中 / `output`=正文输出中 / `tools`=工具事件；
 * - `revision`：每次活动更新 +1（响应式消费者/测试的观测点）；
 * - `thinkingSegment`：**思考段号**——每次"非 thinking → thinking"才 +1。
 *   界面用它复位"用户手动折叠"的选择：同一段里的新 delta 不强行展开，
 *   新一段（如工具之后再次思考）重新自动展开。
 */
export interface ActiveTurnActivity {
  kind: 'thinking' | 'output' | 'tools';
  revision: number;
  thinkingSegment: number;
}

/**
 * R1（2026-10-08 总审）＋ F1（终审）：活动元数据的两半职责
 *
 * - **写入器**（本文件四个内容方法）只负责"**累计快照的重复投递不重写 state**"：
 *   内容没变 ⇒ 返回原 state（引用不变 —— 事件入口正是靠这个引用比较判定"这一项真的变了"）。
 *   它们**不再**自己记活动。R1 的教训：chat delta 的 `message.content` 是全文快照，
 *   dispatcher 固定按「正文→思考→工具」处理，旧 thinking 会被原样重发无数次，
 *   写入端无条件记活动就会把相位拨回 thinking、每帧伪造"新思考段"。
 * - **帧封**（`sealTurnActivity`）：一帧结束时由事件入口按 **content blocks 的真实顺序**
 *   一次定音。F1 的教训：同帧**多项都真变化**时，"处理顺序"不是真实顺序
 *   （`[thinking, text]` 两段都新时，最新活动是正文而不是思考）。
 */
function toolCallChanged(before: ToolCall | undefined, after: ToolCall): boolean {
  if (!before) return true;
  return (
    before.status !== after.status ||
    before.name !== after.name ||
    before.startedAt !== after.startedAt ||
    before.completedAt !== after.completedAt ||
    before.title !== after.title ||
    (before.result ?? '') !== (after.result ?? '') ||
    JSON.stringify(before.args ?? null) !== JSON.stringify(after.args ?? null) ||
    JSON.stringify(before.slideProgress ?? null) !== JSON.stringify(after.slideProgress ?? null)
  );
}

/**
 * 这一轮**出过东西没有** —— 「整轮失败自动重发」判据的唯一真源（BUG-050）。
 *
 * ⚠️ 思考（`streamingThinking`）**不算**：那是模型的推理过程，用户拿不到成品，
 *    也不落任何文件——空转的判据是"有没有交付物"，不是"模型有没有动过脑子"。
 * ⚠️ 工具调用**算**：它可能有不可逆的副作用（写盘、发请求），界面上也已经有痕迹。
 *
 * 放在这里（而不是渲染层的 hook 里）是因为它有**两个消费者**：
 *   ① dispatcher 在 `clearActiveTurn` **之前**用它快照证据（清掉就再也读不到了）；
 *   ② 渲染层评估时用它兜底读"还活着的" activeTurn（迟到帧会把 turn 重新建出来）。
 * 两边必须同一套语义 —— 各写一份迟早分叉。
 */
export function activeTurnProducedOutput(turn: ActiveTurn | undefined): boolean {
  if (!turn) return false;
  if (turn.finalized) return true;
  if (turn.streamingText.trim() !== '' || turn.content.trim() !== '') return true;
  if (turn.toolCalls.length > 0) return true;
  return false;
}

/**
 * 「整轮失败自动重发 1 次」的候选类别（包 D）。
 *
 * `transient` = 登记时带结构化判据说"太频繁/超时"；`unclassified` = 认不出来
 * （lifecycle 失败帧只有一句英文原文）。**确定性失败不在这张表里** —— 它们根本不登记。
 *
 * ⚠️ `kind` 只是**登记时**能拿到的类别；**认不出来的一律不自动重发**（BUG-050 收紧：
 *    malformed tool call / unknown 都落进 `unclassified`），只有 `transient` 才可能发。
 */
export interface AutoRetryFailure {
  taskId: string;
  /** 时间线里那句失败消息（重发目标由它往前找，见 `findRetryTarget`）。 */
  messageId: string;
  kind: 'transient' | 'unclassified';
  /**
   * **登记那一刻**「本轮已产出」的证据快照（BUG-050）。
   *
   * 为什么必须是快照而不是评估时现读：dispatcher 的错误分支**先**
   * `clearActiveTurn(sessionKey)`、**再**登记候选 —— 1.5s 后渲染层评估时那个
   * activeTurn 早就没了，现读恒为 `undefined` ⇒ "什么都没做" ⇒ 守卫形同虚设、
   * 一个已经跑过 write/exec 的轮次被整轮重发（副作用重复，不可逆）。
   * 证据只在清理**之前**拿得到，所以谁清理谁负责把它带出来。
   */
  producedOutput: boolean;
}

export interface MessageState {
  messagesByTask: Record<string, Message[]>;
  activeTurnBySession: Record<string, ActiveTurn>;
  processingBySession: Set<string>;
  /**
   * V2（2026-10-13 step 2）：**执行投影**（按会话）—— 纯归约结果挂在现有 store
   * 生命周期上（不创建并行执行 store）。
   *
   * - 写入：`applyExecutionEvents`（每帧事件折进 `reduceExecutionProjection`）；
   * - 清理：与 `activeTurnBySession` 同生命周期（`clearActiveTurn` / `clearMessages`
   *   同点摘键 —— 换账号/工作区即清该 scope 的投影与候选缓存）；
   * - 消费：V2 尚无渲染订阅（无新增订阅 ⇒ App 根思考风暴提交数不受影响）；V3/V4 的
   *   状态条与执行历史从这里投影。
   */
  executionBySession: Record<string, ExecutionProjection>;
  /**
   * 网关正在做什么（`run_status` 事件的 phase）。
   *
   * 为什么要它：2026-09-11 实测，一条 2 字的消息发出去后有 **9 秒界面毫无反应** ——
   * 网关这 9 秒一直在报 `preparing_workspace`，是我们的 `switch(stream)` 没有这个分支、
   * 把它们当未知事件静默丢了。用户由此判定「响应太慢」。
   */
  runPhaseBySession: Record<string, string | null>;
  /**
   * 这一轮**重试到第几次了**（`run_status` 的 `phase:"retrying"` 才带）。
   *
   * 为什么单独存：`runPhaseBySession` 只放相位名，而"第 2/4 次"这句话需要两个数字。
   * ⚠️ 与相位**同一次 set 写**，且**相位不是 `retrying` 时一定清掉** ——
   *    否则数字会粘在后面的相位上（"正在准备（第 2/4 次）"这种）。
   *
   * ⚠️ 不落库：本轮界面状态，与 `runPhaseBySession` 同性质。
   */
  runRetryBySession: Record<string, { attempt: number; maxAttempts: number }>;

  /**
   * 模型**自述**的进度（网关 `item` 流的 `kind:"preamble"`）。
   *
   * 为什么要它：正文本就不流式（整轮结束才蹦出来，见 `waiting-copy.ts` 的结论），
   * 所以那一大段"卡住"的时间里，**这是唯一在动的东西**。
   * 网关一直在报，我们此前整块丢掉 —— `AgentItemData` 里声明了 `progressText` 却没人读。
   *
   * ⚠️ 是模型的**原话**，不是我们写的文案 —— 界面上要让它跟自家文案能区分开。
   * ⚠️ 不落库：本轮界面状态，与 `runPhaseBySession` 同性质。
   */
  progressTextBySession: Record<string, string | null>;
  /**
   * 「会话已压缩」这句话的**播报记账** —— 只为一件事：**同一个会话别报两次**。
   *
   * 为什么需要：压缩有**两条**来源，都可能说这句话 ——
   * ① 网关的 `sessions.changed {reason:"compact", compacted:true}`（手动压缩走它）；
   * ② 手动压缩那条 RPC 的返回值兜底（万一 ① 没送到）。
   * 两边都只认"真的压了"，但**都要防重复**：事件先到就别再兜底，兜底报过就别再被事件重复。
   *
   * ⚠️ 不落库：本轮界面状态，与 `runPhaseBySession` 同性质。
   *
   * ⚠️ **用"轮次号"而不是时间戳**：时间戳在毫秒内撞车（两轮压缩落在同一毫秒）时，
   *    "同一轮只报一次"的判断会把**新一轮**误杀。轮次号单调递增，没有这个歧义。
   *    （这个坑是测试抓出来的：连做两轮压缩，第二轮被去重挡掉了。）
   */
  compactionAnnouncedEpisodeBySession: Record<string, number>;
  /**
   * **本轮压缩是从什么时候开始的**（ms）。两条路各自在"开始那一刻"记一次：
   * 自动压缩记在网关的 `compaction start` 上；手动压缩记在发出 RPC 那一刻。
   *
   * ⚠️ 为什么必须有它：播报去重是"**同一轮的 `since` 之后只报一次**"，
   *    两条路必须拿到**同一个** `since`，否则会漏判一种顺序 ——
   *    兜底先报(T3)、事件迟到(T4)：若事件用"到达时刻"当 since，T3<T4 就挡不住了 ⇒ 报两次。
   */
  compactionEpisodeBySession: Record<string, number>;
  /**
   * 这个会话**正在压缩上下文**（活动条据此显示"正在压缩上下文…"）。
   *
   * ⚠️ 刻意**不复用** `progressTextBySession`：那一槽的约定是"**模型的原话**，
   *    不是我们写的文案"，而这句是**我们的**文案 —— 塞进去会破坏那条约定
   *    （界面就分不清"模型在说"还是"系统在说"了）。
   * ⚠️ 压缩会让界面**停住一会儿**，这段时间必须看得见东西（用户抱怨的"卡住"）。
   */
  compactingBySession: Record<string, boolean>;
  /**
   * 本轮**从什么时候开始等**（`Date.now()` 毫秒），要么没有这条键。
   *
   * 为什么要它：输入框上方要显示一个**一直在走的秒数** —— 用户骂"卡住"多半是
   * **看不出是否还在动**，一个持续在变的数字比任何 spinner 都能证明"它没死"。
   *
   * ⚠️ 起算点**只在"从空闲变忙"那一刻**打一次：一轮里 `setProcessing(true)`
   * 会被重复调到（重连、迟到的 lifecycle.start），每次都拨表的话，
   * 等了两分钟的用户会看着计时器跳回 3 秒 —— 比不显示还糟。
   * 不落库（与本文件其它 `*BySession` 同性质：本轮界面状态，不是对话数据）。
   */
  turnStartedAtBySession: Record<string, number>;
  /**
   * 「临时会话」（多模型对比的每一列）本轮的失败文案，按 sessionKey 存。
   *
   * 为什么不复用时间线的 system 消息：对比的每一列**还没被采纳**，它不是这个任务的
   * 对话内容 —— 写进时间线等于让用户看到一条他没采纳的回答/报错。而失败**必须让用户看见**
   *（要求「单列失败只在该列显示可读错误 + 重试」），所以给它开一条**旁路**：
   * 错误留在该列自己身上，采纳/退出对比时随 session 一起丢掉。
   *
   * ⚠️ 不落库：这是**本轮界面状态**，不是对话数据（与 `runPhaseBySession` 同性质）。
   */
  errorBySession: Record<string, string>;
  /**
   * 这个会话上**可以重试**的那条错误（`messageId` 指向时间线里那句错误）。
   *
   * 为什么要它：`AppError.retryable` 长期是个**死字段** —— 算了没人读，而且在
   * chat 这条路上还恒为 `'unknown'`（判断只认 `code`，而 chat 错误帧里没有 `code`）。
   * 接上它需要一处"界面能查到"的落点，就是这里。**只有 `retryable === 'yes'` 才登记。**
   *
   * 为什么**不**落库（不加 `messages` 的列）：这是**本轮界面状态**，与
   * `runPhaseBySession` / `errorBySession` 同性质；而且重启后对着一条旧错误重发同一句话，
   * 模型/上下文可能早变了 —— 那不是我们想促成的行为。
   *
   * ⚠️ 两条纪律（都有用例钉着）：
   *   ① **空闲→忙**（真的又跑起来一轮）就作废 —— 否则旧按钮点一下 = 再花一次钱；
   *   ② `setProcessing(false)` **不许**清 —— dispatcher 的错误分支正是"先关忙、再登记"，
   *      在那里清会把刚登记的按钮立刻抹掉，用户永远看不到。
   */
  retryableErrorBySession: Record<string, { taskId: string; messageId: string }>;
  /**
   * 「整轮失败自动重发 1 次」的**候选登记**（包 D，2026-10-07）。
   *
   * 与 `retryableErrorBySession` **故意分成两份**：那份决定"给不给用户一个按钮"
   * （只认结构化判据说 `yes` 的）；这份决定"界面要不要自己重发一次"。lifecycle
   * 失败帧里没有结构化类别（判据恒为 `unknown`），合成一份会让这类失败凭空长出
   * 「重试」按钮 —— B10 明确拒绝过。两份的生命周期纪律相同（见上一条）。
   *
   * `kind` 是登记时能拿到的**唯一**类别信息：
   *   - `transient`（rate_limit / timeout）—— 重发真可能改变结果，**唯一**允许自动重发的类别；
   *   - `unclassified` —— 认不出来（含 malformed tool call）：**一律不自动重发**
   *     （BUG-050 收紧：认不出来就不替用户再花一次钱、更不拿不可逆副作用去赌）。
   *     登记照旧保留 —— 它是排查现场，且渲染层仍要给评估日志一个诚实的类别。
   * 确定性失败（refusal / context_length）**根本不登记**。
   *
   * ⚠️ 候选同时携带 `producedOutput`（本轮已产出的**证据快照**）：dispatcher 在
   *    `clearActiveTurn` 之前取，渲染层据此挡住"跑过工具却整轮重发"（BUG-050）。
   *
   * ⚠️ 不落库：本轮界面状态，与 `retryableErrorBySession` 同性质。
   */
  autoRetryFailureBySession: Record<string, AutoRetryFailure>;
  highlightedMessageId: string | null;

  addMessage: (
    taskId: string,
    role: MessageRole,
    content: string,
    attachments?: MessageAttachment[],
    options?: { persist?: boolean; sessionKey?: string; timestamp?: string },
  ) => Message;
  removeMessage: (taskId: string, messageId: string) => void;
  upsertToolCall: (sessionKey: string, taskId: string, tc: ToolCall) => void;
  /**
   * **帧封**（F1）：把"这一帧真正变化的活动类别"按**真实顺序**交给 store，一次算定
   * `kind` / `revision` / 思考段号。顺序信息只在事件帧里存在（content blocks 的位置），
   * 写入器按处理顺序各记各的会记错 —— 见 `bumpActivity` 旧址上方注释。
   */
  sealTurnActivity: (sessionKey: string, kindsInOrder: readonly ActiveTurnActivity['kind'][]) => void;
  /**
   * V2：把一帧映射出来的执行事件折进该会话的执行投影。
   * 归约是纯函数（`reduceExecutionProjection`），本动作只负责挂在 store 生命周期上。
   */
  applyExecutionEvents: (sessionKey: string, events: readonly ExecutionEvent[]) => void;
  bulkLoad: (taskId: string, msgs: Message[]) => void;
  appendStreamDelta: (sessionKey: string, delta: string) => void;
  bindActiveRun: (sessionKey: string, runId: string) => void;
  /**
   * 把这一轮的流式正文**整个换掉**（不是追加）。
   *
   * ⚠️ 为什么增量之外还需要它：`chat` 的 delta 帧里 `message.content[0].text`
   *    是**到此刻为止的全文**（白皮书 §4.2 原文），v4 的 `deltaText` 在 `replace` 时
   *    也是全文。把这些当增量追加，正文会**重复膨胀**（实测 5–57 倍）。
   *    见 `extractDeltaText` 的说明。
   */
  replaceStreamText: (sessionKey: string, text: string) => void;
  appendThinkingDelta: (sessionKey: string, delta: string) => void;
  finalizeStream: (sessionKey: string, meta?: { runId?: string }) => void;
  promoteActiveTurn: (sessionKey: string, taskId: string, canonical: Message) => void;
  /**
   * 把一个**已经跑完**的临时会话（对比的某一列）的回复收编成任务里的正式 assistant 消息。
   *
   * 与 `promoteActiveTurn` 的区别：那个是「网关历史已经替我们写好了正文，拿它当权威」，
   * 这个的正文**只有本地这一份**（对比列不在这条会话上，网关历史里没有它对应到这个 task 的行），
   * 所以直接用 activeTurn 的内容落库。
   *
   * `options.timestamp` 是**网关侧的**那条回复的生成时刻（调用方从 `chat.history` 探到，
   * 已经过 `toISOTimestamp`）。为什么必须用它而不是本地 `now()`：
   *   ① 对账去重键是 `${sessionKey}|${timestamp}` —— 采纳进时间线的那条要是用本地时间，
   *      事后 `doSyncSession` 就认不出"网关历史里这条已经在时间线上了"，同一段答案会被
   *      再 promote 一遍（用户看到重复回答）；
   *   ② 时间线是按 timestamp 升序读回的（`data:list-messages` 的 `orderBy`）——
   *      问题与答案必须用同一基准，否则重启后答案会排在问题前面。
   * 传不进来（探不到）时才退回 activeTurn 自己的本地时间戳。
   *
   * 返回被收编的消息；**没得采纳时返回 null**（没开过跑、还没 finalize、正文为空）。
   * 调用方据此决定要不要改任务会话指针 —— 收编失败却把指针指过去，下一条消息就发进一个
   * 没有上下文的会话里了。
   */
  adoptActiveTurn: (
    sessionKey: string,
    taskId: string,
    options?: { model?: string; timestamp?: string },
  ) => Message | null;
  clearActiveTurn: (sessionKey: string) => void;
  clearMessages: (taskId: string) => void;
  setHighlightedMessage: (id: string | null) => void;
  setProcessing: (sessionKey: string, processing: boolean) => void;
  /**
   * 传 `null` 表示这一轮结束，清掉进行中提示。
   *
   * `retry` 只有**重试相位**才带（"第 2/4 次"）—— 它和相位**同一次 set 写进去**，
   * 且**相位不是重试时一定清掉**：否则上一轮的数字会粘到后面的相位上。
   */
  setRunPhase: (sessionKey: string, phase: string | null, retry?: { attempt: number; maxAttempts: number }) => void;
  /** 传 `null` 清掉；空串由调用方挡在外面（别把上一句盖成空的）。 */
  setSessionProgressText: (sessionKey: string, text: string | null) => void;
  /** 传 `null` 清掉该会话的失败文案（重试时用）。 */
  setSessionError: (sessionKey: string, message: string | null) => void;
  /**
   * 播报一次「会话已压缩」。
   *
   * **幂等**：同一个会话在 `since`（这次压缩的开始时刻）之后**已经报过**就什么都不做、
   * 返回 false —— 这是"两条来源各报一次 ⇒ 只出现一条"的那道闸。
   * `text` 由调用方翻译好（store 不该依赖翻译器）。
   */
  announceCompactionOnce: (taskId: string, sessionKey: string, episode: number, text: string) => boolean;
  /** 开一轮压缩，返回本轮轮次号（自动那条记在网关的 `compaction start` 上）。 */
  beginCompactionEpisode: (sessionKey: string) => number;
  /** 取当前轮次号；还没有过就开一轮（事件先到、start 没收到时用）。 */
  ensureCompactionEpisode: (sessionKey: string) => number;
  /** 压缩进行中标记（活动条显示"正在压缩上下文…"用）。 */
  setSessionCompacting: (sessionKey: string, compacting: boolean) => void;
  /**
   * 登记"这条错误可以重试"，界面据此给「重试」按钮。
   *
   * ⚠️ **只能**在 `retryable === 'yes'` 时调 —— "不可重试"（模型拒答 / 上下文超长）
   *    给按钮等于劝用户白花一次钱；`'unknown'` 同理（不知道就别装作知道）。
   */
  markRetryableError: (sessionKey: string, target: { taskId: string; messageId: string }) => void;
  /**
   * 登记"这条整轮失败是自动重发一次的候选"，界面据此决定要不要自动重发。
   *
   * ⚠️ 与 `markRetryableError` 分开（原因见 `autoRetryFailureBySession` 的说明）：
   *    确定性失败（refusal / context_length）**两边都不登记**；瞬时 / 未分类的登记
   *    在这里，重发前还要过渲染层的「零最终交付」严格判据。
   */
  markAutoRetryFailure: (sessionKey: string, target: AutoRetryFailure) => void;
}

export interface MessageStoreDeps {
  persistMessage: (msg: {
    id: string;
    taskId: string;
    role: string;
    content: string;
    timestamp: string;
    sessionKey?: string;
    agentId?: string;
    runId?: string;
    attachments?: unknown[];
    toolCalls?: unknown[];
    thinkingContent?: string;
    /** 实际生成这条回复的模型 id（逐条来自网关）。 */
    model?: string;
    /**
     * ⚠️ DOCX-205 合同（2026-10-10）：同步链路标记。经消息 store 的 upsert 落库的
     * 消息一律带 `sync: true`（**绝不带终态证据** —— 这里只有正文/工具快照，没有
     * 整轮终态信息）；主进程交付入口对带标记的消息只认终态证据，中间快照不消费
     * ArtifactRun。
     */
    sync?: true;
  }) => Promise<IpcResult>;
}

function generateId(): string {
  return crypto.randomUUID();
}

function newActiveTurn(): ActiveTurn {
  return {
    id: generateId(),
    streamingText: '',
    streamingThinking: '',
    thinkingCompleted: '',
    thinkingCurrent: '',
    thinkingLastSealed: '',
    toolCalls: [],
    finalized: false,
    content: '',
    timestamp: new Date().toISOString(),
  };
}

/**
 * 读一个 turn 的思考分段状态。缺字段（老字面量/迁移对象）时把**显示文本当当前段** ——
 * 等价于"还没有归档过任何段"，不丢已有内容。
 */
function thinkingSegmentsOf(
  turn: Pick<ActiveTurn, 'streamingThinking' | 'thinkingCompleted' | 'thinkingCurrent' | 'thinkingLastSealed'>,
): ThinkingSegments {
  if (turn.thinkingCompleted === undefined && turn.thinkingCurrent === undefined) {
    return { completed: '', current: turn.streamingThinking, lastSealed: '' };
  }
  return {
    completed: turn.thinkingCompleted ?? '',
    current: turn.thinkingCurrent ?? '',
    lastSealed: turn.thinkingLastSealed ?? '',
  };
}

function toolStatusRank(status: ToolCall['status']): number {
  switch (status) {
    case 'error':
      return 6;
    case 'done':
      return 4;
    // ⚠️ `awaitingApproval` 与 `running` **同级**——它俩都是"没结束"，谁也不比谁更"新"。
    //    同级时 `preferIncoming` 取 `>=` ⇒ 后到的说了算，这正是我们要的帧序：
    //    tool 流的 result 先落 `dispatched`/held，approval 帧把它改判成 `awaitingApproval`；
    //    审批有了结论之后，`done`/`error`（4/6）照样压得过去。
    //    ⇒ 既不会"降级"，也不会卡住收不了场。
    case 'running':
    case 'awaitingApproval':
      return 2;
    // ⭐ V2（2026-10-13 step 2）：`dispatched`（tool/start、item/running —— 调用进入处理）
    //    压得过 declared（模型声明），压不过 running/awaitingApproval/done/error。
    case 'dispatched':
      return 1;
    // ⭐ V1（2026-10-13）：`declared`（模型声明、无执行证据）权重**最低** ——
    //    任何有执行证据的状态都能覆盖它；`done`/`error` 之后迟到的旧声明或
    //    start 帧**不许回退**（`preferIncoming` 判 false）。
    case 'declared':
      return 0;
  }
}

function mergeToolCallState(existing: ToolCall | undefined, incoming: ToolCall): ToolCall {
  if (!existing)
    return {
      ...incoming,
      slideProgress: isSlidegenToolProgress(incoming.slideProgress) ? { ...incoming.slideProgress } : undefined,
    };
  const previousProgress = isSlidegenToolProgress(existing.slideProgress) ? existing.slideProgress : undefined;
  const nextProgress = isSlidegenToolProgress(incoming.slideProgress) ? incoming.slideProgress : undefined;
  const latePage =
    (existing.status === 'done' || existing.status === 'error') &&
    (incoming.status === 'running' || incoming.status === 'dispatched' || incoming.status === 'declared');
  const slideProgress =
    nextProgress &&
    !latePage &&
    (!previousProgress ||
      (nextProgress.sourceSha256 === previousProgress.sourceSha256 &&
        nextProgress.total === previousProgress.total &&
        nextProgress.completed >= previousProgress.completed))
      ? { ...nextProgress }
      : previousProgress;

  const preferIncoming = toolStatusRank(incoming.status) >= toolStatusRank(existing.status);
  const knownStarts = [existing.startedAt, incoming.startedAt].filter((value) => Number.isFinite(Date.parse(value)));
  return {
    ...existing,
    ...incoming,
    status: preferIncoming ? incoming.status : existing.status,
    slideProgress,
    args: incoming.args ?? existing.args,
    result: incoming.result ?? existing.result,
    // `title` 来自 `item` 流、`args` 来自 `tool` 流 —— 两条流各带一半，
    // 谁先到都不许把对方那半冲掉（`...incoming` 会把显式 undefined 一起铺过来）。
    title: incoming.title ?? existing.title,
    startedAt: knownStarts.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? '',
    completedAt: incoming.completedAt ?? existing.completedAt,
  };
}

function mergeToolCalls(canonical: ToolCall[], turn: ToolCall[]): ToolCall[] {
  const merged = new Map<string, ToolCall>();
  for (const toolCall of canonical) {
    merged.set(toolCall.id, toolCall);
  }
  for (const toolCall of turn) {
    merged.set(toolCall.id, {
      ...mergeToolCallState(merged.get(toolCall.id), toolCall),
      startedAt: Number.isFinite(Date.parse(toolCall.startedAt)) ? toolCall.startedAt : '',
    });
  }
  return Array.from(merged.values());
}

export function mergeCanonicalMessageWithActiveTurn(canonical: Message, turn?: ActiveTurn): Message {
  if (turn?.runId && canonical.runId !== turn.runId) return canonical;
  return {
    ...canonical,
    thinkingContent: turn?.thinkingContent ?? canonical.thinkingContent,
    toolCalls: mergeToolCalls(canonical.toolCalls, turn?.toolCalls ?? []),
    runId: turn?.runId ?? canonical.runId,
  };
}

export function activeTurnToMessage(turn: ActiveTurn, taskId: string, sessionKey?: string): Message {
  return {
    id: turn.id,
    taskId,
    role: 'assistant',
    content: turn.content,
    thinkingContent: turn.thinkingContent,
    artifacts: [],
    toolCalls: turn.toolCalls,
    sessionKey,
    agentId: sessionKey ? parseAgentIdFromSessionKey(sessionKey) : undefined,
    runId: turn.runId,
    timestamp: turn.timestamp,
  };
}

function persistMessageUpdate(deps: MessageStoreDeps, msg: Message): void {
  deps
    .persistMessage({
      id: msg.id,
      taskId: msg.taskId,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      sessionKey: msg.sessionKey,
      agentId: msg.agentId,
      runId: msg.runId,
      attachments: msg.attachments as unknown[] | undefined,
      toolCalls: msg.toolCalls,
      thinkingContent: msg.thinkingContent,
      // 中途 upsert（工具调用/推理）拿不到它 ⇒ undefined ⇒ 主进程那边条件覆盖，不会抹掉已有值。
      model: msg.model,
      // ⚠️ DOCX-205 合同：同步链路标记（本路径只有正文/工具快照，永远不带终态证据）。
      sync: true,
    })
    .catch((err) => {
      console.error('[persist:message]', err);
    });
}

export { EMPTY_MESSAGES };

export function createMessageStore(deps: MessageStoreDeps) {
  return createStore<MessageState>((set, get) => ({
    messagesByTask: {},
    activeTurnBySession: {},
    processingBySession: new Set(),
    executionBySession: {},
    runPhaseBySession: {},
    runRetryBySession: {},
    compactionAnnouncedEpisodeBySession: {},
    compactionEpisodeBySession: {},
    compactingBySession: {},
    progressTextBySession: {},
    turnStartedAtBySession: {},
    errorBySession: {},
    retryableErrorBySession: {},
    autoRetryFailureBySession: {},
    highlightedMessageId: null,

    addMessage: (taskId, role, content, attachments?, options?) => {
      const sessionKey = options?.sessionKey;
      const msg: Message = {
        id: generateId(),
        taskId,
        role,
        content,
        artifacts: [],
        toolCalls: [],
        attachments: attachments?.length ? attachments : undefined,
        // 允许调用方钉一个时间（对比采纳时，问题要用与答案同一基准的时间，
        // 见 `adoptActiveTurn` 的说明）；不传就是此刻。
        timestamp: options?.timestamp ?? new Date().toISOString(),
        sessionKey,
        agentId: sessionKey ? parseAgentIdFromSessionKey(sessionKey) : undefined,
      };
      set((s) => ({
        messagesByTask: {
          ...s.messagesByTask,
          [taskId]: [...(s.messagesByTask[taskId] ?? []), msg],
        },
      }));
      if (options?.persist !== false) {
        persistMessageUpdate(deps, msg);
      }
      return msg;
    },

    removeMessage: (taskId, messageId) =>
      set((s) => ({
        messagesByTask: {
          ...s.messagesByTask,
          [taskId]: (s.messagesByTask[taskId] ?? []).filter((message) => message.id !== messageId),
        },
      })),

    upsertToolCall: (sessionKey, _taskId, tc) => {
      set((s) => {
        const turn = s.activeTurnBySession[sessionKey];
        if (turn) {
          const idx = turn.toolCalls.findIndex((t) => t.id === tc.id);
          const next = [...turn.toolCalls];
          let changed = true;
          if (idx >= 0) {
            const merged = mergeToolCallState(next[idx], tc);
            changed = toolCallChanged(next[idx], merged);
            next[idx] = merged;
          } else {
            next.push(tc);
          }
          // R1：重复/未变化的工具快照 ⇒ 连 state 都不动（不是"最新活动"；引用比较即变更判定）。
          if (!changed) return s;
          // ⭐ 段边界（2026-10-13 复审整改）：**新的**工具调用落地 = 之前那段推理结束 ——
          //    真实语义：每段工具调用之后模型重新开始推理，网关从空快照重新累积。
          //    把当前段归档进已完成段（显示文本不变；新段首个快照到达时才出现空行分隔）。
          //    同 id 的状态更新（running→done 等）不算边界。
          if (idx < 0) {
            const prev = thinkingSegmentsOf(turn);
            const sealed = sealThinkingSegment(prev);
            return {
              activeTurnBySession: {
                ...s.activeTurnBySession,
                [sessionKey]: {
                  ...turn,
                  toolCalls: next,
                  thinkingCompleted: sealed.completed,
                  thinkingCurrent: sealed.current,
                  thinkingLastSealed: sealed.lastSealed,
                  streamingThinking: renderThinkingSegments(sealed),
                },
              },
            };
          }
          return {
            activeTurnBySession: {
              ...s.activeTurnBySession,
              [sessionKey]: { ...turn, toolCalls: next },
            },
          };
        }

        const fresh = newActiveTurn();
        return {
          activeTurnBySession: {
            ...s.activeTurnBySession,
            [sessionKey]: { ...fresh, toolCalls: [tc] },
          },
        };
      });
    },

    sealTurnActivity: (sessionKey, kindsInOrder) =>
      set((s) => {
        const turn = s.activeTurnBySession[sessionKey];
        if (!turn || kindsInOrder.length === 0) return s;
        const prev = turn.activity;
        let kind: ActiveTurnActivity['kind'] | null = prev ? prev.kind : null;
        let revision = prev?.revision ?? 0;
        let thinkingSegment = prev?.thinkingSegment ?? 0;
        // 按**真实顺序**走一遍：thinking 只在"进入时上一个活动不是 thinking"才开新段；
        // 每有一项真变化 revision +1（与旧口径"每次内容变化计一"一致）。
        for (const entry of kindsInOrder) {
          if (entry === 'thinking' && kind !== 'thinking') thinkingSegment += 1;
          kind = entry;
          revision += 1;
        }
        const activity: ActiveTurnActivity = { kind: kind as ActiveTurnActivity['kind'], revision, thinkingSegment };
        if (
          prev &&
          prev.kind === activity.kind &&
          prev.revision === revision &&
          prev.thinkingSegment === thinkingSegment
        ) {
          return s;
        }
        return {
          activeTurnBySession: { ...s.activeTurnBySession, [sessionKey]: { ...turn, activity } },
        };
      }),

    // V2：纯归约（`reduceExecutionProjection`）的 store 挂载点。事件被归约层拒收
    // （旧 run 晚包 / 无归属）时投影引用不变 ⇒ 不触发任何 set。
    applyExecutionEvents: (sessionKey, events) =>
      set((s) => {
        if (events.length === 0) return s;
        let projection = s.executionBySession[sessionKey] ?? createExecutionProjection('');
        let changed = false;
        for (const event of events) {
          const next = reduceExecutionProjection(projection, event);
          if (next !== projection) {
            projection = next;
            changed = true;
          }
        }
        if (!changed) return s;
        return { executionBySession: { ...s.executionBySession, [sessionKey]: projection } };
      }),

    // ⚠️ 装载**本地已存**的消息时也要切一次行内推理。
    //    否则「修好之前就落库的那些」永远是脏的 —— 它们早就在磁盘上定形了，
    //    之后无论怎么改代码都不会被重新归一化（实测：修完当场看仍是脏的）。
    bulkLoad: (taskId, msgs) =>
      set((s) => ({
        messagesByTask: {
          ...s.messagesByTask,
          [taskId]: msgs.map((m) => {
            if (m.role !== 'assistant' || !m.content) return m;
            const { text, thinkingText } = splitInlineThinking(m.content, m.thinkingContent ?? '');
            if (text === m.content && !thinkingText) return m;
            return { ...m, content: text, thinkingContent: thinkingText || undefined };
          }),
        },
      })),

    bindActiveRun: (sessionKey, runId) =>
      set((state) => {
        const existing = state.activeTurnBySession[sessionKey];
        const turn = existing && (!existing.runId || existing.runId === runId) ? existing : newActiveTurn();
        return { activeTurnBySession: { ...state.activeTurnBySession, [sessionKey]: { ...turn, runId } } };
      }),

    appendStreamDelta: (sessionKey, delta) =>
      set((s) => {
        const existing = s.activeTurnBySession[sessionKey];
        const turn = existing ?? newActiveTurn();
        const streamingText = mergeGatewayStreamText(turn.streamingText, delta);
        const changed = streamingText !== turn.streamingText;
        // R1：快照重复（合并结果与旧文本一字不差）⇒ 不是"最新活动"，连 state 都不动。
        if (!changed && existing) return s;
        return {
          activeTurnBySession: {
            ...s.activeTurnBySession,
            [sessionKey]: {
              ...turn,
              streamingText,
            },
          },
        };
      }),

    // ⚠️ 不用 `mergeGatewayStreamText`：那是给**增量**用的合并规则，
    //    对"全文快照"会做出重复拼接（正是要修的那个 bug）。
    replaceStreamText: (sessionKey, text) =>
      set((s) => {
        const existing = s.activeTurnBySession[sessionKey];
        const turn = existing ?? newActiveTurn();
        const changed = text !== turn.streamingText;
        // R1：全文快照与原文本相同时不算新活动（正文没动，相位不该被拨）。
        if (!changed && existing) return s;
        return {
          activeTurnBySession: {
            ...s.activeTurnBySession,
            [sessionKey]: {
              ...turn,
              streamingText: text,
            },
          },
        };
      }),

    appendThinkingDelta: (sessionKey, delta) =>
      set((s) => {
        const existing = s.activeTurnBySession[sessionKey];
        const turn = existing ?? newActiveTurn();
        // ⚠️ 思考走**显式分段状态**合并（2026-10-13 复审整改）：只跟"当前段最新快照"比，
        //    不跟整个历史猜段 —— 跨段空行由 `renderThinkingSegments` 负责。
        const prev = thinkingSegmentsOf(turn);
        const next = mergeThinkingSnapshot(prev, delta);
        // R1：累计快照原样重发 / 当前段旧快照重投 ⇒ 状态**同引用**返回 ⇒ 不是新活动
        //    （连 state 都不动；activity revision 不涨）。
        if (next === prev && existing) return s;
        const streamingThinking = renderThinkingSegments(next);
        return {
          activeTurnBySession: {
            ...s.activeTurnBySession,
            [sessionKey]: {
              ...turn,
              streamingThinking,
              thinkingCompleted: next.completed,
              thinkingCurrent: next.current,
              thinkingLastSealed: next.lastSealed,
            },
          },
        };
      }),

    finalizeStream: (sessionKey, meta?) => {
      set((s) => {
        const turn = s.activeTurnBySession[sessionKey];
        if (!turn) return s;

        // ⚠️ 推理可能**混在正文里**（有些模型只给闭标签 `</think>`、没有单独的 thinking
        //    块 —— 2026-09-14 线上实测 qwen3.5-27b）。这里原本是
        //    `content = turn.streamingText` 原样收下，于是**流式**这条路径把推理留在了
        //    正文里，而 `normalizeAssistantTurns` 那条路径是干净的 —— 同一会话两条路径
        //    结果不一致。两处共用同一个切分函数。
        const { text: content, thinkingText: inlineThinking } = splitInlineThinking(
          turn.streamingText,
          turn.streamingThinking,
        );
        const thinkingContent = inlineThinking || undefined;

        if (!content && !thinkingContent && turn.toolCalls.length === 0) {
          return {
            activeTurnBySession: {
              ...s.activeTurnBySession,
              [sessionKey]: {
                ...turn,
                streamingText: '',
                streamingThinking: '',
                thinkingCompleted: '',
                thinkingCurrent: '',
                thinkingLastSealed: '',
              },
            },
          };
        }

        return {
          activeTurnBySession: {
            ...s.activeTurnBySession,
            [sessionKey]: {
              ...turn,
              finalized: true,
              content,
              thinkingContent,
              streamingText: '',
              streamingThinking: '',
              thinkingCompleted: '',
              thinkingCurrent: '',
              thinkingLastSealed: '',
              runId: meta?.runId ?? turn.runId,
            },
          },
        };
      });
    },

    promoteActiveTurn: (sessionKey, taskId, canonical) =>
      set((s) => {
        const turn = s.activeTurnBySession[sessionKey];
        const merged = mergeCanonicalMessageWithActiveTurn(canonical, turn);
        const nextTurns = { ...s.activeTurnBySession };
        if (!turn?.runId || canonical.runId === turn.runId) delete nextTurns[sessionKey];
        return {
          messagesByTask: {
            ...s.messagesByTask,
            [taskId]: [...(s.messagesByTask[taskId] ?? []), merged],
          },
          activeTurnBySession: nextTurns,
        };
      }),

    adoptActiveTurn: (sessionKey, taskId, options?) => {
      const turn = get().activeTurnBySession[sessionKey];
      // 只有**跑完**的一轮才可采纳。半途采纳等于把一段没写完的正文落成正式回复，
      // 而且它的「最终正文」还在 streamingText 里、content 是空的。
      if (!turn || !turn.finalized) return null;

      const adopted: Message = {
        ...activeTurnToMessage(turn, taskId, sessionKey),
        // 实际生成它的模型：**只有**调用方从网关历史探到了才传（见 compare-store 的采纳流程）。
        // 拿列的配置模型兜底是被禁止的 —— 那字段是「我发给谁」不是「谁答的」。
        model: options?.model,
        // 同上：探到网关时间戳就用它（对账去重键 + 时间线排序都要），否则保留 activeTurn 的。
        timestamp: options?.timestamp ?? turn.timestamp,
      };
      if (!adopted.content && !adopted.thinkingContent && adopted.toolCalls.length === 0) return null;

      set((s) => {
        const nextTurns = { ...s.activeTurnBySession };
        delete nextTurns[sessionKey];
        const nextErrors = { ...s.errorBySession };
        delete nextErrors[sessionKey];
        return {
          messagesByTask: { ...s.messagesByTask, [taskId]: [...(s.messagesByTask[taskId] ?? []), adopted] },
          activeTurnBySession: nextTurns,
          errorBySession: nextErrors,
        };
      });
      persistMessageUpdate(deps, adopted);
      return adopted;
    },

    clearActiveTurn: (sessionKey) =>
      set((s) => {
        if (!s.activeTurnBySession[sessionKey]) return s;
        const next = { ...s.activeTurnBySession };
        delete next[sessionKey];
        // V2：执行投影与活动轮次同生命周期（换会话/作废轮次即清该 scope 投影）。
        const nextExecutions = { ...s.executionBySession };
        delete nextExecutions[sessionKey];
        return { activeTurnBySession: next, executionBySession: nextExecutions };
      }),

    clearMessages: (taskId) =>
      set((s) => {
        const nextMessages = { ...s.messagesByTask };
        const nextTurns = { ...s.activeTurnBySession };
        const nextProcessing = new Set(s.processingBySession);
        const nextErrors = { ...s.errorBySession };
        const nextRetryable = { ...s.retryableErrorBySession };
        const nextAutoRetry = { ...s.autoRetryFailureBySession };
        const nextTurnStartedAt = { ...s.turnStartedAtBySession };
        const nextRunRetry = { ...s.runRetryBySession };
        // V2：同 scope 清理执行投影（换账号/工作区即清该任务全部会话的投影）。
        const nextExecutions = { ...s.executionBySession };

        delete nextMessages[taskId];
        for (const key of Object.keys(nextTurns)) {
          if (parseTaskIdFromSessionKey(key) === taskId) delete nextTurns[key];
        }
        for (const key of nextProcessing) {
          if (parseTaskIdFromSessionKey(key) === taskId) nextProcessing.delete(key);
        }
        for (const key of Object.keys(nextErrors)) {
          if (parseTaskIdFromSessionKey(key) === taskId) delete nextErrors[key];
        }
        for (const key of Object.keys(nextRetryable)) {
          if (parseTaskIdFromSessionKey(key) === taskId) delete nextRetryable[key];
        }
        for (const key of Object.keys(nextAutoRetry)) {
          if (parseTaskIdFromSessionKey(key) === taskId) delete nextAutoRetry[key];
        }
        for (const key of Object.keys(nextTurnStartedAt)) {
          if (parseTaskIdFromSessionKey(key) === taskId) delete nextTurnStartedAt[key];
        }
        for (const key of Object.keys(nextRunRetry)) {
          if (parseTaskIdFromSessionKey(key) === taskId) delete nextRunRetry[key];
        }
        for (const key of Object.keys(nextExecutions)) {
          if (parseTaskIdFromSessionKey(key) === taskId) delete nextExecutions[key];
        }

        return {
          messagesByTask: nextMessages,
          activeTurnBySession: nextTurns,
          processingBySession: nextProcessing,
          errorBySession: nextErrors,
          retryableErrorBySession: nextRetryable,
          autoRetryFailureBySession: nextAutoRetry,
          turnStartedAtBySession: nextTurnStartedAt,
          runRetryBySession: nextRunRetry,
          executionBySession: nextExecutions,
        };
      }),

    setHighlightedMessage: (id) => set({ highlightedMessageId: id }),

    setProcessing: (sessionKey, processing) =>
      set((s) => {
        const wasProcessing = s.processingBySession.has(sessionKey);
        const next = new Set(s.processingBySession);
        if (processing) next.add(sessionKey);
        else next.delete(sessionKey);

        // ⚠️ 只在**从空闲变忙**那一刻打点。已经在忙时再收到 `true`（重连、迟到的
        //    lifecycle.start）绝不能拨表 —— 见 `turnStartedAtBySession` 的说明。
        const startedAt = { ...s.turnStartedAtBySession };
        // 「可重试错误」同一条纪律：只有**空闲→忙**（真的又跑起来一轮）才作废。
        // ⚠️ 反过来 `processing === false` **绝不能**清 —— dispatcher 的错误分支正是
        //    "先 setProcessing(false)、再登记"，在这里清会把刚登记的按钮立刻抹掉。
        let nextRetryable = s.retryableErrorBySession;
        // 「自动重试候选」同一条纪律、同一个理由（正是"有人已经重发过"的那道天然闸）：
        // 新一轮起来 ⇒ 这个候选的使命结束；定时器到点时现读它，读到没了就放弃自动重发。
        let nextAutoRetry = s.autoRetryFailureBySession;
        if (processing) {
          if (!wasProcessing) {
            startedAt[sessionKey] = Date.now();
            if (sessionKey in s.retryableErrorBySession) {
              nextRetryable = { ...s.retryableErrorBySession };
              delete nextRetryable[sessionKey];
            }
            if (sessionKey in s.autoRetryFailureBySession) {
              nextAutoRetry = { ...s.autoRetryFailureBySession };
              delete nextAutoRetry[sessionKey];
            }
          }
        } else {
          delete startedAt[sessionKey];
        }

        return {
          processingBySession: next,
          turnStartedAtBySession: startedAt,
          retryableErrorBySession: nextRetryable,
          autoRetryFailureBySession: nextAutoRetry,
        };
      }),

    setRunPhase: (sessionKey, phase, retry) =>
      set((s) => {
        // ⚠️ 相位不是 `retrying`（含 null）时**一定清掉**数字 —— 它与相位同一次 set 写，
        //    这样"什么时候清"只有一条规则，不需要在各个收尾点补清理。
        const nextRetry = { ...s.runRetryBySession };
        if (retry) nextRetry[sessionKey] = retry;
        else delete nextRetry[sessionKey];
        return {
          runPhaseBySession: { ...s.runPhaseBySession, [sessionKey]: phase },
          runRetryBySession: nextRetry,
        };
      }),

    setSessionProgressText: (sessionKey, text) =>
      set((s) => ({
        progressTextBySession: { ...s.progressTextBySession, [sessionKey]: text },
      })),

    announceCompactionOnce: (taskId, sessionKey, episode, text) => {
      // ⚠️ 判断与写入必须在**同一次** `set` 里（zustand 的 updater 是同步的）——
      //    分两步读-改-写的话，两条来源几乎同时到达时会**都**通过检查。
      let announced = false;
      set((s) => {
        if ((s.compactionAnnouncedEpisodeBySession[sessionKey] ?? 0) >= episode) return s;
        announced = true;
        return {
          compactionAnnouncedEpisodeBySession: { ...s.compactionAnnouncedEpisodeBySession, [sessionKey]: episode },
        };
      });
      if (!announced) return false;
      get().addMessage(taskId, 'system', text, undefined, { sessionKey });
      return true;
    },

    beginCompactionEpisode: (sessionKey) => {
      const next = (get().compactionEpisodeBySession[sessionKey] ?? 0) + 1;
      set((s) => ({ compactionEpisodeBySession: { ...s.compactionEpisodeBySession, [sessionKey]: next } }));
      return next;
    },

    ensureCompactionEpisode: (sessionKey) => {
      const current = get().compactionEpisodeBySession[sessionKey];
      return current ?? get().beginCompactionEpisode(sessionKey);
    },

    setSessionCompacting: (sessionKey, compacting) =>
      set((s) => {
        if (compacting) return { compactingBySession: { ...s.compactingBySession, [sessionKey]: true } };
        if (!(sessionKey in s.compactingBySession)) return s;
        const next = { ...s.compactingBySession };
        delete next[sessionKey];
        return { compactingBySession: next };
      }),

    setSessionError: (sessionKey, message) =>
      set((s) => {
        if (message === null) {
          if (!(sessionKey in s.errorBySession)) return s;
          const next = { ...s.errorBySession };
          delete next[sessionKey];
          return { errorBySession: next };
        }
        return { errorBySession: { ...s.errorBySession, [sessionKey]: message } };
      }),

    // 每会话**只留最近一条** —— 攒着没用（界面只给最新那次失败配按钮），还容易给出一条
    // 早就被后续对话甩在身后的"重试"。
    markRetryableError: (sessionKey, target) =>
      set((s) => ({ retryableErrorBySession: { ...s.retryableErrorBySession, [sessionKey]: target } })),

    // 同一条"只留最近一条"：一个会话同时只可能有一个"刚失败、还没人重发"的轮次。
    markAutoRetryFailure: (sessionKey, target) =>
      set((s) => ({ autoRetryFailureBySession: { ...s.autoRetryFailureBySession, [sessionKey]: target } })),
  }));
}
