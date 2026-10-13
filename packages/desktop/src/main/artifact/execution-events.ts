/**
 * ⭐ V3-artifact（2026-10-13/14，计划 §V3 101–113 行）：主进程侧的**执行事件生产者与出口**。
 *
 * 背景（V3 core 侧已就绪）：渲染层 `messageStore.applyExecutionEvents(sessionKey, events)`
 * 是唯一的折入入口；`@clawwork/core` 的 `execution-events` 已定义**交付 / 取消**两族的
 * 判别联合。V2 的事件在渲染层（dispatcher）产生；交付与停止的真实起点在**主进程**
 * （交付流水线 / stop ticket）—— 主进程就是这两族的"边界"，事件在这里**分配一次**
 * eventId 与 seq，经既有窗口广播送达渲染层，不在渲染层猜字段。
 *
 * 纪律（对齐 `execution-events.ts` 文件头与计划 V2/V3 红例）：
 *  - **无 run 归属（runId 空）不发**：归约层对 `runId === ''` 整条拒收（不归到前台），
 *    这里 fail-closed —— 宁可事件缺席，也不伪造一个归属（不猜 task/run）。
 *  - `eventId = main#<uuid>`（边界分配一次）；`seq` 按 session 单调递增。
 *  - `evidence: 'observed'`；`receivedAt` = 本进程此刻（源时间缺席就留空，不冒充）。
 *  - payload 类型**派生自 core 的 ExecutionEvent**（`Omit<..., keyof ExecutionEventBase>`）
 *    —— core 改 payload 时这里在调用点直接红，不靠人手对齐。
 */
import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import type { ExecutionEvent } from '@clawwork/core';

/**
 * 事件基座字段（core 的 `ExecutionEventBase` 没有从包口导出——按所有成员共有的键取；
 * core 改基座字段时这里在编译期就红）。
 */
type ExecutionEventBaseShape = Pick<
  ExecutionEvent,
  'schemaVersion' | 'eventId' | 'seq' | 'runId' | 'taskId' | 'source' | 'receivedAt' | 'evidence'
>;

/** 主进程可生产的执行事件族（交付 + 取消）。 */
export type MainExecutionEventInput = Omit<
  Extract<
    ExecutionEvent,
    {
      type:
        | 'delivery.started'
        | 'delivery.phase'
        | 'delivery.settled'
        | 'cancel.requested'
        | 'cancel.confirmed'
        | 'cancel.unconfirmed';
    }
  >,
  keyof ExecutionEventBaseShape
>;

/** 事件的归属身份：taskId/sessionKey 必备；runId 缺 = 不归属（不发）；gatewayId 缺记空串。 */
export interface MainExecutionIdentity {
  taskId: string;
  sessionKey: string;
  runId?: string;
  gatewayId?: string;
}

/** 主进程执行事件的广播通道（preload 订阅见报告里给 I 的 patch）。 */
export const EXECUTION_EVENTS_CHANNEL = 'artifact:execution-events';

export interface MainExecutionEventsPayload {
  sessionKey: string;
  events: ExecutionEvent[];
}

const seqBySession = new Map<string, number>();

/** 测试用：整表复位（模块级 seq 状态）。 */
export function resetMainExecutionEventsForTests(): void {
  seqBySession.clear();
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
    } catch (error) {
      console.warn('[execution-events] renderer unavailable:', error);
    }
  }
}

/**
 * 发送一批主进程执行事件。返回真正送出的条数（0 = 身份不足被拒发）。
 *
 * ⚠️ 这里**不是**"尽力而为的日志"：投递语义与 `delivery-activity` 的活动帧一致
 * （同一次广播、同一组窗口）；渲染层缺席/关闭时事件丢失是已知边界（投影可由后续
 * 事件补齐；终态不依赖单帧到达 —— 见 core 归约的"终态不回退"与 V 的交付门）。
 */
export function emitMainExecutionEvents(
  identity: MainExecutionIdentity,
  events: readonly MainExecutionEventInput[],
): number {
  const runId = identity.runId?.trim();
  if (events.length === 0) return 0;
  if (!identity.taskId || !identity.sessionKey) return 0;
  if (!runId) return 0; // 不归属的事件归约层拒收；不发（fail-closed，见文件头）。
  const gatewayId = identity.gatewayId?.trim() ?? '';
  const sent: ExecutionEvent[] = [];
  for (const event of events) {
    const seq = (seqBySession.get(identity.sessionKey) ?? -1) + 1;
    seqBySession.set(identity.sessionKey, seq);
    const base: ExecutionEventBaseShape = {
      schemaVersion: 1,
      eventId: `main#${randomUUID()}`,
      seq,
      runId,
      taskId: identity.taskId,
      source: { gatewayId, channel: 'local', event: 'main', derivedIndex: 0 },
      receivedAt: Date.now(),
      evidence: 'observed',
    };
    // 判别联合的展开：`event` 的每个成员都恰好是 ExecutionEvent 的一个成员
    //（类型由 Omit<Extract<...>> 派生）—— 这里的断言**按构造安全**，不是放宽。
    sent.push({ ...base, ...event } as ExecutionEvent);
  }
  broadcast(EXECUTION_EVENTS_CHANNEL, {
    sessionKey: identity.sessionKey,
    events: sent,
  } satisfies MainExecutionEventsPayload);
  return sent.length;
}
