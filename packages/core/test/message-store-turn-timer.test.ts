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
