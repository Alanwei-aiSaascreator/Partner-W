import { describe, expect, it } from 'vitest';
import type { CommercialAccountOverview } from '@clawwork/shared';
import {
  evaluateCommercialSendAccess,
  evaluateQuota,
  quotaBlockCopy,
  QUOTA_WARN_PERCENT,
  QUOTA_DEGRADE_PERCENT,
} from '../src/renderer/lib/quota';

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
