import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

type MockedApi = {
  syncSessions: Mock;
  chatHistory: Mock;
  persistTask: Mock;
  persistTaskUpdate: Mock;
  loadMessages: Mock;
  loadTasks: Mock;
  persistMessage: Mock;
  getDeviceId: Mock;
};

let mockApi: MockedApi;

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function loadModules() {
  vi.resetModules();
  const [sessionSync, taskStore, messageStore] = await Promise.all([
    import('../src/renderer/lib/session-sync'),
    import('../src/renderer/stores/taskStore'),
    import('../src/renderer/stores/messageStore'),
  ]);
  return { sessionSync, taskStore, messageStore };
}

describe('session sync startup flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = {
      syncSessions: vi.fn(),
      chatHistory: vi.fn(),
      persistTask: vi.fn().mockResolvedValue({ ok: true }),
      persistTaskUpdate: vi.fn().mockResolvedValue({ ok: true }),
      loadMessages: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
      loadTasks: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
      persistMessage: vi.fn().mockResolvedValue({ ok: true }),
      getDeviceId: vi.fn().mockResolvedValue('device-1'),
    };
    (globalThis.window ??= {} as typeof globalThis.window).clawwork = mockApi as unknown as Window['clawwork'];
  });

  it('filters gateway-injected model values from discovered session metadata', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();

    taskStore.useTaskStore.setState({ tasks: [], activeTaskId: null, hydrated: false });
    messageStore.useMessageStore.setState({
      messagesByTask: {},
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    mockApi.syncSessions.mockResolvedValue({
      ok: true,
      discovered: [
        {
          gatewayId: 'gw-1',
          taskId: 'task-1',
          sessionKey: 'agent:main:clawwork:task:task-1',
          title: 'Task 1',
          updatedAt: '2026-03-16T00:00:00.000Z',
          agentId: 'main',
          model: 'gateway-injected',
          modelProvider: 'openclaw',
          thinkingLevel: 'medium',
          inputTokens: 1,
          outputTokens: 2,
          contextTokens: 3,
          messages: [],
        },
      ],
    });

    await sessionSync.syncFromGateway();

    const task = taskStore.useTaskStore.getState().tasks[0];
    expect(task).toBeTruthy();
    expect(task.model).toBeUndefined();
    expect(task.modelProvider).toBe('openclaw');
    expect(mockApi.persistTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-1',
        model: undefined,
        modelProvider: 'openclaw',
      }),
    );
  });

  /**
   * ⭐ 同步**元数据**（模型/用量）不是"任务又活动了"。
   *
   * ## 现场（2026-09-20，同时是用户「聊天记录咋找不到」的另一半）
   *
   * `syncFromGateway` 每发现一个会话就调 `updateTaskMetadata(d.taskId, {…})`，
   * **没带 `updatedAt`** ⇒ store 里 `meta.updatedAt ?? new Date().toISOString()`
   * ⇒ 每启动同步一圈，就把**所有任务**的"最后活动时间"改成"现在"。
   * 实测（dev 客户端，直读 sqlite）：42 个任务的 `updated_at` 全落在
   * `03:13:49.996Z ~ 03:13:50.000Z` 这 5 毫秒里。
   *
   * 后果：侧栏「最近任务」按 `updatedAt` 排序 ⇒ **全同时间戳 = 顺序退化成任意**，
   * 用户最近那次对话不一定在最上面（找起来就像"记录没了"）。
   *
   * 判据：网关报的 `d.updatedAt`（那才是真实的最后活动时间，`adoptTasks` 新建任务时
   * 用的也是它）—— 一期一致，不许让本地默认值把它盖掉。
   */
  it('⭐ 同步元数据不许把任务的"最后活动时间"改成"现在"（侧栏排序靠它）', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();

    taskStore.useTaskStore.setState({ tasks: [], activeTaskId: null, hydrated: false });
    messageStore.useMessageStore.setState({
      messagesByTask: {},
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    const taskRow = {
      id: 'task-1',
      sessionKey: 'agent:main:clawwork:task:task-1',
      sessionId: 'session-1',
      title: 'Task 1',
      status: 'active',
      model: null,
      modelProvider: null,
      thinkingLevel: null,
      inputTokens: null,
      outputTokens: null,
      contextTokens: null,
      createdAt: '2026-03-16T00:00:00.000Z',
      updatedAt: '2026-03-16T00:00:00.000Z',
      tags: [],
      artifactDir: 'tasks/task-1',
      gatewayId: 'gw-1',
    };

    mockApi.loadTasks.mockResolvedValue({ ok: true, rows: [taskRow] });
    mockApi.loadMessages.mockResolvedValue({ ok: true, rows: [] });
    mockApi.syncSessions.mockResolvedValue({
      ok: true,
      discovered: [
        {
          gatewayId: 'gw-1',
          taskId: 'task-1',
          sessionKey: 'agent:main:clawwork:task:task-1',
          title: 'Task 1',
          updatedAt: '2026-03-16T10:00:03.000Z',
          agentId: 'main',
          model: 'model-1',
          modelProvider: 'openclaw',
          thinkingLevel: 'medium',
          inputTokens: 1,
          outputTokens: 2,
          contextTokens: 3,
          messages: [],
        },
      ],
    });

    await sessionSync.hydrateFromLocal();
    await sessionSync.syncFromGateway();

    // 内存里：等于网关报的那个时间，不是"现在"
    expect(taskStore.useTaskStore.getState().tasks[0].updatedAt).toBe('2026-03-16T10:00:03.000Z');
    // 落库那次也要带上它（否则重启后读回来还是"现在"）
    expect(mockApi.persistTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1', updatedAt: '2026-03-16T10:00:03.000Z' }),
    );
  });

  it('waits for local hydration before syncing gateway history for an existing task', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();

    taskStore.useTaskStore.setState({ tasks: [], activeTaskId: null, hydrated: false });
    messageStore.useMessageStore.setState({
      messagesByTask: {},
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    const taskRow = {
      id: 'task-1',
      sessionKey: 'agent:main:clawwork:task:task-1',
      sessionId: 'session-1',
      title: 'Task 1',
      status: 'active',
      model: null,
      modelProvider: null,
      thinkingLevel: null,
      inputTokens: null,
      outputTokens: null,
      contextTokens: null,
      createdAt: '2026-03-16T00:00:00.000Z',
      updatedAt: '2026-03-16T00:00:00.000Z',
      tags: [],
      artifactDir: 'tasks/task-1',
      gatewayId: 'gw-1',
    };
    const existingRow = {
      id: 'local-msg-1',
      taskId: 'task-1',
      role: 'assistant',
      content: 'same reply',
      timestamp: '2026-03-16T00:00:01.000Z',
      attachments: undefined,
    };
    const loadMessagesDeferred = createDeferred<{ ok: true; rows: (typeof existingRow)[] }>();

    mockApi.loadTasks.mockResolvedValue({ ok: true, rows: [taskRow] });
    mockApi.loadMessages.mockReturnValue(loadMessagesDeferred.promise);
    mockApi.syncSessions.mockResolvedValue({
      ok: true,
      discovered: [
        {
          gatewayId: 'gw-1',
          taskId: 'task-1',
          sessionKey: 'agent:main:clawwork:task:task-1',
          title: 'Task 1',
          updatedAt: '2026-03-16T00:00:02.000Z',
          agentId: 'main',
          model: 'model-1',
          modelProvider: 'openclaw',
          thinkingLevel: 'medium',
          inputTokens: 1,
          outputTokens: 2,
          contextTokens: 3,
          messages: [
            {
              role: 'assistant',
              content: 'same reply',
              timestamp: '2026-03-16T00:00:01.000Z',
            },
          ],
        },
      ],
    });

    const hydratePromise = sessionSync.hydrateFromLocal();
    await Promise.resolve();

    const syncPromise = sessionSync.syncFromGateway();
    await Promise.resolve();

    loadMessagesDeferred.resolve({ ok: true, rows: [existingRow] });

    await Promise.all([hydratePromise, syncPromise]);

    expect(mockApi.persistMessage).not.toHaveBeenCalled();
    expect(messageStore.useMessageStore.getState().messagesByTask['task-1']).toEqual([
      expect.objectContaining({
        id: 'local-msg-1',
        content: 'same reply',
        timestamp: '2026-03-16T00:00:01.000Z',
      }),
    ]);
  });

  it('deduplicates assistant messages by matching Gateway timestamp', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();

    taskStore.useTaskStore.setState({ tasks: [], activeTaskId: null, hydrated: false });
    messageStore.useMessageStore.setState({
      messagesByTask: {},
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    const taskRow = {
      id: 'task-dup',
      sessionKey: 'agent:main:clawwork:task:task-dup',
      sessionId: 'session-dup',
      title: 'Dup test',
      status: 'active',
      model: null,
      modelProvider: null,
      thinkingLevel: null,
      inputTokens: null,
      outputTokens: null,
      contextTokens: null,
      createdAt: '2026-03-16T00:00:00.000Z',
      updatedAt: '2026-03-16T00:00:00.000Z',
      tags: [],
      artifactDir: 'tasks/task-dup',
      gatewayId: 'gw-1',
    };
    mockApi.loadTasks.mockResolvedValue({ ok: true, rows: [taskRow] });
    mockApi.loadMessages.mockResolvedValue({
      ok: true,
      rows: [
        { id: 'u1', taskId: 'task-dup', role: 'user', content: 'Hello', timestamp: '2026-03-16T10:00:00.123Z' },
        {
          id: 'a1',
          taskId: 'task-dup',
          role: 'assistant',
          content: 'Hi there!',
          timestamp: '2026-03-16T10:00:01.234Z',
        },
      ],
    });
    mockApi.syncSessions.mockResolvedValue({
      ok: true,
      discovered: [
        {
          gatewayId: 'gw-1',
          taskId: 'task-dup',
          sessionKey: 'agent:main:clawwork:task:task-dup',
          title: 'Dup test',
          updatedAt: '2026-03-16T10:00:02.000Z',
          agentId: 'main',
          messages: [
            { role: 'user', content: 'Hello', timestamp: '2026-03-16T10:00:00.456Z' },
            { role: 'assistant', content: 'Hi there!', timestamp: '2026-03-16T10:00:01.234Z' },
          ],
        },
      ],
    });

    await sessionSync.syncFromGateway();

    const msgs = messageStore.useMessageStore.getState().messagesByTask['task-dup'];
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('Hello');
    expect(msgs[1].content).toBe('Hi there!');
    expect(mockApi.persistMessage).not.toHaveBeenCalled();
  });

  it('recovers an older missing canonical tuple without rewriting a legacy collapsed local row', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();
    const sessionKey = 'agent:main:clawwork:task:task-legacy';

    taskStore.useTaskStore.setState({
      tasks: [
        {
          id: 'task-legacy',
          sessionKey,
          sessionId: 'session-legacy',
          title: 'Legacy split test',
          status: 'active',
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
          tags: [],
          artifactDir: 'tasks/task-legacy',
          gatewayId: 'gw-1',
        },
      ],
      activeTaskId: 'task-legacy',
      hydrated: true,
    });
    messageStore.useMessageStore.setState({
      messagesByTask: {
        'task-legacy': [
          {
            id: 'u1',
            taskId: 'task-legacy',
            role: 'user',
            content: 'Check status',
            artifacts: [],
            toolCalls: [],
            timestamp: '2026-03-16T10:00:00.000Z',
          },
          {
            id: 'a1',
            taskId: 'task-legacy',
            role: 'assistant',
            content: 'Intro\n\nFinal status',
            artifacts: [],
            toolCalls: [],
            sessionKey,
            agentId: 'main',
            timestamp: '2026-03-16T10:00:03.000Z',
          },
        ],
      },
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    mockApi.chatHistory.mockResolvedValue({
      ok: true,
      result: {
        messages: [
          {
            role: 'user',
            timestamp: Date.parse('2026-03-16T10:00:00.000Z'),
            content: [{ type: 'text', text: 'Check status' }],
          },
          {
            role: 'assistant',
            timestamp: Date.parse('2026-03-16T10:00:01.000Z'),
            content: [{ type: 'text', text: 'Intro' }],
          },
          {
            role: 'assistant',
            timestamp: Date.parse('2026-03-16T10:00:03.000Z'),
            content: [{ type: 'text', text: 'Final status' }],
          },
        ],
      },
    });

    await sessionSync.syncSessionMessages('task-legacy');
    await sessionSync.syncSessionMessages('task-legacy');

    const msgs = messageStore.useMessageStore.getState().messagesByTask['task-legacy'];
    expect(msgs).toHaveLength(3);
    expect(msgs[1].id).toBe('a1');
    expect(msgs[1].content).toBe('Intro\n\nFinal status');
    expect(msgs[2]).toEqual(
      expect.objectContaining({ content: 'Intro', sessionKey, timestamp: '2026-03-16T10:00:01.000Z' }),
    );
    expect(mockApi.persistMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: msgs[2].id, content: 'Intro', sessionKey }),
    );
  });

  it('syncs only new assistant messages for existing tasks (single-writer)', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();

    taskStore.useTaskStore.setState({ tasks: [], activeTaskId: null, hydrated: false });
    messageStore.useMessageStore.setState({
      messagesByTask: {},
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    const taskRow = {
      id: 'task-legit',
      sessionKey: 'agent:main:clawwork:task:task-legit',
      sessionId: 'session-legit',
      title: 'Legit dup',
      status: 'active',
      model: null,
      modelProvider: null,
      thinkingLevel: null,
      inputTokens: null,
      outputTokens: null,
      contextTokens: null,
      createdAt: '2026-03-16T00:00:00.000Z',
      updatedAt: '2026-03-16T00:00:00.000Z',
      tags: [],
      artifactDir: 'tasks/task-legit',
      gatewayId: 'gw-1',
    };
    mockApi.loadTasks.mockResolvedValue({ ok: true, rows: [taskRow] });
    mockApi.loadMessages.mockResolvedValue({
      ok: true,
      rows: [{ id: 'u1', taskId: 'task-legit', role: 'user', content: 'Hello', timestamp: '2026-03-16T10:00:00.000Z' }],
    });
    mockApi.syncSessions.mockResolvedValue({
      ok: true,
      discovered: [
        {
          gatewayId: 'gw-1',
          taskId: 'task-legit',
          sessionKey: 'agent:main:clawwork:task:task-legit',
          title: 'Legit dup',
          updatedAt: '2026-03-16T10:00:03.000Z',
          agentId: 'main',
          messages: [
            { role: 'user', content: 'Hello', timestamp: '2026-03-16T10:00:00.500Z' },
            { role: 'assistant', content: 'Hi!', timestamp: '2026-03-16T10:00:01.000Z' },
            { role: 'user', content: 'Hello', timestamp: '2026-03-16T10:00:02.000Z' },
            { role: 'assistant', content: 'Hi again!', timestamp: '2026-03-16T10:00:03.000Z' },
          ],
        },
      ],
    });

    await sessionSync.syncFromGateway();

    const msgs = messageStore.useMessageStore.getState().messagesByTask['task-legit'];
    expect(msgs).toHaveLength(3);
    expect(msgs.map((m: { content: string }) => m.content)).toEqual(['Hello', 'Hi!', 'Hi again!']);
  });

  it('collapses consecutive assistant history into one visible assistant turn during startup sync', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();

    taskStore.useTaskStore.setState({ tasks: [], activeTaskId: null, hydrated: false });
    messageStore.useMessageStore.setState({
      messagesByTask: {},
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    const taskRow = {
      id: 'task-collapse',
      sessionKey: 'agent:main:clawwork:task:task-collapse',
      sessionId: 'session-collapse',
      title: 'Collapse test',
      status: 'active',
      model: null,
      modelProvider: null,
      thinkingLevel: null,
      inputTokens: null,
      outputTokens: null,
      contextTokens: null,
      createdAt: '2026-03-16T00:00:00.000Z',
      updatedAt: '2026-03-16T00:00:00.000Z',
      tags: [],
      artifactDir: 'tasks/task-collapse',
      gatewayId: 'gw-1',
    };

    mockApi.loadTasks.mockResolvedValue({ ok: true, rows: [taskRow] });
    mockApi.loadMessages.mockResolvedValue({
      ok: true,
      rows: [
        {
          id: 'u1',
          taskId: 'task-collapse',
          role: 'user',
          content: '再看看今天的记忆有什么',
          timestamp: '2026-03-16T10:00:00.000Z',
        },
      ],
    });
    mockApi.syncSessions.mockResolvedValue({
      ok: true,
      discovered: [
        {
          gatewayId: 'gw-1',
          taskId: 'task-collapse',
          sessionKey: 'agent:main:clawwork:task:task-collapse',
          title: 'Collapse test',
          updatedAt: '2026-03-16T10:00:03.000Z',
          agentId: 'main',
          messages: [
            { role: 'user', content: '再看看今天的记忆有什么', timestamp: '2026-03-16T10:00:00.000Z' },
            {
              role: 'assistant',
              content: '今天还没记录。让我看看之前有啥：',
              timestamp: '2026-03-16T10:00:01.000Z',
              toolCalls: [],
            },
            {
              role: 'assistant',
              content: '',
              timestamp: '2026-03-16T10:00:02.000Z',
              toolCalls: [
                {
                  id: 'read-1',
                  name: 'read',
                  status: 'error',
                  result: 'from memory/2026-03-23.md',
                  startedAt: '2026-03-16T10:00:02.000Z',
                  completedAt: '2026-03-16T10:00:02.100Z',
                },
              ],
            },
            {
              role: 'assistant',
              content: '记忆文件还没创建，今天是头一次聊。有啥需要我干的？',
              timestamp: '2026-03-16T10:00:03.000Z',
              toolCalls: [],
            },
            { role: 'assistant', content: 'NO_REPLY', timestamp: '2026-03-16T10:00:03.500Z', toolCalls: [] },
          ],
        },
      ],
    });

    await sessionSync.syncFromGateway();

    const msgs = messageStore.useMessageStore.getState().messagesByTask['task-collapse'];
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: '今天还没记录。让我看看之前有啥：\n\n记忆文件还没创建，今天是头一次聊。有啥需要我干的？',
      }),
    );
    expect(msgs[1].toolCalls).toHaveLength(1);
  });

  it('promotes one collapsed assistant turn during runtime sync instead of appending multiple assistant bubbles', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();

    taskStore.useTaskStore.setState({
      tasks: [
        {
          id: 'task-runtime',
          sessionKey: 'agent:main:clawwork:task:task-runtime',
          sessionId: 'session-runtime',
          title: 'Runtime test',
          status: 'active',
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
          tags: [],
          artifactDir: 'tasks/task-runtime',
          gatewayId: 'gw-1',
        },
      ],
      activeTaskId: 'task-runtime',
      hydrated: true,
    });
    messageStore.useMessageStore.setState({
      messagesByTask: {
        'task-runtime': [
          {
            id: 'u1',
            taskId: 'task-runtime',
            role: 'user',
            content: '今天他的天气怎么样? 获取当前电脑的 IP',
            artifacts: [],
            toolCalls: [],
            timestamp: '2026-03-16T10:00:00.000Z',
          },
        ],
      },
      activeTurnBySession: {
        'agent:main:clawwork:task:task-runtime': {
          id: 'turn-1',
          streamingText: '',
          streamingThinking: '',
          toolCalls: [
            {
              id: 'exec-1',
              name: 'exec',
              status: 'done',
              result: 'fetch url',
              startedAt: '2026-03-16T10:00:01.000Z',
              completedAt: '2026-03-16T10:00:01.100Z',
            },
            {
              id: 'read-1',
              name: 'read',
              status: 'error',
              result: 'from memory/2026-03-23.md',
              startedAt: '2026-03-16T10:00:01.200Z',
              completedAt: '2026-03-16T10:00:01.300Z',
            },
          ],
          finalized: true,
          content: '天气（上海）： 15°C',
          runId: 'run-1',
          timestamp: '2026-03-16T10:00:03.000Z',
        },
      },
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    mockApi.chatHistory.mockResolvedValue({
      ok: true,
      result: {
        messages: [
          {
            role: 'user',
            timestamp: Date.parse('2026-03-16T10:00:00.000Z'),
            content: [{ type: 'text', text: '今天他的天气怎么样? 获取当前电脑的 IP' }],
          },
          {
            role: 'assistant',
            timestamp: Date.parse('2026-03-16T10:00:01.000Z'),
            content: [{ type: 'text', text: '今天他的天气怎么样? 我先看下天气和 IP。' }],
            __openclaw: { runId: 'run-1' },
          },
          {
            role: 'assistant',
            timestamp: Date.parse('2026-03-16T10:00:02.000Z'),
            content: [{ type: 'toolCall', id: 'exec-1', name: 'exec', arguments: '{}' }],
            __openclaw: { runId: 'run-1' },
          },
          {
            role: 'toolResult',
            timestamp: Date.parse('2026-03-16T10:00:02.100Z'),
            content: [{ type: 'toolResult', id: 'exec-1', result: 'fetch url' }],
            __openclaw: { runId: 'run-1' },
          },
          {
            role: 'assistant',
            timestamp: Date.parse('2026-03-16T10:00:03.000Z'),
            content: [{ type: 'text', text: '天气（上海）： 15°C' }],
            __openclaw: { runId: 'run-1' },
          },
          {
            role: 'assistant',
            timestamp: Date.parse('2026-03-16T10:00:03.100Z'),
            content: [{ type: 'text', text: 'NO_REPLY' }],
            __openclaw: { runId: 'run-1' },
          },
        ],
      },
    });

    await sessionSync.syncSessionMessages('task-runtime');

    const state = messageStore.useMessageStore.getState();
    const msgs = state.messagesByTask['task-runtime'];
    expect(state.activeTurnBySession['agent:main:clawwork:task:task-runtime']).toBeUndefined();
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: '今天他的天气怎么样? 我先看下天气和 IP。\n\n天气（上海）： 15°C',
      }),
    );
    expect(msgs[1].toolCalls).toHaveLength(2);
    expect(msgs[1].toolCalls).toEqual([
      expect.objectContaining({ id: 'exec-1', status: 'done', result: 'fetch url' }),
      expect.objectContaining({ id: 'read-1', status: 'error', result: 'from memory/2026-03-23.md' }),
    ]);
    expect(mockApi.persistMessage).toHaveBeenCalledTimes(1);
  });

  it('prefers terminal tool status from active turn over stale running canonical tool calls during promote', async () => {
    const { messageStore } = await loadModules();

    messageStore.useMessageStore.setState({
      messagesByTask: { 'task-promote': [] },
      activeTurnBySession: {
        'agent:main:clawwork:task:task-promote': {
          id: 'turn-promote',
          streamingText: '',
          streamingThinking: '',
          toolCalls: [
            {
              id: 'exec-1',
              name: 'exec',
              status: 'done',
              result: 'uname -a',
              startedAt: '2026-03-16T10:00:00.000Z',
              completedAt: '2026-03-16T10:00:01.000Z',
            },
          ],
          finalized: true,
          content: 'CPU info',
          timestamp: '2026-03-16T10:00:01.500Z',
        },
      },
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    messageStore.useMessageStore.getState().promoteActiveTurn('agent:main:clawwork:task:task-promote', 'task-promote', {
      id: 'canonical-1',
      taskId: 'task-promote',
      role: 'assistant',
      content: 'CPU info',
      artifacts: [],
      toolCalls: [
        {
          id: 'exec-1',
          name: 'exec',
          status: 'running',
          startedAt: '2026-03-16T10:00:00.000Z',
        },
      ],
      timestamp: '2026-03-16T10:00:01.500Z',
    });

    const saved = messageStore.useMessageStore.getState().messagesByTask['task-promote'];
    expect(saved).toHaveLength(1);
    expect(saved[0].toolCalls).toEqual([
      expect.objectContaining({
        id: 'exec-1',
        status: 'done',
        result: 'uname -a',
        completedAt: '2026-03-16T10:00:01.000Z',
      }),
    ]);
  });

  it('persists merged terminal tool status during runtime sync instead of stale canonical running state', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();

    taskStore.useTaskStore.setState({
      tasks: [
        {
          id: 'task-sync-persist',
          sessionKey: 'agent:main:clawwork:task:task-sync-persist',
          sessionId: 'session-sync-persist',
          title: 'Sync persist',
          status: 'active',
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
          tags: [],
          artifactDir: 'tasks/task-sync-persist',
          gatewayId: 'gw-1',
        },
      ],
      activeTaskId: 'task-sync-persist',
      hydrated: true,
    });
    messageStore.useMessageStore.setState({
      messagesByTask: {
        'task-sync-persist': [
          {
            id: 'u1',
            taskId: 'task-sync-persist',
            role: 'user',
            content: '查 CPU',
            artifacts: [],
            toolCalls: [],
            timestamp: '2026-03-16T10:00:00.000Z',
          },
        ],
      },
      activeTurnBySession: {
        'agent:main:clawwork:task:task-sync-persist': {
          id: 'turn-sync-persist',
          streamingText: '',
          streamingThinking: '',
          toolCalls: [
            {
              id: 'exec-1',
              name: 'exec',
              status: 'done',
              result: 'uname -a',
              startedAt: '2026-03-16T10:00:00.500Z',
              completedAt: '2026-03-16T10:00:01.000Z',
            },
          ],
          finalized: true,
          content: 'CPU info',
          runId: 'run-sync-persist',
          timestamp: '2026-03-16T10:00:01.000Z',
        },
      },
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    mockApi.chatHistory.mockResolvedValue({
      ok: true,
      result: {
        messages: [
          {
            role: 'user',
            timestamp: Date.parse('2026-03-16T10:00:00.000Z'),
            content: [{ type: 'text', text: '查 CPU' }],
          },
          {
            role: 'assistant',
            timestamp: Date.parse('2026-03-16T10:00:01.000Z'),
            content: [
              { type: 'text', text: 'CPU info' },
              { type: 'toolCall', id: 'exec-1', name: 'exec', arguments: '{}' },
            ],
            __openclaw: { runId: 'run-sync-persist' },
          },
        ],
      },
    });

    await sessionSync.syncSessionMessages('task-sync-persist');

    expect(mockApi.persistMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-sync-persist',
        role: 'assistant',
        toolCalls: [expect.objectContaining({ id: 'exec-1', status: 'done', result: 'uname -a' })],
      }),
    );
  });

  // 推理输出（`stream:"thinking"`）只在 agent 通道上流过一次，**网关历史里没有它**
  //（`normalize-history` 不解析，chat 通道的 final 也只带 text 块）。
  // 所以它必须在 final 之后那次 sync 落库 —— 不落就只活在内存里，刷新即丢。
  it('落库时带上推理 —— 网关历史里没有它，不落就重载即丢', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();
    const sessionKey = 'agent:main:clawwork:task:task-think-persist';

    taskStore.useTaskStore.setState({
      tasks: [
        {
          id: 'task-think-persist',
          sessionKey,
          sessionId: 'session-think-persist',
          title: 'Think persist',
          status: 'active',
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
          tags: [],
          artifactDir: 'tasks/task-think-persist',
          gatewayId: 'gw-1',
        },
      ],
      activeTaskId: 'task-think-persist',
      hydrated: true,
    });
    messageStore.useMessageStore.setState({
      messagesByTask: {
        'task-think-persist': [
          {
            id: 'u1',
            taskId: 'task-think-persist',
            role: 'user',
            content: '鸡兔同笼',
            artifacts: [],
            toolCalls: [],
            timestamp: '2026-03-16T10:00:00.000Z',
          },
        ],
      },
      activeTurnBySession: {
        [sessionKey]: {
          id: 'turn-think',
          streamingText: '',
          streamingThinking: '',
          toolCalls: [],
          finalized: true,
          content: '鸡 23 只、兔 12 只。',
          thinkingContent: '设鸡 x 只、兔 y 只，则 x+y=35、2x+4y=94……',
          timestamp: '2026-03-16T10:00:01.000Z',
        },
      },
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    // 网关历史里**只有回复本体**，没有推理
    mockApi.chatHistory.mockResolvedValue({
      ok: true,
      result: {
        messages: [
          {
            role: 'user',
            timestamp: Date.parse('2026-03-16T10:00:00.000Z'),
            content: [{ type: 'text', text: '鸡兔同笼' }],
          },
          {
            role: 'assistant',
            timestamp: Date.parse('2026-03-16T10:00:01.000Z'),
            content: [{ type: 'text', text: '鸡 23 只、兔 12 只。' }],
          },
        ],
      },
    });

    await sessionSync.syncSessionMessages('task-think-persist');

    expect(mockApi.persistMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-think-persist',
        role: 'assistant',
        content: '鸡 23 只、兔 12 只。',
        thinkingContent: '设鸡 x 只、兔 y 只，则 x+y=35、2x+4y=94……',
      }),
    );
  });

  it('reuses resolved hydration state across later gateway sync calls', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();

    taskStore.useTaskStore.setState({ tasks: [], activeTaskId: null, hydrated: false });
    messageStore.useMessageStore.setState({
      messagesByTask: {},
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    mockApi.loadTasks.mockResolvedValue({
      ok: true,
      rows: [
        {
          id: 'task-1',
          sessionKey: 'agent:main:clawwork:task:task-1',
          sessionId: 'session-1',
          title: 'Task 1',
          status: 'active',
          model: null,
          modelProvider: null,
          thinkingLevel: null,
          inputTokens: null,
          outputTokens: null,
          contextTokens: null,
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
          tags: [],
          artifactDir: 'tasks/task-1',
          gatewayId: 'gw-1',
        },
      ],
    });
    mockApi.loadMessages.mockResolvedValue({ ok: true, rows: [] });
    mockApi.syncSessions.mockResolvedValue({ ok: true, discovered: [] });

    await sessionSync.syncFromGateway();
    await sessionSync.syncFromGateway();

    expect(mockApi.loadTasks).toHaveBeenCalledTimes(1);
    expect(mockApi.loadMessages).toHaveBeenCalledTimes(1);
    expect(mockApi.syncSessions).toHaveBeenCalledTimes(2);
  });

  it('hydrates persisted tool calls from local storage', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();

    taskStore.useTaskStore.setState({ tasks: [], activeTaskId: null, hydrated: false });
    messageStore.useMessageStore.setState({
      messagesByTask: {},
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    mockApi.loadTasks.mockResolvedValue({
      ok: true,
      rows: [
        {
          id: 'task-tools',
          sessionKey: 'agent:main:clawwork:task:task-tools',
          sessionId: 'session-tools',
          title: 'Task tools',
          status: 'active',
          model: null,
          modelProvider: null,
          thinkingLevel: null,
          inputTokens: null,
          outputTokens: null,
          contextTokens: null,
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
          tags: [],
          artifactDir: 'tasks/task-tools',
          gatewayId: 'gw-1',
        },
      ],
    });
    mockApi.loadMessages.mockResolvedValue({
      ok: true,
      rows: [
        {
          id: 'a-tool',
          taskId: 'task-tools',
          role: 'assistant',
          content: 'CPU info',
          timestamp: '2026-03-16T10:00:01.000Z',
          toolCalls: [
            {
              id: 'exec-1',
              name: 'exec',
              status: 'done',
              result: 'uname -a',
              startedAt: '2026-03-16T10:00:00.000Z',
              completedAt: '2026-03-16T10:00:01.000Z',
            },
          ],
        },
      ],
    });

    await sessionSync.hydrateFromLocal();

    const msgs = messageStore.useMessageStore.getState().messagesByTask['task-tools'];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].toolCalls).toEqual([
      expect.objectContaining({ id: 'exec-1', name: 'exec', status: 'done', result: 'uname -a' }),
    ]);
  });

  it('persists tool calls when syncing assistant messages', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();

    taskStore.useTaskStore.setState({ tasks: [], activeTaskId: null, hydrated: false });
    messageStore.useMessageStore.setState({
      messagesByTask: {},
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    mockApi.syncSessions.mockResolvedValue({
      ok: true,
      discovered: [
        {
          gatewayId: 'gw-1',
          taskId: 'task-persist-tools',
          sessionKey: 'agent:main:clawwork:task:task-persist-tools',
          title: 'Persist tools',
          updatedAt: '2026-03-16T10:00:03.000Z',
          agentId: 'main',
          model: 'model-1',
          modelProvider: 'openclaw',
          thinkingLevel: 'medium',
          inputTokens: 1,
          outputTokens: 2,
          contextTokens: 3,
          messages: [
            { role: 'user', content: '读 CPU', timestamp: '2026-03-16T10:00:00.000Z', toolCalls: [] },
            {
              role: 'assistant',
              content: 'CPU info',
              timestamp: '2026-03-16T10:00:01.000Z',
              toolCalls: [
                {
                  id: 'exec-1',
                  name: 'exec',
                  status: 'done',
                  result: 'uname -a',
                  startedAt: '2026-03-16T10:00:00.500Z',
                  completedAt: '2026-03-16T10:00:01.000Z',
                },
              ],
            },
          ],
        },
      ],
    });

    await sessionSync.syncFromGateway();

    expect(mockApi.persistMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-persist-tools',
        role: 'assistant',
        toolCalls: [expect.objectContaining({ id: 'exec-1', name: 'exec', status: 'done' })],
      }),
    );
  });

  it('aborts in-flight session sync after resetHydration to prevent cross-workspace writes', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();
    const sessionKey = 'agent:main:clawwork:task:task-race';

    taskStore.useTaskStore.setState({
      tasks: [
        {
          id: 'task-race',
          sessionKey,
          sessionId: 'session-race',
          title: 'Race test',
          status: 'active',
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
          tags: [],
          artifactDir: 'tasks/task-race',
          gatewayId: 'gw-1',
        },
      ],
      activeTaskId: 'task-race',
      hydrated: true,
    });
    messageStore.useMessageStore.setState({
      messagesByTask: {
        'task-race': [
          {
            id: 'u1',
            taskId: 'task-race',
            role: 'user',
            content: 'hello',
            artifacts: [],
            toolCalls: [],
            timestamp: '2026-03-16T10:00:00.000Z',
          },
        ],
      },
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    const chatHistoryDeferred = createDeferred<{
      ok: true;
      result: {
        messages: Array<{
          role: string;
          timestamp: number;
          content: Array<{ type: string; text: string }>;
        }>;
      };
    }>();

    mockApi.chatHistory.mockReturnValue(chatHistoryDeferred.promise);

    const syncPromise = sessionSync.syncSessionMessages('task-race');
    await Promise.resolve();

    sessionSync.resetHydration();

    chatHistoryDeferred.resolve({
      ok: true,
      result: {
        messages: [
          {
            role: 'assistant',
            timestamp: Date.parse('2026-03-16T10:00:01.000Z'),
            content: [{ type: 'text', text: 'stale write' }],
          },
        ],
      },
    });

    await syncPromise;

    expect(mockApi.persistMessage).not.toHaveBeenCalled();
    expect(messageStore.useMessageStore.getState().messagesByTask['task-race']).toHaveLength(1);
  });

  it('resetHydration allows hydrateFromLocal to reload after workspace switch', async () => {
    const { sessionSync, taskStore } = await loadModules();

    mockApi.loadTasks.mockResolvedValue({
      ok: true,
      rows: [
        {
          id: 'task-old',
          sessionKey: 'agent:main:clawwork:task:task-old',
          sessionId: 'sess-old',
          title: 'Old workspace task',
          status: 'active',
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
          tags: [],
          artifactDir: '/tmp/old',
          gatewayId: 'gw-1',
        },
      ],
    });

    await sessionSync.hydrateFromLocal();
    expect(taskStore.useTaskStore.getState().tasks).toHaveLength(1);
    expect(taskStore.useTaskStore.getState().tasks[0].id).toBe('task-old');

    taskStore.useTaskStore.setState({ tasks: [], activeTaskId: null, hydrated: false });
    sessionSync.resetHydration();

    mockApi.loadTasks.mockResolvedValue({
      ok: true,
      rows: [
        {
          id: 'task-new',
          sessionKey: 'agent:main:clawwork:task:task-new',
          sessionId: 'sess-new',
          title: 'New workspace task',
          status: 'active',
          createdAt: '2026-03-17T00:00:00.000Z',
          updatedAt: '2026-03-17T00:00:00.000Z',
          tags: [],
          artifactDir: '/tmp/new',
          gatewayId: 'gw-1',
        },
      ],
    });

    await sessionSync.hydrateFromLocal();

    expect(taskStore.useTaskStore.getState().tasks).toHaveLength(1);
    expect(taskStore.useTaskStore.getState().tasks[0].id).toBe('task-new');
  });

  // 消息级 model —— 「这条回复到底是谁生成的」的唯一可信来源。
  // 形状是**实测**的（2026-09-13 打网关 chat.history + 读 transcript）：每条 assistant 记录
  // 都带 model（glm-4.7 / qwen-turbo / kimi-k2-thinking …），user 记录**没有**。
  // 模型自述不可信（会照抄历史里上一轮的答案），所以 UI 只认这个字段。
  it('落库时带上消息级 model —— 网关逐条返回，不落就重载即丢', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();
    const sessionKey = 'agent:main:clawwork:task:task-model-persist';

    taskStore.useTaskStore.setState({
      tasks: [
        {
          id: 'task-model-persist',
          sessionKey,
          sessionId: 'session-model-persist',
          title: 'Model persist',
          status: 'active',
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
          tags: [],
          artifactDir: 'tasks/task-model-persist',
          gatewayId: 'gw-1',
        },
      ],
      activeTaskId: 'task-model-persist',
      hydrated: true,
    });
    messageStore.useMessageStore.setState({
      messagesByTask: {
        'task-model-persist': [
          {
            id: 'u1',
            taskId: 'task-model-persist',
            role: 'user',
            content: '只回复：收到',
            artifacts: [],
            toolCalls: [],
            timestamp: '2026-03-16T10:00:00.000Z',
          },
        ],
      },
      // 实时回复走 agent 通道，activeTurn 上**没有** model（delta 帧不带）——
      // 落库的值只能来自网关历史，这条就是钉住它。
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    mockApi.chatHistory.mockResolvedValue({
      ok: true,
      result: {
        messages: [
          {
            role: 'user',
            timestamp: Date.parse('2026-03-16T10:00:00.000Z'),
            content: [{ type: 'text', text: '只回复：收到' }],
          },
          {
            role: 'assistant',
            timestamp: Date.parse('2026-03-16T10:00:01.000Z'),
            model: 'glm-4.7',
            content: [{ type: 'text', text: '收到' }],
          },
        ],
      },
    });

    await sessionSync.syncSessionMessages('task-model-persist');

    expect(mockApi.persistMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-model-persist',
        role: 'assistant',
        content: '收到',
        model: 'glm-4.7',
      }),
    );
  });

  it('⭐ 实时路径：流式刚结束就把 model 落到那条 UI 消息上 —— 不刷新、不重启也出徽章', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();
    const sessionKey = 'agent:main:clawwork:task:task-model-live';

    taskStore.useTaskStore.setState({
      tasks: [
        {
          id: 'task-model-live',
          sessionKey,
          sessionId: 'session-model-live',
          title: 'Model live',
          status: 'active',
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
          tags: [],
          artifactDir: 'tasks/task-model-live',
          gatewayId: 'gw-1',
        },
      ],
      activeTaskId: 'task-model-live',
      hydrated: true,
    });

    // 这一刻的真实状态：用户**正看着**这条回复刚流完 ——
    // activeTurn 还在内存里（有正文/thinking，但**没有** model：实时 delta 帧不带它），
    // 而网关那边已经记下了这一轮究竟是谁生成的。
    messageStore.useMessageStore.setState({
      messagesByTask: {
        'task-model-live': [
          {
            id: 'u1',
            taskId: 'task-model-live',
            role: 'user',
            content: '只回复：收到',
            artifacts: [],
            toolCalls: [],
            timestamp: '2026-03-16T10:00:00.000Z',
          },
        ],
      },
      activeTurnBySession: {
        [sessionKey]: {
          id: 'turn-live',
          streamingText: '',
          streamingThinking: '',
          toolCalls: [],
          finalized: true,
          content: '收到',
          timestamp: '2026-03-16T10:00:00.500Z',
        },
      },
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    mockApi.chatHistory.mockResolvedValue({
      ok: true,
      result: {
        messages: [
          {
            role: 'user',
            timestamp: Date.parse('2026-03-16T10:00:00.000Z'),
            content: [{ type: 'text', text: '只回复：收到' }],
          },
          {
            role: 'assistant',
            timestamp: Date.parse('2026-03-16T10:00:01.000Z'),
            model: 'glm-4.7',
            content: [{ type: 'text', text: '收到' }],
          },
        ],
      },
    });

    // `final` 帧之后 dispatcher 立刻调的就是这个（`gateway-dispatcher.ts` 的 state==='final' 分支）
    // —— 这是**唯一**的实时来源：不刷新页面、不重启客户端。
    await sessionSync.syncSessionMessages('task-model-live');

    const state = messageStore.useMessageStore.getState();
    const promoted = (state.messagesByTask['task-model-live'] ?? []).filter((m) => m.role === 'assistant');

    expect(promoted).toHaveLength(1);
    // ⭐ 这条断言就是"实时徽章"的全部依据：canonical 与内存里那一轮合并时，
    //    `mergeCanonicalMessageWithActiveTurn` **不能**把 model 吃掉
    //    （它 spread canonical，再由 thinking/toolCalls/runId 覆盖三个字段）。
    expect(promoted[0].model).toBe('glm-4.7');
    // 这一轮必须真的落地：还挂在流式里的话，UI 上按设计就是**不显示**徽章的。
    expect(state.activeTurnBySession[sessionKey]).toBeUndefined();
  });

  it('重载时把落库的 model 读回消息上 —— 否则重启后徽章全没了', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();

    taskStore.useTaskStore.setState({ tasks: [], activeTaskId: null, hydrated: false });
    messageStore.useMessageStore.setState({
      messagesByTask: {},
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    mockApi.loadTasks.mockResolvedValue({
      ok: true,
      rows: [
        {
          id: 'task-model-hydrate',
          sessionKey: 'agent:main:clawwork:task:task-model-hydrate',
          sessionId: 'session-model-hydrate',
          title: 'Model hydrate',
          status: 'active',
          model: null,
          modelProvider: null,
          thinkingLevel: null,
          inputTokens: null,
          outputTokens: null,
          contextTokens: null,
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
          tags: [],
          artifactDir: 'tasks/task-model-hydrate',
          gatewayId: 'gw-1',
        },
      ],
    });
    mockApi.loadMessages.mockResolvedValue({
      ok: true,
      rows: [
        {
          id: 'a-model',
          taskId: 'task-model-hydrate',
          role: 'assistant',
          content: '收到',
          timestamp: '2026-03-16T10:00:01.000Z',
          model: 'kimi-k2-thinking',
        },
      ],
    });

    await sessionSync.hydrateFromLocal();

    const msgs = messageStore.useMessageStore.getState().messagesByTask['task-model-hydrate'];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].model).toBe('kimi-k2-thinking');
  });

  it('同一会话里两条回复各带自己的 model —— 中途切模型不会串到前一条（导入路径）', async () => {
    const { sessionSync, taskStore, messageStore } = await loadModules();
    const sessionKey = 'agent:main:clawwork:task:task-model-import';

    taskStore.useTaskStore.setState({ tasks: [], activeTaskId: null, hydrated: true });
    messageStore.useMessageStore.setState({
      messagesByTask: {},
      activeTurnBySession: {},
      processingBySession: new Set(),
      highlightedMessageId: null,
    });

    mockApi.syncSessions.mockResolvedValue({
      ok: true,
      discovered: [
        {
          gatewayId: 'gw-1',
          taskId: 'task-model-import',
          sessionKey,
          title: 'Model import',
          updatedAt: '2026-03-16T10:00:02.000Z',
          agentId: 'main',
          messages: [
            { role: 'user', content: '第一个问题', timestamp: '2026-03-16T10:00:00.000Z' },
            { role: 'assistant', content: '回答一', timestamp: '2026-03-16T10:00:01.000Z', model: 'glm-4.7' },
            { role: 'user', content: '第二个问题', timestamp: '2026-03-16T10:00:00.500Z' },
            { role: 'assistant', content: '回答二', timestamp: '2026-03-16T10:00:02.000Z', model: 'qwen-turbo' },
          ],
        },
      ],
    });

    await sessionSync.syncFromGateway();

    const msgs = messageStore.useMessageStore.getState().messagesByTask['task-model-import'];
    const assistants = msgs.filter((m) => m.role === 'assistant');
    expect(assistants.map((m) => m.model)).toEqual(['glm-4.7', 'qwen-turbo']);
    expect(mockApi.persistMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '回答一', model: 'glm-4.7' }),
    );
    expect(mockApi.persistMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '回答二', model: 'qwen-turbo' }),
    );
  });
});
