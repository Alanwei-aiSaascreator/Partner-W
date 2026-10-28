import { describe, expect, it } from 'vitest';
import { deriveSessionActivity, getTaskSessionKeys, pickWaitingSessionKey, type ActiveTurn } from '@clawwork/core';
import type { Task, TaskRoom } from '@clawwork/shared';

function turn(overrides: Partial<ActiveTurn>): ActiveTurn {
  return {
    id: 'turn-1',
    streamingText: '',
    streamingThinking: '',
    toolCalls: [],
    finalized: false,
    content: '',
    timestamp: '2026-04-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('session activity', () => {
  it('returns waiting for processing without renderable turn', () => {
    expect(deriveSessionActivity(['s1'], {}, new Set(['s1']))).toBe('waiting');
  });

  it('returns responding for streaming thinking', () => {
    expect(deriveSessionActivity(['s1'], { s1: turn({ streamingThinking: 'thinking' }) }, new Set())).toBe(
      'responding',
    );
  });

  it('returns tooling for tool-call-only active turns', () => {
    expect(
      deriveSessionActivity(
        ['s1'],
        {
          s1: turn({
            toolCalls: [{ id: 'tc-1', name: 'bash', status: 'running', startedAt: '2026-04-28T00:00:00.000Z' }],
          }),
        },
        new Set(),
      ),
    ).toBe('tooling');
  });

  it('ignores finalized turns', () => {
    expect(deriveSessionActivity(['s1'], { s1: turn({ finalized: true, content: 'done' }) }, new Set())).toBe('idle');
  });

  it('includes performer sessions for task rooms', () => {
    const task = { sessionKey: 'main' } as Task;
    const room = { performers: [{ sessionKey: 'performer' }] } as TaskRoom;

    expect(getTaskSessionKeys(task, room)).toEqual(['main', 'performer']);
  });
});

/**
 * `activity === 'waiting'` 时，界面要给**哪一个会话**渲染"等待中"的助手块。
 *
 * ## 为什么需要这个函数（2026-09-20 实机报障）
 *
 * 用户：「我发完要求，那个对话头像会消失一下，然后再给我反馈」。
 * 根因：等待时渲染的是**另一个组件**（`ThinkingIndicator`，它自带一个头像），
 * 内容一到就换成 `StreamingMessage`（另一个头像）——
 * 两个块各自淡入淡出、**同一帧里两个头像并存**（MutationObserver 实测抓到），
 * 看起来就是"头像闪一下"。
 *
 * 修法是让等待态也走 `StreamingMessage`、**用同一个 key**，React 复用同一个节点，
 * 头像从头到尾是同一个。这个函数就是"该给哪个会话渲染它"。
 */
describe('pickWaitingSessionKey', () => {
  it('正在处理、且还没有可渲染内容 ⇒ 就是它', () => {
    expect(pickWaitingSessionKey(['s1'], {}, new Set(['s1']))).toBe('s1');
  });

  it('有内容了（流式正文/推理）⇒ 不再是"等待中"（交给正常的流式块）', () => {
    expect(pickWaitingSessionKey(['s1'], { s1: turn({ streamingText: '你好' }) }, new Set(['s1']))).toBeUndefined();
    expect(pickWaitingSessionKey(['s1'], { s1: turn({ streamingThinking: '在想' }) }, new Set(['s1']))).toBeUndefined();
  });

  it('有工具调用了 ⇒ 也不算等待（那块已经在显示工具了）', () => {
    expect(
      pickWaitingSessionKey(['s1'], { s1: turn({ toolCalls: [{ id: 't', name: 'ls' }] as never }) }, new Set(['s1'])),
    ).toBeUndefined();
  });

  it('没在处理 ⇒ undefined（别在空闲时挂个"等待中"）', () => {
    expect(pickWaitingSessionKey(['s1'], {}, new Set())).toBeUndefined();
  });

  it('⭐ 多个会话时取**第一个**（与原来"只显示一个指示器"的行为一致）', () => {
    expect(pickWaitingSessionKey(['main', 'worker'], {}, new Set(['worker', 'main']))).toBe('main');
  });

  it('只有 worker 在跑 ⇒ 给它（并发派活时也能显示）', () => {
    expect(pickWaitingSessionKey(['main', 'worker'], {}, new Set(['worker']))).toBe('worker');
  });
});
