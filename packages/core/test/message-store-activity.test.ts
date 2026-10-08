import { describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '../src/stores/message-store';

/**
 * 「最新活动」瞬态元数据（2026-10-08 对话可视化改造 · P1-1）。
 *
 * 为什么必须有它：思考折叠块的"展开/收起/扫光"判据是**最新活动是不是思考**
 *（真实 WorkBuddy 的 `expand = isLastContent`）。而纯 props 无法区分
 * `thinking→tool` 与 `tool→thinking` 两种顺序（同一次 React 提交可能给出
 * 完全相同的最终文本与工具数组）—— 顺序信息只在**事件写入那一刻**存在，
 * 所以在这里（事件入口）同步留痕。
 *
 * 纪律：仅展示元数据；内容合并、落库、重试证据、计费一律不受影响。
 */
function makeStore() {
  return createMessageStore({ persistMessage: vi.fn().mockResolvedValue(undefined) });
}

const SK = 'agent:main:clawwork:dev:task:t1';

function activityOf(store: ReturnType<typeof makeStore>) {
  return store.getState().activeTurnBySession[SK]?.activity;
}

describe('message-store —— 最新活动元数据（仅展示）', () => {
  it('初始轮没有活动记录（未收到任何事件）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, 'x'); // 先建轮再清
    expect(activityOf(store)?.kind).toBe('thinking');
    // 新轮无活动
    store.getState().clearActiveTurn(SK);
    expect(activityOf(store)).toBeUndefined();
  });

  it('思考 delta → kind=thinking，段号 1，修订号递增', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '第一段');
    expect(activityOf(store)).toEqual({ kind: 'thinking', revision: 1, thinkingSegment: 1 });

    store.getState().appendThinkingDelta(SK, '还在第一段');
    expect(activityOf(store)).toEqual({ kind: 'thinking', revision: 2, thinkingSegment: 1 });
  });

  it('正文 delta（追加/替换）→ kind=output，思考段号保持', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '想一下');
    store.getState().appendStreamDelta(SK, '开始写');
    expect(activityOf(store)).toEqual({ kind: 'output', revision: 2, thinkingSegment: 1 });

    store.getState().replaceStreamText(SK, '重写正文');
    expect(activityOf(store)).toEqual({ kind: 'output', revision: 3, thinkingSegment: 1 });
  });

  it('工具事件 → kind=tools；【新段】工具之后的再次思考段号 +1（复位依据）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '第一段');
    store.getState().upsertToolCall(SK, 't1', {
      id: 'tc-1',
      name: 'read',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    expect(activityOf(store)).toEqual({ kind: 'tools', revision: 2, thinkingSegment: 1 });

    store.getState().appendThinkingDelta(SK, '第二段：换个思路');
    expect(activityOf(store)).toEqual({ kind: 'thinking', revision: 3, thinkingSegment: 2 });
  });

  it('⭐ 同帧批量：**多项真实变化**时，按处理顺序留痕（chat delta 帧：正文在前、思考在后 → 最终 thinking）', () => {
    const store = makeStore();
    // 模拟 gateway-dispatcher :1073-1086 的处理顺序：先文本替换，再思考追加
    store.getState().replaceStreamText(SK, '正文');
    store.getState().appendThinkingDelta(SK, '又想了');
    expect(activityOf(store)?.kind).toBe('thinking');

    // 反向：思考在前、工具在后 → 最终 tools
    store.getState().appendThinkingDelta(SK, '再想');
    store.getState().upsertToolCall(SK, 't1', {
      id: 'tc-2',
      name: 'exec',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    expect(activityOf(store)?.kind).toBe('tools');
  });

  it('⭐ R1：同帧里的**重复快照**不再更新活动（正文快照原样 + 旧思考原样重发）', () => {
    const store = makeStore();
    store.getState().replaceStreamText(SK, '正文');
    store.getState().appendThinkingDelta(SK, '想法');
    expect(activityOf(store)?.kind).toBe('thinking');
    const before = activityOf(store);

    // chat delta 的 content 是**全文快照**，dispatcher 固定按 正文→思考→工具 调用：
    // 旧思考与旧正文会被原样重发无数次 —— 它们不是"新活动"。
    store.getState().replaceStreamText(SK, '正文');
    store.getState().appendThinkingDelta(SK, '想法');
    expect(activityOf(store), '重复快照不得更新相位/段号（R1）').toEqual(before);
  });

  it('无轮时工具事件建新轮：activity 同轮写入（revision 1、段号 0）', () => {
    const store = makeStore();
    store.getState().upsertToolCall(SK, 't1', {
      id: 'tc-9',
      name: 'write',
      status: 'done',
      startedAt: new Date().toISOString(),
    });
    expect(activityOf(store)).toEqual({ kind: 'tools', revision: 1, thinkingSegment: 0 });
  });

  it('finalize 不给活动续期（定稿视图不依赖它）', () => {
    const store = makeStore();
    store.getState().appendThinkingDelta(SK, '思考');
    store.getState().replaceStreamText(SK, '正文');
    const before = activityOf(store);
    store.getState().finalizeStream(SK);
    expect(activityOf(store)).toEqual(before);
  });
});
