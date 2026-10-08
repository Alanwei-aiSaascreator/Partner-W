import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RETRY_RUN_PHASE, RUN_PHASE_IDS } from '@clawwork/core';
import { useMessageStore } from '@/stores/messageStore';
import { useQuestionStore } from '@/stores/questionStore';
import {
  classifyToolActivity,
  latestAwaitingApproval,
  latestRunningCall,
  sanitizeToolTitle,
  type DisplayToolCall,
} from '@/lib/tool-activity';
import { waitingLineSuffix } from '@/lib/waiting-copy';

/**
 * 活动条该盯**哪一个会话**（区1 体检 P2-6）。
 *
 * ## 为什么需要它
 *
 * 多智能体/会议任务里，主会话（conductor）经常只是"派活"，真正在跑的是 performer 会话。
 * 活动条原来只认 `activeTask.sessionKey` —— performer 在跑时整条不显示，
 * 而正文里的 `TurnActivityRow` 照样在动：同一条链两种观感，用户以为输入框那边卡死了。
 *
 * 判据用**同一个** `processingBySession`（网关接单 = 这一轮真的在跑），不引入第二套口径：
 *   - 主会话在跑 ⇒ 就是它（一切照旧）；
 *   - 主会话没跑、某个候选会话在跑 ⇒ 用那个（performer）；
 *   - 谁都没跑 ⇒ 还是主会话（调用方据此收掉整条）。
 *
 * ⚠️ 候选顺序 = 「主会话在前、performers 在后」（`getTaskSessionKeys` 的顺序），
 *    取**第一个**在跑的 —— 与 `pickWaitingSessionKey` 同一条规矩，别在这里发明第二套。
 */
function resolveActivitySessionKey(
  primary: string | null,
  fallbackKeys: readonly string[],
  processingBySession: ReadonlySet<string>,
): string | null {
  if (!primary) return null;
  if (processingBySession.has(primary)) return primary;
  for (const key of fallbackKeys) {
    if (key && key !== primary && processingBySession.has(key)) return key;
  }
  return primary;
}

/**
 * 一轮在跑的"活动"推导 —— **唯一出口**（ComposerActivity 与 TurnActivityRow 共用）。
 *
 * ⚠️ 这段推导原先内联在 `ComposerActivity` 里。会话内活动行（`TurnActivityRow`）要复用
 *    同一套主行文案与计时口径，**不许各写一份**：两处一字不差地重写迟早只改一处，
 *    用户会看到输入框上方和正文里说着两件不同的事（本仓对这类"唯一出口"的纪律
 *    见 `latestRunningCall` 的注释）。
 *
 * 口径（逐条与 ComposerActivity 原实现一致，别在这里"顺手改进"）：
 *   - 秒数是**本地等待计时**，不是后台心跳或存活证明，起算点来自 store 的
 *     `turnStartedAtBySession`（组件重挂载也不回跳）。
 *   - 主行优先级：**等人批准的工具** > **等人回答的提问** > 正在跑的工具 > 上下文压缩 >
 *     模型自述进度 > 重试第 n/m 次 > 准备阶段 > 已结束工具计数 > 泛化"处理中"。
 *   - 两类"等人"（`awaitingApproval` / `awaitingAnswer`）是同一个语义面：**不是我们在动，
 *     是在等你**。调用方拿这两个布尔值把"正在动"的视觉停掉（转圈/跳动条/扫光），
 *     只用标题与图标说话 —— 判据只在这里算一次。
 *   - 轮换待机文案只描述等待，**不承诺完成时间**（见 waiting-copy.ts 头注释）。
 *   - 第二个参数（候选会话）只给"整条任务级"的调用方用（`ComposerActivity`）：主会话没跑时
 *     盯正在跑的 performer；会话内的 `TurnActivityRow` **不传**，永远只盯自己那一格。
 *
 * ⚠️ i18n key 必须以**字面量或 `t(`前缀${变量}`)` 模板串**的形式出现在源码里 ——
 *    `scripts/lib/i18n-usage.mjs` 的扫描器只认这两种形状（函数拼 key 会被判 unused）。
 */
