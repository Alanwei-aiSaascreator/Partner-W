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
  onToggleImported,
  onRevokeSource,
}: {
  importedFiles: ImportedMaterialFile[];
  selectedImportedPaths: Set<string>;
  sources: TaskContextSource[];
  onToggleImported: (localPath: string) => void;
  onRevokeSource: (sourceId: string) => void;
}) {
  const { t } = useTranslation();
  if (importedFiles.length === 0 && sources.length === 0) return null;

  return (
    <div
      className="mb-2 flex max-w-full items-center gap-2 overflow-x-auto px-1 py-1"
      aria-label={t('chatInput.materials')}
    >
      <span className="type-support shrink-0 text-[var(--text-muted)]">{t('chatInput.materials')}</span>
      {importedFiles.map((file) => {
        const selected = selectedImportedPaths.has(file.localPath) && file.availability === 'available';
        const missing = file.availability === 'missing';
        return (
          <button
            key={file.localPath}
            type="button"
            disabled={missing}
            aria-pressed={selected}
            onClick={() => onToggleImported(file.localPath)}
            className={cn(
              'type-support inline-flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-lg px-2.5',
              'border transition-colors focus-visible:outline-none glow-focus',
              selected
                ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]'
                : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              missing && 'cursor-not-allowed border-[var(--warning)]/40 text-[var(--warning)] opacity-80',
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
