import type { ComponentType, ReactNode } from 'react';
import {
  Archive,
  BookOpen,
  ChartNoAxesCombined,
  FolderOpen,
  House,
  PanelLeftOpen,
  Settings,
  Sparkles,
  Store,
  Trophy,
  UserRound,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MainView } from '@clawwork/core';
import CubeFaceIcon from '@/components/CubeFaceIcon';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type GlobalView = Extract<
  MainView,
  'files' | 'dashboard' | 'archived' | 'betaHub' | 'community' | 'market' | 'growth' | 'kb'
>;

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
        {/* 身份中心：**排在首页之后**（2026-09-19 从图标栏底部提上来的）。
            原来它和「应用设置」一起待在底部 —— 那是因为它当初接的是**账户设置**
            （文不对题，本刀一并修了）。改成真正的页面后，按产品口径它是**日常入口**，
            埋在底部没人找得到。
            ⚠️ 这是**移动已有按钮**、不是新增 ⇒ 不影响 global-rail.test.tsx
               （那个测试按 label 找按钮，不按位置）。 */}
        <RailButton
          label={t('leftNav.identityCenter')}
          icon={UserRound}
          active={!settingsOpen && mainView === 'identity'}
          onClick={onOpenIdentity}
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
          label={t('beta.title')}
          icon={Sparkles}
          active={!settingsOpen && mainView === 'betaHub'}
          onClick={() => onSelectView('betaHub')}
          badge
        />
        <RailButton
          label={t('leftNav.archivedChats')}
          icon={Archive}
          active={!settingsOpen && mainView === 'archived'}
          onClick={() => onSelectView('archived')}
        />
        {/* ⚠️ 新入口必须排在**最后**：global-rail.test.tsx 用
            toHaveBeenNthCalledWith(1..3) 锁定了前几个按钮的顺序。 */}
        <RailButton
          label={t('community.title')}
          icon={Users}
          active={!settingsOpen && mainView === 'community'}
          onClick={() => onSelectView('community')}
        />
        {/* ⚠️ 新入口仍然加在**最后**：global-rail.test.tsx 的 nth 断言锁定着前几个 */}
        <RailButton
          label={t('market.title')}
          icon={Store}
          active={!settingsOpen && mainView === 'market'}
          onClick={() => onSelectView('market')}
        />
        {/* ⚠️ 新入口仍然加在**最后**：global-rail.test.tsx 的 nth 断言锁定着前几个 */}
        <RailButton
          label={t('growth.title')}
          icon={Trophy}
          active={!settingsOpen && mainView === 'growth'}
          onClick={() => onSelectView('growth')}
        />
        <RailButton
          label={t('kb.title')}
          icon={BookOpen}
          active={!settingsOpen && mainView === 'kb'}
          onClick={() => onSelectView('kb')}
        />
      </div>

      <div className="flex-1" />

      <div className="flex flex-col items-center gap-1">
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
