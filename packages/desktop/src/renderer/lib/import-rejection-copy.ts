import type { ImportFileRejectionReason, ImportFilesResult } from '@clawwork/shared';

/**
 * 「文件没能添加」的**原因**文案 —— 把 `reason` 翻成一句人话。
 *
 * ## 为什么要有这个文件
 *
 * 2026-09-24 同事的真机表格：「添加文件或内容添加不上 → **无法操作**」，
 * 截图里只有一句 `⚠ 有 1 个文件未能添加`。
 *
 * 而数据里本来就带着答案：`ImportFilesResult.rejected` 是
 * `Array<{ fileName, reason }>`，五种 reason 各有各的处置办法 ——
 * 界面只用了 `length`，把文件名和原因一起丢了，于是用户只能得出"无法操作"。
 *
 * 五句的区别是**用户接下来该做什么**，不是修辞：
 *   · unsupported        —— 换格式（或先转成支持的格式）；
 *   · too-large          —— 换小的（100MB 上限）；
 *   · unavailable / copy-failed / publish-unavailable —— 这三条是**环境/临时**问题，
 *     重试或换个位置就行，**不是用户的文件有问题**（说成"格式不支持"会让人白折腾）。
 *
 * ⚠️ 这些 key 是**当变量**传给 `t` 的，`scripts/check-i18n.mjs` 看不见它们
 *    （它的正则要求引号紧跟 `t(`）⇒ 必须由测试按名钉住齐备性，
 *    见 `test/import-rejection-copy.test.ts`。
 */
export const IMPORT_REJECTION_KEYS: Record<ImportFileRejectionReason, string> = {
  unsupported: 'chatInput.importRejected.unsupported',
  'too-large': 'chatInput.importRejected.tooLarge',
  unavailable: 'chatInput.importRejected.unavailable',
  'copy-failed': 'chatInput.importRejected.copyFailed',
  'publish-unavailable': 'chatInput.importRejected.publishUnavailable',
};

/** 列表被截断时补的那句（带 `{{count}}`）。 */
export const IMPORT_REJECTION_MORE_KEY = 'chatInput.importRejected.more';

/**
 * 最多列几个文件。再多就只报个数 —— toast 是**提醒**不是报告页，
 * 长到看不见关键那句就失去意义了。
 */
const MAX_LISTED = 3;

interface Translate {
  (key: string, options?: Record<string, unknown>): string;
}

/**
 * 把被拒的文件拼成一行说明，给 toast 的 `description` 用。
 *
 * 分隔符跟本目录既有的多段 description 一致（`useTaskMaterials.ts` 里
 * `[a, b].filter(Boolean).join('; ')`）—— 用 `; ` 而不是换行，
 * 因为 sonner 的 description 不保证保留换行。
 */
export function describeImportRejections(rejected: ImportFilesResult['rejected'], t: Translate): string {
  if (rejected.length === 0) return '';

  const parts = rejected
    .slice(0, MAX_LISTED)
    .map(({ fileName, reason }) => t(IMPORT_REJECTION_KEYS[reason], { fileName }));

  const remaining = rejected.length - parts.length;
  if (remaining > 0) parts.push(t(IMPORT_REJECTION_MORE_KEY, { count: remaining }));

  return parts.join('; ');
}
