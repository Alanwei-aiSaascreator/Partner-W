import { ChartNoAxesCombined, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MainView } from '@clawwork/core';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface LeftNavPrimaryLinksProps {
  collapsed: boolean;
  mainView: MainView;
  onSelect: (view: MainView) => void;
}

const PRIMARY_LINKS = [
  { view: 'files', icon: FolderOpen, labelKey: 'common.fileManager' },
  { view: 'dashboard', icon: ChartNoAxesCombined, labelKey: 'leftNav.usageOverview' },
] as const;

export default function LeftNavPrimaryLinks({ collapsed, mainView, onSelect }: LeftNavPrimaryLinksProps) {
  const { t } = useTranslation();

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-0.5">
        {PRIMARY_LINKS.map(({ view, icon: Icon, labelKey }) => {
          const label = t(labelKey);
          return (
            <Tooltip key={view}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onSelect(view)}
                  aria-label={label}
                  className={cn(
                    'titlebar-no-drag relative flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                    'focus-visible:outline-none glow-focus active:scale-95',
                    mainView === view
                      ? 'bg-[var(--accent-dim)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  <Icon size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {PRIMARY_LINKS.map(({ view, icon: Icon, labelKey }) => (
        <button
          key={view}
          onClick={() => onSelect(view)}
          className={cn(
            'titlebar-no-drag type-label relative flex w-full items-center gap-2.5 rounded-md px-3 py-2 transition-colors',
            'focus-visible:outline-none glow-focus active:scale-[0.98]',
            mainView === view
              ? 'bg-[var(--accent-dim)] text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
          )}
        >
          <Icon size={16} className="flex-shrink-0 opacity-60" />
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}
