import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConfigMutationTx } from '../src/main/ws/gateway-client.js';

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
const resetSessionMock = vi.fn();
const deleteSessionMock = vi.fn();
const beginArtifactRunForGatewayDispatchMock = vi.fn();
const isArtifactTurnInFlightMock = vi.fn(() => false);
const isArtifactRunPendingCurrentMock = vi.fn();
const bindArtifactRunMock = vi.fn();
const cancelArtifactRunMock = vi.fn();
const cancelArtifactRunsForSessionMock = vi.fn();
// V3-artifact（2026-10-14 五小时窗）：停止事件的 run 归属查询 —— 显式命名以便逐例
// 设定/复位（默认"无绑定轮次"⇒ 不带归属；专测在清理 run 记录前取到的用例自设 runId）。
const currentGatewayRunIdForSessionMock = vi.fn<() => string | undefined>(() => undefined);
const createAgentMock = vi.fn();
const workflowRuntime = vi.hoisted(() => ({ owned: true, supplied: true }));
const nativeBudgetGuardMock = vi.fn();
vi.mock('../src/main/docgen/native-dispatch-guard.js', () => ({
  requireNativeTestBudget: nativeBudgetGuardMock,
}));
vi.mock('../src/main/runtime/index.js', () => ({
  captureOwnedLocalGatewayRuntime: () =>
    workflowRuntime.owned ? { deployedRoot: 'owned-runtime', current: () => workflowRuntime.owned } : null,
}));
vi.mock('../src/main/runtime/workflow-tools.js', async (original) => ({
  ...(await original<typeof import('../src/main/runtime/workflow-tools.js')>()),
  hasBundledWorkflowTool: () => workflowRuntime.supplied,
}));

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
  resetSession: resetSessionMock,
  deleteSession: deleteSessionMock,
  createAgent: createAgentMock,
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
  getGatewayClient: vi.fn((id: string) => (['gw-1', 'local-runtime'].includes(id) ? fakeGatewayClient : null)),
  getAllGatewayClients: vi.fn(() => new Map([['gw-1', fakeGatewayClient]])),
  reconnectGateway: vi.fn(),
}));

vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: vi.fn(() => null),
  ensureDeviceId: vi.fn(() => 'test-device'),
}));

