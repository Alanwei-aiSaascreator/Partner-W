import { describe, expect, it } from 'vitest';
import type { CommercialAccountOverview } from '@clawwork/shared';
import {
  evaluateCommercialSendAccess,
  evaluateQuota,
  quotaBlockCopy,
  QUOTA_WARN_PERCENT,
  QUOTA_DEGRADE_PERCENT,
} from '../src/renderer/lib/quota';
import { deriveAvailableDisplay } from '../src/renderer/lib/quota-display';

// ⚠️ 参数放宽成 unknown 再收窄：有一条用例故意让 tokenUsedMicros = null
//    （"数据不全 ≠ 用尽"），而正式类型不允许 null。
function overviewWith(license: unknown): CommercialAccountOverview {
  return {
    account: { userId: 'u-1', phone: null, email: null, nickname: null, avatar: null },
    org: null,
    license: license as CommercialAccountOverview['license'],
    device: { fingerprint: 'fp', shortFingerprint: 'fp' },
    fetchedAt: '2026-09-15T00:00:00.000Z',
  };
}

describe('evaluateQuota', () => {
  it('blocks a licence without quota', () => {
    expect(evaluateQuota(0, 0).level).toBe('exhausted');
  });

  it('reports ok below the warning threshold', () => {
    expect(evaluateQuota(1000, 100).level).toBe('ok');
  });

  it('reports warn at the warning threshold', () => {
    expect(evaluateQuota(1000, 800).level).toBe('warn');
    expect(QUOTA_WARN_PERCENT).toBe(80);
  });

  it('reports degrade at the degrade threshold', () => {
    expect(evaluateQuota(1000, 950).level).toBe('degrade');
    expect(QUOTA_DEGRADE_PERCENT).toBe(95);
  });

  it('reports exhausted when the whole quota is used', () => {
    expect(evaluateQuota(1000, 1000).level).toBe('exhausted');
  });

  it('reports exhausted when usage overshoots the quota', () => {
    expect(evaluateQuota(1000, 1200).level).toBe('exhausted');
  });

  it('reports exhausted when the balance was never read', () => {
    expect(evaluateQuota(1000, null).level).toBe('unknown-exhausted');
  });

  it('reports exhausted when the balance reads as NaN', () => {
    expect(evaluateQuota(1000, Number.NaN).level).toBe('unknown-exhausted');
  });

  it('blocks when the balance reads as Infinity', () => {
    expect(evaluateQuota(1000, Number.POSITIVE_INFINITY).level).toBe('unknown-exhausted');
  });

  it('reports exhausted when the balance reads as negative Infinity', () => {
    expect(evaluateQuota(1000, Number.NEGATIVE_INFINITY).level).toBe('unknown-exhausted');
  });

  it('blocks an unreadable quota', () => {
    expect(evaluateQuota(Number.NaN, 0).level).toBe('unknown-exhausted');
  });

  it('computes the remaining percentage', () => {
    expect(evaluateQuota(1000, 250).remainingPercent).toBe(75);
  });
});

