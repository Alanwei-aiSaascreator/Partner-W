import { Bot, CheckCircle2, FileInput, FileOutput, LoaderCircle, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AssistantTaskPreset } from '@/lib/assistant-task-presets';
import type { AssistantWorkspaceDefinition } from '@/lib/preset-agents';

export interface AssistantTaskWorkbenchProps {
  definition: AssistantWorkspaceDefinition;
  modelLabel: string;
  ready: boolean;
  recentPresetIds: readonly string[];
  onSelectPreset: (preset: AssistantTaskPreset) => void;
  onCustomTask: () => void;
}

export default function AssistantTaskWorkbench({
  definition,
  modelLabel,
  ready,
  recentPresetIds,
  onSelectPreset,
  onCustomTask,
}: AssistantTaskWorkbenchProps) {
  const { t } = useTranslation();
  const presetsById = new Map(definition.starters.map((preset) => [preset.id, preset]));
  const recentPresets = Array.from(new Set(recentPresetIds)).flatMap((id) => {
    const preset = presetsById.get(id);
    return preset ? [preset] : [];
  });

  return (
    <section
      aria-labelledby="assistant-task-workbench-title"
      className="mx-auto flex w-full max-w-[var(--content-max-width)] flex-col px-2 py-5"
    >
      <header className="flex flex-col items-center text-center">
        <div
          aria-hidden="true"
          className="emoji-lg flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent-dim)] text-[var(--accent)]"
        >
          {definition.emoji}
        </div>
        <h1 id="assistant-task-workbench-title" className="type-page-title mt-2 text-[var(--text-primary)]">
          {t(definition.titleKey)}
        </h1>
        <p className="type-body mt-1 max-w-2xl text-[var(--text-secondary)]">{t(definition.descriptionKey)}</p>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-2 type-support text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1.5">
            <Bot size={13} aria-hidden="true" />
            {modelLabel}
          </span>
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1.5"
          >
            {ready ? (
              <CheckCircle2 size={13} aria-hidden="true" className="text-[var(--accent)]" />
            ) : (
              <LoaderCircle size={13} aria-hidden="true" className="animate-spin text-[var(--accent)]" />
            )}
            {t(ready ? 'startupReadiness.aiReady' : 'startupReadiness.aiStarting')}
          </span>
        </div>
      </header>

      {recentPresets.length > 0 && (
        <div
          className="mt-5 flex flex-wrap items-center justify-center gap-2"
          aria-label={t('taskWorkbench.recentTasks')}
        >
          <span className="type-support text-[var(--text-muted)]">{t('taskWorkbench.recentTasks')}</span>
          {recentPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              data-testid="assistant-task-recent-preset"
              data-preset-id={preset.id}
              onClick={() => onSelectPreset(preset)}
              className="glow-focus rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-left type-support text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none"
            >
              {t(preset.titleKey)}
            </button>
          ))}
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {definition.starters.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-testid="assistant-task-preset"
            data-preset-id={preset.id}
            onClick={() => onSelectPreset(preset)}
            className="glow-focus group flex min-h-36 flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-left transition-colors hover:border-[var(--border-hover)] hover:bg-[var(--bg-hover)] focus-visible:outline-none"
          >
            <span className="type-section-title text-[var(--text-primary)]">{t(preset.titleKey)}</span>
            <span className="type-body mt-1 text-[var(--text-secondary)]">{t(preset.descriptionKey)}</span>

            <span className="mt-4 grid w-full gap-2 border-t border-[var(--border-subtle)] pt-3">
              <span className="flex items-start gap-2">
                <FileInput size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0">
                  <span className="type-support block text-[var(--text-muted)]">{t('taskWorkbench.materialHint')}</span>
                  <span className="type-support block text-[var(--text-secondary)]">{t(preset.materialHintKey)}</span>
                </span>
              </span>
              <span className="flex items-start gap-2">
                <FileOutput size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0">
                  <span className="type-support block text-[var(--text-muted)]">{t('taskWorkbench.output')}</span>
                  <span className="type-support block text-[var(--text-secondary)]">{t(preset.outputKey)}</span>
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="mt-4 flex justify-center">
        <button
          type="button"
          data-testid="assistant-task-custom"
          onClick={onCustomTask}
          className="glow-focus inline-flex items-center gap-2 rounded-lg px-3 py-2 type-label text-[var(--accent)] transition-colors hover:bg-[var(--accent-dim)] focus-visible:outline-none"
        >
          <Plus size={15} aria-hidden="true" />
          {t('taskWorkbench.customTask')}
        </button>
      </div>
    </section>
  );
}
