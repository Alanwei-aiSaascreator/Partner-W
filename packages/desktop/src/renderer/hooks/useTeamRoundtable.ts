import { useCallback, useRef, useState } from 'react';
import { buildSessionKey } from '@clawwork/shared';
import { useMessageStore } from '@/stores/messageStore';
import { runRoundtable } from '@/lib/team-roundtable-runner';
import { watchTurn } from '@/lib/turn-waiter';
import type { Speaker, Turn } from '@/lib/team-roundtable';

/**
 * 圆桌讨论接进真实世界（2026-09-20）。
 *
 * 这一层只做**接线**：把 `runRoundtable` 的 `send` 换成真身 ——
 * 「发到这位助手自己的会话 → 等这一轮结束并取回干净正文」。
 * 顺序、失败即停、人数上限那些判断全在 `lib/team-roundtable-runner.ts`（有单测）。
 *
 * ## 三个实测得来的细节，少一个就出错
 *
 * 1. **会话键**是 `buildSessionKey(taskId, agentId, deviceId)`，形状
 *    `agent:<agentId>:clawwork:<deviceId>:task:<taskId>`（运行时日志里抄下来的）。
 * 2. **先起监视、后发送** —— 反过来的话，`sendMessage` 返回之后、订阅之前那一小段里
 *    start/end 可能已经过去 ⇒ 永远等不到"忙"。
 * 3. ⚠️ **正文要在它出现的那一刻抓，不能"等结束了再去读"**：dispatcher 在
 *    `chat.finalized` 之后紧接着就 `syncSessionMessages`，把 active turn 收编走并删除。
 *    2026-09-20 实机就是这样挂的 —— 第一位助手明明说完了，却卡在"等条件成立超时"，
 *    整个讨论停在第一句。细节见 `lib/turn-waiter.ts`。
 *
 * ## 🔴 已知未解决（2026-09-20 停手时的实测状态）
 *
 * 第一位助手（主持人）**能跑、能出完整回答**（屏幕上看得见），但**这一层拿不到它的正文**：
 * 探针实测那一轮 `messagesByTask[taskId]` 是 **0 条**，而 `activeTurnBySession` 是
 * `finalized:false / content 空` —— 也就是说**界面上显示的那份回答不在我读的这两个地方**。
 * 还没定位到渲染用的数据源。所以**团队讨论目前跑不完第一位**（会以
 * "这一轮结束了但拿不到正文"中断）。
 *
 * 下一步排查方向：从 ChatPanel/消息列表的渲染源反查（谁在读、读的是哪个字段/
 * 哪次 IPC 的返回），而不是继续猜 store 的字段名。
 */

/** `turn-waiter` 只要这两件，直接借 store 的，不另造一层。 */
const messageStorePort = {
  getState: () => useMessageStore.getState(),
  subscribe: (fn: () => void) => useMessageStore.subscribe(fn),
};

/**
 * 读这一位**这一轮**的正文。
 *
 * ⚠️ 读的是**任务消息列表**，不是 `activeTurnBySession`。
 *    2026-09-20 实机踩了两次才定位：
 *      · 先读 active turn 的 `finalized` —— 但 dispatcher 在 `chat.finalized` 之后
 *        紧接着就 `syncSessionMessages`，把它收编走；
 *      · 改成"出现那一刻抓"仍然拿不到 —— 探针实测那一轮的 active turn 是
 *        `finalized:false / content 空 / toolCalls:2`，**压根没有正文**：
 *        这一轮 `chat.final` 没带文本（模型跑了工具），真正的答案是从
 *        `chat.history` 回来、由 sync 落进**任务消息列表**的。
 *    ⇒ 正文的权威位置是消息列表，不是那个短暂的 turn 缓冲。
 *
 * 取该 session 最新一条**有正文的** assistant 消息。取不到返回 null（调用方据此等）。
 * "不能把上一轮的答案当成本轮"由 `watchTurn` 的初始快照负责，这里不做判断。
 */
function readTurnText(taskId: string, sessionKey: string): string | null {
  const msgs = useMessageStore.getState().messagesByTask[taskId] ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.sessionKey !== sessionKey) continue;
    if (m.role !== 'assistant') continue;
    const text = (m.content ?? '').trim();
    if (text) return text;
  }
  return null;
}

