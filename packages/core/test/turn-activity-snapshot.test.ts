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

/**
 * BUG-075 r3 回归（2026-10-13 第三次独立复审反例）：**帧内 [新工具, 新思考]**。
 *
 * dispatcher 此前固定按「正文→思考→工具」写入，而 `upsertToolCall` 的**新工具 id =
 * 思考段边界**（seal 当前段）。`[工具, 思考]` 帧里，工具之后的新思考被先写入、随即被
 * 工具 upsert 错误归档 ⇒ 下一次累计快照被当新段追加：
 *   [first thought] → [tc-9, after tool] → [tc-9(回显), after tool grows]
 *   实际 first thought\n\nafter tool\n\nafter tool grows；
 *   预期 first thought\n\nafter tool grows。
 * 修法：思考/工具两类写入**按 content blocks 真实顺序交错**（正文保持原位；
 * 不能只交换成「先工具后思考」——那会弄错 `[思考, 工具]`）。
 */
describe('BUG-075 r3：帧内写入顺序 = content blocks 真实顺序', () => {
  const turnText = (h: ReturnType<typeof createHarness>) =>
    h.store.getState().activeTurnBySession[SK]!.streamingThinking;

  it('⭐ [first thought] → [tc-9, after tool] → [tc-9, after tool grows] ⇒ 不得重复保留旧段', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('first thought')]);
    h.emitChatDelta([toolCall('tc-9'), thinking('after tool')]);
    expect(turnText(h)).toBe('first thought\n\nafter tool');
    h.emitChatDelta([toolCall('tc-9'), thinking('after tool grows')]);
    expect(turnText(h), '工具后的新思考应作为当前段继续增长，而不是旧段重复').toBe('first thought\n\nafter tool grows');
  });

  it('对照：[思考, 工具] 同帧顺序不受影响；工具后的新思考照常落新段', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('先看目录'), toolCall('tc-1')]);
    expect(turnText(h)).toBe('先看目录');
    h.emitChatDelta([toolCall('tc-1'), thinking('换思路')]);
    expect(turnText(h)).toBe('先看目录\n\n换思路');
    h.emitChatDelta([toolCall('tc-1'), thinking('换思路继续')]);
    expect(turnText(h)).toBe('先看目录\n\n换思路继续');
  });

  it('序列覆盖：[思考, 工具] → [工具回显, 思考增长] 双通道回声不重复', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('第一段'), toolCall('tc-2')]);
    h.emitChatDelta([toolCall('tc-2'), thinking('第一段'), text('答案')]);
    // 回声：工具没变化、思考与刚归档段同文 ⇒ 都不算活动
    h.emitChatDelta([toolCall('tc-2'), thinking('第一段')]);
    const a = h.activity()!;
    expect(a.kind).toBe('output');
    expect(a.thinkingSegment).toBe(1);
    expect(turnText(h)).toBe('第一段');
  });

  it('final：thinkingContent 不重复、恰好一处分隔', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('first thought')]);
    h.emitChatDelta([toolCall('tc-9'), thinking('after tool')]);
    h.emitChatDelta([toolCall('tc-9'), thinking('after tool grows')]);
    h.store.getState().finalizeStream(SK, { runId: 'run-1' });
    const turn = h.store.getState().activeTurnBySession[SK]!;
    expect(turn.thinkingContent).toBe('first thought\n\nafter tool grows');
  });

  /**
   * ⚠️ 待明确契约（第三次独立复审 2026-10-13 明确"暂列待明确契约，不作为已归因缺陷"）：
   *
   * 「边界后新段与刚归档段**前缀/同文**」到底是"新段（应显示）"还是"旧回声（应忽略）"，
   * 在 store 层没有任何可判据的差异（两者拿到的是同一对字符串）。当前实现选择了
   * **回声守卫优先**（忽略），依据是 F1 形状（`[工具回显, 思考回声, 正文]` 同帧，
   * 见上方"回声守卫"用例与旧 `turn-activity-snapshot` F1 测试）。
   * 复审探针 `new-prefix-after-tool` / `new-identical-after-tool`（r3-verify.cjs:25-26）
   * 记录的是**相反预期**（显示为新段）。消歧需要帧级上下文（同帧是否携带工具回显）
   * 或产品口径裁决 —— 定案前这两个用例保持 skip，禁止单方面翻转。
   */
  it.skip('[待契约] 边界后新段 = 刚归档段前缀（复审探针 new-prefix-after-tool）', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('检查配置后再继续')]);
    h.emitChatDelta([toolCall('tool1')]);
    h.emitChatDelta([thinking('检查配置')]);
    expect(turnText(h)).toBe('检查配置后再继续\n\n检查配置');
  });

  it.skip('[待契约] 边界后新段与刚归档段完全同文（复审探针 new-identical-after-tool）', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('检查配置')]);
    h.emitChatDelta([toolCall('tool1')]);
    h.emitChatDelta([thinking('检查配置')]);
    expect(turnText(h)).toBe('检查配置\n\n检查配置');
  });
});

