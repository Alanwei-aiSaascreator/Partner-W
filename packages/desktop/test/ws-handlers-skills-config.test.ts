import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();

const installSkillMock = vi.fn();
const listModelsMock = vi.fn();
const updateSkillMock = vi.fn();
const getSkillBinsMock = vi.fn();
const getConfigMock = vi.fn();
const setConfigMock = vi.fn();
const patchConfigMock = vi.fn();
const getConfigSchemaMock = vi.fn();
const lookupConfigSchemaMock = vi.fn();
const getChatHistoryMock = vi.fn();
const listSessionsBySpawnerMock = vi.fn();
const sendChatMessageMock = vi.fn();
const abortChatMock = vi.fn();
const beginArtifactRunForGatewayDispatchMock = vi.fn();
const bindArtifactRunMock = vi.fn();
const cancelArtifactRunMock = vi.fn();
const cancelArtifactRunsForSessionMock = vi.fn();

const fakeGatewayClient = {
  isConnected: true,
  listModels: listModelsMock,
  httpBase: 'http://127.0.0.1:18789',
  installSkill: installSkillMock,
  updateSkill: updateSkillMock,
  getSkillBins: getSkillBinsMock,
  getConfig: getConfigMock,
  setConfig: setConfigMock,
  patchConfig: patchConfigMock,
  getConfigSchema: getConfigSchemaMock,
  lookupConfigSchema: lookupConfigSchemaMock,
  getChatHistory: getChatHistoryMock,
  listSessionsBySpawner: listSessionsBySpawnerMock,
  sendChatMessage: sendChatMessageMock,
  abortChat: abortChatMock,
};

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleMap.set(channel, handler);
    }),
  },
}));

vi.mock('../src/main/ws/index.js', () => ({
  getGatewayClient: vi.fn((id: string) => (id === 'gw-1' ? fakeGatewayClient : null)),
  getAllGatewayClients: vi.fn(() => new Map([['gw-1', fakeGatewayClient]])),
  reconnectGateway: vi.fn(),
}));

vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: vi.fn(() => null),
  ensureDeviceId: vi.fn(() => 'test-device'),
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: vi.fn(() => ({ emit: vi.fn(), info: vi.fn(), error: vi.fn() })),
}));

vi.mock('../src/main/ipc/data-handlers.js', () => ({
  beginArtifactRunForGatewayDispatch: beginArtifactRunForGatewayDispatchMock,
  bindArtifactRun: bindArtifactRunMock,
  cancelArtifactRun: cancelArtifactRunMock,
  cancelArtifactRunsForSession: cancelArtifactRunsForSessionMock,
}));

// ⚠️ **部分** mock（`importOriginal` 铺底）：整包替换会让"主进程代码新引用了某个
//    共享导出"变成这个文件里一句莫名其妙的 collect 报错（同 `sync-sessions-content`）。
vi.mock('@clawwork/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clawwork/shared')>()),
  isClawWorkSession: vi.fn(() => true),
  parseTaskIdFromSessionKey: vi.fn(() => 'task-1'),
  parseAgentIdFromSessionKey: vi.fn(() => 'main'),
}));

vi.mock('@clawwork/core', () => ({
  parseToolArgs: vi.fn(() => ({})),
}));

async function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handleMap.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return handler({}, payload);
}

/**
 * 埋点走真的 reporter 单例（同 context-handlers.test.ts 的写法）。
 * ⚠️ 必须在 `vi.resetModules()` **之后**（即用例里）动态 import：静态 import 拿到的是
 * 重置前那个注册表里的实例，和 handler 用的新 `active` 不是同一个。
 */
async function freshReporter() {
  const { createAnalyticsReporter, initAnalyticsReporterForTest } = await import('../src/main/analytics/reporter.js');
  const reporter = createAnalyticsReporter({
    storage: { read: () => null, write: () => {} },
    send: vi.fn(async () => ({ ok: true, inserted: 0 })),
  });
  initAnalyticsReporterForTest(reporter);
  return reporter;
}

