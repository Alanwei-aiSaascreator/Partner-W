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

/**
 * 包 D（2026-10-07）：「整轮失败自动重发 1 次」的候选登记。
 *
 * 与上面那份（B10 按钮）**同一套生命周期纪律**，但两件事必须分开存：
 *   - 那份决定"给不给用户一个按钮"（只认结构化判据说 `yes` 的）；
 *   - 这份决定"界面要不要自己重发一次"（瞬时 / 未分类的候选，重发前还要过
 *     渲染层的「零最终交付」严格判据）。
 * 合成一份的话，lifecycle 失败（判据恒为 unknown）会凭空长出按钮 —— B10 明确拒绝过。
 */
describe('message-store —— 自动重试候选的登记（包 D）', () => {
  const candidate = { taskId: TID, messageId: 'msg-err', kind: 'unclassified' as const };

  it('登记之后界面查得到', () => {
    const store = makeStore();
    store.getState().markAutoRetryFailure(SK, candidate);

    expect(store.getState().autoRetryFailureBySession[SK]).toEqual(candidate);
  });

  it('没登记过就查不到（默认不自动重发任何东西）', () => {
    const store = makeStore();
    expect(store.getState().autoRetryFailureBySession[SK]).toBeUndefined();
  });

  it('⭐ 一轮真的跑起来（空闲→忙）就作废 —— 有人已经重发过了，别抢在用户前面再发一次', () => {
    const store = makeStore();
    store.getState().markAutoRetryFailure(SK, candidate);

    store.getState().setProcessing(SK, true);

    expect(store.getState().autoRetryFailureBySession[SK]).toBeUndefined();
  });

  it('⚠️ `setProcessing(false)` 不许清 —— 错误落地时正是先关忙再登记', () => {
    const store = makeStore();
    store.getState().markAutoRetryFailure(SK, candidate);

    store.getState().setProcessing(SK, false);

    expect(store.getState().autoRetryFailureBySession[SK]).toEqual(candidate);
  });

  it('已经在忙时重复 `setProcessing(true)` 不作废（重连/迟到事件不是"新一轮"）', () => {
    const store = makeStore();
    store.getState().setProcessing(SK, true);
    store.getState().markAutoRetryFailure(SK, candidate);

    store.getState().setProcessing(SK, true);

    expect(store.getState().autoRetryFailureBySession[SK]).toEqual(candidate);
  });

  it('同一会话只留**最近**一条（旧的失败不该继续挂着等重发）', () => {
    const store = makeStore();
    store.getState().markAutoRetryFailure(SK, candidate);

    store.getState().markAutoRetryFailure(SK, { ...candidate, messageId: 'msg-err-2' });

    expect(store.getState().autoRetryFailureBySession[SK]).toEqual({ ...candidate, messageId: 'msg-err-2' });
  });

  it('瞬时 / 未分类两种候选各自带着自己的类别（渲染层据此记录判据来源）', () => {
    const store = makeStore();
    store.getState().markAutoRetryFailure(SK, { ...candidate, kind: 'transient' });

    expect(store.getState().autoRetryFailureBySession[SK]?.kind).toBe('transient');
  });

  it('别的会话不受影响（各自独立）', () => {
    const other = 'agent:main:clawwork:dev:task:t2';
    const store = makeStore();
    store.getState().markAutoRetryFailure(SK, candidate);

    store.getState().setProcessing(other, true);

    expect(store.getState().autoRetryFailureBySession[SK]).toEqual(candidate);
  });

  it('清空任务时一并清掉（跟其它按会话存的界面态保持一致，别留孤儿）', () => {
    const store = makeStore();
    store.getState().markAutoRetryFailure(SK, candidate);

    store.getState().clearMessages(TID);

    expect(store.getState().autoRetryFailureBySession[SK]).toBeUndefined();
  });
});
