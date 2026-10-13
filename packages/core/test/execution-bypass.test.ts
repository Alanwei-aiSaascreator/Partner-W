import { describe, expect, it, vi } from 'vitest';
import { createGatewayDispatcher, type GatewayDispatcherDeps } from '../src/services/gateway-dispatcher.js';
import { createMessageStore } from '../src/stores/message-store.js';
import type { GatewayEvent, GatewayStatusEvent, RuntimeStatusEvent } from '../src/ports/gateway-transport.js';
import type { ExecutionProjection } from '../src/stores/execution-projection.js';
import {
  FIXTURE,
  FIXTURE_TASK,
  chatDeltaFrame,
  chatFinalFrame,
  childToolStartFrame,
  heldResultFrame,
  thinkingAccumFrame,
  toolResultFrame,
  toolStartFrame,
} from './fixtures/native-gateway-frames.js';

/**
 * V2（2026-10-13 集中整改 step 2）· 旁路映射（真实 dispatcher + 真实 store）。
 *
 * 验收口径（05 §5 step 2 / R1–R8）：原生夹具经真实工厂 + store，**每帧中间态与最终态**
 * 都断言；旁路映射在已有归属/陈旧 run 守卫**之后** —— 旧 run 晚包不写新 run、cron
 * 无任务归属不归到前台。V2 无新增渲染订阅 ⇒ App 根思考风暴提交数不受影响（集成面另验）。
 */

type EventListener = (data: GatewayEvent) => void;

function createHarness(options: { lookupChildTasks?: boolean } = {}) {
  let listener: EventListener | null = null;
  const store = createMessageStore({ persistMessage: vi.fn().mockResolvedValue(undefined) });
  const reportDebugEvent = vi.fn();
  const onSubagentCandidate = vi.fn();
  const syncSessionMessages = vi.fn(async () => {});
  const sendNotification = vi.fn(async () => {});
  const onApprovalResolved = vi.fn();

  const deps: GatewayDispatcherDeps = {
    gateway: {
      onGatewayEvent: (cb: EventListener) => {
        listener = cb;
        return () => {
          listener = null;
        };
      },
      onGatewayStatus: (_cb: (status: GatewayStatusEvent) => void) => () => {},
      onRuntimeStatus: (_cb: (status: RuntimeStatusEvent) => void) => () => {},
      gatewayStatus: async () => ({}),
      listGateways: async () => [],
      listModels: async () => ({ ok: true, result: {} }),
      listAgents: async () => ({ ok: true, result: { defaultId: 'main', agents: [{ id: 'main' }] } }),
      getToolsCatalog: async () => ({ ok: true, result: {} }),
      getSkillsStatus: async () => ({ ok: true, result: {} }),
      listCommands: async () => ({ ok: true, result: {} }),
      chatHistory: async () => ({ ok: true, result: {} }),
      abortChat: async () => ({ ok: true }),
      patchSession: async () => ({ ok: true }),
      listSessionsBySpawner: async () => ({ ok: true }),
      syncSessions: async () => ({ ok: true }),
      sendMessage: async () => ({ ok: true }),
      createSession: async () => ({ ok: true }),
    } as unknown as GatewayDispatcherDeps['gateway'],
    getSettings: async () => null,
    sendNotification,
    getTaskStore: () =>
      ({
        tasks: [FIXTURE_TASK],
        updateTaskTitle: vi.fn(),
      }) as unknown as ReturnType<GatewayDispatcherDeps['getTaskStore']>,
    getMessageStore: () => store.getState() as unknown as ReturnType<GatewayDispatcherDeps['getMessageStore']>,
    getActiveTaskId: () => null,
    markUnread: vi.fn(),
    setGatewayStatusByGateway: vi.fn(),
    setGatewayVersion: vi.fn(),
    setGatewayMaxPayloadByGateway: vi.fn(),
    setGatewayReconnectInfo: vi.fn(),
    setRuntimeBootstrapFailure: vi.fn(),
    setDefaultGatewayId: vi.fn(),
    setGatewayInfoMap: vi.fn(),
    setGatewaysLoaded: vi.fn(),
    getGatewayInfoMap: () => ({}),
    setModelCatalogForGateway: vi.fn(),
    setModelCatalogFailureForGateway: vi.fn(),
    setAgentCatalogForGateway: vi.fn(),
    setToolsCatalogForGateway: vi.fn(),
    setEffectiveToolsState: vi.fn(),
    setSkillsStatusForGateway: vi.fn(),
    setCommandCatalogForGateway: vi.fn(),
    onToast: vi.fn(),
    translate: (key: string) => key,
    isWindowFocused: () => true,
    reportDebugEvent,
    hydrateFromLocal: async () => {},
    syncFromGateway: async () => {},
    syncSessionMessages,
    retrySyncPending: vi.fn(),
    onSubagentCandidate,
    onApprovalResolved,
    // 后台合法任务（performer 子会话 ⇒ 已知任务）的归属查询。
    ...(options.lookupChildTasks
      ? {
          lookupTaskIdBySubagentKey: (key: string): string | undefined =>
            key.startsWith('agent:worker:') ? FIXTURE.taskId : undefined,
        }
      : {}),
  };

  const dispatcher = createGatewayDispatcher(deps);
  dispatcher.start();

  const emit = (frame: GatewayEvent) => listener?.(frame);
  const primeTurn = () => emit(chatDeltaFrame([{ type: 'text', text: '（回合开始）' }]));
  const calls = () => store.getState().activeTurnBySession[FIXTURE.taskSessionKey]?.toolCalls ?? [];
  const projection = (): ExecutionProjection | undefined => store.getState().executionBySession[FIXTURE.taskSessionKey];
  const stepStates = (): string[] => Object.values(projection()?.steps ?? {}).map((step) => step.state);

  return {
    emit,
    primeTurn,
    calls,
    projection,
    stepStates,
    store,
    onSubagentCandidate,
    reportDebugEvent,
    syncSessionMessages,
    sendNotification,
    onApprovalResolved,
  };
}

