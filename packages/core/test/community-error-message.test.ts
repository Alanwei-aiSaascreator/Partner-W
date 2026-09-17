import { describe, expect, it } from 'vitest';
import { describeCommunityError } from '../src/services/community-error-message.js';

/**
 * 数据库里的 RPC 用机器码报错（`raise exception 'post_not_found'`），
 * 用户看到的必须是中文，且**绝不能**出现机器码本身。
 */
describe('describeCommunityError', () => {
  it('每条已知错误码都有中文', () => {
    const codes = [
      'not_authenticated',
      'no_organization',
      'body_empty',
      'body_too_long',
      'visibility_not_supported',
      'post_not_found',
      'forbidden',
      'role_not_allowed',
      'invalid_usage',
      'invalid_expiry',
      'invalid_code',
      'invite_expired',
      'invite_exhausted',
      'already_member',
      'cannot_change_self',
      'cannot_remove_self',
      'last_owner',
      'owner_cannot_leave',
      'member_not_found',
      'invite_not_found',
      'not_a_member',
    ] as const;

    for (const code of codes) {
      const text = describeCommunityError(code);
      expect(text.length).toBeGreaterThan(0);
      // 中文里必须真的出现汉字，且不回显机器码
      expect(text).toMatch(/[一-龥]/);
      expect(text).not.toContain(code);
    }
  });

  it('用完的邀请码说得具体', () => {
    expect(describeCommunityError('invite_exhausted')).toContain('用完');
  });

  it('认不出来的码给通用中文兜底，不复读原文', () => {
    const text = describeCommunityError('SOMETHING_NEW_FROM_SERVER');
    expect(text).toMatch(/[一-龥]/);
    expect(text).not.toContain('SOMETHING_NEW_FROM_SERVER');
  });

  it('空值也不炸', () => {
    expect(describeCommunityError(undefined)).toMatch(/[一-龥]/);
    expect(describeCommunityError('')).toMatch(/[一-龥]/);
  });
});
