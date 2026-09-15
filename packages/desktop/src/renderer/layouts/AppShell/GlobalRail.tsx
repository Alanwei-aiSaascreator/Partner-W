import type { ComponentType, ReactNode } from 'react';
import { Archive, ChartNoAxesCombined, FolderOpen, House, PanelLeftOpen, Settings, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MainView } from '@clawwork/core';
import CubeFaceIcon from '@/components/CubeFaceIcon';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type GlobalView = Extract<MainView, 'files' | 'dashboard' | 'archived'>;

interface GlobalRailProps {
  mainView: MainView;
  settingsOpen: boolean;
  activeSettingsSection: 'account' | 'general';
  assistantCollapsed: boolean;
  currentAgentId: string;
  hasUpdate: boolean;
  onGoHome: () => void;
  onSelectView: (view: GlobalView) => void;
  onOpenIdentity: () => void;
  onOpenSettings: () => void;
  onExpandAssistant: () => void;
}

interface RailButtonProps {
  label: string;
  active?: boolean;
  onClick: () => void;
  icon?: ComponentType<{ size?: number }>;
  children?: ReactNode;
  badge?: boolean;
}

function RailButton({ label, active = false, onClick, icon: Icon, children, badge = false }: RailButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          onClick={onClick}
          className={cn(
            'titlebar-no-drag glow-focus relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors active:scale-95',
            active
              ? 'bg-[var(--state-selected)] text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
          )}
        >
          {Icon ? <Icon size={18} /> : children}
          {badge && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[var(--accent)]" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export default function GlobalRail({
  mainView,
  settingsOpen,
  activeSettingsSection,
  assistantCollapsed,
  currentAgentId,
  hasUpdate,
  onGoHome,
  onSelectView,
  onOpenIdentity,
  onOpenSettings,
  onExpandAssistant,
}: GlobalRailProps) {
  const { t } = useTranslation();

  return (
    <aside className="relative z-[2] flex h-full w-14 flex-shrink-0 flex-col items-center border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)] py-2">
      <div className="titlebar-drag flex w-full flex-col items-center gap-1">
        <button
          type="button"
          aria-label={t('common.appName')}
          onClick={onGoHome}
          className="titlebar-no-drag glow-focus mb-2 flex h-10 w-10 items-center justify-center rounded-xl transition-colors hover:bg-[var(--bg-hover)] active:scale-95"
        >
          <CubeFaceIcon agentId="rongying-cube" size={32} />
        </button>
        <RailButton
          label={t('leftNav.home')}
          icon={House}
          active={!settingsOpen && mainView === 'chat'}
          onClick={onGoHome}
        />
        {assistantCollapsed && (
          <RailButton label={t('leftNav.expandNav')} onClick={onExpandAssistant}>
            <span className="relative">
              <CubeFaceIcon agentId={currentAgentId || 'main'} size={26} />
              <PanelLeftOpen
                size={11}
                className="absolute -bottom-1 -right-1 rounded-sm bg-[var(--bg-secondary)] text-[var(--text-primary)]"
              />
            </span>
          </RailButton>
        )}
        <RailButton
          label={t('common.fileManager')}
          icon={FolderOpen}
          active={!settingsOpen && mainView === 'files'}
          onClick={() => onSelectView('files')}
        />
        <RailButton
          label={t('leftNav.usageOverview')}
          icon={ChartNoAxesCombined}
          active={!settingsOpen && mainView === 'dashboard'}
          onClick={() => onSelectView('dashboard')}
        />
        <RailButton
          label={t('leftNav.archivedChats')}
          icon={Archive}
          active={!settingsOpen && mainView === 'archived'}
          onClick={() => onSelectView('archived')}
        />
      </div>

      <div className="flex-1" />

      <div className="flex flex-col items-center gap-1">
        <RailButton
          label={t('leftNav.identityCenter')}
          icon={UserRound}
          active={settingsOpen && activeSettingsSection === 'account'}
          onClick={onOpenIdentity}
        />
        <RailButton
          label={hasUpdate ? t('leftNav.updateAvailable') : t('leftNav.appSettings')}
          icon={Settings}
          active={settingsOpen && activeSettingsSection === 'general'}
          onClick={onOpenSettings}
          badge={hasUpdate}
        />
      </div>
    </aside>
  );
}
