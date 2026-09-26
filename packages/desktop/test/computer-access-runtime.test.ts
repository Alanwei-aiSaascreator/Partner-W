import { describe, expect, it } from 'vitest';
import {
  computerAccessRevision,
  createComputerAccessDep,
  normalizeComputerAccessTier,
  permissionModeForTier,
  rememberPermissionMode,
  sessionsToRevoke,
  subscribeComputerAccessRevision,
} from '../src/renderer/lib/computer-access-runtime';
import type { AppliedPermissionRecord } from '@clawwork/core';

/**
 * 桌面端那一层：把「设置里的一个字符串」翻译成 composer 认识的档位。
 *
 * ⚠️ 这一组里**最要紧的是 fail-closed**：设置读不出来 / 值不认识时必须是**安全档**。
 *    搞反了就是"配置坏掉反而放开权限"——本项目栽过"读取期兜底方向反了"的当。
 */
describe('normalizeComputerAccessTier', () => {
  it("认得 'full'", () => {
    expect(normalizeComputerAccessTier('full')).toBe('full');
  });

  it.each([
    ['safe', 'safe'],
    [undefined, 'safe'],
    [null, 'safe'],
    ['', 'safe'],
    ['FULL', 'safe'],
    ['full ', 'safe'],
    ['yolo', 'safe'],
    [1, 'safe'],
    [{}, 'safe'],
    [[], 'safe'],
  ])('认不出的一律当安全档：%p → %p', (input, expected) => {
    expect(normalizeComputerAccessTier(input)).toBe(expected);
  });
});

describe('permissionModeForTier', () => {
  /**
   * ⭐ 收回**必须显式写 `guarded`**，不许靠"记账里有 full 才收"。
   *    进程重启后记账是空的，而会话可能还是 full —— 靠记账就永远收不回来了。
   */
  it('全权档写成 full', () => {
    expect(permissionModeForTier('full')).toBe('full');
  });

  it('安全档写成 guarded（显式收回，不靠记账）', () => {
    expect(permissionModeForTier('safe')).toBe('guarded');
  });
});

describe('createComputerAccessDep', () => {
  const dep = (tier: unknown, applied = new Map<string, AppliedPermissionRecord>()) =>
    createComputerAccessDep({ readTier: () => tier, applied });

  it('tier() 走 fail-closed（设置坏掉 ⇒ safe）', () => {
    expect(dep(undefined).tier()).toBe('safe');
    expect(dep('nonsense').tier()).toBe('safe');
    expect(dep('full').tier()).toBe('full');
  });

  it('applied() 就是宿主那份记账（同一个引用，不是拷贝）', () => {
    const map = new Map<string, AppliedPermissionRecord>();
    const d = dep('full', map);
    expect(d.applied()).toBe(map);
  });

  it('remember() 把模式**与网关**一起写进宿主那份记账', () => {
    const map = new Map<string, AppliedPermissionRecord>();
    const d = dep('full', map);
    d.remember('agent:main:x', { mode: 'full', gatewayId: 'gw-1' });
    expect(map.get('agent:main:x')).toEqual({ mode: 'full', gatewayId: 'gw-1' });
    d.remember('agent:main:x', { mode: 'guarded', gatewayId: 'gw-1' });
    expect(map.get('agent:main:x')?.mode).toBe('guarded');
  });
});

/**
 * 修订号：**"我们刚改过档位"这件事要能被界面听见**。
 *
 * ⚠️ 这一条是真机验收逼出来的：在任务里打开全权（或发一条消息触发补刀）之后，
 *    当前会话**已经**是全权，而徽章**不出现** —— 因为它只在会话键变化时重读一次，
 *    而全权是在它挂载**之后**才生效的。切走再切回来才看得见。
 *    ⇒ 徽章是"看得见"这条判据的承载者，看不见就等于没做。
 */
describe('computerAccess 修订号（订阅）', () => {
  it('初始能读到当前修订号', () => {
    expect(typeof computerAccessRevision()).toBe('number');
  });

  it('rememberPermissionMode 写入 + 让订阅者收到通知', () => {
    const map = new Map<string, AppliedPermissionRecord>();
    const seen: number[] = [];
    const unsubscribe = subscribeComputerAccessRevision(() => seen.push(computerAccessRevision()));

    rememberPermissionMode(map, 'agent:main:x', 'full', 'gw-1');

    expect(map.get('agent:main:x')?.mode).toBe('full');
    expect(seen.length, '订阅者该被叫一次').toBe(1);
    unsubscribe();
  });

  it('退订之后不再收到通知', () => {
    const map = new Map<string, AppliedPermissionRecord>();
    let calls = 0;
    const unsubscribe = subscribeComputerAccessRevision(() => {
      calls += 1;
    });
    unsubscribe();

    rememberPermissionMode(map, 'agent:main:x', 'guarded', 'gw-1');

    expect(calls).toBe(0);
  });

  it('createComputerAccessDep 的 remember 也走同一条通知（发送链补刀后徽章要立刻能重读）', () => {
    const map = new Map<string, AppliedPermissionRecord>();
    const dep = createComputerAccessDep({ readTier: () => 'full', applied: map });
    let calls = 0;
    const unsubscribe = subscribeComputerAccessRevision(() => {
      calls += 1;
    });

    dep.remember('agent:main:x', { mode: 'full', gatewayId: 'gw-1' });

    expect(map.get('agent:main:x')?.mode).toBe('full');
    expect(calls).toBe(1);
    unsubscribe();
  });
});

/**
 * ⭐ 关掉全权时**要收干净**：不只当前任务，还有我们之前设过全权的那些。
 *
 * 缺口（0.0.36 账本 §七-3 登记过）：开关只改当前任务 ⇒ 在任务 A 开了全权、
 * 切到 B 关掉，**A 仍然是全权**。徽章会如实显示，但那不叫"关了" ——
 * 用户的理解是"我把这个功能关了"，而不是"我关掉了其中一个任务"。
 *
 * ⚠️ 只收回**我们设过的那些**（记账里有的）：不认识的会话一律不碰 ——
 *    别的路径（团队/对比/定时任务）开的全权不归这个开关管。
 */
describe('sessionsToRevoke —— 关开关时要收哪些会话', () => {
  it('收回记账里所有 full 的会话', () => {
    const applied = new Map<string, AppliedPermissionRecord>([
      ['a', { mode: 'full', gatewayId: 'gw-1' }],
      ['b', { mode: 'full', gatewayId: 'gw-1' }],
      ['c', { mode: 'guarded', gatewayId: 'gw-1' }],
    ]);
    expect(sessionsToRevoke(applied).sort()).toEqual(['a', 'b']);
  });

  it('记账里没有 full ⇒ 一个都不收（没开过就别动）', () => {
    const applied = new Map<string, AppliedPermissionRecord>([['c', { mode: 'guarded', gatewayId: 'gw-1' }]]);
    expect(sessionsToRevoke(applied)).toEqual([]);
  });

  it('可以排掉一个（刚要单独处理的那个，免得打两次）', () => {
    const applied = new Map<string, AppliedPermissionRecord>([
      ['a', { mode: 'full', gatewayId: 'gw-1' }],
      ['b', { mode: 'full', gatewayId: 'gw-1' }],
    ]);
    expect(sessionsToRevoke(applied, 'a')).toEqual(['b']);
  });

  it('空记账 ⇒ 空（不抛）', () => {
    expect(sessionsToRevoke(new Map())).toEqual([]);
  });
});
