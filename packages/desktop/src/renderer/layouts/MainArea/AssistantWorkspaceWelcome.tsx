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
    <div className="mx-auto flex w-full max-w-[var(--content-max-width)] flex-col items-center px-2 py-5 text-center">
      <div className="emoji-lg flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent-dim)] text-[var(--accent)]">
        {definition.emoji}
      </div>
      <p className="type-support mt-2 text-[var(--accent)]">{t(definition.titleKey)}</p>
      <h1 className="type-page-title mt-0.5 text-[var(--text-primary)]">{t('mainArea.welcomeTitle')}</h1>
      <p className="type-support mt-1 max-w-xl text-[var(--text-secondary)]">{workspaceT(definition.descriptionKey)}</p>

      <div className="mt-5 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {definition.starters.map((starter, index) => (
          <button
            key={starter.promptKey}
            type="button"
            data-testid="assistant-starter"
            onClick={() => onSelectPrompt(workspaceT(starter.promptKey))}
            className="group flex min-h-14 items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-dim)] focus-visible:outline-none glow-focus"
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
      </div>
    </div>
  );
}
