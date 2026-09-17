import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, UserMinus } from 'lucide-react';
import { toast } from '@/lib/toast';
import { describeCommunityError, normalizeTeamInfo } from '@clawwork/core';
import type { TeamInfo, TeamInvite, TeamMember, TeamRole } from '@clawwork/shared';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

/**
 * 成员 + 邀请码 + 切换团队。
 *
 * 三件事在这里交汇，都指向数据库里那一个 `org_members.is_primary`：
 *   · 成员列表（`team_members`）看的是**当前团队**；
 *   · 邀请码（`team_invite_*`）只对**当前团队**的管理员开放，
 *     非管理员调用会被 RPC 拒（`forbidden`）—— 这不是错误，
 *     界面据此**隐藏**邀请区，而不是弹个红条；
 *   · 切换团队（`team_switch`）会连带改变广场里能看到什么。
 */
const EMPTY_INFO: TeamInfo = { orgId: null, orgName: null, role: null, memberCount: 0, myOrgs: [] };

/**
 * 角色 → 文案键的后缀。用模板串取键（`` t(`community.role${…}`) ``）
 * 是**刻意**的：`scripts/check-i18n.mjs` 的扫描器认这种带前缀的模板串，
 * 而 `t(映射表[role])` 这种写法它看不见，会把这几个 key 报成"没人用"。
 */
const ROLE_SUFFIX: Record<TeamRole, 'Owner' | 'Admin' | 'Member'> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

function asNumber(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 0;
  return Number.isFinite(n) ? n : 0;
}

function toMember(raw: unknown): TeamMember | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const userId = typeof r.user_id === 'string' ? r.user_id : '';
  if (!userId) return null;
  return {
    userId,
    displayName: typeof r.display_name === 'string' ? r.display_name : '',
    role: r.role === 'owner' || r.role === 'admin' ? r.role : 'member',
    joinedAt: typeof r.joined_at === 'string' ? r.joined_at : '',
    isMe: r.is_me === true,
  };
}

function toInvite(raw: unknown): TeamInvite | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  const code = typeof r.code === 'string' ? r.code : '';
  if (!id || !code) return null;
  return {
    id,
    code,
    role: r.role === 'admin' ? 'admin' : 'member',
    maxUses: asNumber(r.max_uses),
    usedCount: asNumber(r.used_count),
    expiresAt: typeof r.expires_at === 'string' ? r.expires_at : null,
    createdAt: typeof r.created_at === 'string' ? r.created_at : '',
    active: r.active === true,
  };
}

