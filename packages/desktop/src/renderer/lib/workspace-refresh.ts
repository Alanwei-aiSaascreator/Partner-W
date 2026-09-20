import {
  useTaskStore,
  useMessageStore,
  useUiStore,
  useRoomStore,
  useTeamStore,
  systemSessionService,
} from '../platform';
import { useFileStore } from '../stores/fileStore';
import { useDashboardStore } from '../stores/dashboardStore';
import { useUsageStore } from '../stores/usageStore';
import { useApprovalStore } from '../stores/approvalStore';
import { useQuestionStore } from '../stores/questionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { hydrateFromLocal, resetHydration } from './session-sync';
import { reinitializeGatewayBootstrap } from '../hooks/useGatewayDispatcherSetup';

export async function refreshRendererAfterWorkspaceChange(): Promise<void> {
  await systemSessionService.end().catch(() => {});

  useTaskStore.setState({
    tasks: [],
    activeTaskId: null,
    hydrated: false,
    pendingNewTask: null,
  });

  useMessageStore.setState({
    messagesByTask: {},
    activeTurnBySession: {},
    processingBySession: new Set(),
    runPhaseBySession: {},
    highlightedMessageId: null,
  });

  useRoomStore.setState({ rooms: {}, subagentKeyMap: {} });
  useTeamStore.setState({ teams: {}, loading: false, loadedOnce: false });

  useFileStore.setState({
    artifacts: [],
    selectedArtifactId: null,
    searchQuery: '',
    searchResults: null,
    isSearching: false,
    typeFilter: 'all',
  });

  useDashboardStore.getState().clear();
  useUsageStore.getState().clear();
  useApprovalStore.getState().clear();
  // 退出 / 切号后不能留着上一账号的问题卡片：它指向的会话已经不属于当前账号了
  useQuestionStore.getState().clear();

  useUiStore.setState({
    gatewayStatusMap: {},
    // ⭐ "这次运行连上过"也是**上一个账号/上一轮**的账，切号必须一起清 ——
    //    否则新账号一进来就被当成"连上过"，预热期又会说成"已断开"。
    gatewayEverConnected: {},
    gatewayVersionMap: {},
    gatewayReconnectInfo: {},
    gatewaysLoaded: false,
    defaultGatewayId: null,
    gatewayInfoMap: {},
    unreadTaskIds: new Set(),
    modelCatalogByGateway: {},
    agentCatalogByGateway: {},
    toolsCatalogByGateway: {},
    skillsStatusByGateway: {},
    commandCatalogByGateway: {},
  });

  resetHydration();

  await useSettingsStore
    .getState()
    .refresh()
    .catch((err) => console.error('[workspace-refresh] Failed to refresh settings:', err));
  await hydrateFromLocal().catch((err) => console.error('[workspace-refresh] Failed to hydrate from local:', err));
  await reinitializeGatewayBootstrap().catch((err) =>
    console.error('[workspace-refresh] Failed to reinitialize gateway bootstrap:', err),
  );
  await useTeamStore
    .getState()
    .loadTeams()
    .catch((err) => console.error('[workspace-refresh] Failed to load teams:', err));
}
