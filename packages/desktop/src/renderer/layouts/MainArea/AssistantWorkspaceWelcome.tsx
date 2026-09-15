import { Bot, CheckCircle2, FileText, Globe2, LoaderCircle, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AssistantWorkspaceDefinition } from '@/lib/preset-agents';

export default function AssistantWorkspaceWelcome({
  definition,
  modelLabel,
  ready,
  onSelectPrompt,
}: {
  definition: AssistantWorkspaceDefinition;
  modelLabel: string;
  ready: boolean;
  onSelectPrompt: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const workspaceT = (key: string) => t(`assistantWorkspaces.${key.replace(/^assistantWorkspaces\./, '')}`);

  return (
    <div className="mx-auto flex w-full max-w-[var(--content-max-width)] flex-col items-center px-2 py-6 text-center">
      <div className="emoji-lg flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-dim)] text-[var(--accent)]">
        {definition.emoji}
      </div>
      <p className="type-label mt-3 text-[var(--accent)]">{t(definition.titleKey)}</p>
      <h1 className="type-page-title mt-1 text-[var(--text-primary)]">{t('mainArea.welcomeTitle')}</h1>
      <p className="type-body mt-2 max-w-2xl text-[var(--text-secondary)]">{workspaceT(definition.descriptionKey)}</p>

      <div className="mt-6 grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        {definition.starters.map((starter, index) => (
          <button
            key={starter.promptKey}
            type="button"
            data-testid="assistant-starter"
            onClick={() => onSelectPrompt(workspaceT(starter.promptKey))}
            className="group flex min-h-24 items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-dim)] focus-visible:outline-none glow-focus"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-tertiary)] text-[var(--accent)]">
              {index === 0 ? (
                <Sparkles size={17} />
              ) : index === 1 ? (
                <FileText size={17} />
              ) : index === 2 ? (
                <Globe2 size={17} />
              ) : (
                <Bot size={17} />
              )}
            </span>
            <span className="min-w-0">
              <span className="type-label block text-[var(--text-primary)]">{workspaceT(starter.titleKey)}</span>
              <span className="type-support mt-1 block text-[var(--text-secondary)]">
                {workspaceT(starter.descriptionKey)}
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2 type-support text-[var(--text-secondary)]">
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--bg-tertiary)] px-3 py-1.5">
          <Bot size={13} />
          {modelLabel}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--bg-tertiary)] px-3 py-1.5">
          {ready ? (
            <CheckCircle2 size={13} className="text-[var(--accent)]" />
          ) : (
            <LoaderCircle size={13} className="animate-spin text-[var(--accent)]" />
          )}
          {t(ready ? 'startupReadiness.aiReady' : 'startupReadiness.aiStarting')}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--bg-tertiary)] px-3 py-1.5">
          <FileText size={13} />
          {t('chatInput.attachFile')}
        </span>
      </div>
    </div>
  );
}
