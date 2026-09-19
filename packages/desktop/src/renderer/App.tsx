import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { PanelLeftOpen } from 'lucide-react';
import { Toaster, TOAST_DURATION_MS, TOAST_OPTIONS } from '@/lib/toast';
import LeftNav from './layouts/LeftNav';
import MainArea from './layouts/MainArea';
import RightPanel from './layouts/RightPanel';
import Setup from './layouts/Setup';
import Login from './layouts/Login';
import Onboarding from './layouts/Onboarding';
import Settings from './layouts/Settings';
import type { SettingsSection } from './layouts/Settings/SettingsNav';
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
import { useModuleOpenTracking } from './hooks/useModuleOpenTracking';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useSettingsBootstrap } from './hooks/useSettingsBootstrap';
import { useStartupReadiness } from './hooks/useStartupReadiness';
import { cn } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { motionDuration, motionEase } from '@/styles/design-tokens';
import { loadOnboardingProfile, saveOnboardingProfile, type OnboardingProfile } from '@/lib/user-onboarding';
import { AUTH_CHECK_FALLBACK_MS, resolveAppEntryScreen, runAuthBootstrap } from '@/lib/app-entry-flow';
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
  const { t } = useTranslation();
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
  const openSettings = useCallback(
    (section: SettingsSection) => {
      setSettingsSection(section);
      setSettingsOpen(true);
    },
    [setSettingsOpen],
  );

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
  useModuleOpenTracking();
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
    /** 配置读完才会知道要不要做会话检查，所以取消函数得晚一步才有 —— 先占个位。 */
    let cancelAuthCheck: (() => void) | null = null;

    (async () => {
      // ① 先看商业配置。**没配置就是本地模式，压根没有会话要检查**（也就没有网络依赖）。
      try {
        const config = await window.clawwork.commercialGetConfig();
        if (cancelled) return;
        const configured = Boolean(config.ok && config.result?.supabaseUrl && config.result?.hasAnonKey);
        if (!configured) {
          setOnboardingAccount({ userId: 'local', nickname: '' });
          setOnboardingProfile(loadOnboardingProfile('local'));
          setOnboardingResolved(true);
          setAuthState('ok');
          return;
        }
      } catch (err) {
        // Fail closed — a thrown config read must not bypass the login gate.
        console.error('[App] commercial config read failed:', err);
        if (!cancelled) setAuthState('required');
        return;
      }
      if (cancelled) return;

      // ② 会话检查（B7）：本地快速态只决定**兜底怎么判**，结论一律听后台的。
      cancelAuthCheck = runAuthBootstrap<Awaited<ReturnType<typeof window.clawwork.commercialSession>>>({
        readLocalSession: () => window.clawwork.commercialLocalSession().then((r) => Boolean(r.ok && r.result)),
        checkBackend: () => window.clawwork.commercialSession(),
        isSignedIn: (session) => Boolean(session.ok && session.result?.signedIn),
        timeoutMs: AUTH_CHECK_FALLBACK_MS,
        onSettled: (session, authState) => {
          if (cancelled) return;
          if (authState === 'ok') {
            const userId = session?.result?.profile?.userId ?? 'local';
            setOnboardingAccount({ userId, nickname: session?.result?.profile?.nickname ?? '' });
            setOnboardingProfile(loadOnboardingProfile(userId));
            setOnboardingResolved(true);
          }
          setAuthState(authState);
        },
        onTimeout: (fallback) => {
          if (!cancelled) setAuthState((prev) => (prev === 'checking' ? fallback : prev));
        },
      });
    })();

    return () => {
      cancelled = true;
      cancelAuthCheck?.();
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
        {/* 图标栏（`GlobalRail`）已删除（2026-09-19）—— 它的页面入口与左侧导航列
            **基本重复**；去掉后把别处还没有的几项搬进了 `NavMenu`：
            文件管理 / 归档对话 / 资料库（主清单）、内测中心 / 设置（底部一组）。
            ⇒ 现在左侧只剩**一列**：导航列（`LeftNav`）。 */}
        <motion.aside
          animate={{ width: leftNavCollapsed ? 0 : leftNavWidth }}
          transition={{ duration: motionDuration.moderate, ease: motionEase.standard }}
          className={cn(
            'relative z-[1] flex-shrink-0 overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)]',
          )}
          style={{ minWidth: leftNavCollapsed ? 0 : 200 }}
        >
          <LeftNav
            onOpenAssistantSettings={() => openSettings('agents')}
            onOpenSkills={() => openSettings('skills')}
            onOpenSettings={() => openSettings('general')}
          />
        </motion.aside>

        {!leftNavCollapsed && (
          <div
            className="group w-1.5 flex-shrink-0 cursor-col-resize z-10 -mx-[3px]"
            onMouseDown={(e) => startPanelDrag(e, leftNavWidth, setLeftNavWidth, 1)}
          >
            <div className="h-full w-px mx-auto bg-[var(--border)] group-hover:bg-[var(--accent)] transition-colors" />
          </div>
        )}
        {/* ⚠️ 收起侧栏后**必须留一个展开入口**。
            原来这个入口在图标栏上（`GlobalRail` 的 `expandNav` 按钮），本刀连图标栏一起删了
            ⇒ 不留的话用户收起之后**再也点不回来**（只剩键盘快捷键）。
            这里留一条 28px 窄条，只放一个展开按钮。 */}
        {leftNavCollapsed && (
          <div className="titlebar-drag flex w-7 flex-shrink-0 flex-col items-center border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)] pt-2">
            <button
              type="button"
              onClick={toggleLeftNavCollapsed}
              aria-label={t('leftNav.expandNav')}
              title={t('leftNav.expandNav')}
              className="titlebar-no-drag glow-focus flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <PanelLeftOpen size={15} />
            </button>
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
