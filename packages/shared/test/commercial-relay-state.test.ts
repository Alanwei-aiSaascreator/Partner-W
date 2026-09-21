import { describe, expect, it } from 'vitest';
import {
  createRelayBootstrapPublicStateStore,
  relayBootstrapPublicStateStore,
  resetRelayBootstrapPublicState,
  type RelayBootstrapBlockedCode,
  type RelayBootstrapPhase,
  type RelayBootstrapPublicState,
  type RelayBootstrapRetryableCode,
} from '../src/index.js';

/**
 * 中转 bootstrap 的**对外状态**（渲染层唯一能看到的那份结论）。
 *
 * ## 三条真正的性质（写在这里，是为了让它们**不靠调用方自觉**）
 *
 * 1. **严格单调的 `updatedAt`** —— 渲染层按它取舍（晚到的初始读不许覆盖新事件）。
 *    同一毫秒里连翻两次是常态（登录先把陈旧的 `blocked` 清成 `idle`、紧接着进入
 *    `running`），时间戳相等就分不出先后 —— 界面可能倒回陈旧的结论。
 * 2. **载荷字段是闭集** —— `phase` / `errorCode` / `updatedAt`，一个不多。
 *    多了 `detail` / 原始 message / 卡密 / relay key / token 就是把有密的东西
 *    送进渲染层（`activate_license` 的入参就是卡密）。
 * 3. **`subscribe` 的退订真的退掉** —— 主进程靠它把状态转发成渲染层事件，
 *    退不掉的订阅在同一次会话里会越积越多（每建一次窗口就多一份）。
 */
