import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@clawwork/shared';
import { createMessageStore } from '../src/stores/message-store';

/**
 * 工具调用**跨帧合并**：一条工具调用的信息由**多条帧**拼出来，谁后到都不许把别人那半冲掉。
 *
 * ## 为什么值得单独钉
 *
 * 随包运行时会为**同一次工具调用**发好几帧（都是实测的 `stream:"tool"` 形状）：
 *
 * | phase     | 带什么                                        |
 * | --------- | --------------------------------------------- |
 * | `start`   | `name` + `args`                               |
 * | `update`  | **只有** `partialResult`（没有 args/result）  |
 * | `result`  | `result` + `isError`（**完成就靠它**）        |
 * | `review`  | 审批审查（`approvalReviewOutcome`）           |
 *
 * 另有 `item` 流补 `title` / 真实起止时间 —— 也就是 **args 在一路、title 在另一路**。
 *
 * ⚠️ `update` 是最容易出事的一帧：它**不带** `args` 也不带 `result`，而它**可能晚于
 * `result` 到达**（同一轮里在网络上就是最后飞的那几帧）。若合并写成"后来者覆盖"，
 * 症状是**工具卡上的参数与输出凭空消失、已完成的调用又转回"进行中"**。
 *
 * ⚠️ 这里断言的是**合并后的状态**（store 里那一份），不是传进去的那一帧 ——
 * 传进去的对象永远是对的，出错的是合并。
 */
const SK = 'agent:main:clawwork:dev:task:t1';
const TID = 'task-1';

function makeStore() {
  return createMessageStore({ persistMessage: vi.fn().mockResolvedValue(undefined) });
}

/** 读这个会话里那一份**合并后**的工具调用。 */
function stored(store: ReturnType<typeof makeStore>, id: string): ToolCall {
  const turn = store.getState().activeTurnBySession[SK];
  const tc = turn?.toolCalls.find((t) => t.id === id);
  expect(tc, `${id} 应当已经落进 store`).toBeDefined();
  return tc!;
}

function upsert(store: ReturnType<typeof makeStore>, tc: Partial<ToolCall> & { id: string }): void {
  store.getState().upsertToolCall(SK, TID, {
    name: 'exec',
    status: 'running',
    startedAt: '2026-09-19T00:00:00.000Z',
    ...tc,
  } as ToolCall);
}

describe('工具调用跨帧合并', () => {
  it('⭐ update 帧（只有 partialResult）不许冲掉 start 带来的 args', () => {
    const store = makeStore();

    upsert(store, { id: 'c1', status: 'running', args: { cmd: 'ls' } });
    // 真实 update 帧：`{ phase:"update", name, toolCallId, partialResult: liveResult }` —— 没有 args
    upsert(store, { id: 'c1', status: 'running', args: undefined, result: undefined });

    expect(stored(store, 'c1').args, 'update 不带 args ⇒ 必须保留 start 那份').toEqual({ cmd: 'ls' });
  });

  it('⭐ update 帧不许冲掉 result 帧带回来的真实输出', () => {
    const store = makeStore();

    upsert(store, { id: 'c1', status: 'done', result: 'a.md\nb.md' });
    upsert(store, { id: 'c1', status: 'running', result: undefined });

    expect(stored(store, 'c1').result).toBe('a.md\nb.md');
  });

  it('⭐ 已完成的调用不许被迟到的 update 转回"进行中"（否则卡片永远转圈）', () => {
    const store = makeStore();

    // 真实 result 帧落下来时，dispatcher 会把 completedAt 一起写上
    //（`completedAt: status !== 'running' ? new Date().toISOString() : undefined`）
    upsert(store, { id: 'c1', status: 'done', result: 'ok', completedAt: '2026-09-19T00:00:05.000Z' });
    // 迟到的 update：它自己的 status 就是 running，且**不带** completedAt
    upsert(store, { id: 'c1', status: 'running', completedAt: undefined });

    expect(stored(store, 'c1').status, 'update 的 running 不许覆盖 done').toBe('done');
    expect(stored(store, 'c1').completedAt, '完成时间也不许被抹掉').toBe('2026-09-19T00:00:05.000Z');
  });

  it('已经失败的调用同样不许被迟到的 update 转回"进行中"', () => {
    const store = makeStore();

    upsert(store, { id: 'c1', status: 'error', result: 'timed out' });
    upsert(store, { id: 'c1', status: 'running' });

    expect(stored(store, 'c1').status).toBe('error');
  });

  it('⭐ item 流的 title 与 tool 流的 args 各带一半，谁后到都不许冲掉对方', () => {
    const store = makeStore();

    // item 流先到：只有 title，没有 args
    upsert(store, { id: 'c1', name: 'memory_search', status: 'running', title: 'memory_search 游戏 爆款' });
    // tool 流后到：只有 args，没有 title
    upsert(store, { id: 'c1', name: 'memory_search', status: 'running', args: { query: '游戏 爆款' } });

    const tc = stored(store, 'c1');
    expect(tc.title, 'title 来自 item 流，不许被 tool 流那帧抹掉').toBe('memory_search 游戏 爆款');
    expect(tc.args, 'args 来自 tool 流，不许被 item 流那帧抹掉').toEqual({ query: '游戏 爆款' });
  });

  it('起点只认第一次：后续帧不许把 startedAt 往后拨', () => {
    const store = makeStore();

    upsert(store, { id: 'c1', status: 'running' });
    const first = stored(store, 'c1').startedAt;
    upsert(store, { id: 'c1', status: 'running', startedAt: '2026-09-19T09:99:99.000Z' });

    expect(stored(store, 'c1').startedAt).toBe(first);
  });
});
