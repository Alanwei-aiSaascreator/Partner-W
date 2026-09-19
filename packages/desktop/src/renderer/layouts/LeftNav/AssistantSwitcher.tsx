import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Plus } from 'lucide-react';
import type { AgentInfo } from '@clawwork/shared';
import CubeFaceIcon from '@/components/CubeFaceIcon';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { resolveAgentDisplayNameKey } from '@/lib/preset-agents';
import { cn } from '@/lib/utils';

/**
 * 「我的助手」——**导航列表里的一行**，点开才选角色（2026-09-19）。
 *
 * ## 为什么改成这样
 *
 * 原来是**常驻展开的助手列表**（4 行 + 滚动），用户反馈两点：
 * 「把他放身份中心上面，点击后可以选择这几个角色」+「现在不好看」。
 * ⇒ 收成一行：平时只显示**当前助手**，点开才列角色。
 * 好处是侧栏只剩**一个**列表（导航），不用再和助手列表抢高度。
 *
 * ⚠️ 这是全应用**唯一**切助手的地方 —— 别把 Popover 去掉只留展示。
 */
export interface AssistantSwitcherProps {
  agents: AgentInfo[];
  selectedAgentId: string;
  onSelect: (agentId: string) => void;
  onAddAssistant: () => void;
}

function agentLabel(agent: AgentInfo, t: (k: string) => string): string {
  const key = resolveAgentDisplayNameKey(agent.id);
  return key ? t(key) : agent.identity?.name || agent.name || agent.id;
}

export default function AssistantSwitcher({
  agents,
  selectedAgentId,
  onSelect,
  onAddAssistant,
}: AssistantSwitcherProps) {
  const { t } = useTranslation();
  const current = agents.find((a) => a.id === selectedAgentId) ?? agents[0];
  const currentLabel = current ? agentLabel(current, t) : t('leftNav.myAssistants');

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="assistant-switcher"
          aria-label={t('leftNav.myAssistants')}
          className="titlebar-no-drag glow-focus flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left type-body text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] data-[state=open]:bg-[var(--bg-hover)] data-[state=open]:text-[var(--text-primary)]"
        >
          {current ? (
            <CubeFaceIcon agentId={current.id} size={18} />
          ) : (
            <span className="size-[18px] flex-shrink-0 rounded bg-[var(--bg-tertiary)]" />
          )}
          <span className="min-w-0 flex-1 truncate font-semibold">{currentLabel}</span>
          <ChevronDown size={14} className="flex-shrink-0 opacity-70" />
        </button>
      </PopoverTrigger>

      <PopoverContent side="right" align="start" className="w-56 p-1">
        <ul aria-label={t('leftNav.myAssistants')} className="max-h-72 overflow-y-auto">
          {agents.map((agent) => {
            const selected = agent.id === selectedAgentId;
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  data-agent={agent.id}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(agent.id)}
                  className={cn(
                    'glow-focus flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left type-body transition-colors',
                    selected
                      ? 'bg-[var(--state-selected)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <CubeFaceIcon agentId={agent.id} size={20} />
                  <span className="min-w-0 flex-1 truncate">{agentLabel(agent, t)}</span>
                  {selected && <Check size={14} className="flex-shrink-0 text-[var(--accent)]" />}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="my-1 border-t border-[var(--border-subtle)]" />
        <button
          type="button"
          data-action="add-assistant"
          onClick={onAddAssistant}
          className="glow-focus flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left type-body text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Plus size={15} className="flex-shrink-0" />
          <span className="truncate">{t('leftNav.addAssistant')}</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}
