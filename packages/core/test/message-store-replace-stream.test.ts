import { describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '../src/stores/message-store';

/**
 * `replaceStreamText` —— 把这一轮的流式正文**整个换掉**（B: 2026-09-19 那个 57 倍 bug 的最后一道闸）。
 *
 * ## 为什么单开一条
 *
 * 接线层（dispatcher）用的是 `vi.fn()` 桩，只能证明"它被调了"，
 * **证明不了这个动作本身是替换而不是追加**。变异验证当场暴露了这个缺口：
 * 把实现偷偷改成 `${turn.streamingText}${text}`（即退回追加），
 * 三个测试文件**全绿** —— 而那正是要修的那个 bug 的写法。
 *
 * ⚠️ 这一条必须**用真的 store**，不能再用桩。
 */

const SK = 'agent:main:clawwork:dev:task:t1';

function makeStore() {
  return createMessageStore({ persistMessage: vi.fn().mockResolvedValue(undefined) });
}

const textOf = (store: ReturnType<typeof makeStore>) => store.getState().activeTurnBySession[SK]?.streamingText;

describe('replaceStreamText —— 是"换掉"，不是"接上"', () => {
  it('⭐ 已经有正文时，替换是**覆盖**（不是拼接）—— 拼接就是那个 57 倍', () => {
    const store = makeStore();
    store.getState().appendStreamDelta(SK, '前面已经生成的一段');

    store.getState().replaceStreamText(SK, '到此刻为止的全文');

    expect(textOf(store)).toBe('到此刻为止的全文');
    expect(textOf(store), '拼接的话这里会变成「前面…全文」').not.toContain('前面已经生成的一段');
  });

  it('⭐ 连来两次全文快照（旧形状 delta 的典型形态）⇒ 只留最后那份', () => {
    // 这正是旧形状的行为：每帧都是"到此刻为止的全文"。
    // 追加的实现会得到 `A` + `AB` + `ABC` = 膨胀；正确实现只留 `ABC`。
    const store = makeStore();
    store.getState().replaceStreamText(SK, 'A');
    store.getState().replaceStreamText(SK, 'AB');
    store.getState().replaceStreamText(SK, 'ABC');

    expect(textOf(store)).toBe('ABC');
  });

  it('还没开过这一轮时也能替换（自己把 turn 建出来，不丢内容）', () => {
    const store = makeStore();
    expect(textOf(store)).toBeUndefined();

    store.getState().replaceStreamText(SK, '第一帧就是全文');

    expect(textOf(store)).toBe('第一帧就是全文');
  });

  it('只动正文，不碰同一轮的工具调用（那半边是别的流在写）', () => {
    const store = makeStore();
    store.getState().upsertToolCall(SK, 't1', {
      id: 'call_1',
      name: 'exec',
      status: 'running',
      startedAt: '2026-09-19T00:00:00.000Z',
    });

    store.getState().replaceStreamText(SK, '正文');

    const turn = store.getState().activeTurnBySession[SK];
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].id).toBe('call_1');
  });

  it('⚠️ 空串也是合法的替换（网关确实可能给空）—— 调用方负责挡，store 不做主', () => {
    // 这里刻意**不**在 store 里加"空串就忽略"的判断：那条闸在 `extractDeltaText` / dispatcher
    // 上（那儿才知道这是不是一次 `replace`）。store 只忠实执行。
    const store = makeStore();
    store.getState().replaceStreamText(SK, '有内容');

    store.getState().replaceStreamText(SK, '');

    expect(textOf(store)).toBe('');
  });

  it('每个会话各换各的（不串台）', () => {
    const other = 'agent:main:clawwork:dev:task:t2';
    const store = makeStore();
    store.getState().appendStreamDelta(SK, '会话一');
    store.getState().appendStreamDelta(other, '会话二');

    store.getState().replaceStreamText(SK, '换掉会话一');

    expect(store.getState().activeTurnBySession[SK].streamingText).toBe('换掉会话一');
    expect(store.getState().activeTurnBySession[other].streamingText).toBe('会话二');
  });
});
