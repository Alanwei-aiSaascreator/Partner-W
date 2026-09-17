import type { CommunityPost, TeamInfo, TeamOrgOption, TeamRole } from '@clawwork/shared';

/**
 * 把 RPC 返回的行归一成 DTO。
 *
 * 三条纪律（照 `usage-from-server.ts` 的既定做法）：
 *   ① PostgREST 会把 int 序列化成**字符串** ⇒ 一律过一遍 Number()；
 *   ② 形状不对的行**丢掉**而不是抛异常（一行坏数据不该让整个广场白屏）；
 *   ③ 枚举值越界时降级到安全值，不把未知值透给界面。
 *
 * ⚠️ 这一层**只做形状归一**，不判断"这条帖子该不该给我看" ——
 *    可见性是数据库 RPC 的职责（`community_feed` 里就那么写的），
 *    客户端再判一遍只会制造第二套真相。
 */

function num(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 0;
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asVisibility(value: unknown): 'private' | 'org' {
  return value === 'private' ? 'private' : 'org';
}

function asRole(value: unknown): TeamRole {
  return value === 'owner' || value === 'admin' ? value : 'member';
}

export function normalizeFeed(raw: unknown): CommunityPost[] {
  if (!Array.isArray(raw)) return [];
  const out: CommunityPost[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const postId = str(r.post_id);
    if (!postId) continue;
    out.push({
      postId,
      authorId: str(r.author_id),
      authorName: str(r.author_name),
      body: str(r.body),
      visibility: asVisibility(r.visibility),
      likeCount: num(r.like_count),
      commentCount: num(r.comment_count),
      likedByMe: r.liked_by_me === true,
      createdAt: str(r.created_at),
    });
  }
  return out;
}

/**
 * 下一页的游标 = 最后一条的时间。空列表（或最后一条没有时间戳）给 null，
 * 上游据此停止翻页 —— 返回空串会让 RPC 收到 `p_before = ''` 而报类型错。
 */
export function nextFeedCursor(posts: CommunityPost[]): string | null {
  const last = posts[posts.length - 1];
  return last && last.createdAt ? last.createdAt : null;
}

export function normalizeTeamInfo(raw: unknown): TeamInfo {
  const empty: TeamInfo = { orgId: null, orgName: null, role: null, memberCount: 0, myOrgs: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;

  const myOrgs: TeamOrgOption[] = Array.isArray(r.my_orgs)
    ? (r.my_orgs as unknown[]).flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const o = item as Record<string, unknown>;
        const orgId = str(o.orgId);
        if (!orgId) return [];
        return [{ orgId, orgName: str(o.orgName), role: asRole(o.role) }];
      })
    : [];

  return {
    orgId: typeof r.org_id === 'string' ? r.org_id : null,
    orgName: typeof r.org_name === 'string' ? r.org_name : null,
    role: r.role == null ? null : asRole(r.role),
    memberCount: num(r.member_count),
    myOrgs,
  };
}
