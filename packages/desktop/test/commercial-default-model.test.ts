import { describe, expect, it } from 'vitest';
import { resolveCommercialDefaultModel } from '../src/renderer/lib/commercial-default-model';

describe('resolveCommercialDefaultModel', () => {
  it('selects DeepSeek V4 Flash when available', () => {
    expect(
      resolveCommercialDefaultModel([
        { id: 'qwen3.5-27b', provider: 'clawrouter' },
        { id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' },
      ]),
    ).toEqual({ id: 'deepseek-v4-flash', provider: 'clawrouter', label: 'DeepSeek V4 Flash' });
  });

  it('matches provider-qualified ids', () => {
    expect(
      resolveCommercialDefaultModel([
        { id: 'clawrouter/deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' },
      ]),
    ).toEqual({
      id: 'clawrouter/deepseek-v4-flash',
      provider: 'clawrouter',
      label: 'DeepSeek V4 Flash',
    });
  });

  it('returns undefined instead of inventing an unavailable model', () => {
    expect(resolveCommercialDefaultModel([])).toBeUndefined();
  });
});
