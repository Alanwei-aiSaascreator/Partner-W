import { Wrench, Plug, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import type { EffectiveToolEntry, EffectiveToolsLoadState } from '@clawwork/shared';
import ListItem from '@/components/semantic/ListItem';
import SectionCard from '@/components/semantic/SectionCard';
import ToolbarButton from '@/components/semantic/ToolbarButton';

interface ToolsCatalogProps {
  state: EffectiveToolsLoadState;
  onToolSelect?: (tool: EffectiveToolEntry) => void;
}

export default function ToolsCatalog({ state, onToolSelect }: ToolsCatalogProps) {
  const { t } = useTranslation();
  if (state.status === 'loading') return null;

  if (state.status === 'error') {
    const title = `${t('errors.requestFailed')}: ${state.error}`;
    return (
      <ToolbarButton
        variant="ghost"
        size="sm"
        icon={<TriangleAlert size={14} className="flex-shrink-0" />}
        className="rounded-lg text-[var(--danger)]"
        title={title}
        aria-label={title}
        data-testid="effective-tools-error"
      />
    );
  }

  const { groups, notices = [] } = state.inventory;

  const totalTools = groups.reduce((sum, g) => sum + g.tools.length, 0);
  const title = [t('rightPanel.toolCount', { count: totalTools }), ...notices.map((notice) => notice.message)].join(
    ' — ',
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolbarButton
          variant="ghost"
          size="sm"
          icon={<Wrench size={14} className="flex-shrink-0" />}
          className="rounded-lg text-[var(--text-secondary)]"
          title={title}
          aria-label={title}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-72 overflow-y-auto">
        {notices.map((notice) => (
          <div
            key={notice.id}
            className={
              notice.severity === 'warning'
                ? 'type-meta px-3 py-2 text-[var(--danger)]'
                : 'type-meta px-3 py-2 text-[var(--text-secondary)]'
            }
          >
            {notice.message}
          </div>
        ))}
        {notices.length > 0 && groups.length > 0 && <DropdownMenuSeparator />}
        {groups.map((group, gi) => (
          <div key={group.id}>
            {gi > 0 && <DropdownMenuSeparator />}
            <SectionCard bodyClassName="px-2 py-1.5" className="border-none bg-transparent shadow-none">
              <div className="flex items-center gap-1.5">
                {group.source === 'plugin' ? (
                  <Plug size={14} className="text-[var(--text-muted)]" />
                ) : (
                  <Wrench size={14} className="text-[var(--text-muted)]" />
                )}
                <span className="type-label text-[var(--text-primary)]">{group.label}</span>
                <span className="type-meta ml-auto text-[var(--text-muted)]">{group.tools.length}</span>
              </div>
            </SectionCard>
            {group.tools.map((tool) => (
              <DropdownMenuItem key={tool.id} className="p-0" onSelect={() => onToolSelect?.(tool)}>
                <ListItem
                  title={tool.label}
                  subtitle={tool.description ? <span className="line-clamp-1">{tool.description}</span> : undefined}
                  className="rounded-md px-2 py-1.5"
                />
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