describe('V2 · 旁路映射：真实 dispatcher + 真实 store', () => {
  it('⭐ 逐帧中间态与最终态：声明 → dispatched → done 全部落进执行投影', () => {
    const h = createHarness();
    h.primeTurn();

    h.emit(chatDeltaFrame([{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: 'a.txt' } }]));
    expect(h.stepStates()).toEqual(['declared']);
    expect(h.calls()[0].status, '卡片状态 = 声明（V1 语义保持）').toBe('declared');

    h.emit(toolStartFrame());
    expect(h.stepStates()).toEqual(['dispatched']);
    expect(h.calls()[0].status, 'tool/start ⇒ dispatched（不再伪装执行中）').toBe('dispatched');

    h.emit(toolResultFrame());
    expect(h.stepStates()).toEqual(['done']);
    expect(h.calls()[0].status).toBe('done');
  });

  it('⭐ 被审批按住的 result 直接落 awaitingApproval（不闪"进行中"、不提前 done）', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit(toolStartFrame({ toolCallId: 'tc-exec-1', name: 'bash' }));
    h.emit(heldResultFrame());

    expect(h.calls()[0].status, 'held result ⇒ awaitingApproval（V2 白名单：旧行为 running）').toBe('awaitingApproval');
    expect(h.stepStates()).toEqual(['awaitingApproval']);

    h.emit(
      toolResultFrame({
        toolCallId: 'tc-exec-1',
        name: 'bash',
        isError: true,
        result: { content: [{ type: 'text', text: 'aborted' }] },
      }),
    );
    expect(h.calls()[0].status).toBe('error');
    expect(h.stepStates()).toEqual(['error']);
  });

  it('⭐ model.ended 之后未回报步骤 ⇒ unreported；同 run 真实结果补正', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit(toolStartFrame());
    h.emit(chatFinalFrame([{ type: 'text', text: '完成。' }]));

    expect(h.stepStates(), '定稿后仍缺结果 ⇒ 投影 unreported').toEqual(['unreported']);

    h.emit(toolResultFrame());
    expect(h.stepStates(), '晚到真实结果补正（同 run）').toEqual(['done']);
  });

  it('⭐ 旧 run 晚包不写新 run：新 run 已绑定后，旧 run 的工具帧被守卫拦下、投影不动', () => {
    const h = createHarness();
    const lifecycle = (runId: string): GatewayEvent =>
      ({
        event: 'agent',
        gatewayId: FIXTURE.gatewayId,
        payload: { sessionKey: FIXTURE.taskSessionKey, runId, stream: 'lifecycle', data: { phase: 'start' } },
      }) as GatewayEvent;

    h.primeTurn();
    h.emit(lifecycle('run-old'));
    h.emit(toolStartFrame({ runId: 'run-old' }));
    expect(h.stepStates()).toEqual(['dispatched']);
    expect(h.projection()?.runId).toBe('run-old');

    // 新 run 通过 lifecycle start 绑定（bindRun 把 run-old 退役、随 clearActiveTurn
    // 清掉旧 scope 投影 —— 换 run 即换 scope）
    h.emit(lifecycle('run-new'));
    expect(h.projection()?.runId).toBe('run-new');
    expect(h.stepStates(), '新 run 尚无工具活动').toEqual([]);

    // 旧 run 的 result 迟到 ⇒ acceptsRun 拒绝（retired）⇒ 只走 canonical 同步，
    // 不进新 run 的执行投影（"旧 run 晚包不写新 run"）
    h.emit(toolResultFrame({ runId: 'run-old', isError: true, result: { content: [{ type: 'text', text: 'late' }] } }));
    expect(h.projection()?.runId, '投影仍属于新 run、未被晚包改写').toBe('run-new');
    expect(h.stepStates()).toEqual([]);
    expect(h.syncSessionMessages, '晚包按既有 reconcile 路径走 canonical 同步').toHaveBeenCalledWith(
      FIXTURE.taskId,
      FIXTURE.taskSessionKey,
      expect.objectContaining({ runId: 'run-old' }),
    );
  });

  it('⭐ cron 无任务归属不归到前台：未知任务帧在映射前就被丢弃、投影不存在', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit({
      event: 'agent',
      gatewayId: FIXTURE.gatewayId,
      payload: {
        sessionKey: 'agent:rongying-family:cron:00000000-0000-4000-8000-000000000000',
        runId: 'run-cron',
        stream: 'tool',
        data: { phase: 'start', name: 'dir', toolCallId: 'tc-cron' },
      },
    } as GatewayEvent);

    expect(h.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.dropped.invalid_task' }),
    );
    expect(h.projection(), 'cron 帧不得给主会话造出投影').toBeUndefined();
  });

  it('⭐ 后台合法任务照收：performer 子会话帧归属任务、按 child run 隔离 step', () => {
    const h = createHarness({ lookupChildTasks: true });
    h.primeTurn();
    h.emit(toolStartFrame({ toolCallId: 'tc-shared' }));
    // 子会话自己的 run：相同 toolCallId、不同 nativeSession/nativeRun ⇒ 各自会话投影、不串台
    h.emit(childToolStartFrame('tc-shared'));

    const parentSteps = Object.values(h.projection()?.steps ?? {});
    expect(parentSteps, '父会话投影只有父 run 的那条').toHaveLength(1);
    expect(parentSteps[0].stepKey).toContain(FIXTURE.parentRunId);
    expect(parentSteps[0].state).toBe('dispatched');

    const childProjection = h.store.getState().executionBySession[FIXTURE.childSessionKey];
    const childSteps = Object.values(childProjection?.steps ?? {});
    expect(childSteps, '子会话投影独立存在、runId=child').toHaveLength(1);
    expect(childSteps[0].stepKey).toContain(FIXTURE.childRunId);
    expect(childProjection?.runId).toBe(FIXTURE.childRunId);
  });

  it('⭐ 主/审批连接相同 seq 不碰撞：channel/connectionEpoch 由 transport meta 带入事件源', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit({
      ...toolStartFrame({ toolCallId: 'tc-main' }),
      seq: 9,
      meta: { channel: 'main', connectionEpoch: 'ep-1' },
    });
    h.emit({
      ...toolStartFrame({ toolCallId: 'tc-approval', name: 'bash' }),
      seq: 9,
      meta: { channel: 'approval', connectionEpoch: 'ep-2' },
    });

    const steps = Object.values(h.projection()?.steps ?? {});
    expect(steps).toHaveLength(2);
    // 重连（新 epoch）同样不碰撞
    h.emit({
      ...toolStartFrame({ toolCallId: 'tc-reconnect', name: 'ls' }),
      seq: 9,
      meta: { channel: 'main', connectionEpoch: 'ep-3' },
    });
    expect(Object.values(h.projection()?.steps ?? {})).toHaveLength(3);
  });

  it('⭐ thinking 帧不改投影（正文/思考仍走原逐块 helper，白名单）', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit(thinkingAccumFrame('思考一'));
    expect(h.projection()?.steps ?? {}).toEqual({});
  });
});

