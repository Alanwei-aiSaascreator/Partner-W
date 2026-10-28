import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * 小盈「看桌面 / 整理桌面」（2026-10-17 用户给的范围）。
 *
 * 安全边界（这是本模块的第一性原则）：
 *   · **只看桌面这一层**：不递归、不跟随符号链接、不碰子目录；
 *   · **不碰文件夹与隐藏文件**：整理只移动普通文件；
 *   · 计划（`planDesktopOrganize`）与执行（`applyDesktopOrganize`）分开 ——
 *     调用方必须先把计划给用户确认，再执行；
 *   · 删除只走回收站（`shell.trashItem`，在 IPC 层），**永不** `unlink`。
 */
export type PetCategory =
  | 'images'
  | 'documents'
  | 'sheets'
  | 'slides'
  | 'archives'
  | 'installers'
  | 'media'
  | 'other';

/** 类别 → 桌面上的目标文件夹名（产品中文优先；改名要连测试一起改）。 */
export const PET_CATEGORY_FOLDER: Record<PetCategory, string> = {
  images: '图片',
  documents: '文档',
  sheets: '表格',
  slides: '演示',
  archives: '压缩包',
  installers: '安装包',
  media: '音视频',
  other: '其他',
};

const EXT_CATEGORY: Record<string, PetCategory> = {
  png: 'images', jpg: 'images', jpeg: 'images', gif: 'images', webp: 'images', bmp: 'images', svg: 'images', heic: 'images',
  pdf: 'documents', doc: 'documents', docx: 'documents', txt: 'documents', md: 'documents', rtf: 'documents',
  xls: 'sheets', xlsx: 'sheets', csv: 'sheets', numbers: 'sheets',
  ppt: 'slides', pptx: 'slides', key: 'slides',
  zip: 'archives', rar: 'archives', '7z': 'archives', tar: 'archives', gz: 'archives',
  exe: 'installers', msi: 'installers', dmg: 'installers', pkg: 'installers', appx: 'installers', msix: 'installers',
  mp3: 'media', wav: 'media', flac: 'media', m4a: 'media', mp4: 'media', mov: 'media', mkv: 'media', avi: 'media', webm: 'media',
};

export function petCategoryOf(name: string): PetCategory {
  const index = name.lastIndexOf('.');
  if (index < 0 || index === name.length - 1) return 'other';
  return EXT_CATEGORY[name.slice(index + 1).toLowerCase()] ?? 'other';
}

export interface DesktopEntry {
  name: string;
  isDirectory?: boolean;
}

export interface OrganizeGroup {
  category: PetCategory;
  folder: string;
  files: string[];
}

/** 生成整理计划：按类别分组、组内按名字排序、空组不产出。 */
export function planDesktopOrganize(entries: readonly DesktopEntry[]): OrganizeGroup[] {
  const buckets = new Map<PetCategory, string[]>();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.name.trim();
    if (!name || name.startsWith('.')) continue;
    const category = petCategoryOf(name);
    const list = buckets.get(category) ?? [];
    list.push(name);
    buckets.set(category, list);
  }
  const order: PetCategory[] = ['images', 'documents', 'sheets', 'slides', 'archives', 'installers', 'media', 'other'];
  const groups: OrganizeGroup[] = [];
  for (const category of order) {
    const files = buckets.get(category);
    if (!files || files.length === 0) continue;
    groups.push({ category, folder: PET_CATEGORY_FOLDER[category], files: files.slice().sort((a, b) => a.localeCompare(b)) });
  }
  return groups;
}

/** 读桌面这一层（只看普通文件与目录名；读不到就是空，不抛给渲染层）。 */
export async function listDesktopEntries(desktopDir: string): Promise<DesktopEntry[]> {
  try {
    const rows = await readdir(desktopDir, { withFileTypes: true });
    return rows.map((row) => ({ name: row.name, isDirectory: row.isDirectory() }));
  } catch {
    return [];
  }
}

/** 目标重名时找一个不冲突的名字：`a.png` → `a (1).png`。 */
export function uniqueTargetName(dir: string, name: string): string {
  if (!existsSync(path.join(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    if (!existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/**
 * 执行整理计划。只移动计划里点名的普通文件；目标文件夹不存在就建。
 * 单个文件失败不影响其它文件（返回失败名单，调用方如实告诉用户）。
 */
export async function applyDesktopOrganize(
  desktopDir: string,
  plan: readonly OrganizeGroup[],
): Promise<{ moved: number; failed: string[] }> {
  let moved = 0;
  const failed: string[] = [];
  for (const group of plan) {
    const folder = path.join(desktopDir, group.folder);
    try {
      await mkdir(folder, { recursive: true });
    } catch {
      failed.push(...group.files);
      continue;
    }
    for (const name of group.files) {
      // 只允许桌面直接子文件（名字里带分隔符或 .. 一律拒绝）。
      if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\') || name.includes('..')) {
        failed.push(name);
        continue;
      }
      const source = path.join(desktopDir, name);
      try {
        const stat = await lstat(source);
        if (!stat.isFile()) {
          failed.push(name);
          continue;
        }
        await rename(source, path.join(folder, uniqueTargetName(folder, name)));
        moved += 1;
      } catch {
        failed.push(name);
      }
    }
  }
  return { moved, failed };
}

/** 删除名单只接受桌面直接子文件（防目录穿越）；真正的删除在 IPC 层走回收站。 */
export function safeDesktopChild(desktopDir: string, name: string): string | null {
  if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return path.join(desktopDir, name);
}
