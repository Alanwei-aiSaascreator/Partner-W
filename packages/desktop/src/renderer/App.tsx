import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Toaster, TOAST_DURATION_MS, TOAST_OPTIONS } from '@/lib/toast';
import LeftNav from './layouts/LeftNav';
import MainArea from './layouts/MainArea';
import RightPanel from './layouts/RightPanel';
import Setup from './layouts/Setup';
import Login from './layouts/Login';
import Onboarding from './layouts/Onboarding';
import Settings from './layouts/Settings';
import type { SettingsSection } from './layouts/Settings/SettingsNav';
import GlobalRail from './layouts/AppShell/GlobalRail';
import ApprovalDialog from './components/ApprovalDialog';
import CommandPalette from './components/CommandPalette';
import { useUiStore, type Theme } from './stores/uiStore';
import { useTaskStore } from './stores/taskStore';
import { useFileStore } from './stores/fileStore';
import { composer } from './platform';
import { useGatewayBootstrap } from './hooks/useGatewayBootstrap';
import { useWorkspaceRefresh } from './hooks/useWorkspaceRefresh';
import { useUpdateCheck } from './hooks/useUpdateCheck';
import { useTraySync } from './hooks/useTraySync';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useSettingsBootstrap } from './hooks/useSettingsBootstrap';
import { useStartupReadiness } from './hooks/useStartupReadiness';
import { cn } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { motionDuration, motionEase } from '@/styles/design-tokens';
import { loadOnboardingProfile, saveOnboardingProfile, type OnboardingProfile } from '@/lib/user-onboarding';
import { resolveAppEntryScreen } from '@/lib/app-entry-flow';
import { parseBetaRoute } from '@/features/internal-beta/beta-route';

