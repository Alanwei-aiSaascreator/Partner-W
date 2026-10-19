import { describe, expect, it } from 'vitest';
import { enqueueSend, pendingSendCount, shiftSendForTask, type QueuedSend } from '../src/renderer/lib/chat-queue.js';

/**
 * 「运行中追加对话不打断模型」（2026-10-17 用户需求）。
 *
 * 语义：模型正在跑时用户又发一条 ⇒ **排队**，等这一轮回到 idle 再自动发出去；
 * 排队项按任务绑定（切到别的任务不会把 A 的话发进 B），同一任务内 FIFO，同文不重复排。
 */
const item = (id: string, taskId: string, text: string): QueuedSend => ({ id, taskId, text });

describe('enqueueSend', () => {
  it('按顺序追加', () => {
    const q = enqueueSend([], item('1', 't1', '第一条'));
    const q2 = enqueueSend(q, item('2', 't1', '第二条'));
    expect(q2.map((entry) => entry.text)).toEqual(['第一条', '第二条']);
  });

  it('同任务同文本不重复排（防止连按 Enter 刷出一串一样的请求）', () => {
    const q = enqueueSend([item('1', 't1', '继续')], item('2', 't1', '继续'));
    expect(q).toHaveLength(1);
    expect(q[0].id).toBe('1');
  });

  it('不同任务同文本各自排队（不串任务）', () => {
    const q = enqueueSend([item('1', 't1', '继续')], item('2', 't2', '继续'));
    expect(q).toHaveLength(2);
  });

  it('空白文本不入队', () => {
    expect(enqueueSend([], item('1', 't1', '   '))).toEqual([]);
  });
});

describe('shiftSendForTask', () => {
  it('只取本任务的第一条，别的任务原样留队', () => {
    const q = [item('1', 't1', 'a'), item('2', 't2', 'b'), item('3', 't1', 'c')];
    const result = shiftSendForTask(q, 't1');
    expect(result.next?.text).toBe('a');
    expect(result.rest.map((entry) => entry.id)).toEqual(['2', '3']);
  });

  it('本任务没有排队 ⇒ next 为 null，队列不变', () => {
    const q = [item('1', 't2', 'b')];
    const result = shiftSendForTask(q, 't1');
    expect(result.next).toBeNull();
    expect(result.rest).toBe(q);
  });

  it('空队列 ⇒ null + 空数组', () => {
    expect(shiftSendForTask([], 't1')).toEqual({ next: null, rest: [] });
  });
});

describe('pendingSendCount', () => {
  it('只数本任务', () => {
    const q = [item('1', 't1', 'a'), item('2', 't2', 'b'), item('3', 't1', 'c')];
    expect(pendingSendCount(q, 't1')).toBe(2);
    expect(pendingSendCount(q, 't9')).toBe(0);
  });
});