describe('evaluateCommercialSendAccess', () => {
  it('blocks while the current account snapshot is loading', () => {
    expect(evaluateCommercialSendAccess('loading', null)).toEqual({ allowed: false, reason: 'verifying' });
  });

  /**
   * ⭐ 2026-09-17 改判：读失败时**用最近一次成功的快照**放行。
   *
   * 原先这条断言的是「缓存不许授权发送」（fail-closed）。实机证明那样做的代价是：
   * 一次 8 秒网络抖动 ⇒ `status='offline'` ⇒ 发送被拦，且弹的对话框是
   * 「Token 额度已用尽，充值或兑换卡密后可继续使用」——**把读不到说成了用尽**。
   *
   * 改判的依据（两条都是事实，不是偏好）：
   *   ① 计费边界在**服务端**：`services/relay/src/index.ts` 自己会 `evaluateQuota`
   *      并对真耗尽的请求回 `insufficient balance`。客户端闸门只是提前给个好听的说法。
   *   ② 仓库里已有同款先例：`auth-classify.ts` 就是为「8 秒抖动被固化成没登录」写的，
   *      那里立的原则是"把『暂时』误判成『确定』，代价大得多"。
   *
   * 结果形状带 `stale: true`，好让界面知道这是**旧数据**。
   */
  it('⭐ 读失败但缓存里有有效额度 ⇒ 放行（标记 stale），不拿"额度已用尽"挡人', () => {
    const cached = overviewWith({
      activated: true,
      licenseKey: 'RY-OLD',
      sku: 'USB',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: 1000,
      tokenUsedMicros: 10,
    });
    expect(evaluateCommercialSendAccess('offline', cached)).toMatchObject({
      allowed: true,
      stale: true,
      verdict: { level: 'ok' },
    });
  });

  it('缓存里就已经用尽 ⇒ 仍然拦（真用尽不因为"这次没读到"就放过）', () => {
    const cached = overviewWith({
      activated: true,
      licenseKey: 'RY-OLD',
      sku: 'USB',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: 1000,
      tokenUsedMicros: 1000,
    });
    expect(evaluateCommercialSendAccess('offline', cached)).toMatchObject({
      allowed: false,
      reason: 'exhausted',
    });
  });

  it('读失败且**没有**任何快照 ⇒ unavailable（不是 exhausted —— 读不到 ≠ 用尽）', () => {
    expect(evaluateCommercialSendAccess('offline', null)).toEqual({ allowed: false, reason: 'unavailable' });
  });

  it('blocks an account without a licence', () => {
    expect(evaluateCommercialSendAccess('ready', overviewWith(null))).toEqual({
      allowed: false,
      reason: 'unlicensed',
    });
  });

  it('blocks an inactive or unactivated licence', () => {
    const inactive = overviewWith({
      activated: false,
      licenseKey: 'RY-1',
      sku: 'USB',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: 1000,
      tokenUsedMicros: 10,
    });
    expect(evaluateCommercialSendAccess('ready', inactive)).toEqual({ allowed: false, reason: 'unlicensed' });
  });

  it('allows only a verified active licence with remaining quota', () => {
    const current = overviewWith({
      activated: true,
      licenseKey: 'RY-1',
      sku: 'USB',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: 1000,
      tokenUsedMicros: 10,
    });
    expect(evaluateCommercialSendAccess('ready', current)).toMatchObject({
      allowed: true,
      verdict: { level: 'ok', remainingPercent: 99 },
    });
  });

  it('额度/用量本身读成了空 ⇒ unavailable（数据不全 ≠ 用尽）', () => {
    const partial = overviewWith({
      activated: true,
      licenseKey: 'RY-1',
      sku: 'USB',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: 1000,
      tokenUsedMicros: null,
    });
    expect(evaluateCommercialSendAccess('ready', partial)).toMatchObject({
      allowed: false,
      reason: 'unavailable',
    });
  });

  /**
   * T09 / BUG-082 残余：**发送闸门必须与服务端的预占（held）协调**。
   *
   * 服务端的可用额 = `quota − used − held`（`services/relay` 的 held 三源预留）。
   * 三处界面（账户页 / Dashboard / 顶栏）已经共用 `deriveAvailableDisplay()` 把这个口径
   * 落到了**显示**上；但**发送闸门**（`evaluateCommercialSendAccess`）此前只看
   * `quota − used` ⇒ held > 0 时**前端比服务端可花**：界面允许发，服务端随后拒。
   * 这正是「前端不能比服务端显示更可花」要挡的那一类。
   */
  describe('T09：发送闸门与预占（held）协调', () => {
    const licensed = (extra: Record<string, unknown>) =>
      overviewWith({
        activated: true,
        licenseKey: 'RY-1',
        sku: 'USB',
        status: 'active',
        expiresAt: null,
        tokenQuotaMicros: 1000,
        tokenUsedMicros: 0,
        ...extra,
      });

    it('⭐⭐ 预占吃掉剩余额度 ⇒ 必须拦（quota−used 还有 10%，但服务端已不可花）', () => {
      const access = evaluateCommercialSendAccess(
        'ready',
        licensed({ tokenUsedMicros: 900, tokenHeldMicros: 200, heldComplete: true }),
      );
      expect(access).toMatchObject({ allowed: false, reason: 'exhausted' });
    });

    it('⭐ 预占把用量顶过告警线 ⇒ 告警（不是 ok）', () => {
      const access = evaluateCommercialSendAccess(
        'ready',
        licensed({ tokenUsedMicros: 700, tokenHeldMicros: 150, heldComplete: true }),
      );
      expect(access).toMatchObject({ allowed: true, verdict: { level: 'warn' } });
    });

    it('⭐ 预占把用量顶过降级线 ⇒ 降级（不是 ok）', () => {
      const access = evaluateCommercialSendAccess(
        'ready',
        licensed({ tokenUsedMicros: 900, tokenHeldMicros: 60, heldComplete: true }),
      );
      expect(access).toMatchObject({ allowed: true, verdict: { level: 'degrade' } });
    });

    it('⭐ 预占**为 0** 且口径确定 ⇒ 与"没有预占"完全一致（不许因为带了这个字段就变味）', () => {
      const access = evaluateCommercialSendAccess(
        'ready',
        licensed({ tokenUsedMicros: 10, tokenHeldMicros: 0, heldComplete: true }),
      );
      expect(access).toMatchObject({ allowed: true, verdict: { level: 'ok', remainingPercent: 99 } });
      expect(access).not.toHaveProperty('heldUnknown');
    });

    it('⭐⭐ 预占**不可判定**（heldComplete:false）⇒ 退回 quota−used 放行，但标 heldUnknown（不假装知道）', () => {
      const access = evaluateCommercialSendAccess(
        'ready',
        licensed({ tokenUsedMicros: 10, tokenHeldMicros: 5, heldComplete: false }),
      );
      // 不许因为"读不到预占"就当成用尽 —— 既有 ⭐ 改判（读不到 ≠ 用尽）照旧。
      expect(access).toMatchObject({ allowed: true, verdict: { level: 'ok' }, heldUnknown: true });
    });

    it('⭐⭐ **根本没有读数**（老后端 / relay 不可达）⇒ 同样 heldUnknown，且不把预占当 0 抵扣', () => {
      const access = evaluateCommercialSendAccess('ready', licensed({ tokenUsedMicros: 10 }));
      expect(access).toMatchObject({ allowed: true, verdict: { level: 'ok' }, heldUnknown: true });
    });

    it('⭐⭐ 闸门用的 usedPercent 与三处界面的"可用额"同一口径（同一份 held）', () => {
      const license = { tokenQuotaMicros: 1000, tokenUsedMicros: 700, tokenHeldMicros: 150, heldComplete: true };
      const access = evaluateCommercialSendAccess('ready', licensed(license));
      const displayed = deriveAvailableDisplay(1000, 700, 150);
      // 闸门"已用 85%" ⇔ 界面"剩余 15%"
      expect(access).toMatchObject({ allowed: true, verdict: { usedPercent: 85 } });
      expect(displayed.remainingPercent).toBe(15);
    });

    it('⭐ 微小消费（1 微积分）不算用尽、也不触发告警', () => {
      const access = evaluateCommercialSendAccess(
        'ready',
        licensed({ tokenUsedMicros: 1, tokenHeldMicros: 0, heldComplete: true }),
      );
      expect(access).toMatchObject({ allowed: true, verdict: { level: 'ok' } });
    });
  });
});

