import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '../src/stores/message-store';

/**
 * 「这一轮等了多久」的打点。
 *
 * 为什么值得单独一条：输入框上方要显示一个**一直在走的秒数**，而它恰恰是
 * 消除"卡住"体感最有效的东西 —— 用户骂卡住，多半是**看不出是否还在动**。
 * 秒数要可信，起算点就必须**只在"从空闲变忙"那一刻打一次**：
 *   ① 中途重复 `setProcessing(true)`（重连、迟到事件）不能把表拨回去，
 *      否则等了两分钟的用户会看着计时器跳回 3 秒 —— 比不显示更糟；
 *   ② 一轮结束必须清掉，不能把上一轮的起点漏给下一轮。
 */
function makeStore() {
  return createMessageStore({ persistMessage: vi.fn().mockResolvedValue(undefined) });
}

const SK = 'agent:main:clawwork:dev:task:t1';

afterEach(() => {
  vi.useRealTimers();
});

describe('message-store —— 本轮起算点', () => {
  it('⭐ 从空闲变忙那一刻打点', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const store = makeStore();

    store.getState().setProcessing(SK, true);

    expect(store.getState().turnStartedAtBySession[SK]).toBe(Date.parse('2026-09-18T10:00:00.000Z'));
  });

  it('⭐ 已经在忙时重复 setProcessing(true) **不**拨表（重连/迟到事件很常见）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const store = makeStore();
    store.getState().setProcessing(SK, true);

    vi.setSystemTime(new Date('2026-09-18T10:00:45.000Z'));
    store.getState().setProcessing(SK, true);

    expect(store.getState().turnStartedAtBySession[SK]).toBe(Date.parse('2026-09-18T10:00:00.000Z'));
  });

  it('空闲之后再来一轮 ⇒ 重新打点', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const store = makeStore();
    store.getState().setProcessing(SK, true);

    vi.setSystemTime(new Date('2026-09-18T10:02:00.000Z'));
    store.getState().setProcessing(SK, false);
    expect(store.getState().turnStartedAtBySession[SK]).toBeUndefined();

    vi.setSystemTime(new Date('2026-09-18T10:05:00.000Z'));
    store.getState().setProcessing(SK, true);
    expect(store.getState().turnStartedAtBySession[SK]).toBe(Date.parse('2026-09-18T10:05:00.000Z'));
  });

  it('没在跑的会话查不到起算点（界面据此判断"不该显示活动条"）', () => {
    const store = makeStore();
    expect(store.getState().turnStartedAtBySession[SK]).toBeUndefined();
  });

  it('清空任务时一并清掉（跟其它按会话存的界面态保持一致，别留孤儿）', () => {
    const store = makeStore();
    store.getState().setProcessing(SK, true);

    store.getState().clearMessages('t1');

    expect(store.getState().turnStartedAtBySession[SK]).toBeUndefined();
  });
});

/**
 * 整轮用时落账（2026-10-18 同事批次移植）。
 *
 * 为什么要本地量：网关给的 `message.durationMs` 是**单条消息生成时间** ——
 * 同事现场实测「4 分 46 秒的一轮，产物消息只报 0.4 秒、正文只报 1.8 秒」。
 * 用户看到的"用时"必须覆盖**发出 → 定稿**（含排队、工具等待、续写），
 * 所以起算点复用上面钉住的 `turnStartedAtBySession`。
 */
