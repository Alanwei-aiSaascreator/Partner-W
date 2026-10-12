import { describe, expect, it } from 'vitest';
import { modelVendor, vendorsDistinct } from '../src/renderer/features/team-meeting/vendor';

/**
 * 「审核必须换另一家厂商」的厂商标识（2026-10-10 Cephalon 批补测）。
 *
 * 新增平台计费 ID `deepseek-v4-flash-cephalon` 属于**同一家族（deepseek）** ——
 * 换中转渠道不是换厂商：`vendorsDistinct` 对它与旧 `deepseek-v4-flash` 必须为 false，
 * 不能靠"换渠道"冒充跨厂商审核（团队开会的审核轮判据）。
 */
describe('modelVendor / vendorsDistinct（Cephalon 批）', () => {
  it('新旧两条 DeepSeek 渠道同厂（含 clawrouter/ 引用写法）', () => {
    expect(modelVendor('deepseek-v4-flash-cephalon')).toBe('deepseek');
    expect(modelVendor('clawrouter/deepseek-v4-flash-cephalon')).toBe('deepseek');
    expect(vendorsDistinct('deepseek-v4-flash-cephalon', 'deepseek-v4-flash')).toBe(false);
    expect(vendorsDistinct('clawrouter/deepseek-v4-flash-cephalon', 'clawrouter/deepseek-v4-flash')).toBe(false);
  });

  it('GLM 与 DeepSeek 属不同厂商（跨厂商审核的判据照常成立）', () => {
    expect(modelVendor('glm-5.3-flash')).toBe('glm');
    expect(vendorsDistinct('glm-5.3-flash', 'deepseek-v4-flash-cephalon')).toBe(true);
  });

  it('认不出来的厂商不误拦（任一侧未知 ⇒ 视为满足）', () => {
    expect(vendorsDistinct('', 'deepseek-v4-flash-cephalon')).toBe(true);
    expect(vendorsDistinct('some-unknown-model', 'deepseek-v4-flash')).toBe(true);
  });
});
