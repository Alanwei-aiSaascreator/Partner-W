import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import { useQuotaRefreshOnTurnEnd } from './hooks/useQuotaRefreshOnTurnEnd';
import { useUpdateCheck } from './hooks/useUpdateCheck';
import { useTraySync } from './hooks/useTraySync';
import { useModuleOpenTracking } from './hooks/useModuleOpenTracking';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useSettingsBootstrap } from './hooks/useSettingsBootstrap';
import { useStartupReadiness } from './hooks/useStartupReadiness';
import { useDocgenFailureToast } from './hooks/useDocgenFailureToast';
import { useHtmlgenFailureToast } from './hooks/useHtmlgenFailureToast';
import { useVideogenFailureToast } from './hooks/useVideogenFailureToast';
import { useSlidegenToast } from './hooks/useSlidegenToast';
import { useArtifactPanelReveal } from './hooks/useArtifactPanelReveal';
import { useClaimGuardToast } from './hooks/useClaimGuardToast';
import { useDeliveryActivitySubscription } from './hooks/useDeliveryActivitySubscription';
import { useExecutionEventsSubscription, useExecutionHistoryRecovery } from './hooks/useExecutionEventsSubscription';
import { useDeliverySettlementNotification } from './lib/delivery-settlement-notification';
import { useAutoRetryFailedTurn } from './hooks/useAutoRetryFailedTurn';
import { cn } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { LEFT_NAV_RAIL_WIDTH, motionDuration, motionEase } from '@/styles/design-tokens';
import {
  loadOnboardingProfileResult,
  requestOnboardingProfileStorageFlush,
  saveOnboardingProfile,
  type OnboardingProfile,
} from '@/lib/user-onboarding';
import {
  AUTH_CHECK_FALLBACK_MS,
  entryAccountFromSession,
  entryModeFromConfig,
  resolveAppEntryScreen,
  runAuthBootstrap,
} from '@/lib/app-entry-flow';
import { createEntryLicenseGate, EntryLicenseError } from '@/lib/entry-license-gate';
import { takeArtifactPreviewFocusTarget, useArtifactPanelViewScope } from '@/lib/artifact-preview-navigation';
import { resolveArtifactPanelLayout } from '@/lib/artifact-panel-layout';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
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

/**
 * 抽屉关闭、且**没有**可归还入口时的落点（H5，2026-10-09 复审）。
 *
 * - 当前在聊天：焦点交给**已挂载 Composer 的真实输入框**（textarea 在 Composer 自己的
 *   `composer-drop-zone` 里，见 `components/ChatInput/index.tsx`）—— 这是用户接下来
 *   最可能要打字的地方。没有现成的 `composer.focus()` 平台出口，就按真实 DOM 结构找。
 * - 其他主视图：**不把焦点抢回聊天**（`mainView !== 'chat'` 时什么都不做），
 *   也不聚焦 body / 旧任务元素。
 */
