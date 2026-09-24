import { describe, expect, it } from 'vitest';
import { UnknownAgentError } from '@clawwork/core';
import { sendRefusalCopyKey } from '../src/renderer/lib/send-refusal';

describe('sendRefusalCopyKey', () => {
  it('助手不在本机 ⇒ 说「不在本机」（有确定的下一步：换一个助手）', () => {
    expect(sendRefusalCopyKey(new UnknownAgentError('team-agent-x'))).toBe('errors.agentMissing');
  });

  it('其它错误 ⇒ 仍是「助手无响应」（临时的，下一步是重试）', () => {
    expect(sendRefusalCopyKey(new Error('boom'))).toBe('errors.agentNotResponding');
    expect(sendRefusalCopyKey(undefined)).toBe('errors.agentNotResponding');
    expect(sendRefusalCopyKey('boom')).toBe('errors.agentNotResponding');
  });

  it('两句话必须是**两个不同的** key（压成一句就退化成误导）', () => {
    expect(sendRefusalCopyKey(new UnknownAgentError('x'))).not.toBe(sendRefusalCopyKey(new Error('x')));
  });
});
