import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「本次任务累计消耗」**只能有一个记账来源**（2026-10-18 用户：「积分使用好像对不上」）。
 *
 * 背景：`turnSpend`（回合结束 after-before）与 `tokenUsedMicros` 增量（本组件观察许可证
 * 总量增长）是**同一笔服务端消耗**的两个视角。两边都往 `addTurnSpend` 里加一次 =
 * 双计（显示 0.32 实际应 0.64）。`task-spend.ts` 的 `at` 去重挡不住这种双源——两者的
 * `at` 必然不同。
 *
 * ⇒ 结构守卫：MainArea 里不允许再把 `turnSpend.micros / turnSpend.at` 塞进 `addTurnSpend`。
 *    （本轮展示仍可用 `turnSpend`，那条是本轮消耗那一行。）
 */
describe('任务累计消耗：单一记账来源', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'layouts', 'MainArea', 'index.tsx'),
    'utf-8',
  );

  it('保留 tokenUsedMicros 增量这条来源（能覆盖异步结算）', () => {
    expect(source).toContain('usedMicros - previous');
    expect(source).toMatch(/addTurnSpend\(\s*prev,\s*activeTaskId,\s*delta/);
  });

  it('⭐ 不再把 turnSpend 也加进累计（否则同一笔消耗计两次）', () => {
    expect(source).not.toMatch(/addTurnSpend\([^;]*turnSpend/i);
  });
});
