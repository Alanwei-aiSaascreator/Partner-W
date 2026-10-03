import { describe, expect, it } from 'vitest';
import {
  createRelayLivenessPublicStateStore,
  relayLivenessPublicStateStore,
  type RelayLivenessPhase,
  type RelayLivenessPublicState,
} from '../src/index.js';

/**
 * relay 存活公开状态 —— 与 `commercial-relay-state.test.ts` 同一条纪律：
 * 严格单调 updatedAt、字段闭集、退订真退、订阅者抛错不伤别人。
 */
describe('relay 存活公开状态 store', () => {
  it('初始态是 unknown（还没探过）', () => {
    const store = createRelayLivenessPublicStateStore({ now: () => 1_000 });
    expect(store.get()).toEqual({ phase: 'unknown', updatedAt: 1_000 });
  });

  it('⭐ updatedAt 严格递增：时钟不动也一次比一次大', () => {
    const store = createRelayLivenessPublicStateStore({ now: () => 5_000 });
    const first = store.set({ phase: 'up' });
    const second = store.set({ phase: 'down' });
    expect(first.updatedAt).toBe(5_001);
    expect(second.updatedAt).toBe(5_002);
  });

  it('⭐ 时钟倒退也不许让 updatedAt 变小', () => {
    let t = 10_000;
    const store = createRelayLivenessPublicStateStore({ now: () => t });
    const first = store.set({ phase: 'up' });
    t = 1;
    expect(store.set({ phase: 'down' }).updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it('⭐ 载荷字段是闭集（phase / updatedAt 一个不多）', () => {
    const store = createRelayLivenessPublicStateStore({ now: () => 1_000 });
    for (const phase of ['unknown', 'up', 'down'] as const) {
      expect(Object.keys(store.set({ phase })).sort()).toEqual(['phase', 'updatedAt']);
    }
  });

  it('🔴 `as` 硬塞的多余字段进不来', () => {
    const store = createRelayLivenessPublicStateStore({ now: () => 1_000 });
    const smuggled = { phase: 'down', detail: 'raw message' } as { phase: 'down' };
    const state = store.set(smuggled);
    expect(Object.keys(state).sort()).toEqual(['phase', 'updatedAt']);
    expect(JSON.stringify(state)).not.toContain('detail');
  });

  it('⭐ 每次 set 都通知；退订幂等；订阅者抛错不伤别人与状态', () => {
    const store = createRelayLivenessPublicStateStore({ now: () => 1_000 });
    const seen: RelayLivenessPublicState[] = [];
    const unsub = store.subscribe((s) => seen.push(s));
    store.subscribe(() => {
      throw new Error('boomer');
    });
    store.subscribe((s) => seen.push(s));
    expect(() => store.set({ phase: 'up' })).not.toThrow();
    expect(seen.map((s) => s.phase)).toEqual(['up', 'up']);
    unsub();
    unsub();
    const before = seen.length;
    store.set({ phase: 'down' });
    expect(seen.length, '幸存订阅者收到 1 条、被退订的那个没收到').toBe(before + 1);
    expect(seen[seen.length - 1]?.phase).toBe('down');
    expect(store.get().phase).toBe('down');
  });

  it('⭐⭐ 相位恰好是这三个（闭集护栏）', () => {
    const ALL: Record<RelayLivenessPhase, true> = { unknown: true, up: true, down: true };
    expect(Object.keys(ALL)).toHaveLength(3);
  });

  it('单例存在且可写', () => {
    relayLivenessPublicStateStore.set({ phase: 'down' });
    expect(relayLivenessPublicStateStore.get().phase).toBe('down');
    relayLivenessPublicStateStore.set({ phase: 'unknown' });
  });
});
