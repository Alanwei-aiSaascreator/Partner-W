import { describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '../src/stores/message-store';

/**
 * 「这条错误可以重试」的登记（B10）。
 *
 * 这条登记**只为一件事存在**：让界面知道该不该给「重试」按钮。所以它比别的界面态
 * 更怕两件事 ——
 *   ① **该在不在**（登记被自己的收尾动作误清 ⇒ 用户永远看不到按钮）；
 *   ② **不该在还在**（一轮已经重新跑起来了，旧按钮还挂着 ⇒ 点一下就再花一次钱）。
 */
function makeStore() {
  return createMessageStore({ persistMessage: vi.fn().mockResolvedValue(undefined) });
}

const SK = 'agent:main:clawwork:dev:task:t1';
const TID = 't1';
const entry = { taskId: TID, messageId: 'msg-err' };

describe('message-store —— 可重试错误的登记', () => {
  it('登记之后界面查得到（按钮据此出现）', () => {
    const store = makeStore();

    store.getState().markRetryableError(SK, entry);

    expect(store.getState().retryableErrorBySession[SK]).toEqual(entry);
  });

  it('没登记过就查不到（默认不给按钮）', () => {
    const store = makeStore();
    expect(store.getState().retryableErrorBySession[SK]).toBeUndefined();
  });

  it('⭐ 一轮真的跑起来（空闲→忙）就作废 —— 旧按钮点下去等于再花一次钱', () => {
    const store = makeStore();
    store.getState().markRetryableError(SK, entry);

    store.getState().setProcessing(SK, true);

    expect(store.getState().retryableErrorBySession[SK]).toBeUndefined();
  });

  it('⚠️ `setProcessing(false)` **不许**清 —— 错误落地时正是先关忙再登记', () => {
    // dispatcher 的 error 分支开头就是 `setProcessing(sessionKey,false)`；
    // 要是这里也清，刚登记的按钮会被自己的收尾动作立刻抹掉 —— 永远看不到。
    const store = makeStore();
    store.getState().markRetryableError(SK, entry);

    store.getState().setProcessing(SK, false);

    expect(store.getState().retryableErrorBySession[SK]).toEqual(entry);
  });

  it('已经在忙时重复 `setProcessing(true)` 不作废（重连/迟到事件不是"新一轮"）', () => {
    const store = makeStore();
    store.getState().setProcessing(SK, true);
    store.getState().markRetryableError(SK, entry);

    store.getState().setProcessing(SK, true);

    expect(store.getState().retryableErrorBySession[SK]).toEqual(entry);
  });

  it('同一会话只留**最近**一条（旧错误的按钮不该继续挂着）', () => {
    const store = makeStore();
    store.getState().markRetryableError(SK, entry);

    store.getState().markRetryableError(SK, { taskId: TID, messageId: 'msg-err-2' });

    expect(store.getState().retryableErrorBySession[SK]).toEqual({ taskId: TID, messageId: 'msg-err-2' });
  });

  it('别的会话不受影响（各自独立）', () => {
    const other = 'agent:main:clawwork:dev:task:t2';
    const store = makeStore();
    store.getState().markRetryableError(SK, entry);

    store.getState().setProcessing(other, true);

    expect(store.getState().retryableErrorBySession[SK]).toEqual(entry);
  });

  it('清空任务时一并清掉（跟其它按会话存的界面态保持一致，别留孤儿）', () => {
    const store = makeStore();
    store.getState().markRetryableError(SK, entry);

    store.getState().clearMessages(TID);

    expect(store.getState().retryableErrorBySession[SK]).toBeUndefined();
  });
});
