import { describe, it, expect, vi } from 'vitest';
import { createMessageStore } from '../src/stores/message-store';

/**
 * **流式**路径的推理分离（2026-09-14 线上实测）。
 *
 * `normalizeAssistantTurns` 负责塞进历史的那条路径，早就（这次刚补上）会把
 * `推理</think>答案` 切开；但**流式**这条路径是另一段代码 —— 它把网关推来的
 * 增量直接攒进 `streamingText`，收尾时原样当正文。结果是**同一个会话、两条路径
 * 结果不一致**：刷新后干净，当场看脏。
 *
 * 实测形状（qwen3.5-27b）：**只给闭标签** `</think>`，没有 `<think>`，
 * 也没有单独的 thinking 块 —— 推理整段混在正文里。
 */
function makeStore() {
  return createMessageStore({ persistMessage: vi.fn().mockResolvedValue(undefined) });
}

const SK = 'agent:main:clawwork:dev:task:t1';

describe('message-store finalizeStream —— 行内 </think> 的推理要切出去', () => {
  it('⭐ 流式攒出来的 `推理</think>答案` 收尾时被切开', () => {
    const store = makeStore();
    store.getState().appendStreamDelta(SK, 'The user asked what model I am; I should answer directly. </think>\n');
    store.getState().appendStreamDelta(SK, '你好，我是 clawrouter/qwen3.5-27b 模型。');

    store.getState().finalizeStream(SK);
    const turn = store.getState().activeTurnBySession[SK]!;

    expect(turn.thinkingContent).toBe('The user asked what model I am; I should answer directly.');
    expect(turn.content).toBe('你好，我是 clawrouter/qwen3.5-27b 模型。');
    expect(turn.content).not.toContain('</think>');
  });

  it('普通回复不受影响（没有标签就不动）', () => {
    const store = makeStore();
    store.getState().appendStreamDelta(SK, '就是一句普通回复');

    store.getState().finalizeStream(SK);
    const turn = store.getState().activeTurnBySession[SK]!;

    expect(turn.content).toBe('就是一句普通回复');
    expect(turn.thinkingContent).toBeFalsy();
  });

  it('⭐ bulkLoad 时也切 —— 修好之前就落库的脏消息必须被就地救回来', () => {
    const store = makeStore();
    const dirty = {
      id: 'm1',
      taskId: 't1',
      role: 'assistant' as const,
      content: '推理一段</think>\n你好，我是 qwen3.5-27b 模型。',
      timestamp: '2026-09-14T00:00:00.000Z',
    };

    store.getState().bulkLoad('t1', [dirty as never]);
    const loaded = store.getState().messagesByTask['t1']![0]!;

    expect(loaded.content).toBe('你好，我是 qwen3.5-27b 模型。');
    expect(loaded.thinkingContent).toBe('推理一段');
  });

  it('本来就走了 appendThinkingDelta 的模型（规范形状）保持原样', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '结构化推理');
    store.getState().appendStreamDelta(SK, '答案');

    store.getState().finalizeStream(SK);
    const turn = store.getState().activeTurnBySession[SK]!;

    expect(turn.thinkingContent).toBe('结构化推理');
    expect(turn.content).toBe('答案');
  });
});

/**
 * 推理**分段**合并（2026-09-20 实机）。
 *
 * 实测形状：一个 worker 的 121 条 thinking 事件里有 **7 次重置**
 *（`chars` 从 227 → 3、1409 → 3、860 → 3 …，共 8 段）——
 * 每段工具调用之后推理重新开始、网关从空快照重新累积。
 *
 * ⚠️ 这条守的是**接线**：store 必须用 `mergeThinkingSegments`（分段、空行隔开），
 *    而不是通用的 `mergeGatewayStreamText`（跨段会直接拼接 ⇒ 8 段推理糊成一团，
 *    界面上"同一句反复出现、越接越长"）。纯函数的规则本身在
 *    `packages/shared/test/stream-text.test.ts` 里测。
 */
describe('message-store appendThinkingDelta —— 跨段要隔开，不能粘成一团', () => {
  it('⭐ 两个不同的推理段之间有空行，不是直接拼接', () => {
    const store = makeStore();
    const seg1 = 'Let me read the key files to understand the identity, soul, and dreams';
    const seg2 = 'Let me understand the context: this is a 爆款内容教练 agent';

    store.getState().appendThinkingDelta(SK, seg1);
    store.getState().appendThinkingDelta(SK, seg2);

    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe(`${seg1}\n\n${seg2}`);
  });

  it('同一段内的快照变长仍然只保留最新（不能因为分段改动把这条弄丢）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, 'Let me read');
    store.getState().appendThinkingDelta(SK, 'Let me read the key files');

    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe('Let me read the key files');
  });
});

