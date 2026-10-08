import { useEffect, useState } from 'react';
import { Bot, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLocalAvatarUrl } from '@/lib/local-avatar';
import { mbtiAvatarArtworkFor } from '@/lib/mbti-artwork';
import { portraitArtworkFor } from '@/lib/portrait-artwork';
import { readStoredPortraitIdentity } from '@/lib/user-onboarding';
import { isPortraitGender, type PortraitGender, type PortraitRoleCode } from '@/lib/user-portrait';

interface MessageAvatarProps {
  role: 'user' | 'assistant';
  agentEmoji?: string;
  localAvatarUrl?: string;
  gatewayAvatarUrl?: string;
  /**
   * 06 头像链：本人画像的六角色 code（`profile.portrait.role`）。
   *
   * **首选通道**（2026-10-07 体检问题 5 + 12b）：调用方从 App 下发的 profile 里直接传
   * （`MainArea → ChatMessage → 这里`）—— 这是账号级的真值，而且省掉每条消息的存储扫描。
   * 显式传了 `null` 表示"就是没有"，不再回读存储。
   *
   * 不传（`undefined`）时才回落到**只读**档案选择器 `readStoredPortraitIdentity(userId)`：
   * 唯一真源仍在 `lib/user-onboarding.ts`，不写、不缓存、不立第二套 store。
   */
  portraitRole?: PortraitRoleCode | null;
  /**
   * 16 型形象的另外两件（2026-10-08）：趣味四字码 + 性别。
   * **两件都有**（四字码完整 + 性别有效）时才用 `mbtiAvatarArtworkFor` 的小圆头像；
   * 缺任一件就退回六角色立绘（旧链原样），再坏图才退回图标 —— 三级降级都不破图。
   */
  portraitLetters?: string | null;
  portraitGender?: PortraitGender | null;
  /**
   * 账号 id（可选，只为上面那条回读兜底用）：按账号读档案，避免多账号盘上
   * 取到**别人**的立绘。传了 `portraitRole` 就不需要它。
   */
  userId?: string;
}

export default function MessageAvatar({
  role,
  agentEmoji,
  localAvatarUrl,
  gatewayAvatarUrl,
  portraitRole,
  portraitLetters,
  portraitGender,
  userId,
}: MessageAvatarProps) {
  const [failCount, setFailCount] = useState(0);
  /** 用户头像的坏图降级：素材在但内容坏 ⇒ 退回 User 图标，不许破图。 */
  const [userArtworkFailed, setUserArtworkFailed] = useState(false);
  /** 16 型头像坏图降级：⇒ 退回六角色立绘（若也没有再落图标）。 */
  const [mbtiArtworkFailed, setMbtiArtworkFailed] = useState(false);
  const [storedPortrait] = useState(() =>
    role === 'user' && portraitRole === undefined ? readStoredPortraitIdentity(userId) : null,
  );
  const localMatch = localAvatarUrl?.match(/^clawwork-avatar:\/\/([^/]+)\/(.+)$/);
  const verifiedLocalAvatarUrl = useLocalAvatarUrl(localMatch?.[1], localMatch?.[2]);
  useEffect(() => setFailCount(0), [gatewayAvatarUrl, verifiedLocalAvatarUrl]);
  const urls = [verifiedLocalAvatarUrl, gatewayAvatarUrl].filter(Boolean) as string[];
  const avatarUrl = urls[failCount];
  const showImg = role === 'assistant' && avatarUrl;

  /** 显式传了 `portraitRole`（含 `null`）就按调用方的口径走，不再回读存储（既有语义）。 */
  const callerProvidedPortrait = portraitRole !== undefined;
  const resolvedPortraitRole = callerProvidedPortrait ? portraitRole : (storedPortrait?.role ?? null);
  const resolvedLetters = portraitLetters ?? (callerProvidedPortrait ? null : (storedPortrait?.letters ?? null));
  const resolvedGender = isPortraitGender(portraitGender)
    ? portraitGender
    : callerProvidedPortrait
      ? null
      : (storedPortrait?.gender ?? null);
  const mbtiArtwork = role === 'user' && resolvedLetters ? mbtiAvatarArtworkFor(resolvedLetters, resolvedGender) : null;
  const personaArtwork = role === 'user' && resolvedPortraitRole ? portraitArtworkFor(resolvedPortraitRole) : null;
  const shownMbtiArtwork = mbtiArtworkFailed ? null : mbtiArtwork;
  const userArtworkUrl = shownMbtiArtwork ?? (userArtworkFailed ? null : personaArtwork);

  // 换形象/换性别后重试素材（坏图降级是那一张的事，不该跟着下一次选择走）。
  useEffect(() => setMbtiArtworkFailed(false), [resolvedLetters, resolvedGender]);

  return (
    <div
      // 探针/测试用：一个助手块在"等待→流式→定稿→收编"之间换的是**状态**不是节点，
      // 而肉眼能看出来的就是这颗头像。给它一个稳定的抓手，才钉得住"同一个节点"。
      data-testid="message-avatar"
      data-role={role}
      className={cn(
        'flex-shrink-0 size-[var(--density-avatar-size)] rounded-full flex items-center justify-center overflow-hidden',
        role === 'user' ? 'bg-[var(--bg-tertiary)]' : !showImg && 'bg-[var(--accent-dim)]',
      )}
    >
      {role === 'user' ? (
        shownMbtiArtwork ? (
          <img
            data-user-portrait
            data-mbti-avatar
            src={shownMbtiArtwork}
            alt=""
            className="size-[var(--density-avatar-size)] rounded-full object-cover"
            onError={() => setMbtiArtworkFailed(true)}
          />
        ) : userArtworkUrl ? (
          <img
            data-user-portrait
            src={userArtworkUrl}
            alt=""
            className="size-[var(--density-avatar-size)] rounded-full object-cover"
            onError={() => setUserArtworkFailed(true)}
          />
        ) : (
          <User className="size-[calc(var(--density-avatar-size)*0.6)] text-[var(--text-secondary)]" />
        )
      ) : showImg ? (
        <img
          src={avatarUrl}
          alt=""
          className="size-[var(--density-avatar-size)] rounded-full object-cover"
          onError={() => setFailCount((c) => c + 1)}
        />
      ) : agentEmoji ? (
        <span className="emoji-md leading-none">{agentEmoji}</span>
      ) : (
        <Bot className="size-[calc(var(--density-avatar-size)*0.6)] text-[var(--accent)]" />
      )}
    </div>
  );
}
