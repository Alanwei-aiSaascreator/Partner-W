import { useState, useEffect, useCallback, useRef } from 'react';
import { usePreventFileDropNavigation } from './hooks/usePreventFileDropNavigation';
import { motion, AnimatePresence } from 'framer-motion';
import { Toaster, TOAST_DURATION_MS, TOAST_OPTIONS } from '@/lib/toast';
import LeftNav from './layouts/LeftNav';
import MainArea from './layouts/MainArea';
import RightPanel from './layouts/RightPanel';
import Setup from './layouts/Setup';
import Login from './layouts/Login';
import Onboarding from './layouts/Onboarding';
import EntryPreparation from './layouts/EntryPreparation';
import { useEntryRuntimeStatus } from './hooks/useEntryRuntimeStatus';
import { deriveStartupReadiness } from './lib/startup-readiness';
import { presetAgentBootstrapCoordinator } from './lib/preset-agent-bootstrap';
import { deriveEntryPreparation, type EntryEntitlement, type EntryPreparationFacts } from './lib/entry-preparation';
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
import { useDocgenFailureToast } from './hooks/useDocgenFailureToast';
import { useHtmlgenFailureToast } from './hooks/useHtmlgenFailureToast';
import { useSlidegenToast } from './hooks/useSlidegenToast';
import { useArtifactPanelReveal } from './hooks/useArtifactPanelReveal';
import { useClaimGuardToast } from './hooks/useClaimGuardToast';
import { useDeliveryActivitySubscription } from './hooks/useDeliveryActivitySubscription';
import { useAutoRetryFailedTurn } from './hooks/useAutoRetryFailedTurn';
import { cn } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { LEFT_NAV_RAIL_WIDTH, motionDuration, motionEase } from '@/styles/design-tokens';
import { loadOnboardingProfile, saveOnboardingProfile, type OnboardingProfile } from '@/lib/user-onboarding';
import {
  AUTH_CHECK_FALLBACK_MS,
  entryAccountFromSession,
  entryModeFromConfig,
  resolveAppEntryScreen,
  runAuthBootstrap,
} from '@/lib/app-entry-flow';
import { createEntryLicenseGate, EntryLicenseError } from '@/lib/entry-license-gate';
import { useArtifactPanelViewScope } from '@/lib/artifact-preview-navigation';
import { isInternalBetaEnabled, parseBetaRoute } from '@/features/internal-beta/beta-route';
import { useGatewayDisappearanceNotice } from '@/lib/gateway-disappearance';

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
  const authGeneration = useRef(0);
  // 拖入文件不得触发整页导航（T05）：窗口级兜底，覆盖任何非输入区。
  usePreventFileDropNavigation();
  const [entryLicenseGate] = useState(createEntryLicenseGate);
  const [entryErrorCode, setEntryErrorCode] = useState<string>();
  const [entryEntitlement, setEntryEntitlement] = useState<EntryEntitlement | null>(null);
  const [preparedScope, setPreparedScope] = useState<string | null>(null);
  const [preparationRetry, setPreparationRetry] = useState(0);
  const preparationFactsRef = useRef<EntryPreparationFacts | null>(null);
  const [preparationOverride, setPreparationOverride] = useState<Pick<
    EntryPreparationFacts,
    'scopeKey' | 'runtime' | 'startup'
  > | null>(null);
  const completeAccountEntry = useCallback(
    async (account: { userId: string; nickname: string }, generation: number, activationKey = '') => {
      const license = await entryLicenseGate.ensure({
        userId: account.userId,
        activationKey,
        api: window.clawwork,
        isCurrent: () => generation === authGeneration.current,
      });
      if (generation !== authGeneration.current) throw new EntryLicenseError('entry_superseded');
      setEntryEntitlement({
        userId: account.userId,
        licenseId: license.licenseId,
        orgId: license.orgId,
        status: license.status,
        expiresAt: license.expiresAt,
      });
      setPreparedScope(null);
      setOnboardingAccount(account);
      setOnboardingProfile(loadOnboardingProfile(account.userId));
      setOnboardingResolved(true);
      setEntryErrorCode(undefined);
      setAuthState('ok');
    },
    [entryLicenseGate],
  );
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');

  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const mainView = useUiStore((s) => s.mainView);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setMainView = useUiStore((s) => s.setMainView);
  // ⭐ Task 3 视图门：离开聊天/打开设置 ⇒ 右侧预览复位回列表（回聊天**不**自动恢复 ——
  //    FileBrowser 期间改过共享选中 ID，自动恢复会预览出另一份文件）。
  useArtifactPanelViewScope();
  const toggleCommandPalette = useUiStore((s) => s.toggleCommandPalette);
  const commandPaletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const startNewTask = useTaskStore((s) => s.startNewTask);
  const createTask = useTaskStore((s) => s.createTask);
  const setActiveTask = useTaskStore((s) => s.setActiveTask);
  const workspaceEpoch = useTaskStore((s) => s.workspaceEpoch);
  const onboardingGeneration = authGeneration.current;
  const currentOnboardingOwner = useRef({ authState, userId: onboardingAccount?.userId });
  currentOnboardingOwner.current = { authState, userId: onboardingAccount?.userId };

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
    window.clawwork.reportPortableUpdateRendererReady();
  }, []);

  useEffect(() => {
    const navigateHash = () => {
      if (isInternalBetaEnabled() && parseBetaRoute(window.location.hash)) setMainView('betaHub');
    };
    navigateHash();
    window.addEventListener('hashchange', navigateHash);
    return () => window.removeEventListener('hashchange', navigateHash);
  }, [setMainView]);

  useGatewayBootstrap();
  // 网关从本机消失时给一条说明（`useGatewaySelector` 那边是**静默**换掉的）。
  // ⚠️ 挂在 App 而不是 MainArea：打开设置会卸载 MainArea（`settingsOpen ? <Settings/> : <MainArea/>`），
  //    那期间的"消失"就会被漏掉，且回来时基准重置 ⇒ 一句都不报。
  useGatewayDisappearanceNotice();

  const startupReadiness = useStartupReadiness(ready && authState === 'ok');
  const commercialEntry = onboardingAccount !== null && onboardingAccount.userId !== 'local';
  const preparationScope = JSON.stringify([
    onboardingAccount?.userId,
    entryEntitlement?.licenseId,
    entryEntitlement?.orgId,
    workspaceEpoch,
    startupReadiness.gatewayId,
    authGeneration.current,
    preparationRetry,
  ]);
  const runtimeStatus = useEntryRuntimeStatus(commercialEntry && authState === 'ok' ? preparationScope : null);
  const preparationFacts: EntryPreparationFacts = {
    scopeKey: preparationScope,
    currentScopeKey: preparationScope,
    accountUserId: onboardingAccount?.userId ?? null,
    entitlement: entryEntitlement,
    runtime: preparationOverride?.scopeKey === preparationScope ? preparationOverride.runtime : runtimeStatus,
    startup: preparationOverride?.scopeKey === preparationScope ? preparationOverride.startup : startupReadiness,
  };
  preparationFactsRef.current = preparationFacts;

  useWorkspaceRefresh();
  useUpdateCheck();
  // 挂 App 而不是 MainArea：打开设置会卸载 MainArea，那期间文件生成失败就会被漏掉，
  // 而"漏掉一条失败提示"的表现恰好和"什么都没发生"一模一样。
  useDocgenFailureToast();
  useHtmlgenFailureToast();
  useSlidegenToast();
  // 产物一落盘就把右侧「产物」面板展开 —— 用户反馈 #2：以前要手动点「切换上下文面板」才看得到。
  useArtifactPanelReveal();
  useClaimGuardToast();
  useDeliveryActivitySubscription();
  // 「整轮失败自动重发 1 次」（包 D）：空转型失败（零最终交付）自动重发一次，先明示再发。
  // 挂 App 不挂 MainArea：打开设置会卸载 MainArea —— 那期间被漏掉的失败就再也不会重发了。
  useAutoRetryFailedTurn();
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
      useFileStore.getState().upsertArtifact(artifact as import('@clawwork/shared').Artifact);
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
    const generation = ++authGeneration.current;
    /** 配置读完才会知道要不要做会话检查，所以取消函数得晚一步才有 —— 先占个位。 */
    let cancelAuthCheck: (() => void) | null = null;

    (async () => {
      // ① 先看商业配置。**没配置就是本地模式，压根没有会话要检查**（也就没有网络依赖）。
      try {
        const config = await window.clawwork.commercialGetConfig();
        if (cancelled || generation !== authGeneration.current) return;
        const entryMode = entryModeFromConfig(config);
        if (entryMode === 'error') {
          setAuthState('required');
          return;
        }
        if (entryMode === 'local') {
          setOnboardingAccount({ userId: 'local', nickname: '' });
          setOnboardingProfile(loadOnboardingProfile('local'));
          setOnboardingResolved(true);
          setAuthState('ok');
          return;
        }
      } catch (err) {
        // Fail closed — a thrown config read must not bypass the login gate.
        console.error('[App] commercial config read failed:', err);
        if (!cancelled && generation === authGeneration.current) setAuthState('required');
        return;
      }
      if (cancelled || generation !== authGeneration.current) return;

      // ② 会话检查（B7）：本地快速态只决定**兜底怎么判**，结论一律听后台的。
      cancelAuthCheck = runAuthBootstrap<Awaited<ReturnType<typeof window.clawwork.commercialSession>>>({
        readLocalSession: () => window.clawwork.commercialLocalSession().then((r) => Boolean(r.ok && r.result)),
        checkBackend: () => window.clawwork.commercialSession(),
        isSignedIn: (session) => entryAccountFromSession(session) !== null,
        timeoutMs: AUTH_CHECK_FALLBACK_MS,
        onSettled: (session, authState) => {
          if (cancelled || generation !== authGeneration.current) return;
          if (authState === 'ok') {
            const account = session && entryAccountFromSession(session);
            if (account) {
              setOnboardingAccount(account);
              void completeAccountEntry(account, generation).catch((failure: unknown) => {
                if (cancelled || generation !== authGeneration.current) return;
                setEntryErrorCode(failure instanceof EntryLicenseError ? failure.code : 'license_read_failed');
                setAuthState('required');
              });
              return;
            }
          }
          setAuthState(authState);
        },
        onTimeout: (fallback) => {
          if (!cancelled && generation === authGeneration.current)
            setAuthState((prev) => (prev === 'checking' ? fallback : prev));
        },
      });
    })();

    return () => {
      cancelled = true;
      authGeneration.current += 1;
      cancelAuthCheck?.();
    };
  }, [completeAccountEntry]);

  const handleSignInStarted = useCallback(() => {
    authGeneration.current += 1;
    setAuthState('required');
    setOnboardingAccount(null);
    setOnboardingProfile(null);
    setOnboardingResolved(false);
    setEntryErrorCode(undefined);
    setEntryEntitlement(null);
    setPreparedScope(null);
  }, []);

  const handleSignedIn = useCallback(
    async (activationKey = '') => {
      const generation = ++authGeneration.current;
      const expectedUserId = onboardingAccount?.userId;
      const config = await window.clawwork.commercialGetConfig();
      if (generation !== authGeneration.current) throw new EntryLicenseError('entry_superseded');
      if (entryModeFromConfig(config) !== 'commercial') throw new EntryLicenseError('not_configured');
      const session = await window.clawwork.commercialSession();
      if (generation !== authGeneration.current) throw new EntryLicenseError('entry_superseded');
      const account = entryAccountFromSession(session);
      if (!account) throw new Error('commercial_entry_identity_unavailable');
      if (expectedUserId && account.userId !== expectedUserId)
        throw new EntryLicenseError('entry_identity_unavailable');
      await completeAccountEntry(account, generation, activationKey);
    },
    [completeAccountEntry, onboardingAccount?.userId],
  );
  const handleChangeAccount = useCallback(async () => {
    const generation = ++authGeneration.current;
    const result = await window.clawwork.commercialSignOut();
    if (generation !== authGeneration.current) throw new EntryLicenseError('entry_superseded');
    if (!result.ok) throw new Error('commercial_sign_out_failed');
    handleSignInStarted();
  }, [handleSignInStarted]);

  const handlePreparationContinue = async () => {
    const initial = preparationFactsRef.current;
    if (!initial || !deriveEntryPreparation(initial).canContinue) throw new EntryLicenseError('entry_not_ready');
    const generation = authGeneration.current;
    const scope = initial.scopeKey;
    const isCurrent = () =>
      generation === authGeneration.current &&
      preparationFactsRef.current?.scopeKey === scope &&
      useTaskStore.getState().workspaceEpoch === workspaceEpoch &&
      useUiStore.getState().defaultGatewayId === initial.startup.gatewayId;
    const session = await window.clawwork.commercialSession();
    if (!isCurrent()) throw new EntryLicenseError('entry_superseded');
    const account = entryAccountFromSession(session);
    if (!account || account.userId !== initial.accountUserId) throw new EntryLicenseError('entry_identity_unavailable');

    let license: Awaited<ReturnType<typeof entryLicenseGate.ensure>>;
    try {
      license = await entryLicenseGate.ensure({
        userId: account.userId,
        activationKey: '',
        api: window.clawwork,
        isCurrent,
      });
    } catch (failure) {
      if (isCurrent() && failure instanceof EntryLicenseError && failure.code !== 'entry_superseded') {
        setEntryEntitlement(null);
        setPreparedScope(null);
        setEntryErrorCode(failure.code);
        setAuthState('required');
      }
      throw failure;
    }
    if (!isCurrent()) throw new EntryLicenseError('entry_superseded');
    const entitlement = {
      userId: account.userId,
      licenseId: license.licenseId,
      orgId: license.orgId,
      status: license.status,
      expiresAt: license.expiresAt,
    };
    if (entitlement.licenseId !== initial.entitlement?.licenseId || entitlement.orgId !== initial.entitlement?.orgId) {
      setEntryEntitlement(entitlement);
      throw new EntryLicenseError('entry_superseded');
    }

    const [runtime, relay, workspace] = await Promise.all([
      window.clawwork.runtimeStatus(),
      window.clawwork.commercialRelayBootstrapState(),
      window.clawwork.probeWorkspaceFsIdentity(),
    ]);
    if (!isCurrent()) throw new EntryLicenseError('entry_superseded');
    const ui = useUiStore.getState(),
      gatewayId = ui.defaultGatewayId;
    const live = deriveStartupReadiness({
      gatewayId,
      gatewayStatus: gatewayId ? ui.gatewayStatusMap[gatewayId] : undefined,
      rawModelCatalog: gatewayId ? ui.modelCatalogByGateway[gatewayId] : undefined,
      catalogFailed: Boolean(gatewayId && ui.modelCatalogFailureByGateway[gatewayId]),
      assistantSnapshot: presetAgentBootstrapCoordinator.getSnapshot(gatewayId ?? ''),
      relayState: relay.ok ? relay.result : undefined,
      workspaceFsIdentity: workspace,
      gatewayReconnect: gatewayId ? ui.gatewayReconnectInfo?.[gatewayId] : undefined,
      runtimeBootstrapFailure: runtime?.ok === false ? runtime.reason : null,
    });
    const current = preparationFactsRef.current;
    if (
      !current ||
      !deriveEntryPreparation(current).canContinue ||
      !deriveEntryPreparation({ ...current, entitlement, runtime, startup: live }).canContinue
    ) {
      if (!current || !deriveEntryPreparation({ ...current, entitlement, runtime, startup: live }).canContinue)
        setPreparationOverride({ scopeKey: scope, runtime, startup: live });
      throw new EntryLicenseError('entry_not_ready');
    }
    setEntryEntitlement(entitlement);
    setPreparedScope(scope);
  };
  const handlePreparationRetry = async () => {
    setPreparedScope(null);
    setPreparationOverride(null);
    setPreparationRetry((value) => value + 1);
    await startupReadiness.retry();
  };
  const handleOnboardingComplete = useCallback(
    (profile: OnboardingProfile) => {
      if (
        authState !== 'ok' ||
        currentOnboardingOwner.current.authState !== 'ok' ||
        !onboardingAccount ||
        currentOnboardingOwner.current.userId !== onboardingAccount.userId ||
        profile.userId !== onboardingAccount.userId ||
        onboardingGeneration !== authGeneration.current ||
        useTaskStore.getState().workspaceEpoch !== workspaceEpoch
      )
        return;
      saveOnboardingProfile(profile);
      setOnboardingProfile(profile);
      setEditingOnboardingProfile(false);
    },
    [authState, onboardingAccount, onboardingGeneration, workspaceEpoch],
  );

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
    preparationRequired: commercialEntry && preparedScope !== preparationScope,
  });

  if (entryScreen === 'loading') return null;

  if (entryScreen === 'login') {
    return (
      <TooltipProvider>
        <Login
          activationEnabled
          authenticatedAccount={onboardingAccount}
          entryErrorCode={entryErrorCode}
          onChangeAccount={handleChangeAccount}
          onSignedIn={handleSignedIn}
          onSignInStarted={handleSignInStarted}
        />
        <AppToaster themeMode={themeMode} />
      </TooltipProvider>
    );
  }

  if (entryScreen === 'preparation')
    return (
      <TooltipProvider>
        <EntryPreparation
          key={preparationScope}
          facts={preparationFacts}
          onContinue={handlePreparationContinue}
          onRetry={handlePreparationRetry}
          onChangeAccount={handleChangeAccount}
          onChooseWorkspace={() => {
            setPreparedScope(null);
            setNeedsSetup(true);
          }}
        />
        <AppToaster themeMode={themeMode} />
      </TooltipProvider>
    );
  if (entryScreen === 'onboarding' && onboardingAccount) {
    return (
      <TooltipProvider>
        <Onboarding
          key={JSON.stringify([onboardingAccount.userId, onboardingGeneration, workspaceEpoch])}
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
          key={JSON.stringify([onboardingAccount.userId, onboardingGeneration, workspaceEpoch])}
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
          animate={{ width: leftNavCollapsed ? LEFT_NAV_RAIL_WIDTH : leftNavWidth }}
          transition={{ duration: motionDuration.moderate, ease: motionEase.standard }}
          className={cn(
            'relative z-[1] flex-shrink-0 overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)]',
          )}
          style={{ minWidth: leftNavCollapsed ? LEFT_NAV_RAIL_WIDTH : 200 }}
        >
          <LeftNav
            onOpenAssistantSettings={() => openSettings('agents')}
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
        {/* 2026-09-29：**收起不再等于归零** —— 缩成一条图标条（`LEFT_NAV_RAIL_WIDTH`），
            导航项还在、图标居中、悬停出气泡。
            ⚠️ 因此原来那条 28px 展开窄条**整个删掉**（不是留着不用）：它的存在理由是
            「归零之后再也点不回来」（图标栏 `GlobalRail` 已在 2026-09-19 删除，当时只剩那一条退路），
            现在图标条自己就带着展开按钮（在 `LeftNav` 顶部第一行），理由不成立。
            留着的坏处是两条窄栏并排，用户会以为那是两个东西。 */}

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
              // 个性化中心「编辑我的资料」入口（B 的 IdentityCenter 按需渲染；MainArea 透传）
              onEditOnboardingProfile={() => setEditingOnboardingProfile(true)}
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
