import { describe, expect, it, vi } from 'vitest';
import { createGatewayDispatcher, type GatewayDispatcherDeps } from '../src/services/gateway-dispatcher.js';
import { createMessageStore } from '../src/stores/message-store.js';
import type { GatewayEvent, GatewayStatusEvent, RuntimeStatusEvent } from '../src/ports/gateway-transport.js';
import {
  FIXTURE,
  FIXTURE_TASK,
  approvalRequestedFrame,
  approvalResolvedFrame,
  chatDeltaFrame,
  chatFinalFrame,
  childToolStartFrame,
  heldResultFrame,
  thinkingAccumFrame,
  toolItemStartFrame,
  toolResultFrame,
  toolStartFrame,
} from './fixtures/native-gateway-frames.js';

/**
 * step 0 · 原生帧夹具行为钉（只动测试；不改产品行为）。
 *
 * 目的（05 §5 step 0 验收出口）：让 `start-before-approval`、**同 seq 多事件**、
 * "跳过也发 start"、子代理原生 run、thinking 无段身份等反例**在测试里显式存在**。
 *
 * 结构：每个用例 = 【真实 dispatcher + 真实 message-store】吃源码派生的最小原生帧投影
 * （见 fixtures 注释与 docs 06 证据表），把**现状行为**钉住；与 05 目标语义有差异处
 * 按 05 步骤标注；源码事实、单测覆盖与 UI/远端验收分开记录。
 */

type EventListener = (data: GatewayEvent) => void;

function createHarness() {
  let listener: EventListener | null = null;
  const store = createMessageStore({ persistMessage: vi.fn().mockResolvedValue(undefined) });
  const reportDebugEvent = vi.fn();
  const onSubagentCandidate = vi.fn();
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
    sendNotification: async () => {},
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
    syncSessionMessages: vi.fn(async () => {}),
    retrySyncPending: vi.fn(),
    onSubagentCandidate,
    onApprovalResolved,
  };

  const dispatcher = createGatewayDispatcher(deps);
  dispatcher.start();

  const emit = (frame: GatewayEvent) => listener?.(frame);
  /** 真实流序里工具帧发生在一轮 chat 流**之中**——先给一帧 delta 把祖先轮次立起来。 */
  const primeTurn = () => emit(chatDeltaFrame([{ type: 'text', text: '（回合开始）' }]));
  const turn = () => store.getState().activeTurnBySession[FIXTURE.taskSessionKey];
  const calls = () => turn()?.toolCalls ?? [];

  return { emit, primeTurn, turn, calls, store, reportDebugEvent, onSubagentCandidate, onApprovalResolved };
}

describe('T1 · tool start 先于准备；跳过/未执行也发 start（wire 无 executionStarted）', () => {
  it('start → running：卡片随 start 即显示运行中（现状）', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit(toolStartFrame());
    const call = h.calls().find((c) => c.id === 'tc-1')!;
    expect(call.status).toBe('running');
    expect(call.name).toBe('read');
    expect(call.args).toEqual({ path: 'a.txt' });
  });

  it('★ 证据核心：start 之后的 result(isError:true) 可能来自"从未执行"的调用（admission/steering/中止）', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit(toolStartFrame());
    // completeUnstartedToolCall 的线上投影：start（若未发过）→ result(isError:true)；
    // 真实上游对象里的 executionStarted:false **不会**出现在 wire 上（evidence: agent-core:1339-1360、
    // builtin-openclaw:3463-3475）。
    h.emit(toolResultFrame({ isError: true, result: { content: [{ type: 'text', text: 'Operation aborted' }] } }));
    const call = h.calls().find((c) => c.id === 'tc-1')!;
    expect(call.status).toBe('error');
    // 【step 1 靶点】05 要求区分 step.dispatched（进入处理）与 step.execution_confirmed（有执行证据）；
    // wire 未携带 executionStarted ⇒ 客户端现状把"未执行的收场"与"执行失败"一视同仁为 error。
    // 上层若要显式区分，须依赖源端补字段（独立工作，第四次复审 §2 同口径）。
  });

  it('item/start 的毫秒 startedAt 在已有记录和仅 item 建记录两路都转为精确 ISO', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit(toolStartFrame());
    h.emit(toolItemStartFrame({ title: 'read a.txt', startedAt: Date.parse('2026-10-13T08:00:00.000Z') }));
    const call = h.calls().find((c) => c.id === 'tc-1')!;
    expect(call.title).toBe('read a.txt');
    // runtime 用 Date.now()（builtin-openclaw:2904,2982）；不是 ISO string。
    // 这是上游调用开始时间，不代表底层命令已实际执行。
    expect(call.startedAt).toBe('2026-10-13T08:00:00.000Z');

    // 仅 item 帧（无 tool/start）也采用上游毫秒值。
    h.emit(
      toolItemStartFrame({
        toolCallId: 'tc-item-only',
        title: 'webSearch x',
        startedAt: Date.parse('2026-10-13T07:00:00.000Z'),
      }),
    );
    const second = h.calls().find((c) => c.id === 'tc-item-only')!;
    expect(second.startedAt).toBe('2026-10-13T07:00:00.000Z');
  });
});

