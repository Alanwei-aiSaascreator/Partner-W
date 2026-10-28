import { describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '../src/stores/message-store';

/**
 * `awaitingApproval` 在**合并**里的位置（A2）。
 *
 * ## 为什么单开一条
 *
 * dispatcher 那边的用例断的是 `upsertToolCall` 的**入参** —— 那看不出 rank。
 * 「与 `running` 同级」这件事**只在合并器里成立**，所以必须走**真 store**。
 *
 * ⚠️ 这条是**变异逼出来的**：把 `awaitingApproval` 的 rank 从 1 改成 0，
 *    dispatcher 那一整套用例**全绿**（它们看不见合并），只有这里会红。
 *    ⇒ 用桩只能证明"它被调了"，证不了"落下去是什么"。
 */

const SK = 'agent:main:clawwork:dev:task:t1';
const TASK = 'task-1';

function makeStore() {
  return createMessageStore({ persistMessage: vi.fn().mockResolvedValue(undefined) });
}

/** 把一条工具调用写进 store（只给 status，其余字段是噪音）。 */
function put(store: ReturnType<typeof makeStore>, status: string): void {
  store.getState().upsertToolCall(SK, TASK, {
    id: 'call_1',
    name: 'exec',
    status: status as never,
    startedAt: '2026-09-15T00:00:00.000Z',
  });
}

/** 读回**合并之后**的状态。 */
function statusOf(store: ReturnType<typeof makeStore>): string | undefined {
  const turn = store.getState().activeTurnBySession[SK];
  return turn?.toolCalls.find((c) => c.id === 'call_1')?.status;
}

describe('message-store · awaitingApproval 的合并位置', () => {
  it('⭐⭐ `running` → `awaitingApproval` ⇒ **改得过去**（帧序：tool 的 result 先到）', () => {
    const store = makeStore();
    put(store, 'running');

    put(store, 'awaitingApproval');

    expect(statusOf(store), '同级 + `>=` ⇒ 后到的说了算').toBe('awaitingApproval');
  });

  it('⭐⭐ `awaitingApproval` → `done` ⇒ **收得了场**（真结果到了）', () => {
    const store = makeStore();
    put(store, 'awaitingApproval');

    put(store, 'done');

    expect(statusOf(store), '它**不是**终态，不许把真结果挡在外面').toBe('done');
  });

  it('⭐⭐ `awaitingApproval` → `error` ⇒ 也收得了场（被拒）', () => {
    const store = makeStore();
    put(store, 'awaitingApproval');

    put(store, 'error');

    expect(statusOf(store)).toBe('error');
  });

  it('⭐ `awaitingApproval` → `running` ⇒ **也改得过去**（批了之后真的开始跑了）', () => {
    // ⚠️ 这**不是** bug，是刻意的：同级 + `>=` ⇒ 双向都翻。
    //    批了之后 exec 真的开始跑，`item` 的 `phase:"update" + status:"running"` 会来 ——
    //    那时候「进行中」才是**事实**，比「等待批准」准确。
    const store = makeStore();
    put(store, 'awaitingApproval');

    put(store, 'running');

    expect(statusOf(store), '批准之后它确实在跑了').toBe('running');
  });

  it('⭐ 对照：`done` → `awaitingApproval` ⇒ **不许降级**（跑完了就是跑完了）', () => {
    const store = makeStore();
    put(store, 'done');

    put(store, 'awaitingApproval');

    expect(statusOf(store), '终态权重更高 ⇒ 迟到的"等待"压不动它').toBe('done');
  });

  it('⭐ 对照：`error` → `awaitingApproval` ⇒ 同样不许被压回去', () => {
    const store = makeStore();
    put(store, 'error');

    put(store, 'awaitingApproval');

    expect(statusOf(store)).toBe('error');
  });
});
