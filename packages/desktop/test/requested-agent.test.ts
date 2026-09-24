import { describe, expect, it } from 'vitest';
import { resolveRequestedAgent } from '../src/renderer/lib/requested-agent';

const loaded = { agents: [{ id: 'main' }] };

describe('resolveRequestedAgent', () => {
  it('目录还没拉回来时判 loading，不许判缺失', () => {
    expect(resolveRequestedAgent('team-agent-x', undefined)).toBe('loading');
  });

  it('目录已加载且请求在里面时判 ok', () => {
    expect(resolveRequestedAgent('main', loaded)).toBe('ok');
  });

  it('没有请求时判 ok（用默认助手）', () => {
    expect(resolveRequestedAgent('', loaded)).toBe('ok');
    expect(resolveRequestedAgent(undefined, loaded)).toBe('ok');
  });

  it('目录已加载、请求非空且不在里面时判 missing', () => {
    expect(resolveRequestedAgent('team-agent-x', loaded)).toBe('missing');
  });

  it('目录已加载但为空时，非空请求判 missing', () => {
    expect(resolveRequestedAgent('team-agent-x', { agents: [] })).toBe('missing');
  });
});
