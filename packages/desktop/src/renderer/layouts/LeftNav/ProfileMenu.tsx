import { useEffect, useMemo, useState } from 'react';
import { ChevronUp, Settings as SettingsIcon, Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import brandLogo from '@/assets/logo.png';
import { cn } from '@/lib/utils';
import { mbtiAvatarArtworkFor } from '@/lib/mbti-artwork';
import { portraitArtworkFor } from '@/lib/portrait-artwork';
import {
  readStoredPortraitIdentity,
  subscribeOnboardingProfileChanged,
  type StoredPortraitIdentity,
} from '@/lib/user-onboarding';
import { useCommercialStore } from '@/stores/commercialStore';
import type { MainView } from '@clawwork/core';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * 左栏底部「个人资料」卡片（2026-10-17 晚，用户给的设计稿）。
 *
 * 设计稿要求：左下角是个人资料，点开后是三项 —— 用量与积分 / 游戏化中心 / 应用设置。
 * 这三项原来散在导航清单底部；现在收进这里，把导航留给功能入口。
 *
 * ⚠️ 只显示**盘上/服务端确认得了的**余额：`quota − used − held`（与账户页同一把尺，
 *    口径不可判定时显示「—」而不是一个确定数字）。
 * ⚠️ 「游戏化中心」的 Lv 等级来自 page-local 拉取（没有全局 store），这里**不编造**等级，
 *    只给入口；等级在那一页里看。
 *
 * ## 头像（2026-10-18 用户实测反馈）
 *
 * 用户原话：「这个头像可以用用户画像，如果用户没有设置就是默认Partner-W图标。」
 * ⇒ 优先级：**用户画像**（16 型圆头像 → 六角色立绘）→ 账号头像（`account.avatar`）
 *    → **Partner-W品牌图标**（复用 `@/assets/logo.png`，不新画素材、不用人形图标）。
 *
 * ⚠️ 画像**不在 props 里**（App 只把 `onboardingProfile` 给了 MainArea/Settings；LeftNav 不接它，
 *    见文件域的"只改这一个 LeftNav 文件"）。所以这里走 `lib/user-onboarding.ts` 的**只读选择器**
 *    `readStoredPortraitIdentity(userId)` —— 真源仍然是 `partner-w:onboarding:v3:<userId>`，
 *    **没有第二套 store**。
 * ⚠️ 用户在个性化中心换头像后会走 `saveOnboardingProfile` ⇒ 那里广播变更事件 ⇒ 这里**当场重读**，
 *    不是只在挂载时读一次。
 */
function useStoredPortrait(userId: string | undefined): StoredPortraitIdentity | null {
  const [identity, setIdentity] = useState<StoredPortraitIdentity | null>(() =>
    userId ? readStoredPortraitIdentity(userId) : null,
  );
  useEffect(() => {
    const read = (): StoredPortraitIdentity | null => (userId ? readStoredPortraitIdentity(userId) : null);
    // 账号切换（或首次拿到 userId）时立刻重读一次，再挂上变更订阅。
    setIdentity(read());
    return subscribeOnboardingProfileChanged((changedUserId) => {
      // 知道改的是别人 ⇒ 不重读（多账号盘上不串头像）；说不清是谁 ⇒ 无差别重读。
      if (changedUserId && userId && changedUserId !== userId) return;
      setIdentity(read());
    });
  }, [userId]);
  return identity;
}

export default function ProfileMenu({
  collapsed,
  mainView,
  settingsOpen,
  hasUpdate,
  onSelectView,
  onOpenSettings,
}: {
  collapsed: boolean;
  mainView: MainView;
  settingsOpen: boolean;
  hasUpdate: boolean;
  onSelectView: (view: MainView) => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const overview = useCommercialStore((s) => s.overview);
  const account = overview?.account;
  const displayName = account?.nickname?.trim() || account?.phone || t('leftNav.profile');
  /** ⚠️ userId 未知（概览还没回来）时**不扫描兜底**：宁可先显示品牌图标，也不把别人的画像贴上。 */
  const portrait = useStoredPortrait(account?.userId);
  /** 坏图降级按 URL 记账（素材在、内容坏 ⇒ 换下一个候选，最后落品牌图标，不许破图）。 */
  const [failedAvatars, setFailedAvatars] = useState<readonly string[]>([]);
  const avatarCandidates = useMemo(() => {
    const mbti = portrait?.letters ? mbtiAvatarArtworkFor(portrait.letters, portrait.gender) : null;
    const persona = portrait?.role ? portraitArtworkFor(portrait.role) : null;
    return [mbti, persona, account?.avatar ?? null].filter((url): url is string => Boolean(url));
  }, [portrait, account?.avatar]);
  const avatarUrl = avatarCandidates.find((url) => !failedAvatars.includes(url)) ?? null;
  const rows = [
    {
      key: 'growth',
      label: t('leftNav.pages.growth'),
      icon: Trophy,
      value: null,
      active: mainView === 'growth' && !settingsOpen,
      onSelect: () => onSelectView('growth'),
    },
    {
      key: 'settings',
      label: t('leftNav.appSettings'),
      icon: SettingsIcon,
      value: null,
      active: false,
      onSelect: onOpenSettings,
    },
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="left-nav-profile"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={displayName}
          className={cn(
            'titlebar-no-drag glow-focus flex w-full items-center rounded-md text-left transition-colors',
            collapsed ? 'justify-center py-2' : 'gap-2 px-2 py-1.5',
            open ? 'bg-[var(--state-selected)]' : 'hover:bg-[var(--bg-hover)]',
          )}
        >
          <span className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
            {avatarUrl ? (
              <img
                data-testid="profile-avatar"
                src={avatarUrl}
                alt=""
                className="h-full w-full object-cover"
                onError={() =>
                  setFailedAvatars((previous) => (previous.includes(avatarUrl) ? previous : [...previous, avatarUrl]))
                }
              />
            ) : (
              /* 没画像 / 读不到 / 素材全坏 ⇒ Partner-W品牌图标（不新画素材、不用人形图标）。 */
              <img data-testid="profile-avatar-brand" src={brandLogo} alt="" className="h-full w-full object-cover" />
            )}
            {hasUpdate ? (
              <span
                data-testid="profile-update-dot"
                className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--accent)]"
              />
            ) : null}
          </span>
          <span className={cn('min-w-0 flex-1 truncate type-body text-[var(--text-secondary)]', collapsed && 'hidden')}>
            {displayName}
          </span>
          <ChevronUp
            size={13}
            className={cn(
              'flex-shrink-0 text-[var(--text-muted)] transition-transform',
              collapsed && 'hidden',
              open && 'rotate-180',
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent side={collapsed ? 'right' : 'top'} align="start" className="w-56 p-1">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <button
              key={row.key}
              type="button"
              data-profile-item={row.key}
              onClick={() => {
                setOpen(false);
                row.onSelect();
              }}
              className={cn(
                'glow-focus flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left type-body transition-colors',
                row.active
                  ? 'bg-[var(--state-selected)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <Icon size={15} className="flex-shrink-0" />
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.value !== null ? (
                <span className="flex-shrink-0 type-meta text-[var(--text-muted)]">{row.value}</span>
              ) : null}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
