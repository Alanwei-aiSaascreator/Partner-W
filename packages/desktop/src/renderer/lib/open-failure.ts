/**
 * 打开失败的**原因面**（BUG-042-b）——分类与文案键的**唯一真源**。
 *
 * `artifact:open-file` 回的是稳定标记：
 *   · `artifact invalid`   = 主进程复核确证坏件（只有这时才允许说"已损坏"）；
 *   · `artifact no-opener` = 系统里没有可打开它的程序（文件本身是好的）；
 *   · 其余（`artifact missing`/`unsafe` 与认不出的系统错误）走**中性**文案 ——
 *     旧行为对任何打开失败都说「文件可能已损坏」，文件是好的时那是假话。
 *
 * ⚠️ 两个消费方（ArtifactCard 与 FileBrowser 右键菜单）必须共用本模块：
 *    各写一份就会像 2026-10-08 那样漂移（FileBrowser 漏改，仍说"损坏"）。
 */

export type OpenFailureKind = 'invalid' | 'no-opener' | 'other';

export function openFailureKind(errorCode: string): OpenFailureKind {
  if (errorCode === 'artifact invalid') return 'invalid';
  if (errorCode === 'artifact no-opener') return 'no-opener';
  return 'other';
}

/** 文件扩展名（含点），给"系统里没有能打开 {{ext}} 的程序"那句用；没有就回空串。 */
export function fileExtensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/** 原因 → i18n 键（两种原因各有专键；其余一律中性）。插值 `{ ext }` 仅 no-opener 用。 */
export function openFailureMessageKey(kind: OpenFailureKind): string {
  return kind === 'invalid'
    ? 'artifactCard.openFailed'
    : kind === 'no-opener'
      ? 'artifactCard.noAppToOpen'
      : 'artifactCard.error';
}
