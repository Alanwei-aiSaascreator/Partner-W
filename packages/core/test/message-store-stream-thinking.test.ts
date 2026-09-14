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