export interface StartRoundtableArgs {
  taskId: string;
  gatewayId: string;
  question: string;
  speakers: readonly Speaker[];
}

export interface TeamRoundtableApi {
  running: boolean;
  turns: Turn[];
  /** 已经轮到第几位（0 = 还没开始）—— 界面用它显示「第 2/4 位发言中」。 */
  doneCount: number;
  /** 某位失败时停在他的 agentId 上；用户点了停止则填 stoppedByUser。 */
  stoppedAt?: string;
  stoppedByUser?: boolean;
  /** 中断的原因。界面要能说出为什么停，不能只在日志里（否则用户只看到"悄悄停了"）。 */
  errorMessage?: string;
  start: (args: StartRoundtableArgs) => Promise<void>;
  /** 停止：既不再往下发，也中断当前这一位。 */
  stop: () => void;
}

export function useTeamRoundtable(): TeamRoundtableApi {
  const [running, setRunning] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [doneCount, setDoneCount] = useState(0);
  const [stoppedAt, setStoppedAt] = useState<string | undefined>();
  const [stoppedByUser, setStoppedByUser] = useState<boolean | undefined>();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  const runningRef = useRef(false);
  const stopRef = useRef(false);
  /** 当前正在说的那一位 —— `stop()` 要中断的就是他。 */
  const inFlightRef = useRef<{ gatewayId: string; sessionKey: string } | null>(null);

  const stop = useCallback(() => {
    stopRef.current = true;
    const inFlight = inFlightRef.current;
    if (inFlight) {
      // 只置标志不够：当前这一位会一直说到完。用户点「停止」就是要它现在停。
      void window.clawwork.abortChat(inFlight.gatewayId, inFlight.sessionKey).catch(() => {});
    }
  }, []);

  const start = useCallback(async ({ taskId, gatewayId, question, speakers }: StartRoundtableArgs) => {
    if (runningRef.current) return;
    runningRef.current = true;
    stopRef.current = false;
    setRunning(true);
    setTurns([]);
    setDoneCount(0);
    setStoppedAt(undefined);
    setStoppedByUser(undefined);
    setErrorMessage(undefined);

    // 与 `CronJobDialog` 同一种取法：拿不到就当没有（会话键少一段，网关那边仍是合法的）。
    const deviceId = (await window.clawwork.getDeviceId().catch(() => '')) || undefined;

    const send = async (agentId: string, prompt: string): Promise<string> => {
      const sessionKey = buildSessionKey(taskId, agentId, deviceId);

      // ⚠️ 顺序不能反：先起监视，再发送。
      const watch = watchTurn(messageStorePort, sessionKey, () => readTurnText(taskId, sessionKey));
      inFlightRef.current = { gatewayId, sessionKey };
      try {
        const res = await window.clawwork.sendMessage(gatewayId, sessionKey, prompt);
        if (res && res.ok === false) throw new Error(`发送失败：${res.error ?? ''}`);

        const text = await watch.text;
        if (text.trim() === '') throw new Error(`${agentId} 这一轮没有产出正文`);
        return text;
      } finally {
        watch.dispose();
        inFlightRef.current = null;
      }
    };

    try {
      const result = await runRoundtable({
        question,
        speakers,
        send,
        shouldStop: () => stopRef.current,
        onTurn: (turn) => {
          setTurns((prev) => [...prev, turn]);
          setDoneCount((n) => n + 1);
        },
      });
      setStoppedAt(result.stoppedAt);
      setStoppedByUser(result.stoppedByUser);
      setErrorMessage(result.errorMessage);
      if (result.errorMessage) console.error('[roundtable] 中断：', result.errorMessage);
    } catch (error) {
      // 人数超限之类在**发之前**就抛了 —— 一位都没发出去，停在第 0 位。
      setStoppedAt(speakers[0]?.agentId);
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage(msg);
      console.error('[roundtable] 起不来：', msg);
    } finally {
      runningRef.current = false;
      inFlightRef.current = null;
      setRunning(false);
    }
  }, []);

  return { running, turns, doneCount, stoppedAt, stoppedByUser, errorMessage, start, stop };
}