describe('公开状态的 store', () => {
  it('初始态是 idle（还没跑过任何一轮）', () => {
    const store = createRelayBootstrapPublicStateStore({ now: () => 1_000 });

    expect(store.get()).toEqual({ phase: 'idle', updatedAt: 1_000 });
  });

  it('set 之后 get 拿到的就是刚写进去的那条（含安全码）', () => {
    const store = createRelayBootstrapPublicStateStore({ now: () => 1_000 });

    store.set({ phase: 'blocked', errorCode: 'license_bound_elsewhere' });

    expect(store.get()).toEqual({ phase: 'blocked', errorCode: 'license_bound_elsewhere', updatedAt: 1_001 });
  });

  it('⭐⭐ updatedAt **严格**递增：时钟不动也一次比一次大（渲染层按它取舍，相等就分不出先后）', () => {
    // 冻结时钟 = 同一毫秒里连翻两次。这不是异常场景：登录成功那条路就是
    // "清成 idle" 与 "推成 running" 两行紧挨着的代码。
    const store = createRelayBootstrapPublicStateStore({ now: () => 5_000 });

    const first = store.set({ phase: 'idle' });
    const second = store.set({ phase: 'running' });
    const third = store.set({ phase: 'ready' });

    expect(first.updatedAt).toBe(5_001);
    expect(second.updatedAt, '同一毫秒里的第二次转变必须比第一次大').toBe(5_002);
    expect(third.updatedAt).toBe(5_003);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(third.updatedAt).toBeGreaterThan(second.updatedAt);
  });

  it('⭐⭐ 时钟倒退（系统时间被改过）也不许让 updatedAt 变小', () => {
    let t = 10_000;
    const store = createRelayBootstrapPublicStateStore({ now: () => t });

    const first = store.set({ phase: 'running' });
    t = 1; // 用户把系统时间调回去了
    const second = store.set({ phase: 'ready' });

    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it('⭐ 载荷字段是闭集：带码的相位带 errorCode，不带码的相位一个都不多', () => {
    const store = createRelayBootstrapPublicStateStore({ now: () => 1_000 });

    const samples: Array<[Parameters<typeof store.set>[0], string[]]> = [
      [{ phase: 'idle' }, ['phase', 'updatedAt']],
      [{ phase: 'running' }, ['phase', 'updatedAt']],
      [{ phase: 'ready' }, ['phase', 'updatedAt']],
      [{ phase: 'blocked', errorCode: 'license_required' }, ['errorCode', 'phase', 'updatedAt']],
      [{ phase: 'retryable-error', errorCode: 'transport' }, ['errorCode', 'phase', 'updatedAt']],
    ];

    for (const [input, expectedKeys] of samples) {
      const state = store.set(input);
      expect(Object.keys(state).sort(), `${input.phase} 的字段集`).toEqual(expectedKeys);
    }
  });

  it('⭐ 每次 set 都通知订阅者；退订之后不再通知（且退订可以调两次）', () => {
    const store = createRelayBootstrapPublicStateStore({ now: () => 1_000 });
    const seen: RelayBootstrapPublicState[] = [];
    const unsubscribe = store.subscribe((state) => seen.push(state));

    store.set({ phase: 'running' });
    store.set({ phase: 'ready' });
    expect(seen.map((s) => s.phase)).toEqual(['running', 'ready']);

    unsubscribe();
    store.set({ phase: 'blocked', errorCode: 'license_required' });
    expect(seen, '退订之后不该再收到').toHaveLength(2);

    expect(() => unsubscribe(), '退订要幂等（调用方可能既在清理里退、又在卸载里退）').not.toThrow();
    expect(seen).toHaveLength(2);
  });

  it('⭐ 订阅者只有一个时也不许把通知顺序搞乱（先写状态、再通知）', () => {
    const store = createRelayBootstrapPublicStateStore({ now: () => 1_000 });
    const atNotify: RelayBootstrapPublicState[] = [];
    store.subscribe(() => atNotify.push(store.get()));

    store.set({ phase: 'ready' });

    expect(atNotify[0]).toEqual({ phase: 'ready', updatedAt: 1_001 });
  });

  it('⭐⭐ 一个订阅者抛错：不许打断其余订阅者，也不许把状态写坏', () => {
    // 主进程那条"转发给渲染层"的桥就是订阅者之一 —— 它抛了（窗口正在销毁、
    // send 失败…）不该连带把别的订阅者与状态本身一起废掉。
    const store = createRelayBootstrapPublicStateStore({ now: () => 1_000 });
    const seen: string[] = [];
    store.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    store.subscribe((state) => seen.push(state.phase));

    expect(() => store.set({ phase: 'ready' })).not.toThrow();
    expect(seen, '排在抛错订阅者后面的那个照样要收到').toEqual(['ready']);
    expect(store.get(), '状态已经写下去了，不许回滚/停在旧值').toEqual({ phase: 'ready', updatedAt: 1_001 });
  });

  it('🔴 多余字段进不来：显式挑选把 `as` 硬塞的字段挡在门外（结构性保证，不靠类型）', () => {
    const store = createRelayBootstrapPublicStateStore({ now: () => 1_000 });
    // 用 `as` 绕过类型（真实世界里正是这么漏的：有人顺手把 result.detail 摊进来）。
    const smuggled = { phase: 'blocked', errorCode: 'license_bound_elsewhere', detail: 'raw server message' } as {
      phase: 'blocked';
      errorCode: 'license_bound_elsewhere';
    };

    const state = store.set(smuggled);

    expect(Object.keys(state).sort()).toEqual(['errorCode', 'phase', 'updatedAt']);
    expect(JSON.stringify(state)).not.toContain('detail');
  });
});

describe('进程级单例与账户边界重置', () => {
  it('reset 之后退回 idle（登录 / 登出都靠它作废旧账号的结论）', () => {
    relayBootstrapPublicStateStore.set({ phase: 'blocked', errorCode: 'license_bound_elsewhere' });

    resetRelayBootstrapPublicState();

    expect(relayBootstrapPublicStateStore.get()).toMatchObject({ phase: 'idle' });
  });

  it('reset 也是一次**转变**：时间戳跟着往前，不许停在旧值上', () => {
    const before = relayBootstrapPublicStateStore.set({ phase: 'ready' });

    resetRelayBootstrapPublicState();

    expect(relayBootstrapPublicStateStore.get().updatedAt).toBeGreaterThan(before.updatedAt);
  });
});

/**
 * 闭集护栏（三个联合各一份字面量）。
 *
 * 这些联合是**渲染层与主进程之间的契约**（多一个成员 = 界面渲染一句不存在的话；
 * 少一个成员 = 某种失败永远说不出来）。字面量清单把两头封住：
 *   · 联合**少**一个成员 ⇒ 这里多一个键 ⇒ 编译失败；
 *   · 联合**多**一个成员 ⇒ 这里少一个键 ⇒ 编译失败。
 * 运行期那半句（写入方只会写清单里的相位与码）由 desktop 的映射用例钉。
 *
 * 📏 来源（**两处**，别写成一处 —— 它们在两份不同的文档里）：
 *   - `phase` 五个成员 ← 设计文档 "Renderer visibility" 的载荷句
 *     `docs/superpowers/specs/2026-09-21-multi-org-license-bootstrap-design.md:134-135`；
 *   - 两个 `errorCode` 联合 ← 计划 Task 3 Step 1 的 DTO
 *     `docs/superpowers/plans/2026-09-21-multi-org-license-bootstrap-recovery.md:286-304`。
 *   ⚠️ 设计文档里**没有** `RelayBootstrapPublicState` 这个名字（全仓只有计划 :286 有）。
 */
describe('闭集的护栏', () => {
  it('⭐⭐ phase 恰好是这五个（含"带码"的两个分支）', () => {
    const ALL: Record<RelayBootstrapPhase, true> = {
      idle: true,
      running: true,
      ready: true,
      blocked: true,
      'retryable-error': true,
    };
    expect(Object.keys(ALL)).toHaveLength(5);
  });

  it('⭐⭐ blocked 的码恰好是这七个', () => {
    const ALL: Record<RelayBootstrapBlockedCode, true> = {
      license_required: true,
      license_bound_elsewhere: true,
      license_not_found: true,
      license_inactive: true,
      license_expired: true,
      activation_limit_reached: true,
      activation_failed: true,
    };
    expect(Object.keys(ALL)).toHaveLength(7);
  });

  it('⭐⭐ retryable-error 的码恰好是这四个', () => {
    const ALL: Record<RelayBootstrapRetryableCode, true> = {
      auth_unavailable: true,
      transport: true,
      runtime_not_ready: true,
      relay_apply_failed: true,
    };
    expect(Object.keys(ALL)).toHaveLength(4);
  });
});
