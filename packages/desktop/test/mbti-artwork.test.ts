import { describe, expect, it } from 'vitest';
import {
  MBTI_AVATAR_ARTWORK,
  MBTI_CARD_ARTWORK,
  MBTI_TYPES,
  mbtiArtworkKeyFor,
  mbtiAvatarArtworkFor,
  mbtiCardArtworkFor,
} from '../src/renderer/lib/mbti-artwork';

/**
 * 16 型形象素材表（用户形象 = 16 型 × 男/女）。
 *
 * ⚠️ 这里**故意不打桩**：组件档（`portrait-card.test` / `message-avatar.test` / `identity-center.test`）
 *    把这张表 mock 掉，验的是"有图 / 缺图 / 坏图"三条降级路；这一档反过来钉住**真实素材链** ——
 *    64 张 webp 是不是真的都在仓库里、命名是不是按 `mbti-<TYPE>-<m|f>[-avatar]` 约定
 *    （一张都不许漏）。素材改名/漏挂时这条当场红，而不是等到实机上头像空白。
 */
const GENDERS = ['male', 'female'] as const;

function expectedGenderToken(gender: (typeof GENDERS)[number]): string {
  return gender === 'male' ? 'm' : 'f';
}

describe('mbti-artwork 16 型 × 男女 lookup', () => {
  it('32 个组合（16 型 × 男女）全部有全身卡，且文件名符合约定', () => {
    for (const type of MBTI_TYPES) {
      for (const gender of GENDERS) {
        const url = mbtiCardArtworkFor(type, gender);
        expect(url, `缺少 ${type} / ${gender} 的全身卡`).toBeTruthy();
        expect(url, `${type} / ${gender} 的全身卡文件名不符合约定`).toContain(
          `mbti-${type}-${expectedGenderToken(gender)}.webp`,
        );
      }
    }
  });

  it('32 个组合全部有圆头像，且用的是 -avatar 文件（不是全身卡）', () => {
    for (const type of MBTI_TYPES) {
      for (const gender of GENDERS) {
        const url = mbtiAvatarArtworkFor(type, gender);
        expect(url, `缺少 ${type} / ${gender} 的圆头像`).toBeTruthy();
        expect(url, `${type} / ${gender} 的圆头像文件名不符合约定`).toContain(
          `mbti-${type}-${expectedGenderToken(gender)}-avatar.webp`,
        );
      }
    }
  });

  it('两张表的键 = 32 个组合（16 型 × 男女，不多不少）', () => {
    const expected = MBTI_TYPES.flatMap((type) => [`${type}-m`, `${type}-f`]).sort();
    expect(Object.keys(MBTI_CARD_ARTWORK).sort()).toEqual(expected);
    expect(Object.keys(MBTI_AVATAR_ARTWORK).sort()).toEqual(expected);
    expect(MBTI_TYPES).toHaveLength(16);
    expect(new Set(MBTI_TYPES).size).toBe(16);
  });

  it('男女是两套不同的素材（不许两边指向同一张图）', () => {
    for (const type of MBTI_TYPES) {
      expect(mbtiCardArtworkFor(type, 'male')).not.toBe(mbtiCardArtworkFor(type, 'female'));
      expect(mbtiAvatarArtworkFor(type, 'male')).not.toBe(mbtiAvatarArtworkFor(type, 'female'));
    }
    expect(Object.values(MBTI_CARD_ARTWORK)).toHaveLength(32);
    expect(new Set(Object.values(MBTI_CARD_ARTWORK)).size).toBe(32);
    expect(new Set(Object.values(MBTI_AVATAR_ARTWORK)).size).toBe(32);
  });

  it('含跳过位（X）的四字码一律 null —— 不拿半份画像蒙一张形象', () => {
    for (const letters of ['ENXJ', 'XXXX', 'XXXJ', 'EST']) {
      expect(mbtiArtworkKeyFor(letters, 'male')).toBeNull();
      expect(mbtiCardArtworkFor(letters, 'male')).toBeNull();
      expect(mbtiAvatarArtworkFor(letters, 'female')).toBeNull();
    }
  });

  it('性别无效 / 没填一律 null（按钮组没选就没有形象素材）', () => {
    // 运行时是防御式的：档案/草稿里翻出脏值也得当"没填"（`as never` 只是绕过静态类型）
    for (const gender of [null, undefined, 'x', '', 0]) {
      const candidate = gender as never;
      expect(mbtiArtworkKeyFor('ENFJ', candidate)).toBeNull();
      expect(mbtiCardArtworkFor('ENFJ', candidate)).toBeNull();
      expect(mbtiAvatarArtworkFor('ENFJ', candidate)).toBeNull();
    }
  });

  it('四位都在字母表里但不是真 16 型的组合（如 EEEE）不给素材', () => {
    // `isCompletePortraitCode` 只判"四位都作答"，这里必须再收一层：只有真 16 型才有素材。
    for (const letters of ['EEEE', 'IIII', 'EIEI', 'SNSN']) {
      expect(mbtiArtworkKeyFor(letters, 'male')).toBeNull();
      expect(mbtiCardArtworkFor(letters, 'male')).toBeNull();
    }
  });

  it('四字码与性别真的决定素材键（不串型、不串性别）', () => {
    expect(mbtiArtworkKeyFor('ENFJ', 'male')).toBe('ENFJ-m');
    expect(mbtiArtworkKeyFor('ENFJ', 'female')).toBe('ENFJ-f');
    expect(mbtiArtworkKeyFor('ISTP', 'female')).toBe('ISTP-f');
  });
});