/**
 * ⭐ 跨工具边界后**当前段继续增长**（2026-10-13 独立复审反例 / BUG-075 P1）。
 *
 * 真实入口形状：思考 → 工具调用（`upsertToolCall` + `sealTurnActivity`）→ 第二段
 * 从空重新累积的**累计快照**。修前：跨段后的每个快照都被当"新一段"追加 ⇒
 * `A\n\nB\n\nBC\n\nBCD`，体积平方级膨胀（复审隔离探针实测 2,000 快照
 * 20,044,023 字符 vs 应得 20,040；4,000 个合并 >5s 超时）。
 * 契约：当前段增长**只替换当前段**；不重复追加旧快照；不覆盖历史段。
 */
describe('message-store appendThinkingDelta —— 跨工具边界后当前段继续增长（复审反例）', () => {
  it('⭐ A → 工具 → B/BC/BCD：final 只留 A\\n\\nBCD（不重复追加旧快照）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, 'A');
    store.getState().upsertToolCall(SK, 'task-1', {
      id: 'tool1',
      name: 'read',
      status: 'done',
      args: {},
      startedAt: '2026-10-13T00:00:00.000Z',
      completedAt: '2026-10-13T00:00:01.000Z',
    });
    store.getState().sealTurnActivity(SK, ['tools']);

    for (const chunk of ['B', 'BC', 'BCD']) store.getState().appendThinkingDelta(SK, chunk);

    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe('A\n\nBCD');
  });

  it('当前段旧快照重投（重连/重订阅）不重复追加', () => {
    const store = makeStore();
    for (const chunk of ['A', 'B', 'BC', 'BCD', 'BCDE']) {
      store.getState().appendThinkingDelta(SK, chunk);
    }
    store.getState().appendThinkingDelta(SK, 'BC');
    store.getState().appendThinkingDelta(SK, 'BCDE');

    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe('A\n\nBCDE');
  });

  it('会话隔离：两个 session 的思考互不污染', () => {
    const store = makeStore();
    const other = 'agent:worker:clawwork:dev:task:t1';
    store.getState().appendThinkingDelta(SK, '主会话推理');
    store.getState().appendThinkingDelta(other, '子会话推理');

    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe('主会话推理');
    expect(store.getState().activeTurnBySession[other]!.streamingThinking).toBe('子会话推理');
  });

  it('run 隔离：新 run 从空开始，不继承上一 run 的思考', () => {
    const store = makeStore();
    store.getState().bindActiveRun(SK, 'run-1');
    store.getState().appendThinkingDelta(SK, '上一轮 run 的推理');
    store.getState().bindActiveRun(SK, 'run-2');
    store.getState().appendThinkingDelta(SK, '这一轮 run 的推理');

    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe('这一轮 run 的推理');
    expect(store.getState().activeTurnBySession[SK]!.runId).toBe('run-2');
  });

  it('finalize 把合并结果整段交给 thinkingContent（分段空行保留）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, 'A');
    for (const chunk of ['B', 'BC', 'BCD']) store.getState().appendThinkingDelta(SK, chunk);
    store.getState().finalizeStream(SK);

    const turn = store.getState().activeTurnBySession[SK]!;
    expect(turn.thinkingContent).toBe('A\n\nBCD');
    expect(turn.streamingThinking).toBe('');
  });
});

/**
 * ⭐⭐ 第二次独立复审反例（2026-10-13）：**"最长后缀替换"与"全历史 includes"都猜不出
 * 当前段身份** —— 段身份只能**显式保存**（已完成段 + 当前段最新快照）；工具调用落地
 * （新 id）就是前一段的结束（真实语义：每段工具调用之后模型重新开始推理，网关从空快照
 * 重新累积）。旧快照去重只在**当前段内**判断；新段允许与历史完全同文。
 */
