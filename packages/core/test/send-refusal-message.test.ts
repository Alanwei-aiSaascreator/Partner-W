import { describe, expect, it } from 'vitest';
import { describeSendRefusal } from '../src/services/send-refusal-message';
import { UnknownAgentError } from '../src/stores/task-store';

/** 假的 `t`：直接把 key 透出来，这样断言绑的是"说了哪句话"而不是译文。 */
const t = (key: string): string => key;

describe('describeSendRefusal', () => {
  it('助手不在本机 ⇒ 说「不在本机」（有确定的下一步：换一个助手）', () => {
    expect(describeSendRefusal(new UnknownAgentError('team-agent-x'), t)).toBe('errors.agentMissing');
  });

  it('其它错误 ⇒ 仍是「助手无响应」（临时的，下一步是重试）', () => {
    expect(describeSendRefusal(new Error('boom'), t)).toBe('errors.agentNotResponding');
    expect(describeSendRefusal(undefined, t)).toBe('errors.agentNotResponding');
    expect(describeSendRefusal('boom', t)).toBe('errors.agentNotResponding');
  });

  it('两句话必须是**两个不同的** key（压成一句就退化成误导）', () => {
    expect(describeSendRefusal(new UnknownAgentError('x'), t)).not.toBe(describeSendRefusal(new Error('x'), t));
  });
});