/**
 * 拦截时说什么。⭐ 这几条是本轮实机 bug 的直接回归：
 * 原来四种原因共用「额度已用尽，请充值」，于是"读不到"被说成了"用尽"。
 */
describe('quotaBlockCopy —— 每种拦截原因说自己的话', () => {
  it('⭐ 真正用尽才说"额度已用尽"，确认按钮去充值', () => {
    expect(quotaBlockCopy('exhausted')).toEqual({
      titleKey: 'usage.blockedTitle',
      descKey: 'usage.blockedDesc',
      confirmKey: 'account.recharge',
      action: 'recharge',
    });
  });

  it('⭐ 读不到/还在确认 ⇒ 用"暂时没确认"的话术，确认按钮是重试（不是充值）', () => {
    for (const reason of ['unavailable', 'verifying'] as const) {
      const copy = quotaBlockCopy(reason);
      expect(copy.action).toBe('retry');
      expect(copy.descKey).toBe('usage.unknownDesc');
      expect(copy.descKey).not.toBe('usage.blockedDesc');
      expect(copy.confirmKey).toBe('common.retry');
    }
  });

  it('⭐ 没激活 ⇒ 说"还没有可用额度"，不说"已用尽"', () => {
    const copy = quotaBlockCopy('unlicensed');
    expect(copy.titleKey).toBe('usage.unlicensedTitle');
    expect(copy.titleKey).not.toBe('usage.blockedTitle');
  });

  it('四种原因各不相同（除了两个"说不清"的共用一句）', () => {
    expect(quotaBlockCopy('exhausted').descKey).not.toBe(quotaBlockCopy('unlicensed').descKey);
    expect(quotaBlockCopy('exhausted').descKey).not.toBe(quotaBlockCopy('unavailable').descKey);
    expect(quotaBlockCopy('unlicensed').descKey).not.toBe(quotaBlockCopy('unavailable').descKey);
  });
});
