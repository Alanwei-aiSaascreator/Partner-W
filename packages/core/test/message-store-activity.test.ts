import { describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '../src/stores/message-store';

/**
 * 「最新活动」瞬态元数据（2026-10-08 对话可视化改造；F1 终审后为**帧封**模型）。
 *
 * 职责两半：
 * - **写入器**（`appendStreamDelta`/`replaceStreamText`/`appendThinkingDelta`/`upsertToolCall`）
 *   只负责"重复快照不重写 state"的变化门 —— 内容没变 ⇒ 返回原 state（引用不变，
 *   事件入口靠引用比较收集"这一帧谁真的变了"）；
 * - **`sealTurnActivity(sessionKey, kindsInOrder)`** 在**帧尾**按**真实顺序**一次算定
 *   kind / revision / 思考段号 —— 顺序信息只在事件帧里存在（dispatcher
 *   `sealChatFrameActivity` 按 content blocks 位置排序后调用；见该函数注释）。
 *
 * ⚠️ 真实入口（真实 dispatcher + 真实 store）的行为回归在 `turn-activity-snapshot.test.ts`；
 * 本文件钉的是 store 侧契约本身。
 */
function makeStore() {
  return createMessageStore({ persistMessage: vi.fn().mockResolvedValue(undefined) });
}

const SK = 'agent:main:clawwork:dev:task:t1';

function activityOf(store: ReturnType<typeof makeStore>) {
  return store.getState().activeTurnBySession[SK]?.activity;
}

const tc = (id: string, name = 'read') => ({
  id,
  name,
  status: 'running' as const,
  startedAt: new Date().toISOString(),
});

describe('message-store —— 最新活动元数据（帧封模型）', () => {
  it('首帧只有 thinking：写入 + seal([thinking]) ⇒ {thinking,1,1}；同段再 delta ⇒ rev 递增、段不变', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '第一段');
    store.getState().sealTurnActivity(SK, ['thinking']);
    expect(activityOf(store)).toEqual({ kind: 'thinking', revision: 1, thinkingSegment: 1 });

    store.getState().appendThinkingDelta(SK, '还在第一段');
    store.getState().sealTurnActivity(SK, ['thinking']);
    expect(activityOf(store)).toEqual({ kind: 'thinking', revision: 2, thinkingSegment: 1 });
  });

  it('正文（追加/替换）⇒ output，思考段号保持', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '想一下');
    store.getState().sealTurnActivity(SK, ['thinking']);

    store.getState().appendStreamDelta(SK, '开始写');
    store.getState().sealTurnActivity(SK, ['output']);
    expect(activityOf(store)).toEqual({ kind: 'output', revision: 2, thinkingSegment: 1 });

    store.getState().replaceStreamText(SK, '重写正文');
    store.getState().sealTurnActivity(SK, ['output']);
    expect(activityOf(store)).toEqual({ kind: 'output', revision: 3, thinkingSegment: 1 });
  });

  it('工具事件 ⇒ tools；【新段】工具之后的再次思考段号 +1', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '第一段');
    store.getState().sealTurnActivity(SK, ['thinking']);

    store.getState().upsertToolCall(SK, 't1', tc('tc-1'));
    store.getState().sealTurnActivity(SK, ['tools']);
    expect(activityOf(store)).toEqual({ kind: 'tools', revision: 2, thinkingSegment: 1 });

    store.getState().appendThinkingDelta(SK, '第二段：换个思路');
    store.getState().sealTurnActivity(SK, ['thinking']);
    expect(activityOf(store)).toEqual({ kind: 'thinking', revision: 3, thinkingSegment: 2 });
  });

  it('⭐ 同帧多项真变化：**按传入顺序**定音（[output, thinking] ⇒ thinking；反向 ⇒ output）', () => {
    const store = makeStore();
    store.getState().replaceStreamText(SK, '正文');
    store.getState().appendThinkingDelta(SK, '又想了');
    store.getState().sealTurnActivity(SK, ['output', 'thinking']);
    expect(activityOf(store)).toEqual({ kind: 'thinking', revision: 2, thinkingSegment: 1 });

    const store2 = makeStore();
    store2.getState().appendThinkingDelta(SK, '先想');
    store2.getState().replaceStreamText(SK, '再写');
    store2.getState().sealTurnActivity(SK, ['thinking', 'output']);
    expect(activityOf(store2)).toEqual({ kind: 'output', revision: 2, thinkingSegment: 1 });
  });

  it('⭐ F1 修正：上一活动是 thinking、同帧真序为 [tools, thinking] ⇒ **新段**（+1）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '第一段');
    store.getState().sealTurnActivity(SK, ['thinking']);
    expect(activityOf(store)!.thinkingSegment).toBe(1);

    // 同一帧里工具先行、思考在后（按 content blocks 序传入）：先工具后思考 ⇒ 新一段
    store.getState().appendThinkingDelta(SK, '工具之后的思考');
    store.getState().upsertToolCall(SK, 't1', tc('tc-9'));
    store.getState().sealTurnActivity(SK, ['tools', 'thinking']);
    expect(activityOf(store)).toEqual({ kind: 'thinking', revision: 3, thinkingSegment: 2 });
  });

  it('⭐ R1：重复快照不重写 state（引用不变；不 seal ⇒ 活动不动）', () => {
    const store = makeStore();
    store.getState().replaceStreamText(SK, '正文');
    store.getState().appendThinkingDelta(SK, '想法');
    store.getState().sealTurnActivity(SK, ['output', 'thinking']);
    const before = activityOf(store);
    const turnBefore = store.getState().activeTurnBySession[SK];

    store.getState().replaceStreamText(SK, '正文'); // 原样重发
    store.getState().appendThinkingDelta(SK, '想法'); // 旧思考原样重发
    expect(store.getState().activeTurnBySession[SK], '内容没变 ⇒ state 引用必须不变（帧封的判据）').toBe(turnBefore);
    expect(activityOf(store)).toEqual(before);
  });

  it('seal 空数组 = 不动（没变化的一帧不产生活动更新）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '想');
    store.getState().sealTurnActivity(SK, ['thinking']);
    const before = activityOf(store);
    store.getState().sealTurnActivity(SK, []);
    expect(activityOf(store)).toEqual(before);
  });

  it('无轮时工具事件建新轮 + seal ⇒ {tools,1,0}', () => {
    const store = makeStore();
    store.getState().upsertToolCall(SK, 't1', tc('tc-9'));
    store.getState().sealTurnActivity(SK, ['tools']);
    expect(activityOf(store)).toEqual({ kind: 'tools', revision: 1, thinkingSegment: 0 });
  });

  it('finalize 不给活动续期（定稿视图不依赖它）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '思考');
    store.getState().sealTurnActivity(SK, ['thinking']);
    store.getState().replaceStreamText(SK, '正文');
    store.getState().sealTurnActivity(SK, ['output']);
    const before = activityOf(store);
    store.getState().finalizeStream(SK);
    expect(activityOf(store)).toEqual(before);
  });
});
