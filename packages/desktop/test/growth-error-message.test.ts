import { describe, expect, it } from 'vitest';
import { describeGrowthError } from '@clawwork/core';

describe('describeGrowthError', () => {
  it('认得的机器码给中文（与迁移 45/46/47 里的 raise 逐字对齐）', () => {
    expect(describeGrowthError('insufficient_growth')).toContain('成长值');
    expect(describeGrowthError('cannot_claim_own')).toContain('自己');
    expect(describeGrowthError('invalid_state')).toContain('状态');
    expect(describeGrowthError('bounty_not_found')).toContain('不存在');
    expect(describeGrowthError('invalid_reward')).toContain('10');
    expect(describeGrowthError('no_organization')).toContain('团队');
  });

  it('认不出的、空的、英文长句一律兜底中文，绝不回显原文', () => {
    for (const code of ['weird_code', undefined, '', 'permission denied for table bounties']) {
      const text = describeGrowthError(code);
      expect(text).not.toContain('permission denied');
      expect(text).not.toContain('weird_code');
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('原型链上的名字不当成码（`constructor`/`__proto__` 走兜底，不能返回函数/对象）', () => {
    // 同族第四例（community / growth / agent-template / privacy）统一收紧：
    // `MESSAGES[key] ?? fallback` 会命中原型链，返回的不是 string。
    expect(describeGrowthError('constructor')).toBe('操作没成功，请稍后重试。');
    expect(describeGrowthError('__proto__')).toBe('操作没成功，请稍后重试。');
  });
});
