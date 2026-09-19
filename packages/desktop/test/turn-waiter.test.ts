import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchTurn } from '../src/renderer/lib/turn-waiter';

const KEY = 'agent:e:clawwork:dev:task:t1';

/** 假 store：能手动推进"忙/闲"，也能数还剩几个监听器（测泄漏）。 */
function makeStore() {
  let busy = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  return {
    setBusy(v: boolean) {
      busy = v;
      notify();
    },
    /** 只通知、不改忙闲 —— 用来模拟"正文变了"这种状态变化。 */
    touch: notify,
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

/** 模拟 active turn：`text` 非 null 就代表已 finalize。 */
function makeTurn(text?: string) {
  const box: { value: string | null } = { value: text ?? null };
  return { box, read: () => box.value };
}

/**
 * `watchTurn`（2026-09-20）。
 *
 * 这个文件的重点是**两个竞态**，都是实机踩出来的：
 *  ② 先订阅后发送（否则永远等不到"忙"）
 *  ③ ⭐ 正文要在它出现的那一刻抓 —— dispatcher 在 `chat.finalized` 之后紧接着就
 *     `syncSessionMessages`，把 active turn **收编走并删除**。"等结束了再去读"必然读到
 *     undefined：2026-09-20 实机就是这样挂的，第一位助手说完了却卡在"等条件成立超时"，
 *     整个讨论停在第一句。
 */
describe('watchTurn', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('正常一轮：忙 → 正文 finalize ⇒ 拿到正文', async () => {
    const s = makeStore();
    const t = makeTurn();
    const w = watchTurn(s.store, KEY, t.read);

    s.setBusy(true);
    t.box.value = '答复正文';
    s.touch();

    await expect(w.text).resolves.toBe('答复正文');
    w.dispose();
  });

  it('⭐ 正文出现后**立刻被删**（sync 把它收编走）⇒ 仍然拿得到', async () => {
    const s = makeStore();
    const t = makeTurn();
    const w = watchTurn(s.store, KEY, t.read);

    s.setBusy(true);
    t.box.value = '被收编前的正文';
    s.touch(); // 我们在这个瞬间抓到
    t.box.value = null; // dispatcher 的 syncSessionMessages 把它删了
    s.setBusy(false);
    s.touch();

    await expect(w.text).resolves.toBe('被收编前的正文');
    w.dispose();
  });

  it('⭐ 订阅时它**已经**在忙 ⇒ 也能正常等到（订阅后补查了一次）', async () => {
    const s = makeStore();
    const t = makeTurn();
    s.setBusy(true); // 订阅那一刻就是忙的
    const w = watchTurn(s.store, KEY, t.read);

    t.box.value = '正文';
    s.touch();

    await expect(w.text).resolves.toBe('正文');
    w.dispose();
  });

  it('⭐ 上一轮残留的 finalized **不能**被当成本轮结果（先见忙才认）', async () => {
    const s = makeStore();
    const t = makeTurn('上一轮的旧正文'); // 还没开新一轮，正文就已经在了
    const w = watchTurn(s.store, KEY, t.read);

    // 此刻还没忙 ⇒ 绝不能 resolve
    let settled = false;
    void w.text.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    // 新一轮跑起来并产出新正文
    s.setBusy(true);
    t.box.value = '本轮新正文';
    s.touch();

    await expect(w.text).resolves.toBe('本轮新正文');
    w.dispose();
  });

  it('⭐ 变闲之后**隔一会儿**才 finalize（实测差 22–36ms）⇒ 不能一闲下来就判死', async () => {
    vi.useFakeTimers();
    const s = makeStore();
    const t = makeTurn();
    const w = watchTurn(s.store, KEY, t.read, { finalizeGraceMs: 2000 });
    const p = w.text.catch((e: Error) => e);

    s.setBusy(true);
    s.setBusy(false); // lifecycle.end：变闲了，但正文还没 finalize

    // 变闲后的头 100ms 里绝不能判死 —— 那是正常的时序差
    await vi.advanceTimersByTimeAsync(100);
    let settled = false;
    void w.text.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    // finalize 到（真实是 +22–36ms）
    t.box.value = '迟到的正文';
    s.touch();

    await expect(p).resolves.toBe('迟到的正文');
    w.dispose();
  });

  it('⭐ 一开始就是闲的、且一直没忙起来 ⇒ 不能当成"已经说完了"', async () => {
    vi.useFakeTimers();
    const s = makeStore();
    const t = makeTurn();
    const w = watchTurn(s.store, KEY, t.read, { startTimeoutMs: 1000, timeoutMs: 5000 });
    const err = w.text.catch((e: Error) => e);

    await vi.advanceTimersByTimeAsync(900);
    let settledEarly = false;
    void w.text.then(
      () => (settledEarly = true),
      () => (settledEarly = true),
    );
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(await err).toBeInstanceOf(Error);
    w.dispose();
  });

  it('⚠️ 忙完、宽限期内也没等到正文 ⇒ 报错（不干等到总超时十分钟）', async () => {
    const s = makeStore();
    const t = makeTurn();
    const w = watchTurn(s.store, KEY, t.read, { timeoutMs: 60_000, finalizeGraceMs: 30 });

    s.setBusy(true);
    s.setBusy(false); // 这一轮结束，但正文一直没出现

    await expect(w.text).rejects.toThrow();
    w.dispose();
  });

  it('忙起来了但迟迟不结束 ⇒ 按总超时 reject', async () => {
    vi.useFakeTimers();
    const s = makeStore();
    const t = makeTurn();
    const w = watchTurn(s.store, KEY, t.read, { startTimeoutMs: 1000, timeoutMs: 3000 });
    const err = w.text.catch((e: Error) => e);

    s.setBusy(true);
    await vi.advanceTimersByTimeAsync(3100);

    expect(await err).toBeInstanceOf(Error);
    w.dispose();
  });

  it('结束后监听器被摘掉（不能攒着泄漏）；dispose 之后再变化也不再惊动', async () => {
    const s = makeStore();
    const t = makeTurn();
    const w = watchTurn(s.store, KEY, t.read);
    expect(s.listenerCount()).toBe(1);

    s.setBusy(true);
    t.box.value = 'x';
    s.touch();
    await w.text;
    expect(s.listenerCount()).toBe(0);

    const s2 = makeStore();
    const t2 = makeTurn();
    const w2 = watchTurn(s2.store, KEY, t2.read);
    w2.dispose();
    expect(s2.listenerCount()).toBe(0);
  });
});