vi.mock('../src/main/debug/index.js', () => ({
  // ⚠️ `warn`/`debug` 不能省：turn-lifecycle 的释放路径用它记诊断（B1 复审二轮用例会走到）。
  getDebugLogger: vi.fn(() => ({
    emit: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../src/main/ipc/data-handlers.js', () => ({
  beginArtifactRunForGatewayDispatch: beginArtifactRunForGatewayDispatchMock,
  isArtifactRunPendingCurrent: isArtifactRunPendingCurrentMock,
  // DOCX-205 合同 B（2026-10-10）：普通发送单飞门 —— 本文件默认"没有在飞的轮次"，
  // 专测该门的用例自行 `mockReturnValueOnce(true)`。
  isArtifactTurnInFlight: isArtifactTurnInFlightMock,
  bindArtifactRun: bindArtifactRunMock,
  cancelArtifactRun: cancelArtifactRunMock,
  cancelArtifactRunsForSession: cancelArtifactRunsForSessionMock,
  // V3-artifact（2026-10-14）：停止事件的 run 归属查询（本文件默认"无绑定轮次"⇒ 不带归属）。
  currentGatewayRunIdForSession: currentGatewayRunIdForSessionMock,
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

function simulatePendingRuns(): void {
  let current: string | null = null;
  let sequence = 0;
  beginArtifactRunForGatewayDispatchMock.mockImplementation(() => (current = `pending-run-${++sequence}`));
  isArtifactRunPendingCurrentMock.mockImplementation((_taskId, _sessionKey, token) => current === token);
  cancelArtifactRunMock.mockImplementation((_taskId, _sessionKey, token) => {
    if (current === token) current = null;
  });
  cancelArtifactRunsForSessionMock.mockImplementation(() => {
    current = null;
  });
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
  it('wires the exact owned newly created system agent to the existing transaction and configured ACK', async () => {
    const config = {
      plugins: { entries: { lobster: { enabled: true } } },
      agents: { entries: { 'partner-w-office': { workspace: 'owned' } } },
    };
    getConfigMock.mockResolvedValue({ hash: 'revision', config });
    patchConfigMock.mockImplementation(async ({ raw }) => {
      Object.assign(config.agents.entries['partner-w-office'], JSON.parse(raw).agents.entries['partner-w-office']);
      return { ok: true };
    });
    createAgentMock.mockImplementation(
      async (
        params,
        options?: {
          afterCreated: (id: string, tx: GatewayConfigMutationTx, current: () => boolean) => Promise<boolean>;
        },
      ) => ({
        agentId: params.name,
        workflowToolConfigured: await options?.afterCreated(
          params.name,
          { getConfig: getConfigMock, patchConfig: patchConfigMock, setConfig: setConfigMock },
          () => true,
        ),
      }),
    );
    expect(
      await invoke('ws:agents-create', { gatewayId: 'local-runtime', name: 'partner-w-office', workspace: 'owned' }),
    ).toMatchObject({ ok: true, result: { agentId: 'partner-w-office', workflowToolConfigured: true } });
    expect(patchConfigMock).toHaveBeenCalledTimes(1);
  });
  it.each(['foreign', 'custom', 'reused', 'unsupplied'])(
    'does not supply a workflow hook for %s creation',
    async (mode) => {
      workflowRuntime.owned = mode !== 'reused';
      workflowRuntime.supplied = mode !== 'unsupplied';
      const name = mode === 'custom' ? 'custom' : 'partner-w-office';
      await invoke('ws:agents-create', {
        gatewayId: mode === 'foreign' ? 'gw-1' : 'local-runtime',
        name,
        workspace: 'owned',
      });
      expect(createAgentMock).toHaveBeenCalledWith({ name, workspace: 'owned', emoji: undefined, avatar: undefined });
    },
  );
  beforeEach(async () => {
    vi.unstubAllEnvs();
    handleMap.clear();
    vi.clearAllMocks();
    getChatHistoryMock.mockReset();
    sendChatMessageMock.mockReset().mockResolvedValue(undefined);
    abortChatMock.mockReset().mockResolvedValue(undefined);
    resetSessionMock.mockReset().mockResolvedValue({ ok: true });
    deleteSessionMock.mockReset().mockResolvedValue({ ok: true });
    beginArtifactRunForGatewayDispatchMock.mockReset().mockReturnValue('artifact-run-1');
    isArtifactRunPendingCurrentMock.mockReset().mockReturnValue(true);
    nativeBudgetGuardMock.mockReset().mockResolvedValue({ guardVersion: 'ppt-budget-v1' });
    bindArtifactRunMock.mockReset();
    cancelArtifactRunMock.mockReset();
    cancelArtifactRunsForSessionMock.mockReset();
    currentGatewayRunIdForSessionMock.mockReset().mockReturnValue(undefined);
    isArtifactTurnInFlightMock.mockReset().mockReturnValue(false);
    fakeGatewayClient.isConnected = true;
    workflowRuntime.owned = workflowRuntime.supplied = true;
    createAgentMock.mockReset().mockImplementation(async (params) => ({ agentId: params.name }));

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

  it('blocks a plain resend with a named turn-in-flight error while a turn is running', async () => {
    // ⚠️ DOCX-205 合同（2026-10-10）B 块：单飞门的第二道（API 级）。渲染层键盘/按钮路径
    //    由 useChatSend 的会话活动判据先拦；这道门兜任何不经渲染门的新请求。
    isArtifactTurnInFlightMock.mockReturnValueOnce(true);
    const result = await invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: '再发一份 Word',
    });
    expect(result).toEqual({ ok: false, error: '上一项仍在处理，请完成后再发送。', errorCode: 'TURN_IN_FLIGHT' });
    expect(sendChatMessageMock).not.toHaveBeenCalled();
    expect(beginArtifactRunForGatewayDispatchMock).not.toHaveBeenCalled();
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

  it.each(['native-task-state-unavailable', 'SQLITE_BUSY'])(
    'does not dispatch a controlled paid request when managed state cannot start: %s',
    async (message) => {
      vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
      try {
        beginArtifactRunForGatewayDispatchMock.mockImplementationOnce(() => {
          throw new Error(message);
        });
        const result = await invoke('ws:send-message', {
          gatewayId: 'gw-1',
          sessionKey: 'agent:main:clawwork:task-1',
          content: '做一份PPT',
        });
        expect(result).toEqual(expect.objectContaining({ ok: false, errorCode: 'NATIVE_TASK_STATE_UNAVAILABLE' }));
        expect(sendChatMessageMock).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('does not dispatch after a user stops while the controlled budget guard is pending', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    simulatePendingRuns();
    let release!: () => void;
    nativeBudgetGuardMock.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
    const pending = invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: '做一份PPT',
    });
    await vi.waitFor(() => expect(nativeBudgetGuardMock).toHaveBeenCalledOnce());
    await invoke('ws:abort-chat', { gatewayId: 'gw-1', sessionKey: 'agent:main:clawwork:task-1' });
    release();
    expect(await pending).toEqual(expect.objectContaining({ ok: false, errorCode: 'NATIVE_TASK_CANCELED' }));
    expect(sendChatMessageMock).not.toHaveBeenCalled();
    expect(bindArtifactRunMock).not.toHaveBeenCalled();
  });

  it('does not revive an older controlled dispatch after a newer dispatch passes its budget guard', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    simulatePendingRuns();
    let release!: () => void;
    nativeBudgetGuardMock.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
    const older = invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: '旧PPT请求',
    });
    await vi.waitFor(() => expect(nativeBudgetGuardMock).toHaveBeenCalledOnce());
    const newer = await invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: '新PPT请求',
    });
    expect(newer).toEqual(expect.objectContaining({ ok: true }));
    release();
    expect(await older).toEqual(expect.objectContaining({ ok: false, errorCode: 'NATIVE_TASK_CANCELED' }));
    expect(sendChatMessageMock).toHaveBeenCalledExactlyOnceWith('agent:main:clawwork:task-1', '新PPT请求', undefined);
  });

  it('rejects a controlled dispatch with no managed token before checking budget or sending', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    beginArtifactRunForGatewayDispatchMock.mockReturnValueOnce(null);
    const result = await invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: '做一份PPT',
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, errorCode: 'NATIVE_TASK_STATE_UNAVAILABLE' }));
    expect(nativeBudgetGuardMock).not.toHaveBeenCalled();
    expect(sendChatMessageMock).not.toHaveBeenCalled();
  });

  it('cancels the pending controlled token when budget verification fails', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    nativeBudgetGuardMock.mockRejectedValueOnce(Error('budget-unavailable'));
    const result = await invoke('ws:send-message', {
      gatewayId: 'gw-1',
      sessionKey: 'agent:main:clawwork:task-1',
      content: '做一份PPT',
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, errorCode: 'NATIVE_TEST_GUARD_UNAVAILABLE' }));
    expect(cancelArtifactRunMock).toHaveBeenCalledWith('task-1', 'agent:main:clawwork:task-1', 'artifact-run-1');
    expect(sendChatMessageMock).not.toHaveBeenCalled();
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

  // ⭐ B1（2026-10-11 复审二轮）：停止 = 本地先取消 run，但"远端已停"只能由**确认的
  //    生命周期证据**落地 —— 真实 turn-lifecycle 模块（本文件不 mock 它）作为观察点。
  it('⭐ B1：abort 失败不假称已结束 —— 未确认停止保留，重连补发拿到应答才落地', async () => {
    const turnLifecycle = await import('../src/main/artifact/turn-lifecycle.js');
    const sessionKey = 'agent:main:clawwork:task-1';
    turnLifecycle.resetTurnLifecycleForTests();
    turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1');
    expect(turnLifecycle.hasLiveTurnSessions()).toBe(true);

    // abort RPC 失败：软状态保留（复审原话：失败的 abort 不能凭本地删除记录宣称远端已停）。
    abortChatMock.mockRejectedValueOnce(new Error('abort failed'));
    await invoke('ws:abort-chat', { gatewayId: 'gw-1', sessionKey });
    expect(turnLifecycle.hasLiveTurnSessions(), '失败不许假称已结束').toBe(true);

    // 恢复出口：重连后补发 abort，网关应答（aborted:false = 本来就没有在跑）⇒ 确认 ⇒ 落地。
    await turnLifecycle.retryPendingGatewayTurnStops('gw-1', async () => ({ aborted: false }));
    expect(turnLifecycle.hasLiveTurnSessions(), '网关应答 = 确认 ⇒ 落地').toBe(false);
    turnLifecycle.resetTurnLifecycleForTests();
  });

  it('⭐ B1：abort 应答成功 ⇒ 确认停止（软状态立即落地，不留永久判忙）', async () => {
    const turnLifecycle = await import('../src/main/artifact/turn-lifecycle.js');
    const sessionKey = 'agent:main:clawwork:task-1';
    turnLifecycle.resetTurnLifecycleForTests();
    turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1');

    abortChatMock.mockResolvedValueOnce({ aborted: true });
    expect(await invoke('ws:abort-chat', { gatewayId: 'gw-1', sessionKey })).toEqual({
      ok: true,
      result: { aborted: true },
    });
    expect(turnLifecycle.hasLiveTurnSessions(), '网关已处理 abort ⇒ 确认的终态证据').toBe(false);
    turnLifecycle.resetTurnLifecycleForTests();
  });

  // ⭐ V3-artifact（2026-10-14 五小时窗 · 复审指令"WS 真 run 上下文的窄测试"）：
  //    ws:abort-chat 必须在 cancelArtifactRunsForSession **之前**取本轮 runId，并把它
  //    带进停止事件上下文 —— 否则取消事件缺 run 归属（fail-closed 不发，投影永远看不到
  //    "已在请求停止"）。两半：①有 runId ⇒ 请求/确认两帧都带同一 run；②取不到 ⇒ 一发不发。
  it('⭐ V3-artifact：停止在清理 run 记录之前取 runId，取消事件带真实 run 归属（取不到则 fail-closed 不发）', async () => {
    const turnLifecycle = await import('../src/main/artifact/turn-lifecycle.js');
    const { BrowserWindow } = await import('electron');
    const send = vi.fn();
    const getAllWindows = vi.mocked(BrowserWindow.getAllWindows);
    getAllWindows.mockReturnValue([{ webContents: { isDestroyed: () => false, send } }] as never);
    try {
      const sessionKey = 'agent:main:clawwork:task-1';
      const order: string[] = [];
      currentGatewayRunIdForSessionMock.mockImplementation(() => {
        order.push('read-run');
        return 'run-live-42';
      });
      cancelArtifactRunsForSessionMock.mockImplementation(() => {
        order.push('cancel-runs');
      });
      // ⭐ P-3（2026-10-14）：合法 workspace 上下文 —— 取消帧载荷带捕获时 scope/revision，
      //    无 scope 的帧在发射侧 fail-closed 拒发。本用例钉的是 **runId 归属**，显式建 scope
      //    让"取不到 runId ⇒ 一发不发"的负对照仍然只由 runId 决定（不因缺 scope 假绿）。
      const { setWorkspaceDatabaseOwner } = await import('../src/main/workspace/scope.js');
      setWorkspaceDatabaseOwner({});
      turnLifecycle.resetTurnLifecycleForTests();
      turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1');

      abortChatMock.mockResolvedValueOnce({ aborted: true });
      expect(await invoke('ws:abort-chat', { gatewayId: 'gw-1', sessionKey })).toEqual({
        ok: true,
        result: { aborted: true },
      });

      // ①顺序：先读 runId、再清 run 记录（读在清之后 ⇒ 永远拿不到身份）。
      expect(order).toEqual(['read-run', 'cancel-runs']);
      // ②身份：请求帧与确认帧都带同一真实 run（task 由 sessionKey 解析）。
      const payloads = send.mock.calls
        .filter(([channel]) => channel === 'artifact:execution-events')
        .map(([, payload]) => payload as { sessionKey: string; events: Array<Record<string, unknown>> });
      const events = payloads.flatMap((entry) => entry.events);
      expect(events.map((event) => event.type)).toEqual(['cancel.requested', 'cancel.confirmed']);
      for (const event of events) {
        expect(event.runId).toBe('run-live-42');
        expect(event.taskId).toBe('task-1');
      }

      // ③负对照：取不到 runId ⇒ 不发任何取消事件（不猜归属、不折到错误 run）。
      send.mockClear();
      currentGatewayRunIdForSessionMock.mockImplementation(() => undefined);
      turnLifecycle.resetTurnLifecycleForTests();
      turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1');
      abortChatMock.mockResolvedValueOnce({ aborted: true });
      expect(await invoke('ws:abort-chat', { gatewayId: 'gw-1', sessionKey })).toEqual({
        ok: true,
        result: { aborted: true },
      });
      expect(send, '无 run 归属 ⇒ 一发不发（fail-closed）').not.toHaveBeenCalled();
      turnLifecycle.resetTurnLifecycleForTests();
    } finally {
      getAllWindows.mockReturnValue([] as never);
    }
  });

  // ⭐ R6 同族（2026-10-14）：session-reset / session-delete 两个停止入口同款 ——
  //    也在 cancelArtifactRunsForSession 之前取 runId（R6 复核点名的"其余停止入口可见性"）。
  it('⭐ R6 同族：session-reset 在清 run 记录前取 runId，取消帧带真实 run 归属', async () => {
    const turnLifecycle = await import('../src/main/artifact/turn-lifecycle.js');
    const { BrowserWindow } = await import('electron');
    const send = vi.fn();
    const getAllWindows = vi.mocked(BrowserWindow.getAllWindows);
    getAllWindows.mockReturnValue([{ webContents: { isDestroyed: () => false, send } }] as never);
    try {
      const { setWorkspaceDatabaseOwner } = await import('../src/main/workspace/scope.js');
      setWorkspaceDatabaseOwner({});
      const sessionKey = 'agent:main:clawwork:task-1';
      const order: string[] = [];
      currentGatewayRunIdForSessionMock.mockImplementation(() => {
        order.push('read-run');
        return 'run-reset-7';
      });
      cancelArtifactRunsForSessionMock.mockImplementation(() => {
        order.push('cancel-runs');
      });
      turnLifecycle.resetTurnLifecycleForTests();
      turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1');

      resetSessionMock.mockResolvedValueOnce({ ok: true });
      expect(await invoke('ws:session-reset', { gatewayId: 'gw-1', sessionKey })).toEqual({ ok: true });

      expect(order).toEqual(['read-run', 'cancel-runs']);
      const events = send.mock.calls
        .filter(([channel]) => channel === 'artifact:execution-events')
        .flatMap(([, payload]) => (payload as { events: Array<Record<string, unknown>> }).events);
      expect(events.map((event) => event.type)).toEqual(['cancel.requested', 'cancel.confirmed']);
      expect(events.every((event) => event.runId === 'run-reset-7')).toBe(true);
      turnLifecycle.resetTurnLifecycleForTests();
    } finally {
      getAllWindows.mockReturnValue([] as never);
    }
  });

  it('⭐ B1：网关未连接时的停止同样保留未确认状态（不凭本地取消清软状态）', async () => {
    const turnLifecycle = await import('../src/main/artifact/turn-lifecycle.js');
    const sessionKey = 'agent:main:clawwork:task-1';
    turnLifecycle.resetTurnLifecycleForTests();
    turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1');

    fakeGatewayClient.isConnected = false;
    expect(await invoke('ws:abort-chat', { gatewayId: 'gw-1', sessionKey })).toEqual({
      ok: false,
      error: 'gateway not connected',
    });
    expect(turnLifecycle.hasLiveTurnSessions(), '未送达网关：软状态保留（可核对）').toBe(true);
    turnLifecycle.resetTurnLifecycleForTests();
  });

  // ⭐ B1 复审三轮（2026-10-11）：停止回执必须绑定**具体操作**（ticket 身份）——
  //    真实 IPC 回调 + 真实 turn-lifecycle 模块串接（本文件不 mock 生命周期模块）。
  it('⭐ B1 复审三轮：A 的迟到 abort 回执不许清掉 B 的忙态（B 也已停止，回执在途）', async () => {
    const turnLifecycle = await import('../src/main/artifact/turn-lifecycle.js');
    const sessionKey = 'agent:main:clawwork:task-1';
    turnLifecycle.resetTurnLifecycleForTests();
    turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1'); // A 轮

    // A 的 abort 在途（回执挂住）。
    let resolveA!: (value: unknown) => void;
    abortChatMock.mockReturnValueOnce(new Promise((resolve) => (resolveA = resolve)));
    const requestA = invoke('ws:abort-chat', { gatewayId: 'gw-1', sessionKey });

    // A 的真实终态先到；B 开始，用户也停止 B（B 的回执同样在途）。
    turnLifecycle.noteGatewayTurnLifecycle('end', sessionKey, 'gw-1');
    turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1');
    let resolveB!: (value: unknown) => void;
    abortChatMock.mockReturnValueOnce(new Promise((resolve) => (resolveB = resolve)));
    const requestB = invoke('ws:abort-chat', { gatewayId: 'gw-1', sessionKey });

    // A 的迟到回执返回：只许结算 A 自己的那次停止。
    resolveA({ aborted: true });
    expect(await requestA).toEqual({ ok: true, result: { aborted: true } });
    expect(turnLifecycle.hasLiveTurnSessions(), 'A 的迟到回执不许清掉 B 的忙态').toBe(true);

    // B 自己的回执返回 ⇒ B 落地。
    resolveB({ aborted: true });
    expect(await requestB).toEqual({ ok: true, result: { aborted: true } });
    expect(turnLifecycle.hasLiveTurnSessions(), 'B 自己的回执 = 确认 ⇒ 落地').toBe(false);
    turnLifecycle.resetTurnLifecycleForTests();
  });

  it.each(['ws:session-reset', 'ws:session-delete'])(
    '⭐ B1 复审三轮：%s 失败不许给 await 期间新开的轮留下停止记录（catch 不重捕当前轮）',
    async (channel) => {
      const turnLifecycle = await import('../src/main/artifact/turn-lifecycle.js');
      const sessionKey = 'agent:main:clawwork:task-1';
      const sessionOp = channel === 'ws:session-reset' ? resetSessionMock : deleteSessionMock;
      turnLifecycle.resetTurnLifecycleForTests();
      turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1'); // A 轮

      // 会话操作在途（挂住）。
      let rejectOp!: (error: Error) => void;
      sessionOp.mockReturnValueOnce(new Promise((_resolve, reject) => (rejectOp = reject)));
      const request = invoke(channel, { gatewayId: 'gw-1', sessionKey });

      // 在途期间：A 结束、B 开始（B 从未被停止）。
      turnLifecycle.noteGatewayTurnLifecycle('end', sessionKey, 'gw-1');
      turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1');
      rejectOp(new Error('session op failed'));
      expect(await request).toEqual({ ok: false, error: 'session op failed' });

      // B 是这次失败操作之后新开的一轮：不许被标成"未确认停止"
      // （否则重连补发会拿旧操作的回执确认/清掉 B）。
      let abortCalls = 0;
      await turnLifecycle.retryPendingGatewayTurnStops('gw-1', async () => {
        abortCalls += 1;
        return { aborted: false };
      });
      expect(abortCalls, '失败的会话操作不许给后来新开的一轮留下停止记录').toBe(0);
      expect(turnLifecycle.isLiveTurnSession(sessionKey), 'B 是未被停止的新轮：必须保留').toBe(true);
      turnLifecycle.resetTurnLifecycleForTests();
    },
  );

  it.each(['ws:session-reset', 'ws:session-delete'])(
    '⭐ B1 复审三轮：%s 成功 = 真实 RPC 合同的确认，且只消费捕获的那一轮',
    async (channel) => {
      const turnLifecycle = await import('../src/main/artifact/turn-lifecycle.js');
      const sessionKey = 'agent:main:clawwork:task-1';
      const sessionOp = channel === 'ws:session-reset' ? resetSessionMock : deleteSessionMock;
      turnLifecycle.resetTurnLifecycleForTests();

      // 情形一：成功且同轮未变 ⇒ 网关受理 = 确认（软状态落地）。
      turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1');
      sessionOp.mockResolvedValueOnce({ ok: true });
      expect(await invoke(channel, { gatewayId: 'gw-1', sessionKey })).toEqual({ ok: true });
      expect(turnLifecycle.hasLiveTurnSessions(), '网关受理 = 确认的生命周期证据 ⇒ 落地').toBe(false);

      // 情形二：成功回执迟到 —— 在途期间 A 结束、B 新开 ⇒ 不许消费 B。
      turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1'); // 新的 A'
      let resolveOp!: (value: unknown) => void;
      sessionOp.mockReturnValueOnce(new Promise((resolve) => (resolveOp = resolve)));
      const request = invoke(channel, { gatewayId: 'gw-1', sessionKey });
      turnLifecycle.noteGatewayTurnLifecycle('end', sessionKey, 'gw-1');
      turnLifecycle.noteGatewayTurnLifecycle('start', sessionKey, 'gw-1'); // B'
      resolveOp({ ok: true });
      expect(await request).toEqual({ ok: true });
      expect(turnLifecycle.isLiveTurnSession(sessionKey), '迟到的成功回执不许消费之后新开的一轮').toBe(true);
      turnLifecycle.resetTurnLifecycleForTests();
    },
  );

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
