import { describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '../src/stores/message-store.js';
import type { ExecutionEvent } from '../src/protocol/execution-events.js';

/**
 * 2026-10-14 集中修复批（V owner）· R2 的 core 侧半边：
 * **显式 hydrate 模式**（恢复应用：不重新 persist、不触发业务操作）+
 * 恢复应用前的 scope/epoch 复核窄接口（`canHydrateExecution`）。
 *
 * hook/IPC 接线由 I 做（本文件只钉 core 语义）。
 */

const SK = 'agent:main:clawwork:task:task-1';

function dispatched(runId: string, eventId: string, over: Partial<ExecutionEvent> = {}): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId,
    seq: 0,
    runId,
    taskId: 'task-1',
    source: {
      gatewayId: 'gw-1',
      channel: 'main',
      nativeSessionKey: SK,
      nativeRunId: runId,
      event: 'agent',
      stream: 'tool',
      derivedIndex: 0,
    },
    evidence: 'observed',
    receivedAt: 1_000,
    type: 'step.dispatched',
    payload: { toolCallId: 'tc-1', name: 'read', phase: 'start' },
    ...over,
  } as ExecutionEvent;
}

function store() {
  const persistMessage = vi.fn(async () => ({ ok: true }));
  const persistExecutionHistory = vi.fn();
  const instance = createMessageStore({ persistMessage, persistExecutionHistory });
  return { instance, persistMessage, persistExecutionHistory };
}

describe('R2 · hydrate（恢复）模式', () => {
  it('⭐ hydrate 不落盘：恢复应用绝不重新 persist 到执行历史 writer', () => {
    const { instance, persistExecutionHistory } = store();
    instance.getState().applyExecutionEvents(SK, [dispatched('run-old', 'f1#0')], { mode: 'hydrate' });
    expect(instance.getState().executionBySession[SK]?.runId).toBe('run-old');
    expect(persistExecutionHistory, 'hydrate 不得回写').not.toHaveBeenCalled();

    // live 模式照旧落盘（对照）：真正推进状态的事件才被接受、才交给 writer
    instance.getState().applyExecutionEvents(
      SK,
      [
        dispatched('run-old', 'f2#0', {
          seq: 1,
          type: 'step.result',
          payload: { toolCallId: 'tc-1', name: 'read', isError: false },
        }),
      ],
      { mode: 'live' },
    );
    expect(persistExecutionHistory).toHaveBeenCalledTimes(1);
  });

  it('⭐ 重复恢复幂等：同一批历史应用两次，投影引用不变、条目不翻倍', () => {
    const { instance } = store();
    const records = [
      dispatched('run-old', 'f1#0', { seq: 0 }),
      dispatched('run-old', 'f2#0', {
        seq: 1,
        payload: { toolCallId: 'tc-2', name: 'read', phase: 'start' },
      }),
    ];
    instance.getState().applyExecutionEvents(SK, records, { mode: 'hydrate' });
    const first = instance.getState().executionBySession[SK];
    expect(Object.values(first?.steps ?? {})).toHaveLength(2);

    instance.getState().applyExecutionEvents(SK, records, { mode: 'hydrate' });
    const second = instance.getState().executionBySession[SK];
    expect(second, '同证据重放不翻新投影（引用不变）').toBe(first);
  });

  it('⭐ 跨 scope 拒绝：现场已有新轮时旧历史不灌入（投影与 activeTurn 双重守卫）', () => {
    const { instance } = store();
    instance.getState().applyExecutionEvents(SK, [dispatched('run-new', 'n#0')]);

    expect(instance.getState().canHydrateExecution(SK, 'run-old'), '投影已属新 run ⇒ 拒').toBe(false);
    expect(instance.getState().canHydrateExecution(SK, 'run-new'), '同 run 恢复仍允许').toBe(true);

    instance.getState().applyExecutionEvents(SK, [dispatched('run-old', 'o#0')], { mode: 'hydrate' });
    const projection = instance.getState().executionBySession[SK];
    expect(projection?.runId, '旧历史不得替换现场新 run').toBe('run-new');
    expect(Object.values(projection?.steps ?? {}).length, '旧历史的事件不得混进新轮投影').toBe(1);
  });

  it('⭐ 现场新轮（activeTurn 已绑定、投影尚未建立）时旧历史被拒', () => {
    const { instance } = store();
    instance.getState().bindActiveRun(SK, 'run-new');
    instance.getState().appendStreamDelta(SK, 'new answer');

    expect(instance.getState().canHydrateExecution(SK, 'run-old')).toBe(false);
    instance.getState().applyExecutionEvents(SK, [dispatched('run-old', 'o#0')], { mode: 'hydrate' });
    expect(instance.getState().executionBySession[SK], '现场新轮期间不建立旧 run 投影').toBeUndefined();
  });

  it('⭐ hydrate 不触发业务操作：不落消息、不改 processing', () => {
    const { instance, persistMessage } = store();
    instance.getState().applyExecutionEvents(SK, [dispatched('run-old', 'f1#0')], { mode: 'hydrate' });
    expect(persistMessage).not.toHaveBeenCalled();
    expect(instance.getState().processingBySession.size).toBe(0);
    expect(Object.keys(instance.getState().messagesByTask)).toHaveLength(0);
  });
});
