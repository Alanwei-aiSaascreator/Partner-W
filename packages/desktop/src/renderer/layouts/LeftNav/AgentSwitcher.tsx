import { Bot, Check, ChevronDown, LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentInfo } from '@clawwork/shared';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

interface AgentSwitcherProps {
  agents: AgentInfo[];
  selectedAgentId: string;
  onSelect: (agentId: string) => void;
  className?: string;
}

function agentLabel(agent: AgentInfo): string {
  return agent.identity?.name || agent.name || agent.id;
}

export default function AgentSwitcher({
  agents,
  selectedAgentId,
  onSelect,
  className,
}: AgentSwitcherProps) {
  const { t } = useTranslation();
  const selected = agents.find((agent) => agent.id === selectedAgentId);

  if (agents.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-2.5 py-1.5 type-support text-[var(--text-muted)]',
          className,
        )}
      >
        <Bot size={14} />
        <span>{t('leftNav.noAgents')}</span>
      </div>
    );
  }

  const triggerClass =
    'titlebar-no-drag w-full inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-1.5 type-label text-[var(--text-secondary)] cursor-pointer transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]';

  return (
    <div className={cn('px-3 pb-2 flex-shrink-0', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button aria-label={t('leftNav.switchAgent')} className={triggerClass}>
            {selected ? (
              selected.identity?.emoji ? (
                <span className="text-[13px] leading-none">{selected.identity.emoji}</span>
              ) : (
                <Bot size={14} className="flex-shrink-0" />
              )
            ) : (
              <LayoutGrid size={14} className="flex-shrink-0" />
            )}
            <span className="flex-1 truncate text-left">
              {selected ? agentLabel(selected) : t('leftNav.allAgents')}
            </span>
            <ChevronDown size={12} className="flex-shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
          <DropdownMenuItem onClick={() => onSelect('')}>
            <LayoutGrid size={14} />
            <span className="flex-1 truncate">{t('leftNav.allAgents')}</span>
            {!selectedAgentId && <Check size={14} className="flex-shrink-0" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {agents.map((agent) => (
            <DropdownMenuItem key={agent.id} onClick={() => onSelect(agent.id)}>
              {agent.identity?.emoji ? (
                <span className="text-[13px] leading-none">{agent.identity.emoji}</span>
              ) : (
                <Bot size={14} className="flex-shrink-0" />
              )}
              <span className="flex-1 truncate">{agentLabel(agent)}</span>
              {agent.id === selectedAgentId && <Check size={14} className="flex-shrink-0" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
