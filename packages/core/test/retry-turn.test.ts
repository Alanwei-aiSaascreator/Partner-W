import { describe, expect, it } from 'vitest';
import type { Message, MessageAttachment } from '@clawwork/shared';
import { findRetryTarget } from '../src/services/retry-turn.js';

/**
 * 「重试」到底重发什么（B10）。
 *
 * 选的**不是**"最后一条消息"，而是**那条错误消息之前最近的一条用户消息** ——
 * 这两个在下面几乎每条用例里都不一样，正是本文件存在的理由。
 */

function msg(partial: Partial<Message> & { id: string; role: Message['role'] }): Message {
  return {
    taskId: 'task-1',
    content: '',
    artifacts: [],
    toolCalls: [],
    timestamp: '2026-09-19T00:00:00.000Z',
    ...partial,
  };
}

const ERR = 'msg-err';

describe('findRetryTarget —— 重发"最近的那条用户消息"', () => {
  it('错误紧跟在用户消息之后 ⇒ 重发它', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '你好' }),
      msg({ id: 'a1', role: 'assistant', content: '在的' }),
      msg({ id: 'u2', role: 'user', content: '帮我看看这个' }),
      msg({ id: ERR, role: 'system', content: 'stream: 请求过于频繁' }),
    ];

    expect(findRetryTarget(messages, ERR)).toEqual({ content: '帮我看看这个' });
  });

  it('中间隔了别的消息也要往回找到（错误不一定紧挨着）', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '跑一下' }),
      msg({ id: 'a1', role: 'assistant', content: '好的' }),
      msg({ id: 't1', role: 'assistant', content: '' }),
      msg({ id: ERR, role: 'system', content: 'stream: 超时' }),
    ];

    expect(findRetryTarget(messages, ERR)?.content).toBe('跑一下');
  });

  it('⭐ 取**最近**的一条，不是最早的一条', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '第一句' }),
      msg({ id: 'a1', role: 'assistant', content: '回答一' }),
      msg({ id: 'u2', role: 'user', content: '第二句' }),
      msg({ id: ERR, role: 'system', content: 'stream: 超时' }),
    ];

    expect(findRetryTarget(messages, ERR)?.content).toBe('第二句');
  });

  it('附件一起带回 —— 重发不能把文件悄悄丢掉', () => {
    // 丢掉附件的重发会得到一段**看起来一样、其实问的不是同一件事**的回答，
    // 而用户看不出来。宁可这次不给重试入口，也不能发个残缺的。
    const attachments: MessageAttachment[] = [
      {
        fileName: '报表.xlsx',
        dataUrl: 'data:application/vnd.ms-excel;base64,AAAA',
        mimeType: 'application/vnd.ms-excel',
        localPath: 'D:/x/报表.xlsx',
        size: 1024,
      },
    ];
    const messages = [
      msg({ id: 'u1', role: 'user', content: '看看这个表', attachments }),
      msg({ id: ERR, role: 'system', content: 'stream: 超时' }),
    ];

    expect(findRetryTarget(messages, ERR)).toEqual({ content: '看看这个表', attachments });
  });

  it('没有附件时**不带** attachments 这个键（别塞空数组）', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '在吗' }),
      msg({ id: ERR, role: 'system', content: 'stream: 超时' }),
    ];

    expect(findRetryTarget(messages, ERR)).toEqual({ content: '在吗' });
  });

  it('往前找不到用户消息 ⇒ null（不给一个点下去不知道会发生什么的按钮）', () => {
    const messages = [
      msg({ id: 'a1', role: 'assistant', content: '欢迎' }),
      msg({ id: ERR, role: 'system', content: 'stream: 超时' }),
    ];

    expect(findRetryTarget(messages, ERR)).toBeNull();
  });

  it('⚠️ 空白正文 ⇒ null（`send` 的正文是必填，替用户编一句发出去更糟）', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '   \n  ' }),
      msg({ id: ERR, role: 'system', content: 'stream: 超时' }),
    ];

    expect(findRetryTarget(messages, ERR)).toBeNull();
  });

  it('错误消息不在这个列表里（已删 / 换了任务）⇒ null', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '你好' }),
      msg({ id: 'a1', role: 'assistant', content: '在的' }),
    ];

    expect(findRetryTarget(messages, 'msg-not-here')).toBeNull();
  });

  it('错误消息**之前**的用户消息才算数 —— 之后的不许被选中', () => {
    // 顺序反了就会重发"用户已经打过的新一句"，等于替他做决定
    const messages = [
      msg({ id: 'u1', role: 'user', content: '旧的' }),
      msg({ id: ERR, role: 'system', content: 'stream: 超时' }),
      msg({ id: 'u2', role: 'user', content: '新的' }),
    ];

    expect(findRetryTarget(messages, ERR)?.content).toBe('旧的');
  });

  it('空列表 / 不存在的错误 ⇒ null（不抛）', () => {
    expect(findRetryTarget([], ERR)).toBeNull();
  });
});