/**
 * F1 回归（2026-10-08 终审）：**同帧多项都真变化时，按 content blocks 的真实顺序**定活动，
 * 不能沿用"提取字段后的固定处理顺序（正文→思考→工具）"。
 * 现有测试大多是"一个字段变化、其他字段重复"，因此全绿也盖不住本问题。
 */
describe('F1：同帧多项真变化的活动顺序', () => {
  it('⭐ 首帧 [新 thinking, 新 text]（数组序 text 在后）⇒ output', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('first thought'), text('first answer')]);
    const a = h.activity()!;
    expect(a.kind, '两段都新、数组里 text 在后 ⇒ 最新活动是正文').toBe('output');
    expect(a.thinkingSegment, '首段思考已开始过 = 段 1').toBe(1);
  });

  it('⭐ [新 toolCall, 新 thinking]（数组序 thinking 在后）⇒ thinking，且为**新一段**', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('first thought')]);
    expect(h.activity()!.thinkingSegment).toBe(1);
    // 同帧里工具先行、思考在后（数组序）⇒ 真序是先工具后思考 ⇒ 新思考段
    h.emitChatDelta([toolCall('tc-9'), thinking('after tool')]);
    const a = h.activity()!;
    expect(a.kind, '数组里 thinking 在工具之后 ⇒ 最新活动是思考').toBe('thinking');
    expect(a.thinkingSegment, '按真实顺序：先工具后思考 ⇒ 新段').toBe(2);
  });

  it('重复字段与真正变化混合 ⇒ 只按真变化项的顺序（旧思考回声 + 新 text ⇒ output）', () => {
    const h = createHarness();
    h.emitChatDelta([thinking('先看目录')]);
    h.emitChatDelta([toolCall('tc-1')]);
    h.emitChatDelta([toolCall('tc-1'), thinking('先看目录'), text('开始写答案')]);
    const a = h.activity()!;
    expect(a.kind).toBe('output');
    expect(a.thinkingSegment, '回声不得开新段').toBe(1);
  });
});

/**
 * G1 回归（2026-10-08 集中终审）：**每个变化的工具必须取它自己的 block 位置**。
 *
 * 现场形状：已有 old 工具，下一帧是 `[新工具, 新思考, 旧工具回声]`（数组序）。
 * 工具循环此前把**每一个**变化的工具都记成"最后一个 toolCall block 的位置"
 * （= 旧工具回声的下标 2），把真正排在第 0 位的新工具抬到 thinking（下标 1）之后
 * ⇒ 定音成 tools。修后每个工具保留自己的源位置 ⇒ 最新活动应是 thinking。
 *
 * 注：这是协议边界形状（上游是否产生插入/重排快照未取证），属**条件防御**，
 * 不作为现场故障根因。
 */
describe('G1：工具位置取各自 block index（同帧 [新工具, 新思考, 旧工具回声]）', () => {
  it('⭐ 新工具在第 0 位、新思考第 1 位、旧工具回声第 2 位 ⇒ thinking（新一段）', () => {
    const h = createHarness();
    h.emitChatDelta([toolCall('tc-1')]);
    expect(h.activity()!.kind).toBe('tools');
    // 同帧：新工具 tc-2 排第 0 位；新思考第 1 位；tc-1 是**没变化**的回声（第 2 位）
    h.emitChatDelta([toolCall('tc-2', 'write'), thinking('换个思路'), toolCall('tc-1')]);
    const a = h.activity()!;
    expect(a.kind, '新工具自己的位置（0）在思考（1）之前 ⇒ 最新活动是思考').toBe('thinking');
    expect(a.thinkingSegment, '工具之后的新思考 = 新段').toBe(1);
  });

  it('对照：新工具排在新思考之后 ⇒ tools（位置修正不得把真序也改掉）', () => {
    const h = createHarness();
    h.emitChatDelta([toolCall('tc-1')]);
    h.emitChatDelta([thinking('先想'), toolCall('tc-2', 'write'), toolCall('tc-1')]);
    const a = h.activity()!;
    expect(a.kind, '数组里工具在思考之后 ⇒ 最新活动是工具').toBe('tools');
  });
});
