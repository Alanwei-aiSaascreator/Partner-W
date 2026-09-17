import { describe, expect, it } from 'vitest';
import { betaRoute, parseBetaRoute } from '../src/renderer/features/internal-beta/beta-route';

describe('internal beta route', () => {
  it('round trips every beta module through a stable hash route', () => {
    for (const module of ['operations', 'updates', 'analytics', 'compliance'] as const) {
      expect(parseBetaRoute(betaRoute(module))).toBe(module);
    }
  });

  it('rejects unknown or unrelated hashes', () => {
    expect(parseBetaRoute('#/beta/not-real')).toBeNull();
    expect(parseBetaRoute('#/chat')).toBeNull();
    // 已毕业的模块不再有路由（悬赏与成长中心现在在主界面）
    expect(parseBetaRoute('#/beta/bounty')).toBeNull();
    expect(parseBetaRoute('#/beta/game')).toBeNull();
  });
});
