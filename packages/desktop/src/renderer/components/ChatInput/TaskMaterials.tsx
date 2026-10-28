import { Check, FileText, FolderOpen, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TaskContextSource } from '@clawwork/shared';
import { cn } from '@/lib/utils';
import type { ImportedMaterialFile } from './useTaskMaterials';

function formatMaterialSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function TaskMaterials({
  importedFiles,
  selectedImportedPaths,
  sources,
  binaryCount,
  countLimit,
  onTrimToLimit,
  onToggleImported,
  onRemoveReference,
  onRevokeSource,
}: {
  importedFiles: ImportedMaterialFile[];
  selectedImportedPaths: Set<string>;
  sources: TaskContextSource[];
  /**
   * **二进制附件**数（暂存附件 + 已选导入材料；@ 文件夹文本类不计数，见 constants.ts）。
   * 只有 >0 时材料条才渲染计数徽标；超过 `countLimit` 时徽标转警示态并挂「只保留前 N 个」。
   */
  binaryCount: number;
  countLimit: number;
  onTrimToLimit: () => void;
  onToggleImported: (localPath: string) => void;
  onRemoveReference: (localPath: string) => void;
  onRevokeSource: (sourceId: string) => void;
}) {
  const { t } = useTranslation();
  // ⚠️ 判据含 `binaryCount`：只有暂存附件（没导入材料、没文件夹）时材料条也要出现 ——
  //    否则"粘贴了 31 个文件"这条最常见的超限路径上，计数与裁剪入口全部缺席（P2-4 实害）。
  if (importedFiles.length === 0 && sources.length === 0 && binaryCount === 0) return null;
  const overLimit = binaryCount > countLimit;

  return (
    <div
      className="mb-2 flex max-w-full items-center gap-2 overflow-x-auto px-1 py-1"
      aria-label={t('chatInput.materials')}
    >
      <span className="type-support shrink-0 text-[var(--text-muted)]">{t('chatInput.materials')}</span>
      {/*
        计数徽标（2026-10-07 · 方案 D）：限流从"点发送那刻才存在"提前到**看得见**。
        超限时右边挂一键裁剪（只动引用，不删材料）——用户不必挨个 × 取消（P2-4）。
      */}
      {binaryCount > 0 && (
        <span
          data-testid="material-count-badge"
          className={cn(
            'type-support inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5',
            overLimit
              ? 'border-[var(--warning)]/40 text-[var(--warning)]'
              : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-muted)]',
          )}
        >
          {t('chatInput.materialCountBadge', { count: binaryCount, max: countLimit })}
          {overLimit && (
            <button
              type="button"
              onClick={onTrimToLimit}
              className="shrink-0 rounded font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] focus-visible:outline-none glow-focus"
            >
              {t('chatInput.materialTrimToLimit', { count: countLimit })}
            </button>
          )}
        </span>
      )}
      {importedFiles.map((file) => {
        const selected = selectedImportedPaths.has(file.localPath) && file.availability === 'available';
        const missing = file.availability === 'missing';
        /**
         * ⚠️ 外层是 `<span>` 而不是 `<button>`（2026-10-06，BUG-029）：被引用的材料要挂一个
         * × 按钮，而 **button 里嵌 button 是非法 HTML**（浏览器会在解析时把它们拆开，
         * React 在真机上表现为点不中/结构错乱）。文件夹那一格本来就是这么写的，照抄。
         */
        return (
          <span
            key={file.localPath}
            className={cn(
              'type-support inline-flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-lg px-2.5',
              'border transition-colors',
              selected
                ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]'
                : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              missing && 'border-[var(--warning)]/40 text-[var(--warning)] opacity-80',
            )}
          >
            <button
              type="button"
              disabled={missing}
              aria-pressed={selected}
              onClick={() => onToggleImported(file.localPath)}
              className={cn(
                'inline-flex min-w-0 items-center gap-1.5 rounded focus-visible:outline-none glow-focus',
                missing && 'cursor-not-allowed',
              )}
            >
              {missing ? <TriangleAlert size={13} /> : selected ? <Check size={13} /> : <FileText size={13} />}
              <span className="truncate">{file.fileName}</span>
              <span className="type-meta shrink-0 opacity-70">
                {missing
                  ? t('chatInput.materialMissing')
                  : selected
                    ? t('chatInput.materialSelected')
                    : formatMaterialSize(file.size)}
              </span>
            </button>
            {/*
              「从当前对话移除」（BUG-029）：只出现在**当前引用**上 —— 移除引用不等于把材料
              从任务里删掉（材料还在，点一下就能再加回来），更不碰 inbox 里的原文件。
              文案刻意不说"删除/文件"，见 locales 里 `chatInput.removeReference` 的注释。
            */}
            {selected && (
              <button
                type="button"
                onClick={() => onRemoveReference(file.localPath)}
                aria-label={t('chatInput.removeReference')}
                title={t('chatInput.removeReference')}
                className="ml-0.5 shrink-0 rounded text-[var(--text-muted)] hover:text-[var(--danger)] focus-visible:outline-none glow-focus"
              >
                <X size={12} />
              </button>
            )}
          </span>
        );
      })}
      {sources.map((source) => (
        <span
          key={source.id}
          className={cn(
            'type-support inline-flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-lg px-2.5',
            'border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]',
            source.availability === 'missing' && 'border-[var(--warning)]/40 text-[var(--warning)]',
          )}
        >
          {source.availability === 'missing' ? <TriangleAlert size={13} /> : <FolderOpen size={13} />}
          <span className="truncate">{source.displayName}</span>
          {source.availability === 'missing' && <span className="type-meta">{t('chatInput.materialMissing')}</span>}
          <button
            type="button"
            onClick={() => onRevokeSource(source.id)}
            aria-label={t('chatInput.revokeFolder', { name: source.displayName })}
            className="ml-0.5 shrink-0 rounded text-[var(--text-muted)] hover:text-[var(--danger)] focus-visible:outline-none glow-focus"
          >
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}
