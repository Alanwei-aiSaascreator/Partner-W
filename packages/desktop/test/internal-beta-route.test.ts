import { describe, expect, it } from 'vitest';
import { betaRoute, parseBetaRoute } from '../src/renderer/features/internal-beta/beta-route';

describe('internal beta route', () => {
  it('round trips every beta module through a stable hash route', () => {
    for (const module of ['operations', 'updates'] as const) {
      expect(parseBetaRoute(betaRoute(module))).toBe(module);
    }
  });

  it('rejects unknown or unrelated hashes', () => {
    expect(parseBetaRoute('#/beta/not-real')).toBeNull();
    expect(parseBetaRoute('#/chat')).toBeNull();
    // 已毕业的模块不再有路由（悬赏与成长中心现在在主界面）
    expect(parseBetaRoute('#/beta/bounty')).toBeNull();
    expect(parseBetaRoute('#/beta/game')).toBeNull();
    // P4：埋点分析（数据搬到运营看板）与隐私与合规（搬到设置页）也毕业了，
    //     老书签 / 老 hash 不能再把用户带回一个假页面
    expect(parseBetaRoute('#/beta/analytics')).toBeNull();
    expect(parseBetaRoute('#/beta/compliance')).toBeNull();
  });
});
