import { contextBridge, ipcRenderer } from 'electron';
import type {
  ApprovalDecision,
  QuestionResolveParams,
  CommandsListParams,
  CronJobCreate,
  CronJobPatch,
  CronListParams,
  CronRunParams,
  CronRunsParams,
  SkillInstallParams,
  SkillSearchParams,
  SkillUpdateParams,
  ConfigSetParams,
  ConfigPatchParams,
  Artifact,
} from '@clawwork/shared';
import type { ClawWorkAPI, GatewayServerConfig } from './clawwork';

function buildApi(): ClawWorkAPI {
  return {
    getHttpBase: (gatewayId: string) => ipcRenderer.invoke('ws:get-http-base', { gatewayId }),
    sendMessage: (
      gatewayId: string,
      sessionKey: string,
      content: string,
      attachments?: { mimeType: string; fileName: string; content: string }[],
    ) => ipcRenderer.invoke('ws:send-message', { gatewayId, sessionKey, content, attachments }),
    chatHistory: (gatewayId: string, sessionKey: string, limit?: number) =>
      ipcRenderer.invoke('ws:chat-history', { gatewayId, sessionKey, limit }),
    listSessions: (gatewayId: string) => ipcRenderer.invoke('ws:list-sessions', { gatewayId }),
    gatewayStatus: () => ipcRenderer.invoke('ws:gateway-status'),
    syncSessions: () => ipcRenderer.invoke('ws:sync-sessions'),
    abortChat: (gatewayId: string, sessionKey: string) =>
      ipcRenderer.invoke('ws:abort-chat', { gatewayId, sessionKey }),
    listGateways: () => ipcRenderer.invoke('ws:list-gateways'),
    listModels: (gatewayId: string) => ipcRenderer.invoke('ws:models-list', { gatewayId }),
    listCommands: (gatewayId: string, params?: CommandsListParams) =>
      ipcRenderer.invoke('ws:commands-list', { gatewayId, ...(params ?? {}) }),
    listAgents: (gatewayId: string) => ipcRenderer.invoke('ws:agents-list', { gatewayId }),
    createAgent: (gatewayId: string, params: { name: string; workspace: string; emoji?: string; avatar?: string }) =>
      ipcRenderer.invoke('ws:agents-create', { gatewayId, ...params }),
    updateAgent: (
      gatewayId: string,
      params: {
        agentId: string;
        name?: string;
        workspace?: string;
        model?: string;
        avatar?: string;
      },
    ) => ipcRenderer.invoke('ws:agents-update', { gatewayId, ...params }),
    deleteAgent: (gatewayId: string, params: { agentId: string; deleteFiles?: boolean }) =>
      ipcRenderer.invoke('ws:agents-delete', { gatewayId, ...params }),
    listAgentFiles: (gatewayId: string, agentId: string) =>
      ipcRenderer.invoke('ws:agents-files-list', { gatewayId, agentId }),
    getAgentFile: (gatewayId: string, agentId: string, name: string) =>
      ipcRenderer.invoke('ws:agents-files-get', { gatewayId, agentId, name }),
    setAgentFile: (gatewayId: string, agentId: string, name: string, content: string) =>
      ipcRenderer.invoke('ws:agents-files-set', { gatewayId, agentId, name, content }),
    patchSession: (gatewayId: string, sessionKey: string, patch: Record<string, unknown>) =>
      ipcRenderer.invoke('ws:session-patch', { gatewayId, sessionKey, patch }),
    getToolsCatalog: (gatewayId: string, agentId?: string) =>
      ipcRenderer.invoke('ws:tools-catalog', { gatewayId, agentId }),
    getSkillsStatus: (gatewayId: string, agentId?: string) =>
      ipcRenderer.invoke('ws:skills-status', { gatewayId, agentId }),
    searchSkills: (gatewayId: string, params: SkillSearchParams) =>
      ipcRenderer.invoke('ws:skills-search', { gatewayId, ...params }),
    getSkillDetail: (gatewayId: string, slug: string) => ipcRenderer.invoke('ws:skills-detail', { gatewayId, slug }),
    installSkill: (gatewayId: string, params: SkillInstallParams) =>
      ipcRenderer.invoke('ws:skills-install', { gatewayId, ...params }),
    updateSkill: (gatewayId: string, params: SkillUpdateParams) =>
      ipcRenderer.invoke('ws:skills-update', { gatewayId, ...params }),
    getSkillBins: (gatewayId: string) => ipcRenderer.invoke('ws:skills-bins', { gatewayId }),
    getConfig: (gatewayId: string) => ipcRenderer.invoke('ws:config-get', { gatewayId }),
    setConfig: (gatewayId: string, params: ConfigSetParams) =>
      ipcRenderer.invoke('ws:config-set', { gatewayId, ...params }),
    patchConfig: (gatewayId: string, params: ConfigPatchParams) =>
      ipcRenderer.invoke('ws:config-patch', { gatewayId, ...params }),
    getConfigSchema: (gatewayId: string) => ipcRenderer.invoke('ws:config-schema', { gatewayId }),
    lookupConfigSchema: (gatewayId: string, path: string) =>
      ipcRenderer.invoke('ws:config-schema-lookup', { gatewayId, path }),

    onGatewayEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown): void => {
        callback(data as { event: string; payload: Record<string, unknown>; gatewayId: string });
      };
      ipcRenderer.on('gateway-event', listener);
      return () => {
        ipcRenderer.removeListener('gateway-event', listener);
      };
    },
    onGatewayStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown): void => {
        callback(status as { connected: boolean; error?: string; gatewayId: string });
      };
      ipcRenderer.on('gateway-status', listener);
      return () => {
        ipcRenderer.removeListener('gateway-status', listener);
      };
    },
    onDebugEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: unknown): void => {
        callback(
          event as {
            ts: string;
            level: 'debug' | 'info' | 'warn' | 'error';
            domain: string;
            event: string;
            data?: Record<string, unknown>;
          },
        );
      };
      ipcRenderer.on('debug-event', listener);
      return () => {
        ipcRenderer.removeListener('debug-event', listener);
      };
    },
    exportDebugBundle: (filter) => ipcRenderer.invoke('debug:export-bundle', filter),
    reportDebugEvent: (event) => ipcRenderer.send('debug:renderer-event', event),

    loadTasks: () => ipcRenderer.invoke('data:list-tasks'),
    loadMessages: (taskId: string) => ipcRenderer.invoke('data:list-messages', { taskId }),
    loadDashboardStats: () => ipcRenderer.invoke('stats:get-dashboard'),

    saveArtifact: (params: {
      taskId: string;
      sourcePath: string;
      messageId: string;
      fileName?: string;
      mediaType?: string;
    }) => ipcRenderer.invoke('artifact:save', params),
    listArtifacts: (taskId?: string) => ipcRenderer.invoke('artifact:list', { taskId }),
    getArtifact: (id: string) => ipcRenderer.invoke('artifact:get', { id }),
    readArtifactFile: (artifactId: string, taskId?: string) =>
      ipcRenderer.invoke('artifact:read-file', { artifactId, taskId }),
    readArtifactThumbnail: (artifactId: string, taskId?: string, size?: number) =>
      ipcRenderer.invoke('artifact:thumbnail', { artifactId, taskId, size }),
    onArtifactSaved: (callback: (artifact: Artifact) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, artifact: Artifact): void => {
        callback(artifact);
      };
      ipcRenderer.on('artifact:saved', listener);
      return () => {
        ipcRenderer.removeListener('artifact:saved', listener);
      };
    },
    saveCodeBlock: (params) => ipcRenderer.invoke('artifact:save-content', params),
    saveImageFromUrl: (params) => ipcRenderer.invoke('artifact:save-image-url', params),
    searchArtifacts: (query: string, options) => ipcRenderer.invoke('artifact:search', { query, ...(options ?? {}) }),
    saveArtifactAs: (artifactId: string, taskId?: string) =>
      ipcRenderer.invoke('artifact:save-as', { artifactId, taskId }),
    openArtifactFile: (artifactId: string, taskId?: string) =>
      ipcRenderer.invoke('artifact:open-file', { artifactId, taskId }),
    showArtifactInFolder: (artifactId: string, taskId?: string) =>
      ipcRenderer.invoke('artifact:show-in-folder', { artifactId, taskId }),
    saveInboxAttachment: (params: { taskId: string; fileName: string; base64: string }) =>
      ipcRenderer.invoke('inbox:save', params),
    readInboxFile: (localPath: string) => ipcRenderer.invoke('inbox:read-file', { localPath }),
    readInboxFileForSend: (localPath: string) => ipcRenderer.invoke('inbox:read-file-for-send', { localPath }),
    openInboxFile: (localPath: string) => ipcRenderer.invoke('inbox:open', { localPath }),
    showInboxInFolder: (localPath: string) => ipcRenderer.invoke('inbox:show-in-folder', { localPath }),
    readMediaFile: (sourcePath: string) => ipcRenderer.invoke('media:read-file', { sourcePath }),
    exportSessionMarkdown: (taskId: string) => ipcRenderer.invoke('session:export-markdown', { taskId }),
    exportSessionMarkdownAs: (taskId: string) => ipcRenderer.invoke('session:export-markdown-as', { taskId }),

    openWorkspaceFolder: () => ipcRenderer.invoke('workspace:open-folder'),
    isWorkspaceConfigured: () => ipcRenderer.invoke('workspace:is-configured') as Promise<boolean>,
    getWorkspacePath: () => ipcRenderer.invoke('workspace:get-path') as Promise<string | null>,
    getDefaultWorkspacePath: () => ipcRenderer.invoke('workspace:get-default') as Promise<string>,
    getTeamWorkspacePath: (slug: string) => ipcRenderer.invoke('workspace:team-path', slug) as Promise<string>,
    browseWorkspace: () => ipcRenderer.invoke('workspace:browse') as Promise<string | null>,
    setupWorkspace: (path: string) => ipcRenderer.invoke('workspace:setup', path),
    changeWorkspace: (path: string) => ipcRenderer.invoke('workspace:change', path),

    getSettings: () => ipcRenderer.invoke('settings:get'),
    updateSettings: (partial: Record<string, unknown>) => ipcRenderer.invoke('settings:update', partial),
    rebuildMenu: () => ipcRenderer.invoke('app:rebuild-menu'),
    getMicrophonePermission: () => ipcRenderer.invoke('voice:get-microphone-permission'),
    requestMicrophonePermission: () => ipcRenderer.invoke('voice:request-microphone-permission'),
    checkWhisper: () => ipcRenderer.invoke('voice:check-whisper'),
    transcribeAudio: (audio: ArrayBuffer) => ipcRenderer.invoke('voice:transcribe', { audio }),

    reconnectGateway: (gatewayId: string) => ipcRenderer.invoke('ws:reconnect-gateway', { gatewayId }),

    addGateway: (gateway: GatewayServerConfig) => ipcRenderer.invoke('settings:add-gateway', gateway),
    removeGateway: (gatewayId: string) => ipcRenderer.invoke('settings:remove-gateway', gatewayId),
    updateGateway: (gatewayId: string, partial: Partial<GatewayServerConfig>) =>
      ipcRenderer.invoke('settings:update-gateway', gatewayId, partial),
    setDefaultGateway: (gatewayId: string) => ipcRenderer.invoke('settings:set-default-gateway', gatewayId),
    testGateway: (
      url: string,
      auth: { token?: string; password?: string; pairingCode?: string; tlsVerify?: boolean },
    ) => ipcRenderer.invoke('settings:test-gateway', url, auth),

    getAppVersion: () => ipcRenderer.invoke('app:get-version'),
    checkForUpdates: () => ipcRenderer.invoke('app:check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('app:download-update'),
    cancelUpdateDownload: () => ipcRenderer.invoke('app:cancel-update-download'),
    installUpdate: () => ipcRenderer.invoke('app:install-update'),
    onUpdateDownloadProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown): void => {
        callback(data as { percent: number; bytesPerSecond: number; transferred: number; total: number });
      };
      ipcRenderer.on('update:download-progress', listener);
      return () => {
        ipcRenderer.removeListener('update:download-progress', listener);
      };
    },
    onUpdateDownloaded: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown): void => {
        callback(data as { version: string });
      };
      ipcRenderer.on('update:downloaded', listener);
      return () => {
        ipcRenderer.removeListener('update:downloaded', listener);
      };
    },
    onUpdateError: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown): void => {
        callback(
          data as {
            message: string;
            code: 'dev-not-supported' | 'network' | 'no-release-metadata' | 'signature' | 'unknown';
          },
        );
      };
      ipcRenderer.on('update:error', listener);
      return () => {
        ipcRenderer.removeListener('update:error', listener);
      };
    },

    globalSearch: (query: string) => ipcRenderer.invoke('search:global', query),

    persistTask: (task: {
      id: string;
      sessionKey: string;
      sessionId: string;
      title: string;
      status: string;
      ensemble?: boolean;
      model?: string;
      modelProvider?: string;
      thinkingLevel?: string;
      inputTokens?: number;
      outputTokens?: number;
      contextTokens?: number;
      createdAt: string;
      updatedAt: string;
      tags: string[];
      artifactDir: string;
      gatewayId: string;
    }) => ipcRenderer.invoke('data:create-task', task),

    persistTaskUpdate: (params: {
      id: string;
      title?: string;
      status?: string;
      ensemble?: boolean;
      model?: string;
      modelProvider?: string;
      thinkingLevel?: string;
      inputTokens?: number;
      outputTokens?: number;
      contextTokens?: number;
      teamId?: string | null;
      sessionKey?: string;
      /** 置顶时间（ISO）；`null` = 取消置顶。与 `updatedAt` 无关。 */
      pinnedAt?: string | null;
      updatedAt: string;
    }) => ipcRenderer.invoke('data:update-task', params),

    persistMessage: (msg: {
      id: string;
      taskId: string;
      role: string;
      content: string;
      timestamp: string;
      sessionKey?: string;
      agentId?: string;
      runId?: string;
      attachments?: unknown[];
      toolCalls?: unknown[];
      thinkingContent?: string;
      /** 实际生成这条回复的模型 id（逐条来自网关）。 */
      model?: string;
    }) => ipcRenderer.invoke('data:create-message', msg),

    deleteTask: (taskId: string) => ipcRenderer.invoke('data:delete-task', { id: taskId }),

    persistRoom: (params: { taskId: string; status: string; conductorReady: boolean }) =>
      ipcRenderer.invoke('data:persist-room', params),
    loadRoom: (taskId: string) => ipcRenderer.invoke('data:load-room', { taskId }),
    persistPerformer: (params: {
      taskId: string;
      sessionKey: string;
      agentId: string;
      agentName: string;
      emoji?: string;
      verifiedAt: string;
    }) => ipcRenderer.invoke('data:persist-performer', params),
    deleteRoom: (taskId: string) => ipcRenderer.invoke('data:delete-room', { taskId }),

    listSessionsBySpawner: (gatewayId: string, spawnedBy: string) =>
      ipcRenderer.invoke('ws:list-sessions-by-spawner', { gatewayId, spawnedBy }),
    createSession: (gatewayId: string, params: { key: string; agentId: string; message?: string }) =>
      ipcRenderer.invoke('ws:create-session', { gatewayId, ...params }),

    getUsageStatus: (gatewayId: string) => ipcRenderer.invoke('ws:usage-status', { gatewayId }),
    getUsageCost: (gatewayId: string, params?: { startDate?: string; endDate?: string; days?: number }) =>
      ipcRenderer.invoke('ws:usage-cost', { gatewayId, ...params }),
    getSessionUsage: (gatewayId: string, sessionKey: string) =>
      ipcRenderer.invoke('ws:session-usage', { gatewayId, sessionKey }),
    previewSessions: (gatewayId: string, keys: string[], options?: { limit?: number; maxChars?: number }) =>
      ipcRenderer.invoke('ws:session-preview', { gatewayId, keys, ...options }),

    resolveExecApproval: (gatewayId: string, id: string, decision: ApprovalDecision) =>
      ipcRenderer.invoke('ws:exec-approval-resolve', { gatewayId, id, decision }),

    resolveQuestion: (gatewayId: string, params: QuestionResolveParams) =>
      ipcRenderer.invoke('ws:question-resolve', { gatewayId, params }),
    listQuestions: (gatewayId: string) => ipcRenderer.invoke('ws:question-list', { gatewayId }),

    resetSession: (gatewayId: string, sessionKey: string, reason?: 'new' | 'reset') =>
      ipcRenderer.invoke('ws:session-reset', { gatewayId, sessionKey, reason }),
    deleteSession: (gatewayId: string, sessionKey: string) =>
      ipcRenderer.invoke('ws:session-delete', { gatewayId, sessionKey }),
    compactSession: (gatewayId: string, sessionKey: string, maxLines?: number) =>
      ipcRenderer.invoke('ws:session-compact', { gatewayId, sessionKey, maxLines }),

    updateTrayStatus: (status, tasks) => ipcRenderer.send('tray:update-status', { status, tasks: tasks ?? [] }),
    getTrayEnabled: () => ipcRenderer.invoke('tray:get-enabled') as Promise<boolean>,
    setTrayEnabled: (enabled: boolean) => ipcRenderer.invoke('tray:set-enabled', enabled) as Promise<boolean>,
    onTrayNavigateTask: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, taskId: string): void => {
        callback(taskId);
      };
      ipcRenderer.on('tray:navigate-task', listener);
      return () => {
        ipcRenderer.removeListener('tray:navigate-task', listener);
      };
    },
    onTrayOpenSettings: (callback) => {
      const listener = (): void => {
        callback();
      };
      ipcRenderer.on('tray:open-settings', listener);
      return () => {
        ipcRenderer.removeListener('tray:open-settings', listener);
      };
    },

    quickLaunchSubmit: (message: string) => ipcRenderer.send('quick-launch:submit', message),
    quickLaunchHide: () => ipcRenderer.send('quick-launch:hide'),
    getQuickLaunchConfig: () => ipcRenderer.invoke('quick-launch:get-config'),
    updateQuickLaunchConfig: (enabled: boolean, shortcut?: string) =>
      ipcRenderer.invoke('quick-launch:update-config', enabled, shortcut),
    onQuickLaunchSubmit: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, message: string): void => {
        callback(message);
      };
      ipcRenderer.on('quick-launch:submit', listener);
      return () => {
        ipcRenderer.removeListener('quick-launch:submit', listener);
      };
    },

    setWindowButtonVisibility: (visible: boolean) => ipcRenderer.send('ui:set-window-button-visibility', visible),

    onWorkspaceChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, newPath: string): void => {
        callback(newPath);
      };
      ipcRenderer.on('workspace:changed', listener);
      return () => {
        ipcRenderer.removeListener('workspace:changed', listener);
      };
    },

    getDeviceId: () => ipcRenderer.invoke('workspace:get-device-id') as Promise<string>,

    importTaskFiles: (taskId: string) => ipcRenderer.invoke('context:import-files', { taskId }),
    listImportedTaskFiles: (taskId: string) => ipcRenderer.invoke('context:list-imported-files', { taskId }),
    grantTaskContextFolder: (taskId: string) => ipcRenderer.invoke('context:grant-folder', { taskId }),
    listTaskContextSources: (taskId: string) => ipcRenderer.invoke('context:list-sources', { taskId }),
    revokeTaskContextSource: (taskId: string, sourceId: string) =>
      ipcRenderer.invoke('context:revoke-source', { taskId, sourceId }),
    listTaskContextFiles: (taskId: string, sourceId: string, query?: string) =>
      ipcRenderer.invoke('context:list-source-files', { taskId, sourceId, query }),
    readTaskContextFile: (taskId: string, sourceId: string, relativePath: string) =>
      ipcRenderer.invoke('context:read-source-file', { taskId, sourceId, relativePath }),
    readTaskContextFileForSend: (taskId: string, sourceId: string, relativePath: string) =>
      ipcRenderer.invoke('context:read-source-file-for-send', { taskId, sourceId, relativePath }),

    sendNotification: (params: { title: string; body: string; taskId?: string }) =>
      ipcRenderer.invoke('notification:send', params),
    onNotificationNavigateTask: (callback: (taskId: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, taskId: string): void => {
        callback(taskId);
      };
      ipcRenderer.on('notification:navigate-task', listener);
      return () => {
        ipcRenderer.removeListener('notification:navigate-task', listener);
      };
    },

    listCronJobs: (gatewayId: string, params?: CronListParams) =>
      ipcRenderer.invoke('ws:cron-list', { gatewayId, ...params }),
    getCronStatus: (gatewayId: string) => ipcRenderer.invoke('ws:cron-status', { gatewayId }),
    addCronJob: (gatewayId: string, params: CronJobCreate) =>
      ipcRenderer.invoke('ws:cron-add', { gatewayId, ...params }),
    updateCronJob: (gatewayId: string, jobId: string, patch: CronJobPatch) =>
      ipcRenderer.invoke('ws:cron-update', { gatewayId, jobId, patch }),
    removeCronJob: (gatewayId: string, jobId: string) => ipcRenderer.invoke('ws:cron-remove', { gatewayId, jobId }),
    runCronJob: (gatewayId: string, jobId: string, mode?: CronRunParams['mode']) =>
      ipcRenderer.invoke('ws:cron-run', { gatewayId, jobId, mode }),
    listCronRuns: (gatewayId: string, params?: CronRunsParams) =>
      ipcRenderer.invoke('ws:cron-runs', { gatewayId, ...params }),

    listTeams: () => ipcRenderer.invoke('data:teams-list'),
    getTeam: (id: string) => ipcRenderer.invoke('data:team-get', { id }),
    persistTeam: (team: {
      id: string;
      name: string;
      emoji?: string;
      description?: string;
      gatewayId: string;
      source?: string;
      version?: string;
      hubSlug?: string;
      agents: Array<{ agentId: string; role?: string; isManager?: boolean; skills?: string[] }>;
      createdAt: string;
      updatedAt: string;
    }) => ipcRenderer.invoke('data:team-persist', team),
    deleteTeam: (id: string) => ipcRenderer.invoke('data:team-delete', { id }),

    saveAgentAvatar: (gatewayId: string, agentId: string, dataUrl: string) =>
      ipcRenderer.invoke('avatar:save', { gatewayId, agentId, dataUrl }),
    deleteAgentAvatar: (gatewayId: string, agentId: string) =>
      ipcRenderer.invoke('avatar:delete', { gatewayId, agentId }),
    listLocalAvatars: (gatewayId: string) => ipcRenderer.invoke('avatar:list-local', { gatewayId }),

    hubListRegistries: () => ipcRenderer.invoke('hub:registries-list'),
    hubFetchRegistry: (id: string) => ipcRenderer.invoke('hub:registry-fetch', { id }),
    hubAddRegistry: (url: string) => ipcRenderer.invoke('hub:registry-add', { url }),
    hubRemoveRegistry: (id: string) => ipcRenderer.invoke('hub:registry-remove', { id }),
    hubDownloadTeam: (registryId: string, slug: string) =>
      ipcRenderer.invoke('hub:team-download', { registryId, slug }),

    commercialGetConfig: () => ipcRenderer.invoke('commercial:get-config'),
    commercialSetConfig: (payload: { supabaseUrl?: string; supabaseAnonKey?: string }) =>
      ipcRenderer.invoke('commercial:set-config', payload),
    commercialSendOtp: (target: string) => ipcRenderer.invoke('commercial:send-otp', target),
    commercialVerifyOtp: (target: string, token: string) => ipcRenderer.invoke('commercial:verify-otp', target, token),
    commercialSignInPassword: (email: string, password: string) =>
      ipcRenderer.invoke('commercial:sign-in-password', email, password),
    commercialSignOut: () => ipcRenderer.invoke('commercial:sign-out'),
    commercialSession: () => ipcRenderer.invoke('commercial:session'),
    /** B7 本地快速态：**不发网络**，只回答"本地存着一个会话吗"。 */
    commercialLocalSession: () => ipcRenderer.invoke('commercial:local-session'),
    commercialAccountOverview: () => ipcRenderer.invoke('commercial:account-overview'),
    commercialLicenseStatus: () => ipcRenderer.invoke('commercial:license-status'),
    commercialLicenseActivate: (licenseKey: string) => ipcRenderer.invoke('commercial:license-activate', licenseKey),
    commercialLicenseClear: () => ipcRenderer.invoke('commercial:license-clear'),
    commercialDeviceFingerprint: () => ipcRenderer.invoke('commercial:device-fingerprint'),
    commercialUsageReport: () => ipcRenderer.invoke('commercial:usage-report'),
    commercialRechargeSkus: () => ipcRenderer.invoke('commercial:recharge-skus'),
    commercialRechargeCreate: (sku: string) => ipcRenderer.invoke('commercial:recharge-create', sku),
    commercialRechargeCreateCustom: (amountCents: number) =>
      ipcRenderer.invoke('commercial:recharge-create-custom', amountCents),
    commercialRechargeOrder: (orderNo: string) => ipcRenderer.invoke('commercial:recharge-order', orderNo),

    // ── 广场 / 团队（P1）──────────────────────────────────────────────
    // 频道名与 `main/ipc/community-handlers.ts` 一一对应（那个文件的测试
    // 会把频道清单锁死）；这里的键名由 `community-preload-surface.test.ts` 锁死。
    communityInfo: () => ipcRenderer.invoke('community:info'),
    communityMembers: () => ipcRenderer.invoke('community:members'),
    communitySwitchTeam: (orgId: string) => ipcRenderer.invoke('community:switch-team', { orgId }),
    communityFeed: (params?: { limit?: number; before?: string | null }) =>
      ipcRenderer.invoke('community:feed', params),
    communityCreatePost: (params: { body: string; visibility: 'private' | 'org' }) =>
      ipcRenderer.invoke('community:post-create', params),
    communityDeletePost: (postId: string) => ipcRenderer.invoke('community:post-delete', { postId }),
    communityComments: (postId: string, limit?: number) => ipcRenderer.invoke('community:comments', { postId, limit }),
    communityAddComment: (postId: string, body: string) =>
      ipcRenderer.invoke('community:comment-add', { postId, body }),
    communityLikeToggle: (postId: string) => ipcRenderer.invoke('community:like-toggle', { postId }),
    communityInviteCreate: (params: { role: 'admin' | 'member'; maxUses: number; expiresInHours: number }) =>
      ipcRenderer.invoke('community:invite-create', params),
    communityInviteList: () => ipcRenderer.invoke('community:invite-list'),
    communityInviteRevoke: (id: string) => ipcRenderer.invoke('community:invite-revoke', { id }),
    communityJoin: (code: string) => ipcRenderer.invoke('community:join', { code }),
    communityMemberSetRole: (userId: string, role: 'admin' | 'member') =>
      ipcRenderer.invoke('community:member-set-role', { userId, role }),
    communityMemberRemove: (userId: string) => ipcRenderer.invoke('community:member-remove', { userId }),
    communityLeave: () => ipcRenderer.invoke('community:leave'),

    // ── 助手市场 / 创作者中心（P2）────────────────────────────────────
    // 注意：**安装动作不在这里** —— 真安装要在本地网关建 agent，由渲染进程走
    // window.clawwork 的 agent API（见 useTemplateInstall）。这里只有记账与增删改查。
    marketTemplates: (params?: { category?: string | null; query?: string | null }) =>
      ipcRenderer.invoke('market:templates', params),
    marketTemplateDetail: (id: string) => ipcRenderer.invoke('market:detail', { id }),
    marketTemplateInstalled: (id: string) => ipcRenderer.invoke('market:installed', { id }),
    marketMyTemplates: () => ipcRenderer.invoke('market:mine'),
    marketCreateTemplate: (params: {
      name: string;
      description: string;
      category: string;
      emoji: string;
      instructions: string;
    }) => ipcRenderer.invoke('market:create', params),
    marketUpdateTemplate: (params: {
      id: string;
      name: string;
      description: string;
      category: string;
      emoji: string;
      instructions: string;
    }) => ipcRenderer.invoke('market:update', params),
    marketSetTemplateStatus: (id: string, status: 'draft' | 'published' | 'archived') =>
      ipcRenderer.invoke('market:set-status', { id, status }),
    marketDeleteTemplate: (id: string) => ipcRenderer.invoke('market:delete', { id }),
    // ── 成长值 / 悬赏（P3）──────────────────────────────────────────
    growthSummary: () => ipcRenderer.invoke('growth:summary'),
    growthCheckIn: () => ipcRenderer.invoke('growth:check-in'),
    growthHistory: (params?: { limit?: number; before?: string | null }) =>
      ipcRenderer.invoke('growth:history', params),
    bountyList: (params?: { status?: string | null }) => ipcRenderer.invoke('bounty:list', params),
    bountyCreate: (params: { title: string; description: string; reward: number }) =>
      ipcRenderer.invoke('bounty:create', params),
    bountyClaim: (id: string) => ipcRenderer.invoke('bounty:claim', { id }),
    bountyRelease: (id: string) => ipcRenderer.invoke('bounty:release', { id }),
    bountySubmit: (params: { id: string; note: string }) => ipcRenderer.invoke('bounty:submit', params),
    bountyAccept: (id: string) => ipcRenderer.invoke('bounty:accept', { id }),
    bountyReject: (params: { id: string; note: string }) => ipcRenderer.invoke('bounty:reject', params),
    bountyCancel: (id: string) => ipcRenderer.invoke('bounty:cancel', { id }),

    // ── 埋点上报（P4）────────────────────────────────────────────────
    // ⚠️ 渲染层只能上报白名单里的事件名（`@clawwork/shared` 的 ANALYTICS_EVENTS，
    //    与迁移 48 的表 CHECK 逐字一致）；`props` 到主进程还会过一遍标量白名单化
    //    与体积上限。**不要**在这里加任何加工 —— 白名单只有一份，在 main 侧。
    analyticsTrack: (payload: { event: string; props?: Record<string, string | number | boolean> }) =>
      ipcRenderer.invoke('analytics:track', payload),

    // ── 资料库（T6c）────────────────────────────────────────────────
    // ⚠️ 这里**只做管道**：哪些块该嵌、能不能搜、降级成什么，全在 `kb/service.ts`。
    //    唯一需要渲染层理解的是 `{ ok:false, code:'not-ready' }` —— 运行时是工作区就绪后
    //    **异步**建的（加载 90MB 模型），界面可能在那之前就问上来；这跟"你还没加过资料"
    //    是两回事，混在一起用户会以为自己的东西丢了。
    kbStats: () => ipcRenderer.invoke('kb:stats'),
    kbListSources: () => ipcRenderer.invoke('kb:list-sources'),
    kbPickFiles: () => ipcRenderer.invoke('kb:pick-files'),
    kbAddFile: (params: { path: string; title?: string }) => ipcRenderer.invoke('kb:add-file', params),
    kbAddNote: (params: { title: string; text: string }) => ipcRenderer.invoke('kb:add-note', params),
    kbRemoveSource: (sourceId: string) => ipcRenderer.invoke('kb:remove-source', { sourceId }),
    kbSearch: (params: { query: string; limit?: number }) => ipcRenderer.invoke('kb:search', params),
    kbIndexPending: (params?: { sourceId?: string }) => ipcRenderer.invoke('kb:index-pending', params),
    kbRebuild: (params?: { sourceId?: string }) => ipcRenderer.invoke('kb:rebuild', params),

    // ── 隐私与数据（P4）──────────────────────────────────────────────
    // 工单状态机、7 天冷却期、多成员团队 owner 拦截**全在数据库 RPC 里**，
    // 这里只是管道：参数原样透传，错误码由主进程压成裸机器码（见 privacy-handlers.ts）。
    privacyState: () => ipcRenderer.invoke('privacy:state', {}),
    privacyRequestExport: () => ipcRenderer.invoke('privacy:request-export', {}),
    privacyRequestDeletion: (payload: { reason?: string }) => ipcRenderer.invoke('privacy:request-deletion', payload),
    privacyCancelDeletion: (payload: { id: string }) => ipcRenderer.invoke('privacy:cancel-deletion', payload),
    privacyDownloadExport: () => ipcRenderer.invoke('privacy:download-export', {}),
  };
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('clawwork', buildApi());
  } catch (error) {
    throw new Error(
      `[preload] Failed to expose ClawWork API: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
} else {
  throw new Error('[preload] contextIsolation must be enabled.');
}
