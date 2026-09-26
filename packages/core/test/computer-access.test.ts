import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPUTER_ACCESS_TIER,
  decidePermissionPatch,
  type AppliedPermissionMode,
} from '../src/services/computer-access.js';

/**
 * 「电脑操控权限」两档：把 spec §2.5 那条规则钉死。
 *
 * 规则三句话：
 *   ① 开着的档位必须在你说得上话的每个会话里都成立；
 *   ② 关着的档位**不去动**历史状态；
 *   ③ 补刀只补一次（进程内记账）。
 *
 * ⚠️ 这里断言的是**精确串**（`'full'` / `'guarded'` / `null`），不是 `toContain`
 *    —— 本项目栽过"存在性断言绑不住值"的当（见 memory: stale-green-tests）。
 */
const applied = (...pairs: Array<[string, AppliedPermissionMode]>) => new Map<string, AppliedPermissionMode>(pairs);

describe('DEFAULT_COMPUTER_ACCESS_TIER', () => {
  it('默认必须是安全档', () => {
    expect(DEFAULT_COMPUTER_ACCESS_TIER).toBe('safe');
  });
});

describe('decidePermissionPatch', () => {
  describe('安全档：不去动历史状态（判据 1）', () => {
    it('没记过账 ⇒ 一次都不 patch', () => {
      expect(decidePermissionPatch({ tier: 'safe', sessionKey: 'agent:main:a', applied: applied() })).toBeNull();
    });

    it('别的会话记过账，不影响这个会话', () => {
      const map = applied(['agent:main:other', 'full']);
      expect(decidePermissionPatch({ tier: 'safe', sessionKey: 'agent:main:a', applied: map })).toBeNull();
    });

    it('本会话原本就是我们设的 guarded ⇒ 不重复补刀', () => {
      const map = applied(['agent:main:a', 'guarded']);
      expect(decidePermissionPatch({ tier: 'safe', sessionKey: 'agent:main:a', applied: map })).toBeNull();
    });

    it('本会话被我们开过全权 ⇒ 关掉时要真的收回（判据 5）', () => {
      const map = applied(['agent:main:a', 'full']);
      expect(decidePermissionPatch({ tier: 'safe', sessionKey: 'agent:main:a', applied: map })).toBe('guarded');
    });
  });

  describe('全权档：在说得上话的每个会话里都成立（判据 3）', () => {
    it('没记过账 ⇒ 补一刀 full', () => {
      expect(decidePermissionPatch({ tier: 'full', sessionKey: 'agent:main:a', applied: applied() })).toBe('full');
    });

    it('已经记过 full ⇒ 不重复补刀', () => {
      const map = applied(['agent:main:a', 'full']);
      expect(decidePermissionPatch({ tier: 'full', sessionKey: 'agent:main:a', applied: map })).toBeNull();
    });

    it('记过的是 guarded（刚被关过）⇒ 再打开要重新补 full', () => {
      const map = applied(['agent:main:a', 'guarded']);
      expect(decidePermissionPatch({ tier: 'full', sessionKey: 'agent:main:a', applied: map })).toBe('full');
    });

    it('别的会话记过 full，这个会话没记过 ⇒ 这个会话仍要补', () => {
      const map = applied(['agent:main:other', 'full']);
      expect(decidePermissionPatch({ tier: 'full', sessionKey: 'agent:main:a', applied: map })).toBe('full');
    });
  });

  it('全权↔安全来回切：每次翻转都恰好补一刀，之后安静', () => {
    const map = new Map<string, AppliedPermissionMode>();
    const step = (tier: 'safe' | 'full') => {
      const p = decidePermissionPatch({ tier, sessionKey: 'k', applied: map });
      if (p) map.set('k', p);
      return p;
    };
    expect(step('full')).toBe('full');
    expect(step('full')).toBeNull();
    expect(step('safe')).toBe('guarded');
    expect(step('safe')).toBeNull();
    expect(step('full')).toBe('full');
    expect(step('full')).toBeNull();
  });
});