/**
 * V3（2026-10-13 step 3）· 审批/交付门（真实 dispatcher + store 接线，不只纯函数）。
 */
describe('V3 · 审批投影接线', () => {
  const approvalFrame = (phase: string, approvalId: string, status?: string): GatewayEvent =>
    ({
      event: 'agent',
      gatewayId: FIXTURE.gatewayId,
      payload: {
        sessionKey: FIXTURE.taskSessionKey,
        runId: FIXTURE.parentRunId,
        stream: 'approval',
        data: { phase, kind: 'exec', status, toolCallId: 'tc-exec-1', approvalId },
      },
    }) as GatewayEvent;

  it('⭐ result(held)→requested→deny→abort：审批投影逐帧、allow 不推进步骤、真结果收场', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit(toolStartFrame({ toolCallId: 'tc-exec-1', name: 'bash' }));
    h.emit(heldResultFrame());

    h.emit(approvalFrame('requested', 'ap-1', 'pending'));
    expect(Object.values(h.projection()?.approvals ?? {})[0]?.state).toBe('requested');
    expect(h.calls()[0].status, '等待批准的工具卡（V2 语义保持）').toBe('awaitingApproval');

    h.emit(approvalFrame('resolved', 'ap-1', 'denied'));
    expect(Object.values(h.projection()?.approvals ?? {})[0]?.state).toBe('denied');
    // 既有语义：approval 流 denied ⇒ 工具卡落 error（"被拦下 = 没跑成"，
    // 由 handleAgentApprovalStream 收场）——投影按 approvalId 独立记录终态。
    expect(h.calls()[0].status, '拒绝后卡片如实收场为 error（既有收场语义）').toBe('error');

    h.emit(
      toolResultFrame({
        toolCallId: 'tc-exec-1',
        name: 'bash',
        isError: true,
        result: { content: [{ type: 'text', text: 'aborted' }] },
      }),
    );
    expect(h.calls()[0].status).toBe('error');
    expect(Object.values(h.projection()?.steps ?? {})[0]?.state, '步骤终态随真结果落 error').toBe('error');
  });

  it('⭐ 两个审批并行：解决一个不清另一个（投影按 approvalId 独立）', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit(toolStartFrame({ toolCallId: 'tc-exec-1', name: 'bash' }));
    h.emit(approvalFrame('requested', 'ap-1', 'pending'));
    h.emit(approvalFrame('requested', 'ap-2', 'pending'));
    h.emit(approvalFrame('resolved', 'ap-1', 'allow-once'));

    const states = Object.values(h.projection()?.approvals ?? {}).sort((a, b) =>
      a.approvalId.localeCompare(b.approvalId),
    );
    expect(states.map((a) => a.state)).toEqual(['resolved', 'requested']);
  });

  it('⭐ 顶层 exec.approval.resolved ⇒ 类型化结论（gateway/decision/request）且投影落账', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit({
      event: 'exec.approval.resolved',
      gatewayId: FIXTURE.gatewayId,
      payload: {
        id: 'ap-9',
        decision: 'allow-once',
        resolvedBy: null,
        ts: Date.parse('2026-10-13T00:00:01.000Z'),
        request: {
          command: 'echo hi',
          sessionKey: FIXTURE.taskSessionKey,
          runId: FIXTURE.parentRunId,
          toolCallId: 'tc-exec-1',
        },
      },
    } as GatewayEvent);

    expect(h.onApprovalResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ap-9',
        gatewayId: FIXTURE.gatewayId,
        decision: 'allow-once',
        request: expect.objectContaining({
          sessionKey: FIXTURE.taskSessionKey,
          runId: FIXTURE.parentRunId,
          toolCallId: 'tc-exec-1',
        }),
      }),
    );
    expect(Object.values(h.projection()?.approvals ?? {})[0]).toMatchObject({
      approvalId: 'ap-9',
      state: 'resolved',
      decision: 'allow-once',
    });
  });
});

