import { describe, expect, it } from 'vitest';
import { normalizeBounties, normalizeGrowthHistory, normalizeGrowthSummary } from '@clawwork/core';

describe('growth 归一化', () => {
  it('summary：snake→camel，缺字段给安全默认值', () => {
    const summary = normalizeGrowthSummary({
      balance: 240,
      total_earned: 440,
      level: 3,
      to_next_level: 160,
      checked_in_today: false,
      badges: ['check_in_7'],
    });
    expect(summary).toEqual({
      balance: 240,
      totalEarned: 440,
      level: 3,
      toNextLevel: 160,
      checkedInToday: false,
      badges: ['check_in_7'],
    });
  });

  it('summary：null / 垃圾输入 ⇒ 空账户而不是崩溃', () => {
    expect(normalizeGrowthSummary(null)).toEqual({
      balance: 0,
      totalEarned: 0,
      level: 1,
      toNextLevel: 200,
      checkedInToday: false,
      badges: [],
    });
    expect(normalizeGrowthSummary('nonsense').level).toBe(1);
    expect(normalizeGrowthSummary({ badges: 'nope' }).badges).toEqual([]);
  });

  it('明细：坏行丢掉、数字收敛、负号保留', () => {
    const rows = normalizeGrowthHistory([
      { id: 'e1', amount: '-100', reason: 'bounty_escrow', ref_id: 'b1', note: '', created_at: '2026-09-17T00:00:00Z' },
      null,
      'nonsense',
      { reason: 'check_in' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'e1', amount: -100, refId: 'b1' });
    expect(normalizeGrowthHistory(undefined)).toEqual([]);
  });

  it('悬赏：未知状态压成 cancelled，布尔标记缺省为 false，空名字给空串', () => {
    const list = normalizeBounties([
      { id: 'b1', title: 't', reward: 50, status: 'weird', author_id: 'u1', can_claim: true },
    ]);
    expect(list[0].status).toBe('cancelled');
    expect(list[0].canClaim).toBe(true);
    expect(list[0].canAccept).toBe(false);
    expect(list[0].claimantId).toBeNull();
    expect(list[0].authorName).toBe('');
  });

  it('悬赏：领取人字段有值时原样带出（含显示名）', () => {
    const list = normalizeBounties([
      {
        id: 'b2',
        title: 't2',
        reward: 30,
        status: 'claimed',
        author_id: 'u1',
        author_name: '甲',
        claimant_id: 'u2',
        claimant_name: '乙',
        submitted_note: '',
        created_at: '2026-09-17T10:00:00Z',
        accepted_at: null,
        is_mine: false,
        is_claimed_by_me: true,
        can_submit: true,
        can_release: true,
      },
    ]);
    expect(list[0].claimantId).toBe('u2');
    expect(list[0].claimantName).toBe('乙');
    expect(list[0].isClaimedByMe).toBe(true);
    expect(list[0].canSubmit).toBe(true);
  });
});
