import { useState } from 'react';
import type { Artifact } from '@clawwork/shared';
import { Check, ExternalLink, FileWarning, FolderOpen, Loader2, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn, formatFileSize, formatRelativeTime } from '@/lib/utils';
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

export default function ArtifactCard({
  artifact,
  assistantLabel,
  compact = false,
  onSelectMessage,
}: ArtifactCardProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<ActionState>('idle');
  const available = artifact.availability === 'available';

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
