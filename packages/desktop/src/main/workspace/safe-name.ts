import { existsSync } from 'fs';
import { basename, extname, join } from 'path';
import { randomUUID } from 'crypto';

function sanitizeFileName(name: string): string {
  if (!name || name === '.' || name === '..') throw new Error('invalid file name');
  if (name.includes('/') || name.includes('\\')) throw new Error('invalid file name');
  if (name.includes('..')) throw new Error('invalid file name');
  return basename(name);
}

/** **总是**加随机后缀（保证唯一，代价是名字难看）。仍给"要的就是唯一名"的调用方用。 */
export function uniqueFileName(name: string): string {
  const safe = sanitizeFileName(name);
  const ext = extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  return `${base}-${randomUUID().slice(0, 8)}${ext}`;
}

/**
 * **不撞就用原名**，撞了才退到 `uniqueFileName`（2026-09-25）。
 *
 * 为什么：`uniqueFileName` 拼出来的 `内测汇报-3f9c2a1b.pptx` 是**要交给别人**的交付物名，
 * 而它 99% 的情况下根本没撞上谁。可"永不覆盖"这条不变式不能丢 ——
 * 所以判据是**目标目录里有没有同名文件**（有 ⇒ 改名；没有 ⇒ 照原样用）。
 *
 * ⚠️ 与 `uniqueFileName` 一样，这个名字**会**被拿去 join 后写盘 ⇒ 先过 `sanitizeFileName`。
 */
export function uniqueFileNameIn(dir: string, name: string): string {
  const safe = sanitizeFileName(name);
  // 存在性检查与随后的写入之间理论上仍有 TOCTOU 窗口，但这两步都在主进程里同步、
  // 单线程地挨着做，且撞名时 `uniqueFileName` 的随机后缀兜底 ⇒ 实际不会覆盖。
  return existsSync(join(dir, safe)) ? uniqueFileName(safe) : safe;
}
