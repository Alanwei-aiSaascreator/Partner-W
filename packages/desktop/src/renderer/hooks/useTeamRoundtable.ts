import { useCallback, useRef, useState } from 'react';
import { buildSessionKey } from '@clawwork/shared';
import { useMessageStore } from '@/stores/messageStore';
import { runRoundtable } from '@/lib/team-roundtable-runner';
import { waitForCondition, watchTurnEnd } from '@/lib/turn-waiter';
import type { Speaker, Turn } from '@/lib/team-roundtable';

/**
 * 圆桌讨论接进真实世界（2026-09-20）。
 *
 * 这一层只做**接线**：把 `runRoundtable` 的 `send` 换成真身 ——
 * 「发到这位助手自己的会话 → 等这一轮结束 → 取回正文」。
 * 顺序、失败即停、人数上限那些判断全在 `lib/team-roundtable-runner.ts`（有单测）。
 *
 * ## 三个实测得来的细节，少一个就出错
 *
 * 1. **会话键**是 `buildSessionKey(taskId, agentId, deviceId)`，形状
 *    `agent:<agentId>:clawwork:<deviceId>:task:<taskId>`（运行时日志里抄下来的）。
 * 2. **先订阅、后发送** —— 反过来的话，`sendMessage` 返回之后、订阅之前那一小段里
 *    start/end 可能已经过去了 ⇒ 永远等不到"忙"（见 `turn-waiter.ts`）。
 * 3. ⚠️ **`lifecycle.end` 比 `chat.final` 早 22–36ms**（debug 日志时间线实测）。
 *    而 `finalizeStream`（在 `chat.final` 那条路上）才做 `splitInlineThinking`，
 *    把混在正文里的 `</think>` 推理切出去。所以只等"不忙"就开始读，
 *    读到的是**带推理的流式缓冲** —— 等于把模型的思考过程当成"发言"喂给下一位。
 *    必须再等一次 finalize。
 */

/** `turn-waiter` 只要这两件，直接借 store 的，不另造一层。 */
const messageStorePort = {
  getState: () => useMessageStore.getState(),
  subscribe: (fn: () => void) => useMessageStore.subscribe(fn),
};

/** finalize 的宽限：实测只差几十毫秒，给 5 秒已经非常宽松。 */
const FINALIZE_WAIT_MS = 5_000;

/**
 * 读这一轮**已经 finalize 的**正文。没 finalize 返回 null（调用方据此等一等）。
 * ⚠️ 不要退回 `streamingText` —— 那里面可能还混着 `</think>` 推理。
 */
function readFinalText(sessionKey: string): string | null {
  const turn = useMessageStore.getState().activeTurnBySession[sessionKey];
  return turn?.finalized ? turn.content : null;
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

    // 与 `CronJobDialog` 同一种取法：拿不到就当没有（会话键少一段，网关那边仍是合法的）。
    const deviceId = (await window.clawwork.getDeviceId().catch(() => '')) || undefined;

    const send = async (agentId: string, prompt: string): Promise<string> => {
      const sessionKey = buildSessionKey(taskId, agentId, deviceId);

      // ⚠️ 顺序不能反：先订阅，再发。
      const watch = watchTurnEnd(messageStorePort, sessionKey);
      inFlightRef.current = { gatewayId, sessionKey };
      try {
        const res = await window.clawwork.sendMessage(gatewayId, sessionKey, prompt);
        if (res && res.ok === false) throw new Error(`发送失败：${res.error ?? ''}`);

        await watch.ended;

        await waitForCondition(messageStorePort, () => readFinalText(sessionKey) !== null, {
          timeoutMs: FINALIZE_WAIT_MS,
        });
        const text = readFinalText(sessionKey);
        if (text === null || text.trim() === '') throw new Error(`${agentId} 这一轮没有产出正文`);
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
    } catch {
      // 人数超限之类在**发之前**就抛了 —— 一位都没发出去，停在第 0 位。
      setStoppedAt(speakers[0]?.agentId);
    } finally {
      runningRef.current = false;
      inFlightRef.current = null;
      setRunning(false);
    }
  }, []);

  return { running, turns, doneCount, stoppedAt, stoppedByUser, start, stop };
}
