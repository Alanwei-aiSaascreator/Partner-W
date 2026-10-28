import { describe, expect, it } from 'vitest';
import { resolveCommercialDefaultModel } from '../src/renderer/lib/commercial-default-model';

/**
 * 商业默认模型：**与智能档一致 = GLM-5.3-Flashx**（2026-10-17 三档分模型后）。
 * 单一真源是 shared 的 `COMMERCIAL_DEFAULT_MODEL_ID`；本文件钉选择器行为。
 */
describe('resolveCommercialDefaultModel（默认 = 智能档 GLM-5.3-Flashx）', () => {
  it('selects GLM 5.3 Flashx when available', () => {
    expect(
      resolveCommercialDefaultModel([
        { id: 'qwen3.5-27b', provider: 'clawrouter' },
        { id: 'glm-5.3-flashx', provider: 'clawrouter', name: 'GLM 5.3 Flashx' },
      ]),
    ).toEqual({ id: 'glm-5.3-flashx', provider: 'clawrouter', label: 'GLM 5.3 Flashx' });
  });

  it('matches provider-qualified ids', () => {
    expect(
      resolveCommercialDefaultModel([
        { id: 'clawrouter/glm-5.3-flashx', provider: 'clawrouter', name: 'GLM 5.3 Flashx' },
      ]),
    ).toEqual({
      id: 'clawrouter/glm-5.3-flashx',
      provider: 'clawrouter',
      label: 'GLM 5.3 Flashx',
    });
  });

  it('returns undefined instead of inventing an unavailable model', () => {
    expect(resolveCommercialDefaultModel([])).toBeUndefined();
  });
});