export default function MemberTab() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<TeamInfo>(EMPTY_INFO);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [joinCode, setJoinCode] = useState('');
  const [freshCode, setFreshCode] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const [infoRes, membersRes, invitesRes] = await Promise.all([
      window.clawwork.communityInfo(),
      window.clawwork.communityMembers(),
      window.clawwork.communityInviteList(),
    ]);

    if (infoRes.ok) setInfo(normalizeTeamInfo(infoRes.result));

    setMembers(
      membersRes.ok
        ? ((Array.isArray(membersRes.result) ? membersRes.result : []).map(toMember).filter(Boolean) as TeamMember[])
        : [],
    );

    // 非管理员拉邀请码列表会被拒（forbidden）—— 这是预期，不是错误
    setInvites(
      invitesRes.ok
        ? ((Array.isArray(invitesRes.result) ? invitesRes.result : []).map(toInvite).filter(Boolean) as TeamInvite[])
        : [],
    );
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isAdmin = info.role === 'owner' || info.role === 'admin';

  const createInvite = useCallback(async (): Promise<void> => {
    const res = await window.clawwork.communityInviteCreate({ role: 'member', maxUses: 1, expiresInHours: 72 });
    if (!res.ok) {
      toast.error(describeCommunityError(res.errorCode));
      return;
    }
    setFreshCode(res.result?.code ?? null);
    await reload();
  }, [reload]);

  const revoke = useCallback(
    async (id: string): Promise<void> => {
      const res = await window.clawwork.communityInviteRevoke(id);
      if (!res.ok) {
        toast.error(describeCommunityError(res.errorCode));
        return;
      }
      await reload();
    },
    [reload],
  );

  const join = useCallback(async (): Promise<void> => {
    const code = joinCode.trim();
    if (!code) return;
    const res = await window.clawwork.communityJoin(code);
    if (!res.ok) {
      toast.error(describeCommunityError(res.errorCode));
      return;
    }
    toast.success(t('community.joinSuccess', { name: res.result?.orgName ?? '' }));
    setJoinCode('');
    await reload();
  }, [joinCode, reload, t]);

  const switchTeam = useCallback(
    async (orgId: string): Promise<void> => {
      const res = await window.clawwork.communitySwitchTeam(orgId);
      if (!res.ok) {
        toast.error(describeCommunityError(res.errorCode));
        return;
      }
      await reload();
    },
    [reload],
  );

  const removeMember = useCallback(
    async (userId: string): Promise<void> => {
      const res = await window.clawwork.communityMemberRemove(userId);
      if (!res.ok) {
        toast.error(describeCommunityError(res.errorCode));
        return;
      }
      await reload();
    },
    [reload],
  );

  const copy = useCallback(async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
    } catch {
      // 剪贴板不可用就算了 —— 码就在界面上，用户能自己选中复制
    }
  }, []);

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="type-label flex-1 text-[var(--text-primary)]">{t('community.membersTitle')}</h3>
            <span className="type-support text-[var(--text-muted)]">
              {t('community.memberCount', { count: info.memberCount })}
            </span>
          </div>

          {info.myOrgs.length > 1 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="type-support text-[var(--text-muted)]">{t('community.switchTeam')}</span>
              {info.myOrgs.map((org) => (
                <button
                  key={org.orgId}
                  type="button"
                  aria-pressed={org.orgId === info.orgId}
                  onClick={() => void switchTeam(org.orgId)}
                  className="glow-focus rounded-md px-2 py-1 type-support text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] aria-pressed:bg-[var(--state-selected)] aria-pressed:text-[var(--accent)]"
                >
                  {org.orgName}
                </button>
              ))}
            </div>
          )}

          <ul className="space-y-1">
            {members.map((member) => (
              <li
                key={member.userId}
                className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] px-3 py-2"
              >
                <span className="type-body text-[var(--text-primary)]">{member.displayName}</span>
                {member.isMe && (
                  <span className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5 type-support text-[var(--text-muted)]">
                    {t('community.me')}
                  </span>
                )}
                <span className="type-support text-[var(--text-secondary)]">
                  {t(`community.role${ROLE_SUFFIX[member.role]}`)}
                </span>
                <span className="flex-1" />
                {isAdmin && !member.isMe && (
                  <button
                    type="button"
                    aria-label={t('community.removeMember')}
                    onClick={() => void removeMember(member.userId)}
                    className="glow-focus rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  >
                    <UserMinus size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-2">
          <h3 className="type-label text-[var(--text-primary)]">{t('community.joinTitle')}</h3>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value)}
              placeholder={t('community.joinPlaceholder')}
              className="glow-focus h-[var(--density-control-height-sm)] flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-transparent"
            />
            <Button size="sm" disabled={!joinCode.trim()} onClick={() => void join()}>
              {t('community.join')}
            </Button>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="type-label text-[var(--text-primary)]">{t('community.invite')}</h3>

          {!isAdmin && <p className="type-support text-[var(--text-muted)]">{t('community.inviteOnlyAdmin')}</p>}

          {isAdmin && (
            <>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void createInvite()}>
                  {t('community.inviteGenerate')}
                </Button>
                {freshCode && (
                  <span className="flex items-center gap-1 type-body text-[var(--text-primary)]">
                    {freshCode}
                    <button
                      type="button"
                      aria-label={t('community.inviteCopy')}
                      onClick={() => void copy(freshCode)}
                      className="glow-focus rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                    >
                      {copied === freshCode ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </span>
                )}
              </div>

              <ul className="space-y-1">
                {invites.map((invite) => (
                  <li
                    key={invite.id}
                    className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] px-3 py-2"
                  >
                    <span className="type-body text-[var(--text-primary)]">{invite.code}</span>
                    <span className="type-support text-[var(--text-muted)]">
                      {invite.active
                        ? t('community.inviteRemaining', {
                            left: Math.max(0, invite.maxUses - invite.usedCount),
                            total: invite.maxUses,
                          })
                        : t('community.inviteInactive')}
                    </span>
                    <span className="flex-1" />
                    <button
                      type="button"
                      aria-label={t('community.inviteRevoke')}
                      onClick={() => void revoke(invite.id)}
                      className="glow-focus rounded p-1 type-support text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                    >
                      {t('community.inviteRevoke')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}
