/**
 * 六角色立绘的加载表（3a 身份画像）。
 *
 * 约定：素材放在 `src/renderer/assets/personas/persona-<role>.webp`
 * （`.png` / `.jpg` / `.jpeg` 也认），文件名里的 `<role>` 必须是六个角色 code 之一。
 *
 * ⚠️ 为什么用 `import.meta.glob` 而不是逐张 `import`：素材由美术侧后补，**缺图时构建、
 *    类型检查、测试都必须照常绿**。逐张静态 import 一个还不存在的文件会当场把
 *    vitest / vite build 打红；glob 收集不到就是空表 ⇒ 组件走 `personaUnavailable`
 *    占位（红线：不生成虚构素材）。素材按约定命名丢进目录即自动生效，无需改代码。
 *
 * 运行时仍可能拿到一个坏图（文件在、内容坏）——所以 `PortraitCard` 还挂着 `onError`
 * 降级，两条路都落到同一个占位文案。
 */

import { PORTRAIT_ROLE_CODES, type PortraitRoleCode } from '@/lib/user-portrait';

const ARTWORK_PREFIX = 'persona-';

// ⚠️ `import.meta.glob` 的模式**必须是字面量**（写成变量会被 Vite 拒绝：
//    "Invalid glob import syntax: Could only use literals"）。
const artworkModules = import.meta.glob('../assets/personas/persona-*.{webp,png,jpg,jpeg}', {
  eager: true,
  query: '?url',
  import: 'default',
});

function roleCodeFromPath(path: string): PortraitRoleCode | null {
  const file = path.split('/').pop() ?? '';
  const stem = file.replace(/\.[a-z0-9]+$/i, '');
  if (!stem.startsWith(ARTWORK_PREFIX)) return null;
  const code = stem.slice(ARTWORK_PREFIX.length);
  return (PORTRAIT_ROLE_CODES as readonly string[]).includes(code) ? (code as PortraitRoleCode) : null;
}

function buildArtworkTable(): Record<PortraitRoleCode, string | null> {
  const table = Object.fromEntries(PORTRAIT_ROLE_CODES.map((code) => [code, null])) as Record<
    PortraitRoleCode,
    string | null
  >;
  for (const [path, url] of Object.entries(artworkModules)) {
    if (typeof url !== 'string' || !url) continue;
    const code = roleCodeFromPath(path);
    // 同名多扩展名时按 glob 返回顺序取第一个（确定性来自 Vite 的稳定文件序）。
    if (code && table[code] === null) table[code] = url;
  }
  return table;
}

/** 角色 code → 立绘 URL；`null` = 素材未就位（调用方必须降级，不许破图）。 */
export const PORTRAIT_ARTWORK: Record<PortraitRoleCode, string | null> = buildArtworkTable();

export function portraitArtworkFor(code: PortraitRoleCode): string | null {
  return PORTRAIT_ARTWORK[code] ?? null;
}
