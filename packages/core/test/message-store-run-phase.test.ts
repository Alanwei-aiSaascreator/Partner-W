import { describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '../src/stores/message-store';

/**
 * `setRunPhase` 的**重试次数**与相位**同步**。
 *
 * ## 为什么单开一条
 *
 * 两处变异（"非重试相位也带次数"、"store 不按相位清次数"）**都存活**过 ——
 * 因为我的用例都是**摆状态**（直接塞 `runRetryBySession`），
 * 而没有**驱动转换**（真的先重试、再换相位）。摆状态的写法**表达不出**
 * "数字是跟着相位走的"这件事。
 *
 * ⚠️ 这里必须用**真 store**：用桩只能证明"它被调了"。
 */

const SK = 'agent:main:clawwork:dev:task:t1';

function makeStore() {
  return createMessageStore({ persistMessage: vi.fn().mockResolvedValue(undefined) });
}

const retryOf = (store: ReturnType<typeof makeStore>) => store.getState().runRetryBySession[SK];

describe('setRunPhase —— 重试次数跟着相位走', () => {
  it('重试相位带上次数 ⇒ 存下来', () => {
    const store = makeStore();

    store.getState().setRunPhase(SK, 'retrying', { attempt: 2, maxAttempts: 4 });

    expect(retryOf(store)).toEqual({ attempt: 2, maxAttempts: 4 });
  });

  it('⭐ **换成别的相位 ⇒ 次数必须清掉**（否则会显示"正在准备（第 2/4 次）"）', () => {
    const store = makeStore();
    store.getState().setRunPhase(SK, 'retrying', { attempt: 2, maxAttempts: 4 });

    store.getState().setRunPhase(SK, 'starting_model');

    expect(retryOf(store), '数字粘在后面的相位上就是在说谎').toBeUndefined();
  });

  it('⭐ **这一轮结束（null）⇒ 次数也要清掉**', () => {
    const store = makeStore();
    store.getState().setRunPhase(SK, 'retrying', { attempt: 1, maxAttempts: 3 });

    store.getState().setRunPhase(SK, null);

    expect(retryOf(store)).toBeUndefined();
  });

  it('再来一轮重试 ⇒ 用**新**的数字（不是上一轮的）', () => {
    const store = makeStore();
    store.getState().setRunPhase(SK, 'retrying', { attempt: 1, maxAttempts: 3 });
    store.getState().setRunPhase(SK, 'starting_model');

    store.getState().setRunPhase(SK, 'retrying', { attempt: 3, maxAttempts: 5 });

    expect(retryOf(store)).toEqual({ attempt: 3, maxAttempts: 5 });
  });

  it('不带数字的重试相位（畸形帧）⇒ 不清掉旧的？**清** —— 相位是重试但没有数字，宁可没有', () => {
    // ⚠️ 这条刻意选了"清"：留着上一轮的数字，会显示成"第 1/3 次"却其实已经是新一轮，
    //    那是**确定的错**；而没数字只是少一句话（落回泛化文案）。宁可少说，不说错。
    const store = makeStore();
    store.getState().setRunPhase(SK, 'retrying', { attempt: 1, maxAttempts: 3 });

    store.getState().setRunPhase(SK, 'retrying');

    expect(retryOf(store)).toBeUndefined();
  });

  it('会话之间不串台', () => {
    const other = 'agent:main:clawwork:dev:task:t2';
    const store = makeStore();
    store.getState().setRunPhase(SK, 'retrying', { attempt: 2, maxAttempts: 4 });

    store.getState().setRunPhase(other, 'starting_model');

    expect(retryOf(store)).toEqual({ attempt: 2, maxAttempts: 4 });
  });

  it('清空任务时一并清掉（跟其它按会话存的界面态一致，别留孤儿）', () => {
    const store = makeStore();
    store.getState().setRunPhase(SK, 'retrying', { attempt: 2, maxAttempts: 4 });

    store.getState().clearMessages('t1');

    expect(retryOf(store)).toBeUndefined();
  });
});
