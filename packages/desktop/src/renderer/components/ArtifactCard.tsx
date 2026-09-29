import { useEffect, useState } from 'react';
import type { Artifact } from '@clawwork/shared';
import { Check, Copy, ExternalLink, FileWarning, FolderOpen, Loader2, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn, formatFileSize, formatRelativeTime } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getArtifactLabel } from '@/lib/artifact-labels';
import ArtifactThumbnail from '@/components/ArtifactThumbnail';
import { Button } from '@/components/ui/button';

interface ArtifactCardProps {
  artifact: Artifact;
  assistantLabel?: string;
  compact?: boolean;
  onSelectMessage?: (messageId: string) => void;
}

type ActionState = 'idle' | 'saving' | 'saved' | 'cancelled' | 'error';

/**
 * 只把真正的绝对路径呈现给用户。
 *
 * `Artifact.filePath` 是跨主进程 / renderer 的现有字段；新产物和列表 IPC
 * 都会把它规范成当前成品的绝对路径。老数据或夹具若只有相对路径，
 * 宁可不显示，也不把它冒充成“可复制的完整路径”。
 */
function absoluteArtifactPath(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || candidate.includes('\0')) return null;
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(candidate) ? candidate : null;
}

export default function ArtifactCard({
  artifact,
  assistantLabel,
  compact = false,
  onSelectMessage,
}: ArtifactCardProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<ActionState>('idle');
  const [pathCopied, setPathCopied] = useState(false);
  const available = artifact.availability === 'available';
  const absolutePath = absoluteArtifactPath(artifact.filePath);

  useEffect(() => {
    if (!pathCopied) return;
    const timer = window.setTimeout(() => setPathCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [pathCopied]);

  const copyPath = (): void => {
    if (!absolutePath) return;
    void copyTextToClipboard(absolutePath)
      .then(() => setPathCopied(true))
      .catch(() => {
        setState('error');
        window.setTimeout(() => setState('idle'), 2400);
      });
  };

  const runAction = async (action: 'save' | 'open' | 'reveal'): Promise<void> => {
    if (!available || state === 'saving') return;
    if (action === 'save') setState('saving');
    try {
      const response =
        action === 'save'
          ? await window.clawwork.saveArtifactAs(artifact.id, artifact.taskId)
          : action === 'open'
            ? await window.clawwork.openArtifactFile(artifact.id, artifact.taskId)
            : await window.clawwork.showArtifactInFolder(artifact.id, artifact.taskId);
      if (!response.ok) throw new Error(response.error);
      if (action === 'save') {
        setState(response.result?.status === 'cancelled' ? 'cancelled' : 'saved');
        window.setTimeout(() => setState('idle'), 1800);
      }
    } catch {
      setState('error');
      window.setTimeout(() => setState('idle'), 2400);
    }
  };

  const statusLabel = !available
    ? t(`artifactCard.${artifact.availability}`)
    : state === 'saved'
      ? t('artifactCard.saved')
      : state === 'cancelled'
        ? t('artifactCard.cancelled')
        : state === 'error'
          ? t('artifactCard.error')
          : t('artifactCard.available');
  const identity = (
    <>
      <span className="type-label block truncate text-[var(--text-primary)]">{artifact.name}</span>
      <span className="type-support mt-0.5 block truncate text-[var(--text-muted)]">
        {getArtifactLabel(artifact, t)} · {formatFileSize(artifact.size)} ·{' '}
        {formatRelativeTime(new Date(artifact.createdAt))}
      </span>
      {assistantLabel ? (
        <span className="type-support mt-0.5 block truncate text-[var(--text-secondary)]">{assistantLabel}</span>
      ) : null}
    </>
  );

  return (
    <article
      className={cn(
        'min-w-0 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 text-left',
        compact && 'p-2.5',
      )}
      data-testid="artifact-card"
    >
      <div className="flex min-w-0 items-start gap-3">
        <ArtifactThumbnail artifact={artifact} className="h-10 w-10 shrink-0 border border-[var(--border-subtle)]" />
        {onSelectMessage ? (
          <button
            type="button"
            className="glow-focus min-w-0 flex-1 rounded-md text-left"
            onClick={() => onSelectMessage(artifact.messageId)}
            aria-label={t('artifactCard.locateMessage', { name: artifact.name })}
          >
            {identity}
          </button>
        ) : (
          <div className="min-w-0 flex-1">{identity}</div>
        )}
      </div>

      {absolutePath ? (
        <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-md bg-[var(--bg-tertiary)] px-2 py-1">
          <p
            className="type-mono-data min-w-0 flex-1 truncate text-[var(--text-muted)]"
            title={absolutePath}
            data-testid="artifact-path"
          >
            {absolutePath}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            aria-label={pathCopied ? t('chatMessage.copied') : t('artifactCard.copyPath')}
            title={pathCopied ? t('chatMessage.copied') : t('artifactCard.copyPath')}
            onClick={copyPath}
          >
            {pathCopied ? <Check size={13} /> : <Copy size={13} />}
            {!compact ? (pathCopied ? t('chatMessage.copied') : t('artifactCard.copyPath')) : null}
          </Button>
        </div>
      ) : null}

      <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5">
        <span
          className={cn(
            'type-support mr-auto inline-flex min-w-0 items-center gap-1.5',
            available ? 'text-[var(--text-muted)]' : 'text-[var(--warning)]',
          )}
          role="status"
          aria-live="polite"
        >
          {!available ? <FileWarning size={13} className="shrink-0" /> : state === 'saved' ? <Check size={13} /> : null}
          <span className="truncate">{statusLabel}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!available || state === 'saving'}
          aria-label={t('artifactCard.open')}
          onClick={() => void runAction('open')}
        >
          <ExternalLink size={14} />
          {!compact ? t('artifactCard.open') : null}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!available || state === 'saving'}
          aria-label={t('artifactCard.showInFolder')}
          onClick={() => void runAction('reveal')}
        >
          <FolderOpen size={14} />
          {!compact ? t('artifactCard.showInFolder') : null}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!available || state === 'saving'}
          aria-label={t('artifactCard.saveAs')}
          onClick={() => void runAction('save')}
        >
          {state === 'saving' ? (
            <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Save size={14} />
          )}
          {t('artifactCard.saveAs')}
        </Button>
      </div>
      {!available ? (
        <p className="type-support mt-2 text-[var(--text-muted)]">{t('artifactCard.recoveryHint')}</p>
      ) : null}
    </article>
  );
}
