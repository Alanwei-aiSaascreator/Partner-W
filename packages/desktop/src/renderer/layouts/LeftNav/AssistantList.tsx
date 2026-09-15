import { useTranslation } from 'react-i18next';
import type { AgentInfo } from '@clawwork/shared';
import CubeFaceIcon from '@/components/CubeFaceIcon';
import { resolveAgentDisplayNameKey } from '@/lib/preset-agents';
import { cn } from '@/lib/utils';

interface AssistantListProps {
  agents: AgentInfo[];
  selectedAgentId: string;
  onSelect: (agentId: string) => void;
}

export default function AssistantList({ agents, selectedAgentId, onSelect }: AssistantListProps) {
  const { t } = useTranslation();

  return (
    <ul className="space-y-0.5" aria-label={t('leftNav.myAssistants')}>
      {agents.map((agent) => {
        const labelKey = resolveAgentDisplayNameKey(agent.id);
        const label = labelKey ? t(labelKey) : agent.identity?.name || agent.name || agent.id;
        const selected = agent.id === selectedAgentId;

        return (
          <li key={agent.id}>
            <button
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => onSelect(agent.id)}
              className={cn(
                'titlebar-no-drag glow-focus flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors active:scale-[0.98]',
                selected
                  ? 'bg-[var(--state-selected)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <CubeFaceIcon agentId={agent.id} size={28} />
              <span className="type-label min-w-0 flex-1 truncate" title={label}>
                {label}
              </span>
              {selected && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--accent)]" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
