import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * preload 是**唯一的桥**：渲染进程只能通过 `window.clawwork.*` 说话。
 * 这里用源码文本断言盯着"方法名 ↔ 通道名 ↔ 类型声明"三处不许漂
 * （与 `market-preload-surface.test.ts` 同款）。
 */
const preload = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8');
const types = readFileSync(join(__dirname, '../src/preload/clawwork.d.ts'), 'utf8');

describe('preload 暴露的成长 / 悬赏接口', () => {
  it.each([
    ['growthSummary', 'growth:summary'],
    ['growthCheckIn', 'growth:check-in'],
    ['growthHistory', 'growth:history'],
    ['bountyList', 'bounty:list'],
    ['bountyCreate', 'bounty:create'],
    ['bountyClaim', 'bounty:claim'],
    ['bountyRelease', 'bounty:release'],
    ['bountySubmit', 'bounty:submit'],
    ['bountyAccept', 'bounty:accept'],
    ['bountyReject', 'bounty:reject'],
    ['bountyCancel', 'bounty:cancel'],
  ])('%s → %s（且类型声明里有它）', (method, channel) => {
    expect(preload).toContain(method);
    expect(preload).toContain(channel);
    expect(types).toContain(`${method}:`);
  });
});