describe('message-store —— 整轮用时', () => {
  it('⭐ 定稿时写进 turn.durationMs（发出 → 定稿，不是单条消息耗时）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const store = makeStore();
    store.getState().setProcessing(SK, true);

    store.getState().appendStreamDelta(SK, '好的');
    vi.setSystemTime(new Date('2026-09-18T10:04:46.000Z'));
    store.getState().finalizeStream(SK);

    expect(store.getState().activeTurnBySession[SK]!.durationMs).toBe(4 * 60_000 + 46_000);
  });

  it('没有起算点（迟到事件 / 历史轮）⇒ 不瞎编一个数', () => {
    const store = makeStore();
    store.getState().appendStreamDelta(SK, '好的');
    store.getState().finalizeStream(SK);

    expect(store.getState().activeTurnBySession[SK]!.durationMs).toBeUndefined();
  });

  it('⭐ 真实 dispatcher 顺序：首字与 final 都会 setProcessing(false)，定稿仍算得出用时', () => {
    // 2026-10-18 独立审核抓到的真缺陷：等待相计时器（turnStartedAtBySession）在
    // 首个正文 delta 与 final 分支都会被删 ⇒ 复用它做"整轮起点"永远拿到 undefined。
    // 这里按真实顺序驱动：setProcessing(true) → 正文 → setProcessing(false) → finalize。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const store = makeStore();
    store.getState().setProcessing(SK, true);

    vi.setSystemTime(new Date('2026-09-18T10:00:30.000Z'));
    store.getState().appendStreamDelta(SK, '好');
    store.getState().setProcessing(SK, false); // dispatcher: 首个正文 delta 就会这么干

    vi.setSystemTime(new Date('2026-09-18T10:04:46.000Z'));
    store.getState().finalizeStream(SK); // dispatcher 的 final 分支：先 false、再 finalize

    expect(store.getState().activeTurnBySession[SK]!.durationMs).toBe(4 * 60_000 + 46_000);
  });

  it('⭐ 重复 finalize 不把用时越写越大（迟到/重复的 final 很常见）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const store = makeStore();
    store.getState().setProcessing(SK, true);
    vi.setSystemTime(new Date('2026-09-18T10:01:00.000Z'));
    store.getState().appendStreamDelta(SK, '好');
    store.getState().finalizeStream(SK);

    vi.setSystemTime(new Date('2026-09-18T10:05:00.000Z'));
    store.getState().finalizeStream(SK);

    expect(store.getState().activeTurnBySession[SK]!.durationMs).toBe(60_000);
  });

  it('第二轮重新计时，不继承上一轮', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const store = makeStore();
    store.getState().setProcessing(SK, true);
    vi.setSystemTime(new Date('2026-09-18T10:01:00.000Z'));
    store.getState().appendStreamDelta(SK, '一');
    store.getState().finalizeStream(SK);
    // 一轮结束 = 回到空闲（这里同时清掉起算点，与真实 setProcessing(false) 一致）。
    store.getState().setProcessing(SK, false);
    store.getState().clearActiveTurn(SK);

    vi.setSystemTime(new Date('2026-09-18T10:10:00.000Z'));
    store.getState().setProcessing(SK, true);
    vi.setSystemTime(new Date('2026-09-18T10:10:05.000Z'));
    store.getState().appendStreamDelta(SK, '二');
    store.getState().finalizeStream(SK);

    expect(store.getState().activeTurnBySession[SK]!.durationMs).toBe(5_000);
  });
});

/**
 * 起算点泄漏（2026-10-18 构建前自审）。
 *
 * `setProcessing(true)` 的打点规则是"只在缺失时打" —— 这条规则成立的前提是**每一条
 * 结束路径**都把打点清掉。自审发现两条漏网：网关历史收编（`promoteActiveTurn`）与
 * "打过点但还没写内容就被清理"的孤儿。漏掉一次，**下一轮**就不会重新打点 ⇒ 用时被算成
 * 从上一轮开始（10 分钟起步）。
 */
describe('message-store —— 整轮起算点不许泄漏到下一轮', () => {
  it('⭐ 网关历史收编（promote，没走 finalize）后，下一轮重新打点', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const store = makeStore();
    store.getState().setProcessing(SK, true);
    store.getState().appendStreamDelta(SK, '一');
    store.getState().promoteActiveTurn(SK, 't1', {
      id: 'm1',
      taskId: 't1',
      role: 'assistant',
      content: '一',
      artifacts: [],
      toolCalls: [],
      timestamp: '2026-09-18T10:00:10.000Z',
    });
    store.getState().setProcessing(SK, false);

    vi.setSystemTime(new Date('2026-09-18T10:10:00.000Z'));
    store.getState().setProcessing(SK, true);
    vi.setSystemTime(new Date('2026-09-18T10:10:05.000Z'));
    store.getState().appendStreamDelta(SK, '二');
    store.getState().finalizeStream(SK);

    expect(store.getState().activeTurnBySession[SK]!.durationMs).toBe(5_000);
  });

  it('⭐ 只打过点、还没写内容就被清理 ⇒ 孤儿打点一并清掉', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const store = makeStore();
    store.getState().setProcessing(SK, true);
    store.getState().clearActiveTurn(SK);
    store.getState().setProcessing(SK, false);

    vi.setSystemTime(new Date('2026-09-18T10:10:00.000Z'));
    store.getState().setProcessing(SK, true);
    vi.setSystemTime(new Date('2026-09-18T10:10:03.000Z'));
    store.getState().appendStreamDelta(SK, '二');
    store.getState().finalizeStream(SK);

    expect(store.getState().activeTurnBySession[SK]!.durationMs).toBe(3_000);
  });
});
