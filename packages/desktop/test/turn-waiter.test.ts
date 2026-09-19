import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForCondition, watchTurnEnd } from '../src/renderer/lib/turn-waiter';

const KEY = 'agent:e:clawwork:dev:task:t1';

/** 假 store：能手动推进"忙/闲"，也能数还剩几个监听器（测泄漏）。 */
function makeStore(initiallyBusy = false) {
  let busy = initiallyBusy;
  const listeners = new Set<() => void>();
  return {
    setBusy(v: boolean) {
      busy = v;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
    store: {
      getState: () => ({ processingBySession: busy ? new Set([KEY]) : new Set<string>() }),
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
  };
}

/**
 * 「等某一次回复结束」（2026-09-20）。
 *
 * ⚠️ 这个文件的重点是**竞态**：如果先发消息再订阅，`sendMessage` 返回之后、
 *    订阅之前那一小段里 start（甚至 start+end）可能已经过去了 ⇒ 永远等不到"忙"。
 *    所以接口是"先订阅、拿到 ended 再发"，下面第 2 条就是钉这个的。
 */
describe('watchTurnEnd', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('正常一轮：忙 → 闲 ⇒ resolve', async () => {
    const s = makeStore();
    const w = watchTurnEnd(s.store, KEY);

    s.setBusy(true);
    s.setBusy(false);

    await expect(w.ended).resolves.toBeUndefined();
    w.dispose();
  });

  it('⭐ 订阅时它**已经**在忙（先订阅后发送之外的情形）⇒ 也能正常等到结束', async () => {
    const s = makeStore(true); // 订阅那一刻就是忙的
    const w = watchTurnEnd(s.store, KEY);

    s.setBusy(false);

    await expect(w.ended).resolves.toBeUndefined();
    w.dispose();
  });

  it('⭐ 一开始就是闲的、而且一直没忙起来 ⇒ **不能**当成"已经说完了"', async () => {
    vi.useFakeTimers();
    const s = makeStore();
    const w = watchTurnEnd(s.store, KEY, { startTimeoutMs: 1000, timeoutMs: 5000 });
    const err = w.ended.catch((e: Error) => e);

    // 关键：这时是闲的，但绝不能 resolve —— 消息还没跑起来
    await vi.advanceTimersByTimeAsync(900);
    let settledEarly = false;
    void w.ended.then(
      () => (settledEarly = true),
      () => (settledEarly = true),
    );
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(await err).toBeInstanceOf(Error);
    w.dispose();
  });

  it('忙起来了但迟迟不结束 ⇒ 按总超时 reject', async () => {
    vi.useFakeTimers();
    const s = makeStore();
    const w = watchTurnEnd(s.store, KEY, { startTimeoutMs: 1000, timeoutMs: 3000 });
    const err = w.ended.catch((e: Error) => e);

    s.setBusy(true);
    await vi.advanceTimersByTimeAsync(3100);

    expect(await err).toBeInstanceOf(Error);
    w.dispose();
  });

  it('dispose 之后不再被后续状态变化惊动，且监听器真的摘掉了', async () => {
    const s = makeStore();
    const w = watchTurnEnd(s.store, KEY);
    expect(s.listenerCount()).toBe(1);

    w.dispose();
    expect(s.listenerCount()).toBe(0);

    // 之后再忙再闲，promise 不该有任何反应
    let settled = false;
    void w.ended.then(
      () => (settled = true),
      () => (settled = true),
    );
    s.setBusy(true);
    s.setBusy(false);
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('结束后监听器也被摘掉（不能攒着泄漏）', async () => {
    const s = makeStore();
    const w = watchTurnEnd(s.store, KEY);

    s.setBusy(true);
    s.setBusy(false);
    await w.ended;

    expect(s.listenerCount()).toBe(0);
  });
});

/**
 * `waitForCondition`（2026-09-20）。
 *
 * 为什么需要它：实测生命周期是 `lifecycle.end`（不忙了）→ **22ms 后** → `chat.finalized`。
 * 而 `finalizeStream` 才把混在正文里的 `</think>` 推理切出去 ⇒ 只等"不忙"就开始读，
 * 会把模型的思考过程喂给下一位。
 */
describe('waitForCondition', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('条件后来成立 ⇒ resolve', async () => {
    let done = false;
    const s = makeStore();
    const p = waitForCondition(s.store, () => done);

    done = true;
    s.setBusy(true); // 用任意一次状态变化把监听器叫醒

    await expect(p).resolves.toBeUndefined();
  });

  it('订阅那刻就已经成立 ⇒ 立刻返回，不占监听器', async () => {
    const s = makeStore();
    await expect(waitForCondition(s.store, () => true)).resolves.toBeUndefined();
    expect(s.listenerCount()).toBe(0);
  });

  it('一直不成立 ⇒ 超时 reject（不能永远挂着）', async () => {
    vi.useFakeTimers();
    const s = makeStore();
    const p = waitForCondition(s.store, () => false, { timeoutMs: 1000 });
    const err = p.catch((e: Error) => e);

    await vi.advanceTimersByTimeAsync(1100);
    expect(await err).toBeInstanceOf(Error);
    expect(s.listenerCount()).toBe(0);
  });

  it('成立之后监听器要摘掉（不能攒着）', async () => {
    let done = false;
    const s = makeStore();
    const p = waitForCondition(s.store, () => done);

    done = true;
    s.setBusy(true);
    await p;

    expect(s.listenerCount()).toBe(0);
  });
});
