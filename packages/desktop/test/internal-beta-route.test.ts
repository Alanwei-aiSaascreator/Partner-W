import { describe, expect, it } from 'vitest';
import { betaRoute, parseBetaRoute } from '../src/renderer/features/internal-beta/beta-route';

describe('internal beta route', () => {
  it('round trips every beta module through a stable hash route', () => {
    for (const module of [
      'team',
      'market',
      'bounty',
      'square',
      'creator',
      'game',
      'operations',
      'updates',
      'analytics',
      'compliance',
    ] as const) {
      expect(parseBetaRoute(betaRoute(module))).toBe(module);
    }
  });

  it('rejects unknown or unrelated hashes', () => {
    expect(parseBetaRoute('#/beta/not-real')).toBeNull();
    expect(parseBetaRoute('#/chat')).toBeNull();
  });
});
