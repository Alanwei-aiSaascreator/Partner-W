import { describe, expect, it } from 'vitest';
import { normalizeFeed, normalizeTeamInfo, nextFeedCursor } from '../src/services/community-service.js';
import type { CommunityPost } from '@clawwork/shared';

/**
 * PostgREST / RPC 返回的是**数据库的行**（snake_case、数字可能是字符串、
 * 形状不受我们控制）。这一层的职责就一条：把行归一成 DTO，
 * **一行坏数据不许让整个广场白屏**。
 */

function post(overrides: Partial<CommunityPost> = {}): CommunityPost {
  return {
    postId: 'a',
    authorId: 'u1',
    authorName: '甲',
    body: '正文',
    visibility: 'org',
    likeCount: 0,
    commentCount: 0,
    likedByMe: false,
    createdAt: '2026-09-17T10:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeFeed —— 把 RPC 的行转成 DTO', () => {
  it('字段名与类型都对上', () => {
    const rows = normalizeFeed([
      {
        post_id: 'p1',
        author_id: 'u1',
        author_name: '甲',
        body: '你好',
        visibility: 'org',
        like_count: 3,
        comment_count: 1,
        liked_by_me: true,
        created_at: '2026-09-17T10:00:00.000Z',
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      postId: 'p1',
      authorId: 'u1',
      authorName: '甲',
      body: '你好',
      visibility: 'org',
      likeCount: 3,
      commentCount: 1,
      likedByMe: true,
      createdAt: '2026-09-17T10:00:00.000Z',
    });
  });

  it('数字字段给字符串也认（PostgREST 会把 int 序列化成字符串）', () => {
    const rows = normalizeFeed([
      {
        post_id: 'p1',
        author_id: 'u1',
        author_name: '甲',
        body: 'x',
        visibility: 'org',
        like_count: '2',
        comment_count: '0',
        liked_by_me: false,
        created_at: 't',
      },
    ]);
    expect(rows[0]?.likeCount).toBe(2);
    expect(rows[0]?.commentCount).toBe(0);
  });

  it('不是对象的行直接丢掉，不抛异常', () => {
    expect(normalizeFeed([null, {}, 'x', 42, []] as unknown[])).toEqual([]);
    expect(normalizeFeed(undefined)).toEqual([]);
    expect(normalizeFeed('nope')).toEqual([]);
  });

  it('只有 post_id 的行保留，其余字段给安全默认值（契约：post_id 是唯一必须的）', () => {
    const rows = normalizeFeed([{ post_id: 'p1' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ postId: 'p1', body: '', likeCount: 0, likedByMe: false, visibility: 'org' });
  });

  it('visibility 只认 private/org，其他一律当 org', () => {
    const rows = normalizeFeed([
      {
        post_id: 'p1',
        author_id: 'u1',
        author_name: '甲',
        body: 'x',
        visibility: 'weird',
        like_count: 0,
        comment_count: 0,
        liked_by_me: false,
        created_at: 't',
      },
    ]);
    expect(rows[0]?.visibility).toBe('org');
  });
});

describe('nextFeedCursor —— 分页游标取最后一条的时间', () => {
  it('有数据时取最后一条的 createdAt', () => {
    expect(nextFeedCursor([post({ postId: 'a' }), post({ postId: 'b', createdAt: '2026-09-17T09:00:00.000Z' })])).toBe(
      '2026-09-17T09:00:00.000Z',
    );
  });

  it('空列表给 null（上游据此停止翻页）', () => {
    expect(nextFeedCursor([])).toBeNull();
  });

  it('最后一条没有时间戳也给 null（别把空串当游标发出去）', () => {
    expect(nextFeedCursor([post({ createdAt: '' })])).toBeNull();
  });
});

describe('normalizeTeamInfo', () => {
  it('没团队时给一个全空的结构，而不是 null', () => {
    expect(normalizeTeamInfo(undefined)).toEqual({
      orgId: null,
      orgName: null,
      role: null,
      memberCount: 0,
      myOrgs: [],
    });
  });

  it('my_orgs 里的角色非法时降级成 member', () => {
    const info = normalizeTeamInfo({
      org_id: 'o1',
      org_name: '甲',
      role: 'owner',
      member_count: 2,
      my_orgs: [{ orgId: 'o1', orgName: '甲', role: 'weird' }],
    });
    expect(info.myOrgs[0]?.role).toBe('member');
    expect(info.role).toBe('owner');
  });

  it('my_orgs 里缺 orgId 的条目丢掉', () => {
    const info = normalizeTeamInfo({ my_orgs: [{ orgName: '没有 id' }, { orgId: 'o2', orgName: '乙' }] });
    expect(info.myOrgs.map((o) => o.orgId)).toEqual(['o2']);
  });
});