describe('T2 · result(isError:false) 先于 approval/pending —— 不许提前 done', () => {
  it('held result（details.status=approval-pending）后状态保持 running，随后 approval 帧落 awaitingApproval', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit(toolStartFrame({ toolCallId: 'tc-exec-1', name: 'bash' }));
    h.emit(heldResultFrame());
    let call = h.calls().find((c) => c.id === 'tc-exec-1')!;
    expect(call.status, '被审批按住的 result 不得落 done（isExecHeldByApproval）').toBe('running');
    h.emit(approvalRequestedFrame());
    call = h.calls().find((c) => c.id === 'tc-exec-1')!;
    expect(call.status).toBe('awaitingApproval');
    // 【05 step 3】approval.requested 独立归并（approvalId），等待态不转圈文案。
  });

  it('原生 resolved 按 id 通知审批回调；不凭 allow 确认执行，随后 error 如实收场', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit(toolStartFrame({ toolCallId: 'tc-exec-1', name: 'bash' }));
    h.emit(heldResultFrame());
    h.emit(approvalRequestedFrame());
    expect(h.onApprovalResolved).not.toHaveBeenCalled();
    h.emit(approvalResolvedFrame('ap-1'));
    expect(h.onApprovalResolved).toHaveBeenCalledExactlyOnceWith('ap-1');
    let call = h.calls().find((c) => c.id === 'tc-exec-1')!;
    expect(call.status, 'allow ≠ 开始执行；resolved 回调不推进 tool 状态').toBe('awaitingApproval');
    // 允许后仍可能被中止（evidence: bash-tools:327-338 run-aborted），以真实结果帧收场：
    h.emit(
      toolResultFrame({
        toolCallId: 'tc-exec-1',
        name: 'bash',
        isError: true,
        result: { content: [{ type: 'text', text: 'Operation aborted' }] },
      }),
    );
    call = h.calls().find((c) => c.id === 'tc-exec-1')!;
    expect(call.status).toBe('error');
    // 【05 step 3】本例只证明 resolved 回调路由与 tool 状态；不证明弹窗/UI 或远端解除阻塞。
  });
});

describe('A1/S1 · 同 seq 多事件与子代理候选路由（连接级 seq 隔离另待测）', () => {
  it('chat delta 与 final 复用同一 seq ⇒ 两帧都生效（final 照常收口）', () => {
    const h = createHarness();
    h.emit(chatDeltaFrame([{ type: 'text', text: '答案前半' }], { seq: 7 }));
    expect(h.turn()?.streamingText, 'final 不能掩盖 delta 被吞').toBe('答案前半');
    expect(h.turn()?.finalized).toBe(false);
    h.emit(chatFinalFrame([{ type: 'text', text: '答案前半，完整收尾。' }], { seq: 7, stopReason: 'end_turn' }));
    const t = h.turn()!;
    expect(t.finalized).toBe(true);
    expect(t.content).toBe('答案前半，完整收尾。');
    // 现状：客户端不消费 seq（全链路只透传）⇒ 无同 seq 误去重；05 目标：身份不用 runId:seq（外层按连接计数）。
  });

  it('子会话帧（childRunId）不改写父会话的 run 绑定', () => {
    const h = createHarness();
    h.primeTurn();
    const before = h.turn()!;
    h.emit(childToolStartFrame());
    const after = h.turn()!;
    expect(after, '父轮次对象未被子会话帧触碰').toBe(before);
    expect(after.runId).toBe(FIXTURE.parentRunId);
    expect(h.onSubagentCandidate).toHaveBeenCalledExactlyOnceWith(FIXTURE.childSessionKey, FIXTURE.gatewayId);
    // 【05 step 2】候选回调只带 session/gateway，本例不证明完整 child run 树或 UI 归属。
  });
});

describe('K1 · thinking 外发无段身份（text/delta 两条字段，无 segment/blockId）', () => {
  it('累计 text 合并依现状语义（与 chat 通道同一分段契约）', () => {
    const h = createHarness();
    h.primeTurn();
    h.emit(thinkingAccumFrame('思考一'));
    h.emit(thinkingAccumFrame('思考一继续', '继续'));
    expect(h.turn()!.streamingThinking).toBe('思考一继续');
    // 【独立源端工作，非 step 1】跨通道"回声 vs 新段同文"的无损判据在源端（无段身份字段可借）；
    // 本用例只钉"无身份字段下的现状合并"，不表达无法无损消歧的部分。
  });
});
