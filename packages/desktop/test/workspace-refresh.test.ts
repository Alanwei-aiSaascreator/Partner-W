import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, Message } from '@clawwork/shared';

const reinitializeGatewayBootstrapMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/renderer/hooks/useGatewayDispatcherSetup', () => ({
  reinitializeGatewayBootstrap: reinitializeGatewayBootstrapMock,
}));

describe('refreshRendererAfterWorkspaceChange', () => {
  it('invalidates workspace artifact ownership before asynchronous side-session cleanup', async () => {
    vi.resetModules();
    let finish!: () => void;
    vi.doMock('../src/renderer/platform', async () => {
      const actual = await vi.importActual<typeof import('../src/renderer/platform')>('../src/renderer/platform');
      return {
        ...actual,
        systemSessionService: {
          end: () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        },
      };
    });
    const { useTaskStore, useMessageStore, useUiStore } = await import('../src/renderer/platform');
    const { useFileStore } = await import('../src/renderer/stores/fileStore');
    const { useArtifactDeliveryStore } = await import('../src/renderer/stores/artifactDeliveryStore');
    useFileStore.setState({
      artifacts: [{ id: 'old-artifact' } as Artifact],
      selectedArtifactId: 'old-artifact',
      searchQuery: 'private-old',
      searchResults: [],
      isSearching: true,
    });
    useMessageStore.setState({
      messagesByTask: { old: [{ id: 'old-message' } as Message] },
      highlightedMessageId: 'old-message',
    });
    useUiStore.setState({ agentCatalogByGateway: { old: { agents: [{ id: 'old-agent' }], defaultId: 'old-agent' } } });
    useArtifactDeliveryStore.setState({
      settled: [{ taskId: 'old', sessionKey: 'old-session', messageId: 'old-message', status: 'succeeded' }],
    });
    const { refreshRendererAfterWorkspaceChange } = await import('../src/renderer/lib/workspace-refresh');
    const epoch = useTaskStore.getState().workspaceEpoch;
    const pending = refreshRendererAfterWorkspaceChange();
    const actual = useTaskStore.getState().workspaceEpoch;
    const during = {
      file: useFileStore.getState(),
      messages: useMessageStore.getState(),
      catalog: useUiStore.getState().agentCatalogByGateway,
      delivery: useArtifactDeliveryStore.getState().settled,
    };
    finish();
    await pending;
    vi.doUnmock('../src/renderer/platform');
    expect(actual).toBe(epoch + 1);
    expect(during.file.selectedArtifactId).toBeNull();
    expect(during.file.artifacts).toEqual([]);
    expect(during.file.searchQuery).toBe('');
    expect(during.file.searchResults).toBeNull();
    expect(during.file.isSearching).toBe(false);
    expect(during.messages.messagesByTask).toEqual({});
    expect(during.messages.highlightedMessageId).toBeNull();
    expect(during.catalog).toEqual({});
    expect(during.delivery).toEqual([]);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    reinitializeGatewayBootstrapMock.mockResolvedValue(undefined);

    const clawwork = {
      getSettings: vi.fn().mockResolvedValue({ workspacePath: '/tmp/new-workspace', gateways: [] }),
      loadTasks: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
      getDeviceId: vi.fn().mockResolvedValue('device-1'),
      listTeams: vi.fn().mockResolvedValue({ ok: true, result: [] }),
      listTeamMeetings: vi.fn().mockResolvedValue({ ok: true, result: [] }),
      deleteSession: vi.fn().mockResolvedValue({ ok: true }),
    };

    (globalThis.window ??= {} as typeof globalThis.window).clawwork =
      clawwork as unknown as typeof globalThis.window.clawwork;
  });

  it('clears workspace-scoped renderer stores and re-bootstraps', async () => {
    vi.resetModules();

    const [
      { refreshRendererAfterWorkspaceChange },
      { useTaskStore },
      { useMessageStore },
      { useUiStore },
      { useFileStore },
      { useTeamStore },
      { useRoomStore },
    ] = await Promise.all([
      import('../src/renderer/lib/workspace-refresh'),
      import('../src/renderer/stores/taskStore'),
      import('../src/renderer/stores/messageStore'),
      import('../src/renderer/stores/uiStore'),
      import('../src/renderer/stores/fileStore'),
      import('../src/renderer/stores/teamStore'),
      import('../src/renderer/stores/roomStore'),
    ]);

    useTaskStore.setState({
      tasks: [
        {
          id: 'stale-task',
          sessionKey: 'agent:main:clawwork:task:stale-task',
          sessionId: 'sess-1',
          title: 'Stale',
          status: 'active',
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
          tags: [],
          artifactDir: '/tmp/stale',
          gatewayId: 'gw-1',
        },
      ],
      activeTaskId: 'stale-task',
      hydrated: true,
      pendingNewTask: null,
    });

    useMessageStore.setState({
      messagesByTask: {
        'stale-task': [
          {
            id: 'msg-1',
            taskId: 'stale-task',
            role: 'user',
            content: 'hello',
            artifacts: [],
            toolCalls: [],
            timestamp: '2026-03-16T00:00:00.000Z',
          },
        ],
      },
      activeTurnBySession: {},
      processingBySession: new Set(['agent:main:clawwork:task:stale-task']),
      highlightedMessageId: 'msg-1',
    });

    useUiStore.setState({
      agentCatalogByGateway: {
        'gw-1': { agents: [{ id: 'main', name: 'Main' }], defaultId: 'main' },
      },
      unreadTaskIds: new Set(['stale-task']),
      gatewaysLoaded: true,
      defaultGatewayId: 'gw-1',
      // 「这次运行连上过」是**上一账号/上一轮**的账：切号不清就会让新账号一进来
      // 就被当成"连上过"，首启预热期又会说成"已断开"（见 `gateway-display-phase.ts`）。
      gatewayEverConnected: { 'gw-1': true },
    });

    useFileStore.setState({
      artifacts: [
        {
          id: 'art-1',
          taskId: 'stale-task',
          messageId: 'msg-1',
          name: 'stale.txt',
          type: 'file',
          filePath: '/tmp/stale.txt',
          localPath: '/tmp/stale.txt',
          mimeType: 'text/plain',
          size: 1,
          createdAt: '2026-03-16T00:00:00.000Z',
          availability: 'available',
        },
      ],
      selectedArtifactId: 'art-1',
      searchQuery: 'stale',
      searchResults: [],
      isSearching: true,
      typeFilter: 'file',
    });

    useTeamStore.setState({
      teams: {
        'team-1': {
          id: 'team-1',
          name: 'Stale team',
          emoji: '🤖',
          description: 'stale',
          gatewayId: 'gw-1',
          source: 'local',
          version: '1',
          agents: [],
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
        },
      },
      loading: false,
      loadedOnce: true,
    });

    useRoomStore.setState({
      rooms: {
        'stale-task': {
          taskId: 'stale-task',
          conductorSessionKey: 'agent:main:clawwork:task:stale-task',
          status: 'active',
          conductorReady: true,
          performers: [],
        },
      },
      subagentKeyMap: { 'agent:sub:1': 'stale-task' },
    });

    await refreshRendererAfterWorkspaceChange();

    expect(useTaskStore.getState().tasks).toEqual([]);
    expect(useTaskStore.getState().activeTaskId).toBeNull();
    expect(useMessageStore.getState().messagesByTask).toEqual({});
    expect(useMessageStore.getState().processingBySession.size).toBe(0);
    expect(useUiStore.getState().agentCatalogByGateway).toEqual({});
    expect(useUiStore.getState().unreadTaskIds.size).toBe(0);
    expect(useUiStore.getState().gatewaysLoaded).toBe(false);
    expect(useUiStore.getState().gatewayEverConnected).toEqual({});
    expect(useFileStore.getState().artifacts).toEqual([]);
    expect(useFileStore.getState().selectedArtifactId).toBeNull();
    expect(useTeamStore.getState().teams).toEqual({});
    expect(useRoomStore.getState().rooms).toEqual({});
    expect(reinitializeGatewayBootstrapMock).toHaveBeenCalledTimes(1);
  });
});
