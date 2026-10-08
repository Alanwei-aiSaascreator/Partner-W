import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserRound } from 'lucide-react';
import PortraitRadar from '@/components/PortraitRadar';
import { cn } from '@/lib/utils';
import { mbtiCardArtworkFor } from '@/lib/mbti-artwork';
import { portraitArtworkFor } from '@/lib/portrait-artwork';
import {
  displayPortraitLetters,
  isCompletePortraitCode,
  isPortraitGender,
  parsePortraitAge,
  type PortraitAxes,
  type PortraitGender,
  type PortraitRoleCode,
} from '@/lib/user-portrait';

/**
 * 角色卡（左人物 + 右五维雷达 + 角色文案，rulepack §0 的「梦幻西游式」形态）。
 *
 * 形象链（2026-10-08，16 型形象）：
 *   完整四字码 **且** 选了性别 ⇒ 16 型全身卡（`mbtiCardArtworkFor`）
 *   → 否则 / 图缺 → 六角色立绘（`portraitArtworkFor`，旧链原样保留）
 *   → 再缺 / 坏图 → 占位文案。三条路都不破图、不崩，也不生成虚构素材。
 *
 * 卡面上的「类型 · 性别 · 年龄」一行**只在真的有 16 型形象时出现**（四字码完整 + 性别有效）；
 * 没填的项不显示，也不编。
 */

interface PortraitCardProps {
  axes: PortraitAxes;
  letters: string;
  role: PortraitRoleCode;
  /** 形象层：性别（可选）。缺它就退回六角色立绘，四字码再完整也不硬凑 16 型形象。 */
  gender?: PortraitGender | null;
  /** 形象层：年龄（可选，1–120）。只用于卡面那一行，不参与任何判定。 */
  age?: number | null;
  className?: string;
}

export default function PortraitCard({ axes, letters, role, gender, age, className }: PortraitCardProps) {
  const { t } = useTranslation();
  /** ② 六角色立绘坏图降级（素材在、内容坏 ⇒ 回占位）。 */
  const [artworkFailed, setArtworkFailed] = useState(false);
  /** ① 16 型全身卡坏图降级（⇒ 退回六角色立绘，再坏才占位）。 */
  const [mbtiArtworkFailed, setMbtiArtworkFailed] = useState(false);
  /**
   * 16 型展示只在**四题全部作答**时出现；有跳过位就只说"含未答题"，
   * 不查类型名/一句话（未作答的位显示 `?`，见 `displayPortraitLetters`）。
   */
  const typeCode = isCompletePortraitCode(letters) ? letters : null;
  const genderValue = isPortraitGender(gender) ? gender : null;
  const ageValue = parsePortraitAge(age ?? null);
  const mbtiArtwork = typeCode ? mbtiCardArtworkFor(letters, genderValue) : null;
  const roleArtwork = portraitArtworkFor(role);
  const shownMbtiArtwork = mbtiArtworkFailed ? null : mbtiArtwork;
  const shownRoleArtwork = artworkFailed ? null : roleArtwork;
  const hasMbtiIdentity = Boolean(typeCode && genderValue);

  // 换人/换形象/换性别后重试素材（坏图降级是**这一张**的事，不该跟着下一次选择走）。
  useEffect(() => setMbtiArtworkFailed(false), [letters, genderValue]);
  useEffect(() => setArtworkFailed(false), [role]);

  return (
    <section
      data-testid="portrait-card"
      data-role={role}
      data-artwork-source={shownMbtiArtwork ? 'mbti' : shownRoleArtwork ? 'persona' : 'placeholder'}
      className={cn(
        'grid gap-5 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5 sm:grid-cols-3',
        className,
      )}
    >
      <div className="flex flex-col items-center justify-center gap-3 text-center">
        {shownMbtiArtwork ? (
          <img
            data-mbti-artwork
            src={shownMbtiArtwork}
            alt=""
            onError={() => setMbtiArtworkFailed(true)}
            className="mx-auto h-auto w-full max-w-xs"
          />
        ) : shownRoleArtwork ? (
          <img
            data-portrait-artwork
            src={shownRoleArtwork}
            alt=""
            onError={() => setArtworkFailed(true)}
            className="mx-auto h-auto w-full max-w-xs"
          />
        ) : (
          <div data-portrait-fallback className="flex flex-col items-center gap-3">
            <UserRound size={72} className="text-[var(--text-muted)]" />
            <p className="type-support text-[var(--text-muted)]">{t('onboarding.firstRun.personaUnavailable')}</p>
          </div>
        )}
      </div>
      <div className="space-y-3 sm:col-span-2">
        <p className="type-support text-[var(--text-muted)]">{t('onboarding.portrait.resultTitle')}</p>
        <p data-portrait-role-name className="type-section-title text-[var(--text-primary)]">
          {t(`onboarding.portrait.roles.${role}.name`)}
        </p>
        <p className="type-support text-[var(--text-secondary)]">
          {t(`onboarding.portrait.roles.${role}.description`)}
        </p>
        <div data-portrait-type>
          <p className="type-support text-[var(--text-muted)]">{t('onboarding.portrait.letters')}</p>
          <p className="type-label mt-1 text-[var(--text-primary)]">
            <span data-portrait-letters>{displayPortraitLetters(letters)}</span>
            {typeCode ? ` · ${t(`onboarding.firstRun.types.${typeCode}.name`)}` : null}
          </p>
          {typeCode ? (
            <p className="type-support mt-1 text-[var(--text-secondary)]">
              {t(`onboarding.firstRun.types.${typeCode}.line`)}
            </p>
          ) : (
            <p className="type-support mt-1 text-[var(--text-muted)]" data-portrait-partial>
              {t('onboarding.firstRun.types.partial')}
            </p>
          )}
        </div>
        {/* 「类型 · 性别 · 年龄」一行：只有 16 型形象真的成立（四字码完整 + 性别有效）才出现；
            年龄没填就不显示那一段 —— 不编、不留空壳。 */}
        {hasMbtiIdentity ? (
          <p data-portrait-identity className="type-label text-[var(--text-primary)]">
            <span className="text-[var(--text-muted)]">{t('onboarding.portrait.typeLabel')}</span>{' '}
            <span data-portrait-mbti-type>{typeCode}</span>
            <span aria-hidden="true">{' · '}</span>
            <span className="text-[var(--text-muted)]">{t('onboarding.portrait.genderLabel')}</span>{' '}
            <span data-portrait-gender>{t(`onboarding.portrait.gender.${genderValue}`)}</span>
            {ageValue !== null ? (
              <>
                <span aria-hidden="true">{' · '}</span>
                <span className="text-[var(--text-muted)]">{t('onboarding.portrait.ageLabel')}</span>{' '}
                <span data-portrait-age>{ageValue}</span>
              </>
            ) : null}
          </p>
        ) : null}
        <PortraitRadar axes={axes} className="mx-auto max-w-xs" />
      </div>
    </section>
  );
}