describe('V3 · 交付完成门（chat.final 不再直接弹"任务完成"）', () => {
  const deliveryEvent = (over: Record<string, unknown>): unknown => ({
    schemaVersion: 1,
    eventId: over.eventId,
    seq: over.seq,
    runId: FIXTURE.parentRunId,
    taskId: FIXTURE.taskId,
    source: {
      gatewayId: FIXTURE.gatewayId,
      channel: 'local',
      nativeSessionKey: FIXTURE.taskSessionKey,
      nativeRunId: FIXTURE.parentRunId,
      event: 'local',
      derivedIndex: 0,
    },
    evidence: 'observed',
    receivedAt: over.receivedAt,
    type: over.type,
    payload: over.payload,
  });

  it('⭐ 活动作业未结算 ⇒ chat.final 不弹任务完成（统一留痕延后）', async () => {
    const h = createHarness();
    h.primeTurn();

    // P 侧把可信生成请求折进投影（delivery.started）后，chat.final 的通知被交付门拦下
    h.store.getState().applyExecutionEvents(FIXTURE.taskSessionKey, [
      deliveryEvent({
        eventId: 'f#0',
        seq: 0,
        receivedAt: 1,
        type: 'delivery.started',
        payload: { operationId: 'op-video', kind: 'video' },
      }),
    ] as never);

    h.emit(chatFinalFrame([{ type: 'text', text: '生成中…' }]));
    expect(h.sendNotification).not.toHaveBeenCalledWith(expect.objectContaining({ body: FIXTURE.taskId }));
    expect(h.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.chat.task_complete_deferred' }),
    );

    // 交付结算（P 侧证据）到达后投影 settled —— 通知由 P 的结算路径发（本包不再发）
    h.store.getState().applyExecutionEvents(FIXTURE.taskSessionKey, [
      deliveryEvent({
        eventId: 'f#1',
        seq: 1,
        receivedAt: 2,
        type: 'delivery.settled',
        payload: { operationId: 'op-video', outcome: 'complete' },
      }),
    ] as never);
    expect(h.projection()?.delivery).toMatchObject({ phase: 'settled', outcome: 'complete' });
  });

  it('⭐ V4 修正：settled 之后新 operation ⇒ 交付门重新拦截 chat.final 通知', async () => {
    const h = createHarness();
    h.primeTurn();
    h.store.getState().applyExecutionEvents(FIXTURE.taskSessionKey, [
      deliveryEvent({
        eventId: 'f#0',
        seq: 0,
        receivedAt: 1,
        type: 'delivery.started',
        payload: { operationId: 'op-1', kind: 'ppt' },
      }),
      deliveryEvent({
        eventId: 'f#1',
        seq: 1,
        receivedAt: 2,
        type: 'delivery.settled',
        payload: { operationId: 'op-1', outcome: 'complete' },
      }),
    ] as never);
    expect(h.projection()?.delivery.phase).toBe('settled');

    // 同 run 后到的新作业
    h.store.getState().applyExecutionEvents(FIXTURE.taskSessionKey, [
      deliveryEvent({
        eventId: 'f#2',
        seq: 2,
        receivedAt: 3,
        type: 'delivery.started',
        payload: { operationId: 'op-2', kind: 'video' },
      }),
    ] as never);
    expect(h.projection()?.delivery.phase, '新 operation 未结算 ⇒ 回到交付中').toBe('pending');

    h.emit(chatFinalFrame([{ type: 'text', text: '主体完成，视频生成中…' }]));
    await vi.waitFor(() => expect(h.sendNotification).not.toHaveBeenCalled());
    expect(h.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.chat.task_complete_deferred' }),
    );
  });

  it('⭐ R5：普通聊天 final 也不再直接弹通知 —— 一律留痕延后，由统一资格（封口后）发', async () => {
    const h = createHarness();
    h.primeTurn();
    h.emit(chatFinalFrame([{ type: 'text', text: '答案是 42。' }]));
    // R5（2026-10-14）：final 当场看到"无 operation"**不能证明**这是普通聊天（登记经异步
    // 最终交付路径才到）—— dispatcher 不再调 maybeNotify；现场完成通知由 renderer 的
    // `useDeliverySettlementNotification` 在**封口后**（模型结束 + 轮次关闭）按统一资格发。
    await vi.waitFor(() =>
      expect(h.reportDebugEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'renderer.chat.task_complete_deferred' }),
      ),
    );
    expect(h.sendNotification, 'dispatcher 侧一发不发（通知只有一个出口）').not.toHaveBeenCalled();
  });
});
