/**
 * 「等某一次回复结束」（2026-09-20）。
 *
 * 圆桌要串行：第 2 位必须等第 1 位说完。客户端原本只有"发出去就不管"的扇出
 * （`chat-composer.ts` 的 `Promise.allSettled`），没有等待原语 —— 这个文件补上它。
 *
 * ## 信号是什么（运行时实测，不是猜的）
 *
 * gateway 每轮都会发 `agent.lifecycle.start` / `.end`，**带 `sessionKey`**
 * （实测样本见 `%APPDATA%/@clawwork/desktop/logs/debug-*.ndjson`，
 * 形如 `agent:main:clawwork:<deviceId>:task:<taskId>`）。
 * dispatcher 收到后调 `messageStore.setProcessing(sessionKey, bool)`
 * —— `processingBySession` 就是这个信号在渲染进程里的落点。
 *
 * ## ⚠️ 竞态是这里唯一的难点
 *
 * 如果**先发再订阅**：`sendMessage` 返回之后、我们开始订阅之前，那一小段里
 * start（甚至 start+end）可能已经过去了 ⇒ 我们会**永远等不到"忙"**，然后超时。
 * 所以接口是 `watchTurnEnd()` 先订阅、拿到 `ended` 之后**再**发。
 *
 * store 是注入的（而不是直接 import），这样上面这条竞态可以用假 store 直接测掉。
 */

interface ProcessingStore {
  getState: () => { processingBySession: Set<string> };
  subscribe: (listener: () => void) => () => void;
}

export interface TurnWatch {
  /** 这一轮说完时 resolve。 */
  ended: Promise<void>;
  /** 取消订阅（无论 resolve 与否都要调，否则监听器会攒着）。 */
  dispose: () => void;
}

export interface TurnWatchOptions {
  /** 等"从忙变闲"的上限。给得宽松些：长回答 + 工具调用会很慢。 */
  timeoutMs?: number;
  /** 等它"开始忙"的上限 —— 超过说明这条消息根本没跑起来（网关没连、会话不对）。 */
  startTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_START_TIMEOUT_MS = 60 * 1000;

/**
 * 订阅某个 session 的"说完"。**先订阅、后发送**，别反过来。
 */
export function watchTurnEnd(store: ProcessingStore, sessionKey: string, opts: TurnWatchOptions = {}): TurnWatch {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;

  const busy = () => store.getState().processingBySession.has(sessionKey);

  let seenBusy = false;
  let settled = false;
  let unsubscribe: (() => void) | undefined;

  // 计时器放在容器里而不是两个 `let`：`cleanup` 要引用它们，而它们的回调又要引用
  // `settle`（它依赖 `cleanup`）—— 直接互相引用会绕成一个循环。
  const timers: { start?: ReturnType<typeof setTimeout>; end?: ReturnType<typeof setTimeout> } = {};

  let resolveEnded!: () => void;
  let rejectEnded!: (e: Error) => void;
  const ended = new Promise<void>((res, rej) => {
    resolveEnded = res;
    rejectEnded = rej;
  });

  const cleanup = () => {
    if (timers.start) clearTimeout(timers.start);
    if (timers.end) clearTimeout(timers.end);
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
    if (busy()) {
      seenBusy = true;
      if (timers.start) {
        clearTimeout(timers.start);
        timers.start = undefined;
      }
      return;
    }
    // 只有**先见过忙**才算"说完了"；否则发出去之前那一下闲会被误判成一整轮结束。
    if (seenBusy) settle(resolveEnded);
  };

  unsubscribe = store.subscribe(check);

  timers.start = setTimeout(() => {
    if (seenBusy) return; // 已经在忙了，这个表不用管
    settle(() => rejectEnded(new Error(`等不到这一轮开始（${sessionKey}）`)));
  }, startTimeoutMs);

  timers.end = setTimeout(() => {
    settle(() => rejectEnded(new Error(`等这一轮结束超时（${sessionKey}）`)));
  }, timeoutMs);

  // 订阅之后立刻查一次：订阅之前它可能就已经在忙了。
  check();

  return { ended, dispose: () => settle(() => {}) };
}

/**
 * 等某个条件成立。**只用来等"将来才会发生的事"** —— 如果条件在订阅那一刻就已经成立，
 * 它会立刻 resolve。所以它不适合判断"状态有没有变化"（那种用 `watchTurnEnd`）。
 *
 * 为什么需要它：实测（debug 日志时间线）
 *
 * ```
 * 10:40:13.716  agent.lifecycle.end
 * 10:40:13.738  chat.final.received   (+22ms)
 * 10:40:13.738  chat.finalized        (+22ms)
 * ```
 *
 * ⇒ 拿到"不忙了"的时候，这一轮**还没 finalize**。而 `finalizeStream` 才做
 * `splitInlineThinking`（把混在正文里的 `</think>` 推理切出去）。
 * 少等这一步，会把模型的思考过程当成"发言"喂给下一位。
 */
export function waitForCondition(
  store: ProcessingStore,
  isDone: () => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;

  if (isDone()) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    // 与 `watchTurnEnd` 同一种写法：计时器放容器里 —— `cleanup` 要引用它，
    // 它的回调又要引用 `settle`（依赖 `cleanup`），直接互相引用会绕成循环。
    const timers: { t?: ReturnType<typeof setTimeout> } = {};

    const cleanup = () => {
      if (timers.t) clearTimeout(timers.t);
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
      if (isDone()) settle(resolve);
    };

    unsubscribe = store.subscribe(check);
    timers.t = setTimeout(() => settle(() => reject(new Error('等条件成立超时'))), timeoutMs);
    check();
  });
}
