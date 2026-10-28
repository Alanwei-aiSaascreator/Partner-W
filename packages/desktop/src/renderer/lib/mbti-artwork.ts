/**
 * 16 型形象素材的加载表（用户形象 = 16 型 × 男/女；旧六角色立绘仍在 `portrait-artwork.ts`）。
 *
 * 约定：素材放在 `src/renderer/assets/mbti/`
 *   - 全身卡：`mbti-<TYPE>-<m|f>.webp`（`.png` / `.jpg` / `.jpeg` 也认）
 *   - 圆头像：`mbti-<TYPE>-<m|f>-avatar.webp`（同一 `.webp` 名后可接 `-avatar`）
 * `<TYPE>` 必须是 16 型之一（E/I × S/N × T/F × J/P）。
 *
 * ⚠️ 为什么用 `import.meta.glob` 而不是逐张 `import`：与六立绘同理 —— 素材缺一张，
 *    构建 / 类型检查 / 测试都必须照常绿，缺图 = `null` ⇒ 调用方退回六角色立绘
 *    （再缺就落到既有占位，红线：不生成虚构素材）。素材按约定命名丢进目录即自动生效。
 *
 * ⚠️ 只有**完整四字码 + 有效性别**才谈得上有 16 型形象：任一位是 `X`（跳过）或性别没填，
 *    一律 `null`（`isCompletePortraitCode` 挡在前面）—— 不许拿半份画像蒙一张形象出来。
 *
 * 运行时仍可能拿到坏图（文件在、内容坏）—— 调用方挂着 `onError` 降级，两条路都落到六立绘 / 占位。
 */

import { isCompletePortraitCode, isPortraitGender, type PortraitGender } from '@/lib/user-portrait';

/** 16 型（与 `onboarding.firstRun.types.<TYPE>.{name,line}` 的键一一对应）。 */
export const MBTI_TYPES = [
  'ISTJ',
  'ISFJ',
  'INFJ',
  'INTJ',
  'ISTP',
  'ISFP',
  'INFP',
  'INTP',
  'ESTP',
  'ESFP',
  'ENFP',
  'ENTP',
  'ESTJ',
  'ESFJ',
  'ENFJ',
  'ENTJ',
] as const;
export type MbtiType = (typeof MBTI_TYPES)[number];

/** 素材键：`<类型>-<m|f>`（与文件名 `mbti-<类型>-<m|f>[-avatar].webp` 同构）。 */
export type MbtiArtworkKey = `${MbtiType}-${'m' | 'f'}`;

const ARTWORK_KEYS: readonly MbtiArtworkKey[] = MBTI_TYPES.flatMap(
  (type) => [`${type}-m`, `${type}-f`] as MbtiArtworkKey[],
);

/** `mbti-<E|I><S|N><T|F><J|P>-<m|f>`，尾部可选 `-avatar`。 */
const FILE_STEM_RE = /^mbti-(E|I)(S|N)(T|F)(J|P)-(m|f)(-avatar)?$/;

// ⚠️ `import.meta.glob` 的模式**必须是字面量**（写成变量会被 Vite 拒绝：
//    "Invalid glob import syntax: Could only use literals"）。
const artworkModules = import.meta.glob('../assets/mbti/mbti-*.{webp,png,jpg,jpeg}', {
  eager: true,
  query: '?url',
  import: 'default',
});

function parseArtworkPath(path: string): { key: MbtiArtworkKey; avatar: boolean } | null {
  const file = path.split('/').pop() ?? '';
  const stem = file.replace(/\.[a-z0-9]+$/i, '');
  const match = FILE_STEM_RE.exec(stem);
  if (!match) return null;
  const type = `${match[1]}${match[2]}${match[3]}${match[4]}` as MbtiType;
  return { key: `${type}-${match[5]}` as MbtiArtworkKey, avatar: match[6] === '-avatar' };
}

function emptyTable(): Record<MbtiArtworkKey, string | null> {
  return Object.fromEntries(ARTWORK_KEYS.map((key) => [key, null])) as Record<MbtiArtworkKey, string | null>;
}

function buildTables(): {
  card: Record<MbtiArtworkKey, string | null>;
  avatar: Record<MbtiArtworkKey, string | null>;
} {
  const card = emptyTable();
  const avatar = emptyTable();
  for (const [path, url] of Object.entries(artworkModules)) {
    if (typeof url !== 'string' || !url) continue;
    const parsed = parseArtworkPath(path);
    if (!parsed) continue;
    const table = parsed.avatar ? avatar : card;
    // 同名多扩展名时按 glob 返回顺序取第一个（确定性来自 Vite 的稳定文件序）。
    if (table[parsed.key] === null) table[parsed.key] = url;
  }
  return { card, avatar };
}

const TABLES = buildTables();

/** `<类型>-<m|f>` → 全身卡 URL；`null` = 素材未就位（调用方必须降级，不许破图）。 */
export const MBTI_CARD_ARTWORK: Record<MbtiArtworkKey, string | null> = TABLES.card;

/** `<类型>-<m|f>` → 256×256 圆头像 URL；`null` = 素材未就位。 */
export const MBTI_AVATAR_ARTWORK: Record<MbtiArtworkKey, string | null> = TABLES.avatar;

/**
 * 四字码 + 性别 → 素材键；**只有完整四字码**（四位都是确定的字母）**且性别有效**、
 * 且确实是 16 型之一时才给键，其余一律 `null`。
 */
export function mbtiArtworkKeyFor(letters: string, gender: PortraitGender | null | undefined): MbtiArtworkKey | null {
  if (!isCompletePortraitCode(letters)) return null;
  if (!isPortraitGender(gender)) return null;
  const key = `${letters}-${gender === 'male' ? 'm' : 'f'}`;
  return (ARTWORK_KEYS as readonly string[]).includes(key) ? (key as MbtiArtworkKey) : null;
}

/** 完整四字码 + 性别 → 全身卡 URL；不完整 / 没性别 / 缺图一律 `null`。 */
export function mbtiCardArtworkFor(letters: string, gender: PortraitGender | null | undefined): string | null {
  const key = mbtiArtworkKeyFor(letters, gender);
  return key ? (MBTI_CARD_ARTWORK[key] ?? null) : null;
}

/** 完整四字码 + 性别 → 圆头像 URL；不完整 / 没性别 / 缺图一律 `null`。 */
export function mbtiAvatarArtworkFor(letters: string, gender: PortraitGender | null | undefined): string | null {
  const key = mbtiArtworkKeyFor(letters, gender);
  return key ? (MBTI_AVATAR_ARTWORK[key] ?? null) : null;
}