function AppToaster({ themeMode }: { themeMode: Theme }) {
  return (
    <Toaster
      theme={themeMode === 'auto' ? 'system' : themeMode}
      position="top-right"
      closeButton
      visibleToasts={3}
      duration={TOAST_DURATION_MS}
      toastOptions={TOAST_OPTIONS}
    />
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [authState, setAuthState] = useState<'checking' | 'required' | 'ok'>('checking');
  const [onboardingAccount, setOnboardingAccount] = useState<{ userId: string; nickname: string } | null>(null);
  const [onboardingProfile, setOnboardingProfile] = useState<OnboardingProfile | null>(null);
  const [onboardingResolved, setOnboardingResolved] = useState(false);
  const [editingOnboardingProfile, setEditingOnboardingProfile] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');

  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const mainView = useUiStore((s) => s.mainView);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setMainView = useUiStore((s) => s.setMainView);
  const toggleCommandPalette = useUiStore((s) => s.toggleCommandPalette);
  const commandPaletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const startNewTask = useTaskStore((s) => s.startNewTask);
  const createTask = useTaskStore((s) => s.createTask);
  const setActiveTask = useTaskStore((s) => s.setActiveTask);

  const leftNavCollapsed = useUiStore((s) => s.leftNavCollapsed);
  const toggleLeftNavCollapsed = useUiStore((s) => s.toggleLeftNavCollapsed);
  const leftNavWidth = useUiStore((s) => s.leftNavWidth);
  const setLeftNavWidth = useUiStore((s) => s.setLeftNavWidth);
  const rightPanelWidth = useUiStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUiStore((s) => s.setRightPanelWidth);
  const leftNavShortcut = useUiStore((s) => s.leftNavShortcut);
  const rightPanelShortcut = useUiStore((s) => s.rightPanelShortcut);
  const themeMode = useUiStore((s) => s.theme);
  const hasUpdate = useUiStore((s) => s.hasUpdate);
  const currentAgentId = useUiStore((s) => {
    const gatewayId = s.defaultGatewayId;
    if (!gatewayId) return 'main';
    return s.selectedAgentByGateway[gatewayId] || s.agentCatalogByGateway[gatewayId]?.defaultId || 'main';
  });

  const openSettings = useCallback(
    (section: SettingsSection) => {
      setSettingsSection(section);
      setSettingsOpen(true);
    },
    [setSettingsOpen],
  );

  const goHome = useCallback(() => {
    if (window.location.hash.startsWith('#/beta/')) window.history.replaceState(null, '', '#/');
    setActiveTask(null);
    setMainView('chat');
  }, [setActiveTask, setMainView]);

  useEffect(() => {
    const navigateHash = () => {
      if (parseBetaRoute(window.location.hash)) setMainView('betaHub');
    };
    navigateHash();
    window.addEventListener('hashchange', navigateHash);
    return () => window.removeEventListener('hashchange', navigateHash);
  }, [setMainView]);

  useGatewayBootstrap();
  const startupReadiness = useStartupReadiness(ready);
  useWorkspaceRefresh();
  useUpdateCheck();
  useTraySync();
  useSettingsBootstrap(ready);
  useKeyboardShortcuts({
    startNewTask,
    setMainView,
    toggleCommandPalette,
    leftNavShortcut,
    rightPanelShortcut,
    toggleLeftNavCollapsed,
    toggleRightPanel,
  });

  const startPanelDrag = useCallback(
    (e: React.MouseEvent, startWidth: number, setWidth: (w: number) => void, dir: 1 | -1) => {
      e.preventDefault();
      const ox = e.clientX;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      const onMove = (ev: MouseEvent) => setWidth(startWidth + dir * (ev.clientX - ox));
      const onUp = () => {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [],
  );

  useEffect(() => {
    const cleanup = window.clawwork.onArtifactSaved((artifact) => {
      useFileStore.getState().addArtifactIfNew(artifact as import('@clawwork/shared').Artifact);
    });
    return cleanup;
  }, []);

  useEffect(() => {
    window.clawwork
      .isWorkspaceConfigured()
      .then((configured) => {
        if (configured) {
          setReady(true);
        } else {
          setNeedsSetup(true);
        }
      })
      .catch((err: unknown) => {
        console.error('[App] isWorkspaceConfigured failed:', err);
        setNeedsSetup(true);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!cancelled) setAuthState((prev) => (prev === 'checking' ? 'required' : prev));
    }, 5000);

    (async () => {
      try {
        const config = await window.clawwork.commercialGetConfig();
        const configured = Boolean(config.ok && config.result?.supabaseUrl && config.result?.hasAnonKey);
        if (cancelled) return;
        if (!configured) {
          setOnboardingAccount({ userId: 'local', nickname: '' });
          setOnboardingProfile(loadOnboardingProfile('local'));
          setOnboardingResolved(true);
          setAuthState('ok');
          return;
        }
        const session = await window.clawwork.commercialSession();
        if (cancelled) return;
        const signedIn = Boolean(session.ok && session.result?.signedIn);
        if (signedIn) {
          const userId = session.result?.profile?.userId ?? 'local';
          setOnboardingAccount({ userId, nickname: session.result?.profile?.nickname ?? '' });
          setOnboardingProfile(loadOnboardingProfile(userId));
          setOnboardingResolved(true);
        }
        setAuthState(signedIn ? 'ok' : 'required');
      } catch (err) {
        // Fail closed — a thrown session check must not bypass the login gate.
        console.error('[App] commercial auth check failed:', err);
        if (!cancelled) setAuthState('required');
      } finally {
        clearTimeout(timeout);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, []);

  const handleSignedIn = useCallback(async () => {
    try {
      const session = await window.clawwork.commercialSession();
      const userId = session.result?.profile?.userId ?? 'local';
      setOnboardingAccount({ userId, nickname: session.result?.profile?.nickname ?? '' });
      setOnboardingProfile(loadOnboardingProfile(userId));
    } catch {
      setOnboardingAccount({ userId: 'local', nickname: '' });
      setOnboardingProfile(loadOnboardingProfile('local'));
    }
    setOnboardingResolved(true);
    setAuthState('ok');
  }, []);

  const handleOnboardingComplete = useCallback((profile: OnboardingProfile) => {
    saveOnboardingProfile(profile);
    setOnboardingProfile(profile);
    setEditingOnboardingProfile(false);
  }, []);

  useEffect(() => {
    window.clawwork.setWindowButtonVisibility(!leftNavCollapsed);
  }, [leftNavCollapsed]);

  useEffect(() => {
    return window.clawwork.onQuickLaunchSubmit((message) => {
      const task = createTask();
      composer.send(task.id, { content: message, titleHint: message });
    });
  }, [createTask]);

  useEffect(() => {
    const navigateToTask = (taskId: string): void => {
      setActiveTask(taskId);
      setSettingsOpen(false);
      setMainView('chat');
    };
    const cleanupNav = window.clawwork.onTrayNavigateTask(navigateToTask);
    const cleanupNotification = window.clawwork.onNotificationNavigateTask(navigateToTask);
    const cleanupSettings = window.clawwork.onTrayOpenSettings(() => {
      setSettingsSection('general');
      setSettingsOpen(true);
    });
    return () => {
      cleanupNav();
      cleanupNotification();
      cleanupSettings();
    };
  }, [setActiveTask, setSettingsOpen, setMainView]);

  const entryScreen = resolveAppEntryScreen({
    authState,
    onboardingResolved,
    hasOnboardingAccount: Boolean(onboardingAccount),
    hasOnboardingProfile: Boolean(onboardingProfile),
    needsSetup,
    ready,
  });

  if (entryScreen === 'loading') return null;

  if (entryScreen === 'login') {
    return (
      <TooltipProvider>
        <Login onSignedIn={handleSignedIn} />
        <AppToaster themeMode={themeMode} />
      </TooltipProvider>
    );
  }

  if (entryScreen === 'onboarding' && onboardingAccount) {
    return (
      <TooltipProvider>
        <Onboarding
          userId={onboardingAccount.userId}
          defaultNickname={onboardingAccount.nickname}
          onComplete={handleOnboardingComplete}
        />
        <AppToaster themeMode={themeMode} />
      </TooltipProvider>
    );
  }

  if (entryScreen === 'workspace' && editingOnboardingProfile && onboardingAccount && onboardingProfile) {
    return (
      <TooltipProvider>
        <Onboarding
          userId={onboardingAccount.userId}
          defaultNickname={onboardingAccount.nickname}
          mode="edit"
          initialProfile={onboardingProfile}
          onComplete={handleOnboardingComplete}
          onCancel={() => setEditingOnboardingProfile(false)}
        />
        <AppToaster themeMode={themeMode} />
      </TooltipProvider>
    );
  }

  if (entryScreen === 'setup') {
    return (
      <TooltipProvider>
        <Setup
          onSetupComplete={() => {
            setNeedsSetup(false);
            setReady(true);
          }}
        />
        <AppToaster themeMode={themeMode} />
      </TooltipProvider>
    );
  }

  if (entryScreen !== 'workspace' || !onboardingProfile) return null;

  return (
    <TooltipProvider>
      <AnimatePresence>{commandPaletteOpen && <CommandPalette />}</AnimatePresence>
      <div className="relative flex h-screen overflow-hidden bg-[var(--bg-primary)]">
        <GlobalRail
          mainView={mainView}
          settingsOpen={settingsOpen}
          activeSettingsSection={settingsSection === 'account' ? 'account' : 'general'}
          assistantCollapsed={leftNavCollapsed}
          currentAgentId={currentAgentId}
          hasUpdate={hasUpdate}
          onGoHome={goHome}
          onSelectView={setMainView}
          onOpenIdentity={() => openSettings('account')}
          onOpenSettings={() => openSettings('general')}
          onExpandAssistant={toggleLeftNavCollapsed}
        />
        <motion.aside
          animate={{ width: leftNavCollapsed ? 0 : leftNavWidth }}
          transition={{ duration: motionDuration.moderate, ease: motionEase.standard }}
          className={cn(
            'relative z-[1] flex-shrink-0 overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)]',
          )}
          style={{ minWidth: leftNavCollapsed ? 0 : 200 }}
        >
          <LeftNav onOpenAssistantSettings={() => openSettings('agents')} />
        </motion.aside>

        {!leftNavCollapsed && (
          <div
            className="group w-1.5 flex-shrink-0 cursor-col-resize z-10 -mx-[3px]"
            onMouseDown={(e) => startPanelDrag(e, leftNavWidth, setLeftNavWidth, 1)}
          >
            <div className="h-full w-px mx-auto bg-[var(--border)] group-hover:bg-[var(--accent)] transition-colors" />
          </div>
        )}

        <main className="relative flex-1 min-w-0 flex flex-col z-[1]">
          {settingsOpen ? (
            <Settings
              initialSection={settingsSection}
              onboardingProfile={onboardingProfile}
              onEditOnboardingProfile={() => {
                setSettingsOpen(false);
                setEditingOnboardingProfile(true);
              }}
            />
          ) : (
            <MainArea
              onTogglePanel={toggleRightPanel}
              onboardingProfile={onboardingProfile}
              startupReadiness={startupReadiness}
              onRetryStartup={startupReadiness.retry}
            />
          )}
        </main>

        <AnimatePresence>
          {rightPanelOpen && !settingsOpen && mainView === 'chat' && (
            <>
              <div
                className="group w-1.5 flex-shrink-0 cursor-col-resize z-10 -mx-[3px]"
                onMouseDown={(e) => startPanelDrag(e, rightPanelWidth, setRightPanelWidth, -1)}
              >
                <div className="h-full w-px mx-auto bg-[var(--border)] group-hover:bg-[var(--accent)] transition-colors" />
              </div>
              <motion.aside
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: rightPanelWidth, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: motionDuration.moderate, ease: motionEase.standard }}
                className={cn('glass-heavy relative flex-shrink-0 overflow-hidden z-[1] border-l-0')}
              >
                <RightPanel />
              </motion.aside>
            </>
          )}
        </AnimatePresence>
        <AppToaster themeMode={themeMode} />
        <ApprovalDialog />
      </div>
    </TooltipProvider>
  );
}
