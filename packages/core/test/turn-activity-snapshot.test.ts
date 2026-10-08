import { describe, expect, it, vi } from 'vitest';
import { createGatewayDispatcher, type GatewayDispatcherDeps } from '../src/services/gateway-dispatcher.js';
import { createMessageStore } from '../src/stores/message-store.js';
import type { GatewayEvent, GatewayStatusEvent, RuntimeStatusEvent } from '../src/ports/gateway-transport.js';

/**
 * R1 回归（2026-10-08 总审）：**累计快照不得被当成"新活动"**。
 *
 * dispatcher 对 chat delta 帧固定按「正文 → 思考 → 工具」调用 store，而这个顺序是
 * **函数执行顺序**、不是快照里内容的真实顺序：旧 thinking 会被原样重发。若写入端
 * 无条件 bump 活动元数据，就会：
 *   - 正文期间相位被拨回 thinking（扫光/展开不复位）；
 *   - 每帧伪造"新思考段"（段号 +1）⇒ 用户手动折叠被反复复位；
 *   - 工具之后真正的思考反而被随后的重复工具快照盖成 tools。
 *
 * 本文件用**真实 dispatcher + 真实 message-store**（无 mock store）钉住：只有
 * **内容真的变化**才算活动；重复/未变化的快照一律不更新相位与段号。
 */

type EventListener = (data: GatewayEvent) => void;

const TASK = {
  id: 'task-1',
  title: 'Task',
  gatewayId: 'gw-1',
  sessionKey: 'agent:main:clawwork:task:task-1',
};

const SK = TASK.sessionKey;

function createHarness() {
  let listener: EventListener | null = null;

  const store = createMessageStore({ persistMessage: vi.fn().mockResolvedValue(undefined) });

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
        tasks: [TASK],
        updateTaskTitle: vi.fn(),
      }) as unknown as ReturnType<GatewayDispatcherDeps['getTaskStore']>,
    // 与生产接线一致（platform/index.ts:147 / useGatewayDispatcherSetup.ts:89）：
    // dispatcher 拿到的是 **state 对象**（字段 + 动作都在上面），不是 zustand 的 StoreApi。
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
    reportDebugEvent: vi.fn(),
    hydrateFromLocal: async () => {},
    syncFromGateway: async () => {},
    syncSessionMessages: vi.fn(async () => {}),
    retrySyncPending: vi.fn(),
  };

  const dispatcher = createGatewayDispatcher(deps);
  dispatcher.start();

  function emitChatDelta(blocks: unknown[], runId = 'run-1'): void {
    listener?.({
      event: 'chat',
      gatewayId: 'gw-1',
      payload: {
        sessionKey: SK,
        state: 'delta',
        runId,
        message: { content: blocks },
      },
    } satisfies GatewayEvent);
  }

  const activity = () => store.getState().activeTurnBySession[SK]?.activity;

  return { emitChatDelta, activity, store };
}

const thinking = (text: string) => ({ type: 'thinking', thinking: text });
const text = (t: string) => ({ type: 'text', text: t });
const toolCall = (id: string, name = 'read') => ({ type: 'toolCall', id, name, arguments: { path: 'a.txt' } });

describe('R1：累计快照与真实活动（真实 dispatcher + 真实 store）', () => {
  it('首帧只有 thinking ⇒ thinking，段 1', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('先看目录')]);
    expect(h.activity()).toEqual({ kind: 'thinking', revision: 1, thinkingSegment: 1 });
  });

  it('⭐ 快照 [旧 thinking 原样重发, 新 text] ⇒ output；段号保持 1（不得拨回 thinking/开新段）', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('先看目录')]);
    h.emitChatDelta([thinking('先看目录'), text('答案第一段')]);
    const a = h.activity()!;
    expect(a.kind, '旧思考快照重复投递不得更新相位').toBe('output');
    expect(a.thinkingSegment, '重复快照不得伪造新思考段').toBe(1);
  });

  it('同一旧 thinking 随 text 持续增长 ⇒ 一直 output，段号不动', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('先看目录')]);
    h.emitChatDelta([thinking('先看目录'), text('答')]);
    h.emitChatDelta([thinking('先看目录'), text('答案')]);
    h.emitChatDelta([thinking('先看目录'), text('答案来了')]);
    const a = h.activity()!;
    expect(a.kind).toBe('output');
    expect(a.thinkingSegment).toBe(1);
  });

  it('⭐ 思考→工具→再次思考：重复 toolCall 快照不得盖住新思考；真实新思考 = 新段', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('先看目录')]);
    expect(h.activity()!.thinkingSegment).toBe(1);
    h.emitChatDelta([toolCall('tc-1')]);
    expect(h.activity()!.kind).toBe('tools');
    // 同一工具（同 id/参数）原样重发 + 真正新增的思考：最后处理的是工具，但它没变化 ⇒ 不算活动
    h.emitChatDelta([toolCall('tc-1'), thinking('换个思路')]);
    const a = h.activity()!;
    expect(a.kind, '没变化的工具快照不是"最新活动"').toBe('thinking');
    expect(a.thinkingSegment, '工具之后真正的思考 = 新段（复位用户折叠的依据）').toBe(2);
  });

  it('纯思考快照重复（内容一字不变）⇒ 不更新活动（revision/段号都不动）', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('想一下')]);
    const before = h.activity()!;
    h.emitChatDelta([thinking('想一下')]);
    expect(h.activity()).toEqual(before);
  });

  it('工具状态真的变化 ⇒ tools（变更检测不能把真变化吃掉）', () => {
    const h = createHarness();
    h.emitChatDelta([toolCall('tc-1')]);
    const rev = h.activity()!.revision;
    h.emitChatDelta([{ type: 'toolCall', id: 'tc-2', name: 'write', arguments: { path: 'b.txt' } }]);
    expect(h.activity()!.kind).toBe('tools');
    expect(h.activity()!.revision).toBeGreaterThan(rev);
  });
});
