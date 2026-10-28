/**
 * 「等某一次回复结束，并把**干净正文**拿回来」（2026-09-20）。
 *
 * 圆桌要串行：第 2 位必须等第 1 位说完。客户端原本只有"发出去就不管"的扇出
 * （`chat-composer.ts` 的 `Promise.allSettled`），这个文件补上等待原语。
 *
 * ## 信号是什么（运行时实测，不是猜的）
 *
 * gateway 每轮都会发 `agent.lifecycle.start` / `.end`，**带 `sessionKey`**
 * （实测样本在 `%APPDATA%/@clawwork/desktop/logs/debug-*.ndjson`）。
 * dispatcher 收到后调 `messageStore.setProcessing(sessionKey, bool)`
 * —— `processingBySession` 就是这个信号在渲染进程里的落点。
 *
 * ## ⚠️ 两个竞态，一个都不能省
 *
 * 1. **必须先订阅、后发送**。反过来的话，`sendMessage` 返回之后、订阅之前那一小段里
 *    start（甚至 start+end）可能已经过去了 ⇒ 永远等不到"忙"。
 *
 * 2. ⭐ **正文必须在它出现的那一刻抓下来，不能"等结束了再去读"**。
 *    实测时间线（debug 日志）：
 *    ```
 *    agent.lifecycle.end      ← "不忙了"
 *    chat.final.received      (+22ms)
 *    chat.finalized           (+22ms)  ← 此刻 finalized 才为 true、正文才切掉 </think>
 *    ```
 *    而 dispatcher 在 `chat.finalized` 之后**紧接着**就 `syncSessionMessages`，
 *    把这条 active turn **收编走并删除**。所以"等结束 → 再去读"必然读到 undefined
 *    —— 2026-09-20 实机就是这样：第一位助手明明说完了，却卡在"等条件成立超时"，
 *    整个讨论停在第一句。
 *    ⇒ 订阅时就把 `readFinalText` 挂上，看到非空立刻 resolve。
 *
 * `readFinalText` 与 store 都是注入的，所以上面两条竞态都能用假 store 直接测掉。
 */

interface TurnStore {
  getState: () => { processingBySession: Set<string> };
  subscribe: (listener: () => void) => () => void;
}

export interface TurnWatch {
  /** 这一轮说完时 resolve，值是**已 finalize 的正文**。 */
  text: Promise<string>;
  /** 取消订阅（无论 resolve 与否都要调，否则监听器会攒着）。 */
  dispose: () => void;
}

export interface TurnWatchOptions {
  /** 等"从忙变闲"的上限。给得宽松些：长回答 + 工具调用会很慢。 */
  timeoutMs?: number;
  /** 等它"开始忙"的上限 —— 超过说明这条消息根本没跑起来（网关没连、会话不对）。 */
  startTimeoutMs?: number;
  /** "变闲"之后还允许等多久正文（见 DEFAULT_FINALIZE_GRACE_MS 的说明）。 */
  finalizeGraceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_START_TIMEOUT_MS = 60 * 1000;

/**
 * "变闲"之后还允许等多久正文。
 *
 * ⚠️ **不能一闲下来就判死**：实测 `lifecycle.end`（变闲）比 `chat.finalized`（正文才切干净）
 *    **早 22–36ms** —— 变闲那一刻正文本来就还没好。这段宽限就是给那几十毫秒用的；
 *    给 5 秒是为了容忍慢的 finalize，同时又不至于让真失败一直挂着。
 */
const DEFAULT_FINALIZE_GRACE_MS = 5_000;

/**
 * 盯住某个 session 的这一轮。**先调用它、再去发送**。
 */
export function watchTurn(
  store: TurnStore,
  sessionKey: string,
  readFinalText: () => string | null,
  opts: TurnWatchOptions = {},
): TurnWatch {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const graceMs = opts.finalizeGraceMs ?? DEFAULT_FINALIZE_GRACE_MS;

  const busy = () => store.getState().processingBySession.has(sessionKey);

  /**
   * 订阅那一刻的正文。
   *
   * ⚠️ 必须有它：**同一个 session 会被重复使用**（同一场讨论跑第二轮、或用户对同一位
   *    助手再问一次）。上一轮 finalize 的 turn 会留在 store 里，新一轮一"忙"我们就
   *    读到它 —— 于是把**上一轮的答案**当成本轮结果。不能只看"非空"。
   */
  const initialText = readFinalText();

  let seenBusy = false;
  /** 忙起来之后见过一次"还没 finalize" ⇒ 说明新一轮确实把 turn 重置了。 */
  let sawResetAfterBusy = false;
  let settled = false;
  let unsubscribe: (() => void) | undefined;
  // 计时器放容器里而不是两个 `let`：`cleanup` 要引用它们，而它们的回调又要引用
  // `settle`（它依赖 `cleanup`）—— 直接互相引用会绕成一个循环。
  const timers: {
    start?: ReturnType<typeof setTimeout>;
    end?: ReturnType<typeof setTimeout>;
    grace?: ReturnType<typeof setTimeout>;
  } = {};

  let resolveText!: (v: string) => void;
  let rejectText!: (e: Error) => void;
  const text = new Promise<string>((res, rej) => {
    resolveText = res;
    rejectText = rej;
  });

  const cleanup = () => {
    if (timers.start) clearTimeout(timers.start);
    if (timers.end) clearTimeout(timers.end);
    if (timers.grace) clearTimeout(timers.grace);
    unsubscribe?.();
    unsubscribe = undefined;
  };

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    fn();
  };

  const check = () => {
    if (settled) return;

    const nowBusy = busy();
    if (nowBusy) {
      seenBusy = true;
      if (timers.start) {
        clearTimeout(timers.start);
        timers.start = undefined;
      }
    }

    // 只有**先见过忙**才认正文 —— 否则上一轮残留的会被当成本轮的结果。
    if (seenBusy) {
      const t = readFinalText();
      if (t === null) {
        // 还没出现新正文。记下来 —— 有它就能容忍"本轮答案与上一轮一字不差"。
        sawResetAfterBusy = true;
      } else if (t !== initialText || sawResetAfterBusy) {
        settle(() => resolveText(t));
        return;
      }

      // ⚠️ 变闲之后还没拿到新正文 ⇒ 给一个宽限窗口，**不管读到的是空还是旧值**。
      //    两种真实情形都会走到这里：
      //      ① `lifecycle.end` 比 `chat.finalized` 早 22–36ms，那一刻正文还没好；
      //      ② 正文要走 `chat.history` 往返才落进消息列表，期间读到的还是**上一轮**那条。
      //    少了这个窗口，情形 ② 会一直挂到总超时（实机与单测都踩过）。
      if (!nowBusy && !timers.grace) {
        timers.grace = setTimeout(() => {
          settle(() => rejectText(new Error(`这一轮结束了但拿不到正文（${sessionKey}）`)));
        }, graceMs);
      }
    }
  };

  unsubscribe = store.subscribe(check);

  timers.start = setTimeout(() => {
    if (seenBusy) return; // 已经在忙了，这个表不用管
    settle(() => rejectText(new Error(`等不到这一轮开始（${sessionKey}）`)));
  }, startTimeoutMs);

  timers.end = setTimeout(() => {
    settle(() => rejectText(new Error(`等这一轮结束超时（${sessionKey}）`)));
  }, timeoutMs);

  // 订阅之后立刻查一次：订阅之前它可能就已经在忙了。
  check();

  return { text, dispose: () => settle(() => {}) };
}