describe('ws-handlers: skills + config IPC channels', () => {
  beforeEach(async () => {
    handleMap.clear();
    vi.clearAllMocks();
    getChatHistoryMock.mockReset();
    sendChatMessageMock.mockReset().mockResolvedValue(undefined);
    abortChatMock.mockReset().mockResolvedValue(undefined);
    beginArtifactRunForGatewayDispatchMock.mockReset().mockReturnValue('artifact-run-1');
    bindArtifactRunMock.mockReset();
    cancelArtifactRunMock.mockReset();
    cancelArtifactRunsForSessionMock.mockReset();
    fakeGatewayClient.isConnected = true;

    vi.resetModules();
    const { registerWsHandlers } = await import('../src/main/ipc/ws-handlers.js');
    registerWsHandlers();
  });

  it('forwards the explicitly selected catalog owner', async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    expect(await invoke('ws:models-list', { gatewayId: 'gw-1', agentId: 'office' })).toEqual({
      ok: true,
      result: { models: [] },
    });
    expect(listModelsMock).toHaveBeenCalledWith('office');
  });

  it('captures an artifact baseline before gateway dispatch', async () => {
    const result = await invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: 'create a file',
    });

    expect(result).toEqual({ ok: true });
    expect(beginArtifactRunForGatewayDispatchMock).toHaveBeenCalledWith({
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      taskId: 'task-1',
      userContent: 'create a file',
    });
    expect(beginArtifactRunForGatewayDispatchMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendChatMessageMock.mock.invocationCallOrder[0],
    );
    expect(cancelArtifactRunMock).not.toHaveBeenCalled();
  });

  it.each(['你是干啥的，怎么获客', '帮我生成一个 HTML 网页'])(
    'uses only the user request for delivery expectations: %s',
    async (userContent) => {
      const content =
        '<artifacts-index>\n报告.html (帮我做一个ppt)\n</artifacts-index>\n[artifact-delivery-failed] PPT 生成失败\n\n' +
        userContent;
      await invoke('ws:send-message', {
        gatewayId: 'gw-1',
        sessionKey: 'agent:main:clawwork:task-1',
        content,
        dispatchContext: { userContent },
      });
      expect(beginArtifactRunForGatewayDispatchMock).toHaveBeenCalledWith(expect.objectContaining({ userContent }));
      expect(sendChatMessageMock).toHaveBeenCalledWith('agent:main:clawwork:task-1', content, undefined);
    },
  );

  it('binds the trusted artifact run slot to the gateway run id', async () => {
    sendChatMessageMock.mockResolvedValueOnce({ runId: 'gateway-run-42' });

    const result = await invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: 'create a file',
    });

    expect(result).toEqual({
      ok: true,
      result: { sessionKey: 'agent:main:clawwork:task-1', runId: 'gateway-run-42' },
    });
    expect(bindArtifactRunMock).toHaveBeenCalledWith(
      'task-1',
      'agent:main:clawwork:task-1',
      'artifact-run-1',
      'gateway-run-42',
    );
  });

  it.each([undefined, null, {}, { runId: '' }, { runId: '  ' }, { runId: 42 }])(
    'omits the dispatch receipt when the gateway has no valid run id: %j',
    async (response) => {
      sendChatMessageMock.mockResolvedValueOnce(response);
      expect(
        await invoke('ws:send-message', {
          gatewayId: 'gw-1',
          sessionKey: 'agent:main:clawwork:task-1',
          content: 'hello',
        }),
      ).toEqual({ ok: true });
      expect(bindArtifactRunMock).not.toHaveBeenCalled();
    },
  );

  it('cancels only the matching artifact run when gateway dispatch fails', async () => {
    sendChatMessageMock.mockRejectedValueOnce(new Error('dispatch failed'));
    const result = await invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: 'create a file',
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, error: 'dispatch failed' }));
    expect(cancelArtifactRunMock).toHaveBeenCalledWith('task-1', 'agent:main:clawwork:task-1', 'artifact-run-1');
  });

  it('still dispatches when artifact baseline setup fails', async () => {
    beginArtifactRunForGatewayDispatchMock.mockImplementationOnce(() => {
      throw new Error('baseline unavailable');
    });

    const result = await invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: 'create a file',
    });

    expect(result).toEqual({ ok: true });
    expect(sendChatMessageMock).toHaveBeenCalledTimes(1);
  });

  it.each(['ws:abort-chat', 'ws:session-reset', 'ws:session-delete'])(
    '%s clears artifact runs for the session',
    async (channel) => {
      await invoke(channel, { gatewayId: 'gw-1', sessionKey: 'agent:main:clawwork:task-1' });
      expect(cancelArtifactRunsForSessionMock).toHaveBeenCalledWith('agent:main:clawwork:task-1');
    },
  );

  it.each([{ aborted: true }, { aborted: false }, {}])(
    'preserves the gateway abort receipt %j without inventing confirmation',
    async (receipt) => {
      abortChatMock.mockResolvedValueOnce(receipt);
      expect(await invoke('ws:abort-chat', { gatewayId: 'gw-1', sessionKey: 'agent:main:clawwork:task-1' })).toEqual({
        ok: true,
        result: receipt,
      });
      expect(abortChatMock).toHaveBeenCalledOnce();
      expect(abortChatMock).toHaveBeenCalledWith('agent:main:clawwork:task-1');
    },
  );

  it('preserves rejected abort errors without a success receipt', async () => {
    abortChatMock.mockRejectedValueOnce(new Error('abort failed'));
    expect(await invoke('ws:abort-chat', { gatewayId: 'gw-1', sessionKey: 'agent:main:clawwork:task-1' })).toEqual({
      ok: false,
      error: 'abort failed',
    });
  });

  it('★ 发送成功才记 chat_sent（首条同时记 first_chat_sent）', async () => {
    const reporter = await freshReporter();

    await invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: 'hi',
    });

    expect(reporter.peek().map((e) => e.event)).toEqual(['first_chat_sent', 'chat_sent']);
  });

  it('★ 失败路径一条都不记：网关没连上、派发抛错', async () => {
    const reporter = await freshReporter();

    fakeGatewayClient.isConnected = false;
    await invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: 'hi',
    });

    fakeGatewayClient.isConnected = true;
    sendChatMessageMock.mockRejectedValueOnce(new Error('dispatch failed'));
    await invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: 'hi',
    });

    expect(reporter.peek()).toEqual([]);
  });

  it('registers all expected channels', () => {
    const expected = [
      'ws:skills-install',
      'ws:skills-update',
      'ws:skills-bins',
      'ws:config-get',
      'ws:config-set',
      'ws:config-patch',
      'ws:config-schema',
      'ws:config-schema-lookup',
    ];
    for (const ch of expected) {
      expect(handleMap.has(ch), `missing handler for ${ch}`).toBe(true);
    }
  });

  describe('gateway error handling', () => {
    it('returns GATEWAY_NOT_CONNECTED when gateway is disconnected', async () => {
      fakeGatewayClient.isConnected = false;

      const result = await invoke('ws:skills-install', { gatewayId: 'gw-1', source: 'clawhub', slug: 'test' });

      expect(result).toEqual({ ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' });
      expect(installSkillMock).not.toHaveBeenCalled();
    });

    it('returns GATEWAY_NOT_CONNECTED when gateway id is unknown', async () => {
      const result = await invoke('ws:config-get', { gatewayId: 'nonexistent' });

      expect(result).toEqual({ ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' });
      expect(getConfigMock).not.toHaveBeenCalled();
    });

    it('surfaces gateway error code and details on RPC failure', async () => {
      const err = Object.assign(new Error('install failed'), {
        code: 'INSTALL_ERROR',
        details: { bin: 'npm', reason: 'not found' },
      });
      installSkillMock.mockRejectedValue(err);

      const result = await invoke('ws:skills-install', { gatewayId: 'gw-1', source: 'clawhub', slug: 'broken' });

      expect(result).toEqual({
        ok: false,
        error: 'install failed',
        errorCode: 'INSTALL_ERROR',
        errorDetails: { bin: 'npm', reason: 'not found' },
      });
    });
  });

  describe('ws:chat-history', () => {
    it('resolves only OpenClaw media paths against the gateway origin', async () => {
      getChatHistoryMock.mockResolvedValue({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'image', url: '/media/out.png', openUrl: '/api/chat/media/outgoing/open.png' },
              { type: 'image', url: '/Users/x/out.png', openUrl: '/tmp/open.png' },
              { type: 'image', url: '/__openclaw__/media/screenshot.png' },
            ],
          },
        ],
      });

      const response = (await invoke('ws:chat-history', {
        gatewayId: 'gw-1',
        sessionKey: 'agent:main:clawwork:task:t1',
      })) as { ok: boolean; result: { messages: { content: Record<string, unknown>[] }[] } };

      expect(response.ok).toBe(true);
      const content = response.result.messages[0].content;
      expect(content[0]).toMatchObject({
        url: 'http://127.0.0.1:18789/media/out.png',
        openUrl: 'http://127.0.0.1:18789/api/chat/media/outgoing/open.png',
      });
      expect(content[1]).toMatchObject({ url: '/Users/x/out.png', openUrl: '/tmp/open.png' });
      expect(content[2]).toMatchObject({ url: 'http://127.0.0.1:18789/__openclaw__/media/screenshot.png' });
    });
  });

  describe('ws:skills-install', () => {
    it('forwards clawhub install params without gatewayId', async () => {
      installSkillMock.mockResolvedValue({ ok: true, message: 'installed', stdout: '', stderr: '', code: 0 });

      const result = await invoke('ws:skills-install', {
        gatewayId: 'gw-1',
        source: 'clawhub',
        slug: 'web-search',
        version: '1.0.0',
      });

      const args = installSkillMock.mock.calls[0][0];
      expect(args).toEqual({ source: 'clawhub', slug: 'web-search', version: '1.0.0' });
      expect(args).not.toHaveProperty('gatewayId');
      expect(result).toEqual({
        ok: true,
        result: { ok: true, message: 'installed', stdout: '', stderr: '', code: 0 },
      });
    });

    it('forwards direct install params without gatewayId', async () => {
      installSkillMock.mockResolvedValue({ ok: true, message: 'done', stdout: '', stderr: '', code: 0 });

      await invoke('ws:skills-install', {
        gatewayId: 'gw-1',
        name: 'my-skill',
        installId: 'brew',
        timeoutMs: 30_000,
      });

      const args = installSkillMock.mock.calls[0][0];
      expect(args).toEqual({ name: 'my-skill', installId: 'brew', timeoutMs: 30_000 });
      expect(args).not.toHaveProperty('gatewayId');
    });

    it('forwards dangerouslyForceUnsafeInstall flag', async () => {
      installSkillMock.mockResolvedValue({ ok: true, message: 'forced', stdout: '', stderr: '', code: 0 });

      await invoke('ws:skills-install', {
        gatewayId: 'gw-1',
        name: 'risky-skill',
        installId: 'npm',
        dangerouslyForceUnsafeInstall: true,
      });

      expect(installSkillMock.mock.calls[0][0]).toMatchObject({ dangerouslyForceUnsafeInstall: true });
    });
  });

  describe('ws:skills-update', () => {
    it('forwards config update params without gatewayId', async () => {
      updateSkillMock.mockResolvedValue({ ok: true, skillKey: 'web-search', config: { enabled: true } });

      await invoke('ws:skills-update', {
        gatewayId: 'gw-1',
        skillKey: 'web-search',
        enabled: true,
        apiKey: 'sk-xxx',
        env: { NODE_ENV: 'production' },
      });

      const args = updateSkillMock.mock.calls[0][0];
      expect(args).toEqual({
        skillKey: 'web-search',
        enabled: true,
        apiKey: 'sk-xxx',
        env: { NODE_ENV: 'production' },
      });
      expect(args).not.toHaveProperty('gatewayId');
    });

    it('forwards clawhub update-all params without gatewayId', async () => {
      updateSkillMock.mockResolvedValue({ ok: true });

      await invoke('ws:skills-update', { gatewayId: 'gw-1', source: 'clawhub', all: true });

      const args = updateSkillMock.mock.calls[0][0];
      expect(args).toEqual({ source: 'clawhub', all: true });
      expect(args).not.toHaveProperty('gatewayId');
    });
  });

  describe('ws:skills-bins', () => {
    it('calls getSkillBins with no arguments', async () => {
      getSkillBinsMock.mockResolvedValue({ bins: ['node', 'python3', 'brew'] });

      const result = await invoke('ws:skills-bins', { gatewayId: 'gw-1' });

      expect(getSkillBinsMock).toHaveBeenCalledWith();
      expect(result).toEqual({ ok: true, result: { bins: ['node', 'python3', 'brew'] } });
    });
  });

  describe('ws:config-get', () => {
    it('calls getConfig with no arguments', async () => {
      const snapshot = { raw: '{}', hash: 'abc123', config: { model: 'claude' }, path: '/etc/openclaw.json5' };
      getConfigMock.mockResolvedValue(snapshot);

      const result = await invoke('ws:config-get', { gatewayId: 'gw-1' });

      expect(getConfigMock).toHaveBeenCalledWith();
      expect(result).toEqual({ ok: true, result: snapshot });
    });
  });

  describe('ws:config-set', () => {
    it('passes raw and baseHash without gatewayId', async () => {
      setConfigMock.mockResolvedValue({ ok: true, path: '/etc/openclaw.json5', config: {} });

      await invoke('ws:config-set', {
        gatewayId: 'gw-1',
        raw: '{ model: "claude" }',
        baseHash: 'abc123',
      });

      const args = setConfigMock.mock.calls[0][0];
      expect(args).toEqual({ raw: '{ model: "claude" }', baseHash: 'abc123' });
      expect(args).not.toHaveProperty('gatewayId');
    });

    it('passes undefined baseHash when omitted', async () => {
      setConfigMock.mockResolvedValue({ ok: true, path: '/etc/openclaw.json5', config: {} });

      await invoke('ws:config-set', { gatewayId: 'gw-1', raw: '{}' });

      expect(setConfigMock.mock.calls[0][0]).toEqual({ raw: '{}', baseHash: undefined });
    });
  });

  describe('ws:config-patch', () => {
    it('passes all fields explicitly without gatewayId', async () => {
      patchConfigMock.mockResolvedValue({ ok: true, noop: false, path: '/etc/openclaw.json5', config: {} });

      await invoke('ws:config-patch', {
        gatewayId: 'gw-1',
        raw: '{ model: "claude" }',
        baseHash: 'abc123',
        sessionKey: 'agent:main:clawwork:task:t1',
        note: 'enable skill',
        restartDelayMs: 2000,
      });

      const args = patchConfigMock.mock.calls[0][0];
      expect(args).toEqual({
        raw: '{ model: "claude" }',
        baseHash: 'abc123',
        sessionKey: 'agent:main:clawwork:task:t1',
        note: 'enable skill',
        restartDelayMs: 2000,
      });
      expect(args).not.toHaveProperty('gatewayId');
    });

    it('passes undefined for omitted optional fields', async () => {
      patchConfigMock.mockResolvedValue({ ok: true, noop: true, path: '/etc/openclaw.json5', config: {} });

      await invoke('ws:config-patch', { gatewayId: 'gw-1', raw: '{}' });

      expect(patchConfigMock.mock.calls[0][0]).toEqual({
        raw: '{}',
        baseHash: undefined,
        sessionKey: undefined,
        note: undefined,
        restartDelayMs: undefined,
      });
    });
  });

  describe('ws:config-schema', () => {
    it('calls getConfigSchema with no arguments', async () => {
      const schema = { schema: { type: 'object' }, uiHints: {}, version: '1.0', generatedAt: '2026-04-02' };
      getConfigSchemaMock.mockResolvedValue(schema);

      const result = await invoke('ws:config-schema', { gatewayId: 'gw-1' });

      expect(getConfigSchemaMock).toHaveBeenCalledWith();
      expect(result).toEqual({ ok: true, result: schema });
    });
  });

  describe('ws:config-schema-lookup', () => {
    it('passes path to lookupConfigSchema without gatewayId', async () => {
      const lookupResult = {
        path: 'model',
        schema: { type: 'string' },
        hint: { widget: 'select' },
        children: [],
      };
      lookupConfigSchemaMock.mockResolvedValue(lookupResult);

      const result = await invoke('ws:config-schema-lookup', { gatewayId: 'gw-1', path: 'model' });

      expect(lookupConfigSchemaMock).toHaveBeenCalledWith('model');
      expect(result).toEqual({ ok: true, result: lookupResult });
    });
  });

  describe('ws:list-sessions-by-spawner', () => {
    it('rejects missing spawnedBy before contacting the gateway', async () => {
      const result = await invoke('ws:list-sessions-by-spawner', { gatewayId: 'gw-1', spawnedBy: '' });

      expect(result).toEqual({ ok: false, error: 'invalid spawnedBy parameter' });
      expect(listSessionsBySpawnerMock).not.toHaveBeenCalled();
    });

    it('rejects non-string spawnedBy before contacting the gateway', async () => {
      const result = await invoke('ws:list-sessions-by-spawner', {
        gatewayId: 'gw-1',
        spawnedBy: 123 as unknown as string,
      });

      expect(result).toEqual({ ok: false, error: 'invalid spawnedBy parameter' });
      expect(listSessionsBySpawnerMock).not.toHaveBeenCalled();
    });

    it('forwards valid spawnedBy to listSessionsBySpawner', async () => {
      listSessionsBySpawnerMock.mockResolvedValue({ sessions: [] });

      const result = await invoke('ws:list-sessions-by-spawner', {
        gatewayId: 'gw-1',
        spawnedBy: 'agent:main:clawwork:task:task-1',
      });

      expect(listSessionsBySpawnerMock).toHaveBeenCalledWith('agent:main:clawwork:task:task-1');
      expect(result).toEqual({ ok: true, result: { sessions: [] } });
    });
  });
});