export interface TurnActivity {
  /** 这个会话当前有没有一轮在跑（没有时其余字段无意义）。 */
  active: boolean;
  /** 已等待毫秒（本地计时）。 */
  elapsedMs: number;
  /** 主行文案（"此刻在干什么"）。 */
  headline: string;
  /** 按等待时长轮换的中性提示。 */
  quip: string;
  /** 是否有"正在执行"的工具（用于状态标识，不等于完成度）。 */
  running: boolean;
  /**
   * 是否在**等人做决定**：有工具停在 `awaitingApproval`（A2：这一条排在 headline 最前）。
   * 界面据此把"正在动"的语言停掉（转圈/跳动条/扫光 → 静态图标 + 准确的等待文案）。
   */
  awaitingApproval: boolean;
  /**
   * 是否在**等人回答**：本会话挂着网关结构化提问（`ask_user`）。
   *
   * ⚠️ **必须按会话键过滤**（`questionStore.pendingQuestions` 是全应用一份）：
   *    同任务其他会话（performer）、其他任务的问题不得冻结**本**会话这一格。
   */
  awaitingAnswer: boolean;
}

export function useTurnActivity(sessionKey: string | null, fallbackSessionKeys?: readonly string[]): TurnActivity {
  const { t } = useTranslation();
  // ⚠️ 候选列表每次渲染都是新数组（调用方直接摆的），只按内容去重 —— 身份不稳定不影响正确性，
  //    下面所有 selectors 返回的都是原始值（字符串/数字/布尔），不会触发额外渲染。
  const fallbackKeys = useMemo(
    () => (fallbackSessionKeys ?? []).filter((key) => key && key !== sessionKey),
    [fallbackSessionKeys, sessionKey],
  );
  // 真正被盯的会话：主会话没在跑时退到正在跑的 performer（区1 体检 P2-6）。
  const resolvedKey = useMessageStore((s) =>
    resolveActivitySessionKey(sessionKey, fallbackKeys, s.processingBySession),
  );

  const active = useMessageStore((s) => (resolvedKey ? s.processingBySession.has(resolvedKey) : false));
  const startedAt = useMessageStore((s) => (resolvedKey ? s.turnStartedAtBySession[resolvedKey] : undefined));
  const runPhase = useMessageStore((s) => (resolvedKey ? s.runPhaseBySession[resolvedKey] : null));
  // 重试到第几次了（只有 `run_status` 的 `phase:"retrying"` 才有）—— 见下面的文案分支。
  const retry = useMessageStore((s) => (resolvedKey ? s.runRetryBySession[resolvedKey] : undefined));
  // 模型**自述**的进度（网关 item 流的 preamble）—— 正文不流式时唯一在动的东西。
  const modelProgress = useMessageStore((s) => (resolvedKey ? s.progressTextBySession[resolvedKey] : null));
  const toolCalls = useMessageStore((s) => (resolvedKey ? s.activeTurnBySession[resolvedKey]?.toolCalls : undefined));
  // 正在压缩上下文（B8 Phase 2）—— 压缩会让界面**停住一会儿**，必须有东西说明"为什么不动"。
  const compacting = useMessageStore((s) => (resolvedKey ? s.compactingBySession[resolvedKey] === true : false));
  // ⭐ P1-3：「等人」的第二类 —— 网关结构化提问（`ask_user`）挂起。
  // ⚠️ 判据是 `question.sessionKey === resolvedKey`（**不是**按 taskId/全局一律冻结）：
  //    提问是"某个会话里模型在等某个人回答"，同任务的其他会话（performer）或
  //    其他任务的提问跟本会话毫无关系，拿它们冻住这一格同样是说谎。
  const awaitingAnswer = useQuestionStore((s) =>
    resolvedKey ? s.pendingQuestions.some((question) => question.sessionKey === resolvedKey) : false,
  );

  // 每秒重渲染一次，只为让秒数和轮播文案往前走。不在跑的时候连定时器都不挂。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const calls = toolCalls ?? [];
  // ⚠️ 走**唯一出口**（`latestRunningCall`）：这个推导原先在多处各写了一遍，
  //    一字不差 ⇒ 迟早只改一处。返回 null 就是"该收掉了"（跑完/失败/取消）。
  const runningCall = latestRunningCall(calls);
  // ⭐ A2：**在等人批准**的调用 —— 排在**最前面**。它正是"为什么没有进展"的答案，
  //    而且**该谁动**在用户那边（不是我们）。
  // ⚠️ 计算结果只提出来**这一次**：headline 分支与返回值共用同一个变量，
  //    各自再算一遍迟早漂成两个判据（"文案说在等人、图标还在转"就是这么来的）。
  const awaitingCall = latestAwaitingApproval(calls);
  const awaitingApproval = awaitingCall !== null;
  // 已结束调用包含成功与错误，不代表成功步骤数或整个任务的完成度。
  const endedCallCount = calls.filter((call) => call.status === 'done' || call.status === 'error').length;

  // 主行要说的是"此刻在干什么"，优先级：**等人批准的工具** > **等人回答的提问** >
  // 正在跑的工具 > 网关报的准备阶段 > 已结束工具调用计数 / 等待响应。
  // ⭐ 两类"等人"排在最前：它们才是"为什么没有进展"的答案（而且该谁动在用户那边）。
  let headline: string;
  const activityLabel = (call: DisplayToolCall): string => {
    // 图12（2026-10-06）：活动行同样走产品化——title 剥工具名/遮路径；拿不到就退回动作词
    //（`other` 类原来直出原始工具名，现在同样退回词表里的「使用工具」）。
    const title = sanitizeToolTitle(call.title, call.name);
    if (title) return title;
    return t(`toolActivity.actions.${classifyToolActivity(call.name)}`);
  };
  if (awaitingCall) {
    // ⚠️ **不复用 `runningTool`**："执行中：X" 说的是"在动"，而这条要说的是"没动，在等人"
    //    —— 复用就等于什么都没说（A2 的口径就是不让复用）。
    headline = t('chatInput.waiting.awaitingApproval', { what: activityLabel(awaitingCall) });
  } else if (awaitingAnswer) {
    // ⭐ P1-3：提问挂起时**模型在等用户**，工具的"在跑"根本不是此刻的实情
    //    （用户在 `QuestionPanel` 里答完，这一轮才会继续）⇒ 排在 `runningTool` 前面。
    // ⚠️ 这句话没有"在等哪一问"的位置（问题本身就在 `QuestionPanel` 里摆着，
    //    再抄一遍标题只会把活动行变成第二张问题卡片）。
    headline = t('chatInput.waiting.awaitingAnswer');
  } else if (runningCall) {
    headline = t('chatInput.waiting.runningTool', { what: activityLabel(runningCall) });
  } else if (compacting) {
    // ⭐ 压缩是**此刻系统在做的事**（与"正在跑的工具"同类：都是事实），而且它正是
    //    "界面为什么停住"的答案 ⇒ 排在模型**自述**的进度前面
    //    （那句是它上一轮说的话，压缩期间已经过期了）。
    headline = t('chatInput.compacting');
  } else if (modelProgress) {
    // 工具的 `title` 是网关拼好的**事实**（工具名 + 参数），比模型的话更硬 ⇒ 排在它后面。
    // 但它比 `runPhase` 具体得多（后者只是"正在调用模型"这一档），所以排在它前面。
    headline = t('chatInput.waiting.modelProgress', { what: modelProgress });
  } else if (runPhase === RETRY_RUN_PHASE && retry) {
    // ⭐ 重试相位要说得出"**第 2/4 次**" —— 比"正在重试…"有用得多：
    //    它同时回答了"在动吗"和"还要等几轮"。
    // ⚠️ **只有同时拿到两个数字**才走这条（畸形帧没有数字 ⇒ 落回下面的泛化文案，
    //    而不是显示一句"第 / 次"）。
    headline = t('chatInput.runPhase.retrying', { attempt: retry.attempt, maxAttempts: retry.maxAttempts });
  } else if (runPhase) {
    // ⚠️ `retrying` **必须排除在这条泛化路之外**：它有自己的分支（上面那条，要两个数字），
    //    走到这里就说明**没拿到数字**（畸形帧）。而 `runPhase.retrying` 那句里有
    //    `{{attempt}}/{{maxAttempts}}` —— 没数字时 i18next 会渲染出
    //    「正在重试（第 / 次）…」这种半截话，比泛化文案更糟。
    const generic = runPhase !== RETRY_RUN_PHASE && RUN_PHASE_IDS.includes(runPhase) ? runPhase : 'unknown';
    headline = t(`chatInput.runPhase.${generic}`);
  } else if (endedCallCount > 0) {
    headline = t('chatInput.waiting.writing', { count: endedCallCount });
  } else {
    headline = t('chatInput.waiting.working');
  }

  // 中性等待提示：按已等待时长确定性轮播，不作为后台心跳。
  // ⚠️ 前缀必须**写在这个模板串里**：`scripts/lib/i18n-usage.mjs` 的扫描器
  //    只认字面 key 或「前缀 + ${变量}」，把 key 拼在辅助函数里它看不见，
  //    这些文案会被判成 unused 然后 check:i18n 失败（真踩过）。
  const quip = t(`chatInput.waiting.line.${waitingLineSuffix(elapsedMs)}`);

  return { active, elapsedMs, headline, quip, running: Boolean(runningCall), awaitingApproval, awaitingAnswer };
}
