import { CircleCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface FirstTaskCompletionCardProps {
  artifactCount: number;
  onContinue: () => void;
  onNewTask: () => void;
  onViewUsage: () => void;
  onGenerateFile: () => void;
  onViewArtifacts: () => void;
  onDismiss: () => void;
}

export default function FirstTaskCompletionCard({
  artifactCount,
  onContinue,
  onNewTask,
  onViewUsage,
  onGenerateFile,
  onViewArtifacts,
  onDismiss,
}: FirstTaskCompletionCardProps) {
  const { t } = useTranslation();

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4" aria-live="polite">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-dim)] text-[var(--accent)]">
          <CircleCheck size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="type-label text-[var(--text-primary)]">{t('firstTaskCompletion.title')}</h2>
          <p className="type-support mt-1 max-w-2xl text-[var(--text-secondary)]">
            {t('firstTaskCompletion.description')}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onDismiss}
          aria-label={t('firstTaskCompletion.dismiss')}
          className="-mr-1 -mt-1 flex-shrink-0"
        >
          <X size={15} />
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 pl-11">
        <Button type="button" size="sm" onClick={onContinue}>
          {t('firstTaskCompletion.continue')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onNewTask}>
          {t('firstTaskCompletion.newTask')}
        </Button>
        {artifactCount === 0 ? (
          <Button type="button" size="sm" variant="outline" onClick={onGenerateFile}>
            {t('taskWorkbench.generateFile')}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={onViewArtifacts}>
            {t('taskWorkbench.viewArtifacts')}
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onViewUsage}>
          {t('firstTaskCompletion.viewUsage')}
        </Button>
      </div>
    </section>
  );
}
