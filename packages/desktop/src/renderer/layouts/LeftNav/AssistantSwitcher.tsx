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
  /**
   * 收纳态（2026-09-29）：只留头像图标。
   *
   * ⚠️ **不叠 Tooltip** —— 这个按钮已经是 `Popover` 的触发器，两个 Radix portal
   * 抢同一个元素会互相打架（Popover 自己的 `side="right"` 在窄条旁边本来就够用）。
   *
   * ⭐ 「当前助手不在本机」时，展开态由紧跟其后的 `AgentMissingNotice` 说明；
   * 收纳态那点宽度放不下那句说明，所以**落成一个警示角点**。
   *
   * ⚠️ 只留一个 2px 的点，对**读屏**等于什么都没说（独立复核指出：那句话是
   * "不许悄悄消化掉"，而当时对 AT 恰恰就是消化的）。所以警示也折进了
   * `aria-label` —— 见下面那个三元。
   */
  collapsed?: boolean;
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
  collapsed = false,
}: AssistantSwitcherProps) {
  const { t } = useTranslation();
  /**
   * ⚠️ 2026-09-24：`selectedAgentId` **非空但不在目录里**时**不许**拿 `agents[0]` 顶上 ——
   * 那会把别的助手显示成「当前助手」，而用户点的是另一个（与欢迎屏同一个病，
   * 也就是 [[team-agent-404-405-brief]] 里的层 2）。
   *
   * 区分两种"找不到"：**空串 = 没有选择**（退回第一个是对的）；**非空且找不到 = 拒绝**
   * （下面的中性格子 + `leftNav.myAssistants` 文案本来就有，正好是诚实的落点），
   * 说明由 `LeftNav` 紧跟其后渲染的 `AgentMissingNotice` 给出。
   */
  const current = agents.find((a) => a.id === selectedAgentId) ?? (selectedAgentId ? undefined : agents[0]);
  const currentLabel = current ? agentLabel(current, t) : t('leftNav.myAssistants');
  /** 点了名却不在目录里 —— 展开态由 `AgentMissingNotice` 说，收纳态落成角点。 */
  const missing = !current && Boolean(selectedAgentId);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="assistant-switcher"
          data-missing={missing ? 'true' : undefined}
          /**
           * ⚠️ 收纳态那句说明放不下，只落了一个 2px 的角点 —— 对读屏**等于什么都没说**。
           * 所以把"当前助手不在本机"折进**可访问名**（展开态同样无害，只是与下面的
           * `AgentMissingNotice` 重复一次，而重复远好过沉默）。
           */
          aria-label={
            missing
              ? `${t('leftNav.myAssistants')} — ${t('agent.missingTitle', { agentId: selectedAgentId })}`
              : t('leftNav.myAssistants')
          }
          className={cn(
            'titlebar-no-drag glow-focus relative flex w-full items-center rounded-md text-left type-body text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] data-[state=open]:bg-[var(--bg-hover)] data-[state=open]:text-[var(--text-primary)]',
            collapsed ? 'justify-center py-2' : 'gap-2.5 px-2.5 py-1.5',
          )}
        >
          {current ? (
            <CubeFaceIcon agentId={current.id} size={18} />
          ) : (
            <span className="size-[18px] flex-shrink-0 rounded bg-[var(--bg-tertiary)]" />
          )}
          <span className={cn('min-w-0 flex-1 truncate font-semibold', collapsed && 'hidden')}>{currentLabel}</span>
          <ChevronDown size={14} className={cn('flex-shrink-0 opacity-70', collapsed && 'hidden')} />
          {collapsed && missing && (
            <span
              data-testid="assistant-missing-dot"
              className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--warning)]"
            />
          )}
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