describe('message-store appendThinkingDelta —— 段身份必须精确（复审第二轮反例）', () => {
  const tool = (id: string, status: 'running' | 'done' = 'done') => ({
    id,
    name: 'read',
    status,
    args: {},
    startedAt: '2026-10-13T00:00:00.000Z',
    completedAt: '2026-10-13T00:00:01.000Z',
  });

  it('⭐ 反例1：新段开头与上一段结尾同字（"检查"）不许被吞掉分隔', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '开始检查');
    store.getState().upsertToolCall(SK, 'task-1', tool('tool-r2-1'));
    store.getState().sealTurnActivity(SK, ['tools']);
    store.getState().appendThinkingDelta(SK, '检查结果正常');

    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe('开始检查\n\n检查结果正常');
  });

  it('⭐ 反例2：新段与历史完全同文也要显示（文本相同 ≠ 同一段）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '先读取配置，再检查依赖。');
    store.getState().upsertToolCall(SK, 'task-1', tool('tool-r2-2'));
    store.getState().sealTurnActivity(SK, ['tools']);
    store.getState().appendThinkingDelta(SK, '读取配置');

    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe('先读取配置，再检查依赖。\n\n读取配置');
  });

  it('⭐ 反例3：旧快照重投不许污染当前段，也不许弹 activity（state 引用不动）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, 'H');
    store.getState().upsertToolCall(SK, 'task-1', tool('tool-r2-3'));
    store.getState().sealTurnActivity(SK, ['tools']);
    store.getState().appendThinkingDelta(SK, 'AB');
    store.getState().appendThinkingDelta(SK, 'ABCA');

    const before = store.getState().activeTurnBySession[SK]!;
    store.getState().appendThinkingDelta(SK, 'AB'); // 重投当前段的旧快照
    const after = store.getState().activeTurnBySession[SK]!;

    expect(after.streamingThinking).toBe('H\n\nABCA');
    expect(after).toBe(before); // R1：没变 ⇒ 连 state 都不动
  });

  it('⭐ 回声守卫：工具后帧里刚归档段被原样重投 ⇒ 不开新段、不重复显示（F1 形状）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '先看目录');
    store.getState().upsertToolCall(SK, 'task-1', tool('tool-echo-1'));
    store.getState().sealTurnActivity(SK, ['tools']);

    const before = store.getState().activeTurnBySession[SK]!;
    store.getState().appendThinkingDelta(SK, '先看目录'); // 旧 thinking 块原样回放
    expect(store.getState().activeTurnBySession[SK]).toBe(before); // 连 state 都不动
    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe('先看目录');

    // 真正的新段（不以刚归档段为前缀延伸）照常开段
    store.getState().appendThinkingDelta(SK, '先看目录，再查配置');
    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe('先看目录\n\n先看目录，再查配置');
  });

  it('多个工具边界：三段各自归档，段间恰好一个空行', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, 'A');
    store.getState().upsertToolCall(SK, 'task-1', tool('tool-m1'));
    store.getState().appendThinkingDelta(SK, 'B');
    store.getState().upsertToolCall(SK, 'task-1', tool('tool-m2'));
    store.getState().appendThinkingDelta(SK, 'C');
    store.getState().appendThinkingDelta(SK, 'CD');

    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe('A\n\nB\n\nCD');
  });

  it('工具状态更新（同 id）不是段边界：段内增长不受影响', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, 'A');
    store.getState().upsertToolCall(SK, 'task-1', tool('tool-u1', 'running'));
    store.getState().appendThinkingDelta(SK, '第二段');
    store.getState().upsertToolCall(SK, 'task-1', tool('tool-u1', 'done')); // 同 id 状态更新
    store.getState().appendThinkingDelta(SK, '第二段继续');

    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe('A\n\n第二段继续');
  });

  it('正文含空行不干扰段合并（空行只是字符，不是段界）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, 'A\n\nB');
    store.getState().upsertToolCall(SK, 'task-1', tool('tool-b1'));
    store.getState().appendThinkingDelta(SK, 'C\n\nD');

    expect(store.getState().activeTurnBySession[SK]!.streamingThinking).toBe('A\n\nB\n\nC\n\nD');
  });

  it('⭐ final：两段 + 恰好一次分隔，整段进 thinkingContent', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '开始检查');
    store.getState().upsertToolCall(SK, 'task-1', tool('tool-f1'));
    store.getState().appendThinkingDelta(SK, '检查结果正常');
    store.getState().appendThinkingDelta(SK, '检查结果正常，且格式正确');
    store.getState().finalizeStream(SK);

    const turn = store.getState().activeTurnBySession[SK]!;
    expect(turn.thinkingContent).toBe('开始检查\n\n检查结果正常，且格式正确');
    expect(turn.streamingThinking).toBe('');
  });
});
