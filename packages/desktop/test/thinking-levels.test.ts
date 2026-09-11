import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from '@clawwork/shared';
import {
  FALLBACK_THINKING_LEVELS,
  isThinkingSupported,
  thinkingDefaultFor,
  thinkingLevelsFor,
  thinkingMenuFor,
} from '../src/renderer/components/ChatInput/thinking-levels.js';

/** 造一条目录项；`levels` 用 `undefined` 表示**没有**该字段。 */
function entry(id: string, levels?: string[], thinkingDefault?: string): ModelCatalogEntry {
  const e: Record<string, unknown> = { id, provider: 'clawrouter' };
  if (levels !== undefined) e.thinkingLevels = levels.map((l) => ({ id: l, label: l }));
  if (thinkingDefault !== undefined) e.thinkingDefault = thinkingDefault;
  return e as ModelCatalogEntry;
}

describe('thinkingLevelsFor —— 参数化：不同目录 → 不同档位集合', () => {
  // 取值来自 2026-09-11 实测的 11 个中转模型
  const cases: Array<{ name: string; entry: ModelCatalogEntry | undefined; expected: string[] }> = [
    // 8/11 只支持 off —— 用户就是在这类模型上点「中」失败的
    { name: 'deepseek-r1（只支持 off）', entry: entry('deepseek-r1', ['off'], 'off'), expected: ['off'] },
    { name: 'qwen3.6-plus（只支持 off）', entry: entry('qwen3.6-plus', ['off'], 'off'), expected: ['off'] },
    { name: 'glm-4.6（只支持 off）', entry: entry('glm-4.6', ['off'], 'off'), expected: ['off'] },
    // 3/11 支持完整梯子 —— 注意**没有 adaptive**
    {
      name: 'deepseek-v4-flash（完整梯子）',
      entry: entry('deepseek-v4-flash', ['off', 'minimal', 'low', 'medium', 'high'], 'medium'),
      expected: ['off', 'minimal', 'low', 'medium', 'high'],
    },
    {
      name: 'deepseek-v3.2（完整梯子）',
      entry: entry('deepseek-v3.2', ['off', 'minimal', 'low', 'medium', 'high'], 'medium'),
      expected: ['off', 'minimal', 'low', 'medium', 'high'],
    },
    // 我们没见过的 id 要原样透传，不能丢
    { name: '含未知档位 xhigh', entry: entry('m', ['off', 'high', 'xhigh']), expected: ['off', 'high', 'xhigh'] },
    // 数据缺失 → 回退固定 6 档（回滚行为）
    { name: '没有 thinkingLevels 字段', entry: entry('m'), expected: FALLBACK_THINKING_LEVELS },
    { name: 'thinkingLevels 为空数组', entry: entry('m', []), expected: FALLBACK_THINKING_LEVELS },
    { name: '没有目录项（目录为空/未加载）', entry: undefined, expected: FALLBACK_THINKING_LEVELS },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(thinkingLevelsFor(c.entry)).toEqual(c.expected);
    });
  }
});

describe('thinkingMenuFor —— 只支持一档时要置灰', () => {
  it('只支持 off → locked（界面不给必然失败的选项）', () => {
    expect(thinkingMenuFor(entry('deepseek-r1', ['off'], 'off'))).toEqual({ levels: ['off'], locked: true });
  });

  it('多档 → 不锁', () => {
    expect(thinkingMenuFor(entry('m', ['off', 'high'])).locked).toBe(false);
  });

  it('数据缺失 → 不锁（回滚到今天的 6 档行为）', () => {
    expect(thinkingMenuFor(entry('m')).locked).toBe(false);
  });
});

describe('thinkingDefaultFor —— 切模型回落的依据', () => {
  it('用目录声明的 thinkingDefault', () => {
    expect(thinkingDefaultFor(entry('deepseek-v4-flash', ['off', 'minimal', 'low', 'medium', 'high'], 'medium'))).toBe(
      'medium',
    );
  });

  it('没声明时取第一档', () => {
    expect(thinkingDefaultFor(entry('deepseek-r1', ['off']))).toBe('off');
  });

  it('什么都没有时给 off', () => {
    expect(thinkingDefaultFor(undefined)).toBe('off');
  });
});

describe('isThinkingSupported —— 切模型判断当前档位还能不能用', () => {
  it('r1 上 medium 不支持（就是用户踩的那个）', () => {
    expect(isThinkingSupported(entry('deepseek-r1', ['off'], 'off'), 'medium')).toBe(false);
  });

  it('v4-flash 上 medium 支持', () => {
    expect(isThinkingSupported(entry('m', ['off', 'minimal', 'low', 'medium', 'high'], 'medium'), 'medium')).toBe(true);
  });

  it('数据缺失时一律放行，不误伤', () => {
    expect(isThinkingSupported(entry('m'), 'medium')).toBe(true);
    expect(isThinkingSupported(undefined, 'adaptive')).toBe(true);
  });
});