function focusCurrentViewFallback(): void {
  if (useUiStore.getState().mainView !== 'chat') return;
  const composerInput = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-drop-zone"] textarea');
  composerInput?.focus();
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
      const onboardingLoad = loadOnboardingProfileResult(account.userId, undefined, { source: 'entry' });
      setOnboardingProfile(onboardingLoad.profile);
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

  // ── Task 4：预览布局裁定（宽窗并排 / 窄窗抽屉 / 极小全屏，24px 回滞）────────────
  const { t } = useTranslation();
  const artifactPanelMode = useUiStore((s) => s.artifactPanelMode);
  const setArtifactPanelMode = useUiStore((s) => s.setArtifactPanelMode);
  const artifactPreviewWidth = useUiStore((s) => s.artifactPreviewWidth);
  const setArtifactPreviewWidth = useUiStore((s) => s.setArtifactPreviewWidth);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
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
  /** 回滞记忆：上一次裁定（纯函数按它决定临界区间的去留）。 */
  const panelLayoutRef = useRef<ReturnType<typeof resolveArtifactPanelLayout>['mode'] | undefined>(undefined);
  const panelLayout = useMemo(() => {
    const next = resolveArtifactPanelLayout({
      viewportWidth,
      navigationWidth: leftNavCollapsed ? LEFT_NAV_RAIL_WIDTH : leftNavWidth,
      requestedPreviewWidth: artifactPreviewWidth,
      previousMode: panelLayoutRef.current,
    });
    panelLayoutRef.current = next.mode;
    return next;
  }, [viewportWidth, leftNavCollapsed, leftNavWidth, artifactPreviewWidth]);
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
  // 余额（积分）的主动刷新调度：回合结束 / 消费进行中 / 回前台。
  // ⚠️ 挂 App 不挂 MainArea：打开设置会卸载 MainArea，而"留在账户页盯后台消费"
  //    正是要覆盖的场景之一（余额面板此时只剩设置页那一处）。
  useQuotaRefreshOnTurnEnd();
  useUpdateCheck();
  // 挂 App 而不是 MainArea：打开设置会卸载 MainArea，那期间文件生成失败就会被漏掉，
  // 而"漏掉一条失败提示"的表现恰好和"什么都没发生"一模一样。
  useDocgenFailureToast();
  useHtmlgenFailureToast();
  useVideogenFailureToast();
  useSlidegenToast();
  // 产物一落盘就把右侧「产物」面板展开 —— 用户反馈 #2：以前要手动点「切换上下文面板」才看得到。
  useArtifactPanelReveal();
  useClaimGuardToast();
  useDeliveryActivitySubscription();
  // V3-artifact（I 接线）：主进程交付/取消执行事件 → 投影；交付结算后的补发通知。
  useExecutionEventsSubscription();
  useDeliverySettlementNotification();
  // V4（I 接线）：激活任务的会话从本地执行历史恢复（只还原本地已写证据）。
  useExecutionHistoryRecovery();
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

  /**
   * 正在拖拽的面板（H6，2026-10-09 复审）。
   *
   * 只用来**取消这一轴**的宽度过渡：拖拽期间右栏宽度必须跟手（旧实现里所有宽度变化
   * 共用 moderate 过渡 —— 手柄实时改 store、实际 DOM 还在播动画，测量到 20ms 后
   * 只走到 529/600）。opacity 的入场动画和 reduced-motion 出口都照旧。
   */
  const [draggingPanel, setDraggingPanel] = useState<'left' | 'right' | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  /** 收尾当前拖拽（幂等）：摘监听、还原 body 样式、清跟手标志。 */
  const endPanelDrag = useCallback((): void => {
    const cleanup = dragCleanupRef.current;
    if (!cleanup) return;
    cleanup();
    setDraggingPanel(null);
  }, []);

  const startPanelDrag = useCallback(
    (e: React.MouseEvent, startWidth: number, setWidth: (w: number) => void, dir: 1 | -1, panel: 'left' | 'right') => {
      e.preventDefault();
      // 上一拖拽若没收尾（丢了 mouseup），先把它的监听/body 样式收干净再开新的。
      endPanelDrag();
      const ox = e.clientX;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      const onMove = (ev: MouseEvent) => setWidth(startWidth + dir * (ev.clientX - ox));
      const onUp = (): void => endPanelDrag();
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      // 窗口失焦（鼠标甩出窗口 / Alt+Tab）收不到 mouseup —— 不一起收尾就会把列宽
      // 拖拽卡在"跟手"态，下一次点击还会继续跟着鼠标跑。
      window.addEventListener('blur', onUp);
      dragCleanupRef.current = () => {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('blur', onUp);
      };
      setDraggingPanel(panel);
    },
    [endPanelDrag],
  );

  /** 两侧手柄是否还挂着（渲染条件与下面 JSX 一致）：布局切换把手柄换掉时也要收尾。 */
  const leftPanelHandleMounted = !leftNavCollapsed;
  const rightPanelInlineVisible =
    rightPanelOpen &&
    !settingsOpen &&
    mainView === 'chat' &&
    !(artifactPanelMode === 'preview' && panelLayout.mode !== 'inline');
  useEffect(() => {
    // 手柄被卸载（或 App 整个卸载）⇒ 拖拽必须收尾：不能把全局鼠标监听和 body 光标留在外面。
    // H6 终审 E6：`artifactPanelMode` 也进依赖 —— 预览退回列表时手柄 DOM 可能没卸载，
    // 但**用途已经变了**（同一个手柄改拖的是另一种宽度）；旧的 setWidth 闭包必须当场
    // 失效，否则后续 mousemove 会继续改预览宽度偏好、body 光标也不还原。
    return () => endPanelDrag();
  }, [leftPanelHandleMounted, rightPanelInlineVisible, artifactPanelMode, endPanelDrag]);

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
          const localOnboardingLoad = loadOnboardingProfileResult('local', undefined, { source: 'local-entry' });
          setOnboardingProfile(localOnboardingLoad.profile);
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
  /**
   * BUG-034 · M3：完成回执的**一次性接纳闸**。同一 (账号, 认证代次, 工作区代次, 档案逐字)
   * 只接纳一次 —— 重复/滞留的回调不再重写存储、不再重发刷新请求（真编辑必带新的
   * `completedAt`/字段 ⇒ 新键照常放行）。只在保存**成功**后记录：保存失败不占位，可直接重试。
   */
  const acceptedOnboardingCompletion = useRef<string | null>(null);
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
      const completionKey = JSON.stringify([onboardingAccount.userId, onboardingGeneration, workspaceEpoch, profile]);
      if (acceptedOnboardingCompletion.current === completionKey) return;
      // BUG-034（2026-10-13）：失败照旧向上抛（编辑页留住）；成功/失败各留一条诊断（不含画像内容）。
      saveOnboardingProfile(profile, undefined, { source: 'entry-complete' });
      acceptedOnboardingCompletion.current = completionKey;
      setOnboardingProfile(profile);
      setEditingOnboardingProfile(false);
      /**
       * BUG-034 · M3：**保存成功之后**才请求刷新 sender 所属 session 的 DOMStorage。
       * fire-and-forget：`requested:true` 只代表"已发起刷新请求"（Electron 34 该 API 是 void，
       * 没有物理落盘回执），所以**不 await、不参与推进** —— 旧回执天然不可能把新账号/新工作区
       * 送进工作台；请求失败/异常只留诊断，照常进工作台。try/catch 是最后一层保险：
       * 刷新是尽力而为，任何异常都不许改写"已保存并已推进"的结论。
       */
      try {
        requestOnboardingProfileStorageFlush(onboardingAccount.userId, { source: 'entry-complete' });
      } catch {
        /* 已保存并已推进：刷新请求自身的异常到此为止 */
      }
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
          transition={{
            // H6：拖左栏时**只**取消宽度的过渡（跟手）；开关/收纳的动画照旧。
            width: {
              duration: draggingPanel === 'left' ? 0 : motionDuration.moderate,
              ease: motionEase.standard,
            },
          }}
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
            onMouseDown={(e) => startPanelDrag(e, leftNavWidth, setLeftNavWidth, 1, 'left')}
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
          {rightPanelOpen &&
            !settingsOpen &&
            mainView === 'chat' &&
            (artifactPanelMode === 'preview' && panelLayout.mode !== 'inline' ? (
              /* 窄窗/小屏：预览改**抽屉**（Task 4）—— Radix Dialog 供 Esc 关闭与焦点归还，
                 内容贴右缘（样式在 theme.css 的 .artifact-drawer*；宽度由布局裁定给）。 */
              <DialogPrimitive.Root
                open
                onOpenChange={(open) => {
                  if (!open) setArtifactPanelMode('list');
                }}
              >
                <DialogPrimitive.Portal>
                  <DialogPrimitive.Overlay className="artifact-drawer__overlay" />
                  <DialogPrimitive.Content
                    className="artifact-drawer"
                    data-mode={panelLayout.mode}
                    style={{ '--artifact-drawer-width': `${panelLayout.width}px` } as React.CSSProperties}
                    aria-describedby={undefined}
                    /* ⭐ H5：整棵树里**没有 Trigger** —— Radix 默认的"归还 Trigger"在这里
                       无处可去（实测焦点落到 body）。所以自己归还：优先仍连接的进入点
                       （请求预览那一刻在导航适配层捕获的元素），入口已经随布局卸载时退到
                       当前聊天视图的稳定输入控件。焦点约束本身不取消（只接管这一次落点）。 */
                    onCloseAutoFocus={(event) => {
                      event.preventDefault();
                      const target = takeArtifactPreviewFocusTarget();
                      if (target) target.focus();
                      else focusCurrentViewFallback();
                    }}
                  >
                    <DialogPrimitive.Title className="sr-only">{t('rightPanel.artifacts')}</DialogPrimitive.Title>
                    <RightPanel />
                  </DialogPrimitive.Content>
                </DialogPrimitive.Portal>
              </DialogPrimitive.Root>
            ) : (
              <>
                <div
                  className="group w-1.5 flex-shrink-0 cursor-col-resize z-10 -mx-[3px]"
                  onMouseDown={(e) =>
                    // 拖拽以**当前可见宽**（布局裁定后的有效宽）为基准：窄窗受夹时拖动仍 1:1 跟手；
                    // 此时拖出的宽度会写进偏好 —— 那是用户的显式动作，语义上是"就调到这里"
                    //（窗口变化本身**不会**触碰偏好，见 ui-store 注释与布局纯函数）。
                    artifactPanelMode === 'preview'
                      ? startPanelDrag(e, panelLayout.width, setArtifactPreviewWidth, -1, 'right')
                      : startPanelDrag(e, rightPanelWidth, setRightPanelWidth, -1, 'right')
                  }
                >
                  <div className="h-full w-px mx-auto bg-[var(--border)] group-hover:bg-[var(--accent)] transition-colors" />
                </div>
                <motion.aside
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: artifactPanelMode === 'preview' ? panelLayout.width : rightPanelWidth, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{
                    // H6：拖右栏时**只**取消宽度的过渡 —— 拖拽跟手、opacity 入场照旧；
                    // 释放（mouseup/blur/卸载）后恢复既有 moderate 过渡。
                    width: {
                      duration: draggingPanel === 'right' ? 0 : motionDuration.moderate,
                      ease: motionEase.standard,
                    },
                    opacity: { duration: motionDuration.moderate, ease: motionEase.standard },
                  }}
                  className={cn('glass-heavy relative flex-shrink-0 overflow-hidden z-[1] border-l-0')}
                >
                  <RightPanel />
                </motion.aside>
              </>
            ))}
        </AnimatePresence>
        <AppToaster themeMode={themeMode} />
        <ApprovalDialog />
      </div>
    </TooltipProvider>
  );
}
