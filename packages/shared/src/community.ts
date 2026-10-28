/**
 * 广场 / 团队的对外类型（P1）。
 *
 * 设计文档：docs/superpowers/specs/2026-09-17-p1-community-team-design.md
 *
 * ⚠️ 这里定义的是**归一之后**的形状（驼峰）。数据库 RPC 返回的行是
 *    snake_case，两种处理方式：
 *      · 单对象（点赞 / 建码 / 加入）在 main 的 IPC 层就翻成这里的 DTO；
 *      · 列表（feed / 成员 / 评论 / 邀请码）由 core 的 normalizer 归一，
 *        preload 的类型老实写 `unknown[]`，不假装它是 DTO。
 */

export type TeamRole = 'owner' | 'admin' | 'member';

/** 帖子的可见范围。`public` **不在 P1 范围内**（没有审核能力，RPC 一律拒绝）。 */
export type PostVisibility = 'private' | 'org';

export interface CommunityPost {
  postId: string;
  authorId: string;
  authorName: string;
  body: string;
  visibility: PostVisibility;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  createdAt: string;
}

export interface CommunityComment {
  commentId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  isMine: boolean;
}

export interface TeamOrgOption {
  orgId: string;
  orgName: string;
  role: TeamRole;
}

export interface TeamInfo {
  orgId: string | null;
  orgName: string | null;
  role: TeamRole | null;
  memberCount: number;
  /** 切换器用：这个账号所属的全部团队（含当前）。 */
  myOrgs: TeamOrgOption[];
}

export interface TeamMember {
  userId: string;
  displayName: string;
  role: TeamRole;
  joinedAt: string;
  isMe: boolean;
}

export interface TeamInvite {
  id: string;
  code: string;
  role: TeamRole;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
  active: boolean;
}

/** `community_like_toggle` 的结果（IPC 层已翻成驼峰）。 */
export interface LikeToggleResult {
  liked: boolean;
  likeCount: number;
}

/** `team_join_with_code` 的结果（IPC 层已翻成驼峰）。 */
export interface JoinTeamResult {
  orgId: string;
  orgName: string;
  role: TeamRole;
}
