import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSessionKey } from '@clawwork/shared';
import type { IpcResult, Message, MessageAttachment } from '@clawwork/shared';
import { createChatComposer } from '../src/services/chat-composer';
import type { ChatComposerDeps } from '../src/services/chat-composer';
import type { AppliedPermissionRecord, ComputerAccessTier } from '../src/services/computer-access.js';
import type { ChatAttachment } from '../src/ports/gateway-transport.js';
import { translateGatewayError } from '../src/services/gateway-error-message.js';
import { UnknownAgentError } from '../src/stores/task-store.js';

const TASK_ID = 'abc';
const SESSION_KEY = buildSessionKey(TASK_ID);
const SEND_TIMEOUT_MS = 30_000;

type AddMessageOptions = { persist?: boolean; sessionKey?: string };

/**
 * `getSupportedThinkingLevels` 的可注入桩。
 * `undefined` = 「还不知道」（目录没加载完）—— 必须与「空数组」区分开。
 */
let supportedLevels: string[] | undefined = undefined;

/**
 * `resolveAgentName` 的可注入桩（宿主按目录查名字）。`undefined` = **没注入**（老宿主）。
 * 这里刻意做成模块级变量而不是 setup 参数：测的是"同一个 composer 在不同目录状态下
 * 写出什么"，与档位那一组同一个形状。
 */
let mentionNameResolver: ((agentId: string) => string | undefined) | undefined;

function setup(
  options: {
    ensemble?: boolean;
    teamId?: string;
    model?: string;
    performers?: Array<{ agentId: string; agentName: string; sessionKey: string }>;
    /** 模拟"宿主没接这个 dep"（字段真的不存在，不是"存在但返回 undefined"）。 */
    withoutNameResolver?: boolean;
    /** 让 `commitPendingTask` 抛出这个错误（模拟"点名要的助手不在本机"这类拒绝）。 */
    pendingTaskRejection?: unknown;
    /**
     * 「电脑操控权限」两档的宿主桩。
     * ⚠️ **不传 = dep 字段真的不存在**（= 老宿主 / 没开这个功能），
     *    与"传了但档位是 safe"必须走同一条行为路径 —— 有测试按这个钉。
     */
    computerAccess?: { tier: ComputerAccessTier; applied: Map<string, AppliedPermissionRecord> };
  } = {},
) {
  const addMessage = vi.fn(
    (
      _taskId: string,
      _role: 'user' | 'system',
      _content: string,
      _attachments?: MessageAttachment[],
      _options?: AddMessageOptions,
    ): Message => ({
      id: 'm1',
      taskId: TASK_ID,
      role: 'user',
      content: '',
      artifacts: [],
      toolCalls: [],
      timestamp: '',
    }),
  );

  // ⚠️ 参数类型必须写出来：不写的话 `mock.calls` 是长度 0 的元组，
  //    `calls[i][2]` 直接编不过（tsc 报 TS2493）—— 而"发出去的正文"正是要读的载荷。
  const sendMessage = vi.fn(
    async (
      _gatewayId: string,
      _sessionKey: string,
      _content: string,
      _attachments?: ChatAttachment[],
      _dispatchContext?: { userContent: string },
    ): Promise<IpcResult> => ({ ok: true }),
  );
  const removeMessage = vi.fn();
  const abortChat = vi.fn().mockResolvedValue({ ok: true });
  const patchSession = vi.fn().mockResolvedValue({ ok: true });
  const compactSession = vi.fn().mockResolvedValue({ ok: true });
  const resetSession = vi.fn().mockResolvedValue({ ok: true });
  const updateTaskMetadata = vi.fn();
  const persistMessage = vi.fn().mockResolvedValue(undefined);
  const processingBySession = new Set<string>();
  const setProcessing = vi.fn((sessionKey: string, processing: boolean) => {
    if (processing) processingBySession.add(sessionKey);
    else processingBySession.delete(sessionKey);
  });
  /** 清掉"这一轮正在进行"的提示（与 `setProcessing(false)` 成对，见 `settleLocalStop`）。 */
  const clearActiveTurn = vi.fn();
  const task = {
    id: TASK_ID,
    gatewayId: 'gw-1',
    sessionKey: SESSION_KEY,
    title: 'T',
    model: options.model ?? 'qwen3.5-27b',
    ensemble: options.ensemble,
    teamId: options.teamId,
  };
  const room = options.ensemble
    ? {
        taskId: TASK_ID,
        conductorSessionKey: `${SESSION_KEY}:conductor`,
        performers: (
          options.performers ?? [{ agentId: 'worker', agentName: 'Worker', sessionKey: `${SESSION_KEY}:worker` }]
        ).map((p) => ({ ...p, verifiedAt: '2026-09-16T00:00:00.000Z' })),
        status: 'active' as const,
        conductorReady: true,
      }
    : undefined;

  const deps: ChatComposerDeps = {
    gateway: { sendMessage, abortChat, patchSession },
    getTaskStore: () => ({
      tasks: [task],
      commitPendingTask: () => {
        if (options.pendingTaskRejection !== undefined) throw options.pendingTaskRejection;
        return task;
      },
      updateTaskTitle: vi.fn(),
      updateTaskMetadata,
    }),
    getSupportedThinkingLevels: () => supportedLevels,
    resolveAgentName: (_taskId, agentId) => mentionNameResolver?.(agentId),
    getRoomState: () => room,
    getMessageStore: () => ({
      addMessage,
      removeMessage,
      setProcessing,
      clearActiveTurn,
      clearMessages: vi.fn(),
      // ⭐ B8：压缩播报交给统一出口 ⇒ 这三个要走真的（桩成空函数的话"报没报"根本看不出来）
      compactionAnnouncedEpisodeBySession: {},
      compactionEpisodeBySession: {},
      beginCompactionEpisode: () => {
        const next = 1;
        return next;
      },
      ensureCompactionEpisode: () => 1,
      announceCompactionOnce: vi.fn(() => {
        throw new Error('composer 不该自己播报压缩（B8：交给统一出口）');
      }),
    }),
    persistMessage,
    markAbortedByUser: vi.fn(),
    compactSession,
    resetSession,
    translate: (key: string) => key,
    onError: vi.fn(),
  };
  // 「没注入」= 字段不存在 —— 与"注入了一个返回 undefined 的"是两条不同的路。
  if (options.withoutNameResolver) delete deps.resolveAgentName;
  if (options.computerAccess) {
    const ca = options.computerAccess;
    deps.computerAccess = {
      tier: () => ca.tier,
      applied: () => ca.applied,
      remember: (sessionKey, record) => {
        ca.applied.set(sessionKey, record);
      },
    };
  }

  const composer = createChatComposer(deps);

  function systemOptions(): (AddMessageOptions | undefined)[] {
    return addMessage.mock.calls.filter((c) => c[1] === 'system').map((c) => c[4]);
  }

  /**
   * 只挑出**带 `permissionMode` 的** patch 调用。
   * ⚠️ 判据是"载荷里有没有这个键"，不是"调了几次 patchSession" ——
   *    model / thinkingLevel 也在同一条链上发 patch，数次数会被它们污染。
   */
  function permissionPatches(): Array<{ sessionKey: string; mode: unknown }> {
    return patchSession.mock.calls
      .filter((c) => (c[2] as Record<string, unknown>)?.permissionMode !== undefined)
      .map((c) => ({
        sessionKey: c[1] as string,
        mode: (c[2] as Record<string, unknown>).permissionMode,
      }));
  }

  return {
    composer,
    deps,
    task,
    addMessage,
    systemOptions,
    sendMessage,
    compactSession,
    resetSession,
    patchSession,
    permissionPatches,
    updateTaskMetadata,
    persistMessage,
    removeMessage,
    processingBySession,
    setProcessing,
    clearActiveTurn,
    abortChat,
    onError: deps.onError,
  };
}

describe('chat-composer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the accepted dispatch receipt for the sent session', async () => {
    const h = setup();
    const receipt = { sessionKey: SESSION_KEY, runId: 'gateway-run-42' };
    h.sendMessage.mockResolvedValueOnce({ ok: true, result: receipt });
    expect(await h.composer.send(TASK_ID, { content: 'hello' })).toEqual({
      ok: true,
      taskId: TASK_ID,
      dispatch: receipt,
    });
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
    h.composer.dispose();
  });

  it('validates the receipt against the session actually submitted', async () => {
    const h = setup();
    h.sendMessage.mockImplementationOnce(async (_gatewayId, sessionKey) => {
      h.task.sessionKey = buildSessionKey('replacement');
      return { ok: true, result: { sessionKey, runId: 'gateway-run-42' } };
    });
    expect(await h.composer.send(TASK_ID, { content: 'hello' })).toMatchObject({
      ok: true,
      dispatch: { sessionKey: SESSION_KEY, runId: 'gateway-run-42' },
    });
    h.composer.dispose();
  });

  it.each(['rejected', 'failed'] as const)(
    'does not report a %s patch as provider failure after cancellation',
    async (kind) => {
      const h = setup();
      const controller = new AbortController();
      h.patchSession.mockImplementationOnce(async () => {
        controller.abort();
        if (kind === 'rejected') throw new Error('patch failed');
        return { ok: false, error: 'patch failed' };
      });
      expect(
        await h.composer.send(TASK_ID, { content: 'hello', signal: controller.signal, presetModel: 'model' }),
      ).toEqual({
        ok: false,
        taskId: TASK_ID,
        aborted: true,
      });
      expect(h.sendMessage).not.toHaveBeenCalled();
      expect(h.onError).not.toHaveBeenCalled();
      expect(h.systemOptions()).toEqual([]);
      expect(h.removeMessage).toHaveBeenCalledWith(TASK_ID, 'm1');
      expect(h.processingBySession.size).toBe(0);
      h.composer.dispose();
    },
  );

  it.each([
    undefined,
    null,
    'run-id',
    {},
    { runId: 'gateway-run-42' },
    { sessionKey: SESSION_KEY, runId: '' },
    { sessionKey: SESSION_KEY, runId: '  ' },
    { sessionKey: SESSION_KEY, runId: 42 },
    { sessionKey: buildSessionKey('other'), runId: 'gateway-run-42' },
  ])('preserves ordinary success without trusting an invalid receipt: %j', async (result) => {
    const h = setup();
    h.sendMessage.mockResolvedValueOnce({ ok: true, result });
    expect(await h.composer.send(TASK_ID, { content: 'hello' })).toEqual({ ok: true, taskId: TASK_ID });
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
    h.composer.dispose();
  });

  it('does not submit or create pending state for an already aborted send', async () => {
    const h = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await h.composer.send(TASK_ID, { content: 'hello', signal: controller.signal })).toEqual({
      ok: false,
      taskId: TASK_ID,
      aborted: true,
    });
    expect(h.patchSession).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.addMessage).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    h.composer.dispose();
  });

  it.each(['presetModel', 'taskModel', 'thinking', 'permission'] as const)(
    'cancels before submission when aborted while awaiting %s',
    async (stage) => {
      vi.useFakeTimers();
      const h = setup({ computerAccess: { tier: 'full', applied: new Map() } });
      const controller = new AbortController();
      let releasePatch!: (result: IpcResult) => void;
      h.patchSession.mockImplementation(async (_gatewayId, _sessionKey, patch) => {
        const target =
          stage === 'presetModel' || stage === 'taskModel'
            ? 'model'
            : stage === 'thinking'
              ? 'thinkingLevel'
              : 'permissionMode';
        if (target in patch)
          return new Promise<IpcResult>((resolve) => {
            releasePatch = resolve;
          });
        return { ok: true };
      });
      const pending = h.composer.send(TASK_ID, {
        content: 'hello',
        signal: controller.signal,
        presetModel: stage === 'presetModel' ? 'test-model' : undefined,
        presetThinking: stage === 'thinking' ? 'high' : undefined,
      });
      await vi.waitFor(() => expect(releasePatch).toBeTypeOf('function'));
      controller.abort();
      releasePatch({ ok: true });
      expect(await pending).toEqual({ ok: false, taskId: TASK_ID, aborted: true });
      expect(h.sendMessage).not.toHaveBeenCalled();
      expect(h.persistMessage).not.toHaveBeenCalled();
      expect(h.removeMessage).toHaveBeenCalledWith(TASK_ID, 'm1');
      expect(h.processingBySession.size).toBe(0);
      expect(h.clearActiveTurn).toHaveBeenCalledWith(SESSION_KEY);
      expect(h.onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
      expect(h.systemOptions()).toEqual([]);
      h.composer.dispose();
    },
  );

  it('returns the accepted receipt even when aborted while awaiting submission', async () => {
    const h = setup();
    const controller = new AbortController();
    const receipt = { sessionKey: SESSION_KEY, runId: 'gateway-run-42' };
    h.sendMessage.mockImplementationOnce(async () => {
      controller.abort();
      return { ok: true, result: receipt };
    });
    expect(await h.composer.send(TASK_ID, { content: 'hello', signal: controller.signal })).toEqual({
      ok: true,
      taskId: TASK_ID,
      dispatch: receipt,
    });
    expect(h.removeMessage).not.toHaveBeenCalled();
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
    h.composer.dispose();
  });

  it.each([
    { name: 'same task and session', nextTaskId: TASK_ID, nextSessionKey: SESSION_KEY },
    { name: 'same task with a replaced session', nextTaskId: TASK_ID, nextSessionKey: buildSessionKey('replacement') },
    { name: 'different task and session', nextTaskId: 'next-task', nextSessionKey: buildSessionKey('next-task') },
  ])('an older cancellation preserves the accepted send for $name', async ({ nextTaskId, nextSessionKey }) => {
    vi.useFakeTimers();
    const h = setup();
    const controller = new AbortController();
    const pendingMessages = new Map<string, Message>();
    let nextMessageId = 0;
    h.addMessage.mockImplementation((taskId, role, content) => {
      const message: Message = {
        id: `message-${++nextMessageId}`,
        taskId,
        role,
        content,
        artifacts: [],
        toolCalls: [],
        timestamp: '',
      };
      pendingMessages.set(message.id, message);
      return message;
    });
    h.removeMessage.mockImplementation((_taskId, messageId) => pendingMessages.delete(messageId));
    let releaseOldPatch!: (result: IpcResult) => void;
    h.patchSession.mockImplementationOnce(
      () =>
        new Promise<IpcResult>((resolve) => {
          releaseOldPatch = resolve;
        }),
    );
    const oldSend = h.composer.send(TASK_ID, { content: 'old request', signal: controller.signal });
    expect(releaseOldPatch).toBeTypeOf('function');
    controller.abort();
    h.task.id = nextTaskId;
    h.task.sessionKey = nextSessionKey;
    const receipt = { sessionKey: nextSessionKey, runId: 'new-run' };
    h.sendMessage.mockResolvedValueOnce({ ok: true, result: receipt });
    expect(await h.composer.send(nextTaskId, { content: 'new request' })).toEqual({
      ok: true,
      taskId: nextTaskId,
      dispatch: receipt,
    });
    releaseOldPatch({ ok: true });
    expect(await oldSend).toEqual({ ok: false, taskId: TASK_ID, aborted: true });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.processingBySession).toEqual(new Set([nextSessionKey]));
    expect(h.clearActiveTurn).not.toHaveBeenCalledWith(nextSessionKey);
    if (nextSessionKey !== SESSION_KEY) expect(h.clearActiveTurn).toHaveBeenCalledWith(SESSION_KEY);
    expect(h.removeMessage.mock.calls).toEqual([[TASK_ID, 'message-1']]);
    expect([...pendingMessages.values()].map((message) => message.content)).toEqual(['new request']);
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
    expect(h.persistMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'message-2', taskId: nextTaskId }));
    expect(h.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect(h.systemOptions()).toEqual([{ sessionKey: nextSessionKey }]);
    expect(h.processingBySession.size).toBe(0);
    h.composer.dispose();
  });

  it('attaches task.sessionKey to system messages from emitError, send-timeout, reset（compact 已改走统一出口）', async () => {
    {
      const { composer, systemOptions, sendMessage } = setup();
      sendMessage.mockResolvedValueOnce({ ok: false });
      await composer.send(TASK_ID, { content: 'hi' });
      const system = systemOptions();
      expect(system).toHaveLength(1);
      expect(system[0]?.sessionKey).toBe(SESSION_KEY);
    }

    {
      const { composer, systemOptions, sendMessage } = setup();
      vi.useFakeTimers();
      sendMessage.mockResolvedValueOnce({ ok: true });
      await composer.send(TASK_ID, { content: 'hi' });
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
      vi.useRealTimers();
      const system = systemOptions();
      expect(system).toHaveLength(1);
      expect(system[0]?.sessionKey).toBe(SESSION_KEY);
    }

    {
      // ⭐ B8：compact **不再**由 composer 自己插消息 —— 它只把网关的结论
      //    （`compacted === true`）交给统一出口，由那边负责"什么时候、报不报"。
      const { composer, systemOptions, compactSession } = setup();
      compactSession.mockResolvedValueOnce({ ok: true, result: { compacted: true } });
      const result = await composer.applySlashCommand(TASK_ID, 'compact');
      expect(result.ok, '命令本身仍然成功').toBe(true);
      expect(systemOptions(), 'composer 不再自己报"已压缩"').toHaveLength(0);
    }

    {
      const { composer, systemOptions, resetSession } = setup();
      resetSession.mockResolvedValueOnce({ ok: true });
      await composer.applySlashCommand(TASK_ID, 'reset');
      const system = systemOptions();
      expect(system).toHaveLength(1);
      expect(system[0]?.sessionKey).toBe(SESSION_KEY);
    }
  });

  it('does not create or persist a deferred user message when gateway dispatch fails', async () => {
    const { composer, addMessage, sendMessage, persistMessage, removeMessage } = setup();
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'offline' });

    const result = await composer.send(TASK_ID, {
      content: 'first ensemble message',
      deferUserMessageUntilSent: true,
    });

    expect(result.ok).toBe(false);
    expect(addMessage.mock.calls.filter((call) => call[1] === 'user')).toHaveLength(1);
    expect(removeMessage).toHaveBeenCalledWith(TASK_ID, 'm1');
    expect(persistMessage).not.toHaveBeenCalled();
  });

  it('creates and persists a deferred user message only after gateway dispatch succeeds', async () => {
    const { composer, addMessage, sendMessage, persistMessage } = setup();
    const attachments = [{ fileName: 'brief.pdf', dataUrl: '', localPath: 'tasks/abc/inbox/brief.pdf' }];

    const result = await composer.send(TASK_ID, {
      content: 'first ensemble message',
      attachments: [{ fileName: 'brief.pdf', mimeType: 'application/pdf', content: 'cGRm' }],
      messageAttachments: attachments,
      deferUserMessageUntilSent: true,
    });

    expect(result.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      'gw-1',
      SESSION_KEY,
      'first ensemble message',
      [{ fileName: 'brief.pdf', mimeType: 'application/pdf', content: 'cGRm' }],
      { userContent: 'first ensemble message' },
    );
    expect(addMessage).toHaveBeenCalledWith(TASK_ID, 'user', 'first ensemble message', attachments, { persist: false });
    expect(addMessage.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0]);
    expect(persistMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps processing only for accepted ensemble targets and clears it when the accepted worker responds', async () => {
    vi.useFakeTimers();
    const { composer, sendMessage, persistMessage, removeMessage, addMessage, onError, processingBySession } = setup({
      ensemble: true,
    });
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'conductor offline' }).mockResolvedValueOnce({ ok: true });

    const result = await composer.send(TASK_ID, {
      content: 'team request',
      mentionAll: true,
      deferUserMessageUntilSent: true,
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: true, partialFailure: expect.stringContaining('conductor offline') }),
    );
    expect(removeMessage).not.toHaveBeenCalled();
    expect(persistMessage).toHaveBeenCalledTimes(1);
    expect(addMessage.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0]);
    expect([...processingBySession]).toEqual([`${SESSION_KEY}:worker`]);
    composer.notifyResponse(`${SESSION_KEY}:worker`);
    expect([...processingBySession]).toEqual([]);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect(addMessage.mock.calls.filter((call) => call[1] === 'system')).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes a persisted team task directly even when its legacy ensemble flag is still true', async () => {
    const { composer, sendMessage, processingBySession } = setup({ ensemble: true, teamId: 'team-design' });

    const result = await composer.send(TASK_ID, {
      content: 'team request',
      mentionAll: true,
      mentions: ['worker'],
    });

    expect(result.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('gw-1', SESSION_KEY, 'team request', undefined, {
      userContent: 'team request',
    });
    expect([...processingBySession]).toEqual([SESSION_KEY]);
  });

  it('rolls back a deferred ensemble message only when every target fails', async () => {
    const { composer, sendMessage, persistMessage, removeMessage, processingBySession } = setup({ ensemble: true });
    sendMessage
      .mockResolvedValueOnce({ ok: false, error: 'conductor offline' })
      .mockRejectedValueOnce(new Error('worker offline'));

    const result = await composer.send(TASK_ID, {
      content: 'team request',
      mentionAll: true,
      deferUserMessageUntilSent: true,
    });

    expect(result.ok).toBe(false);
    expect(removeMessage).toHaveBeenCalledWith(TASK_ID, 'm1');
    expect(persistMessage).not.toHaveBeenCalled();
    expect([...processingBySession]).toEqual([]);
  });

  it('keeps ordinary single-target processing until that session responds', async () => {
    const { composer, processingBySession } = setup();

    expect((await composer.send(TASK_ID, { content: 'hello' })).ok).toBe(true);
    expect([...processingBySession]).toEqual([SESSION_KEY]);

    composer.notifyResponse(SESSION_KEY);
    expect([...processingBySession]).toEqual([]);
  });

  it('keeps the ensemble timer until the remaining accepted target times out', async () => {
    vi.useFakeTimers();
    const { composer, processingBySession, addMessage } = setup({ ensemble: true });

    expect((await composer.send(TASK_ID, { content: 'team request', mentionAll: true })).ok).toBe(true);
    expect(new Set(processingBySession)).toEqual(new Set([`${SESSION_KEY}:conductor`, `${SESSION_KEY}:worker`]));

    composer.notifyResponse(`${SESSION_KEY}:conductor`);
    expect([...processingBySession]).toEqual([`${SESSION_KEY}:worker`]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect([...processingBySession]).toEqual([]);
    expect(addMessage.mock.calls.filter((call) => call[1] === 'system')).toHaveLength(1);
  });

  it('cancels the ensemble timer only after every accepted target responds', async () => {
    vi.useFakeTimers();
    const { composer, processingBySession, addMessage } = setup({ ensemble: true });

    expect((await composer.send(TASK_ID, { content: 'team request', mentionAll: true })).ok).toBe(true);
    composer.notifyResponse(`${SESSION_KEY}:conductor`);
    expect(vi.getTimerCount()).toBe(1);
    composer.notifyResponse(`${SESSION_KEY}:worker`);

    expect([...processingBySession]).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect(addMessage.mock.calls.filter((call) => call[1] === 'system')).toHaveLength(0);
  });
});

/**
 * 思考档位的**最后一道关**。
 *
 * 2026-09-14 线上实测的 bug：这里的守卫以前只挡 `'off'`
 * （`if (options.presetThinking && options.presetThinking !== 'off')`），
 * **从不校验该模型到底支不支持**。于是历史/持久化里带着的 `adaptive` 被原样发给网关：
 *
 *   thinkingLevel "adaptive" is not supported for clawrouter/qwen3.5-27b
 *   (use off|minimal|low|medium|high|xhigh)
 *
 * 用户看到的是这么一条英文报错，而客户端明明**知道**每个模型支持哪些档位
 * （目录每行都带 `thinkingLevels`，`thinking-levels.ts` 已经在用同一份数据渲染菜单）。
 */
describe('chat-composer —— 思考档位必须对着模型能力校验', () => {
  const patchThinkingCalls = (patchSession: ReturnType<typeof vi.fn>) =>
    patchSession.mock.calls.map((c) => c[2] as { thinkingLevel?: string }).filter((p) => p?.thinkingLevel);

  afterEach(() => {
    supportedLevels = undefined;
  });

  it('⭐ 模型不支持的档位**不会**发到网关（复现 adaptive 那个 bug）', async () => {
    // qwen3.5-27b 的实际声明（实测目录）：没有 adaptive
    supportedLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    const { composer, patchSession } = setup();

    await composer.send(TASK_ID, { content: 'hi', presetModel: 'qwen3.5-27b', presetThinking: 'adaptive' });

    const sent = patchThinkingCalls(patchSession);
    expect(sent, '无效档位被发给网关了').toHaveLength(0);
    expect(JSON.stringify(patchSession.mock.calls)).not.toContain('adaptive');
  });

  it('qwen3.5-27b 的默认档是 off ⇒ 回落成 off 就等于「不用 patch」，一样不发', async () => {
    // 该模型目录里第一档是 off。off 是默认态，本来就不需要 patch。
    // ⚠️ 这里**刻意不断言** `updateTaskMetadata` 被调用：回落成 off 时根本
    //    没有一次成功的 patch，状态就没有在该路径上被重写的机会
    //    （渲染层的「切模型自动回落」那条 effect 负责常规场景）。
    //    这条要钉的不变量只有一条：**用户请求的那个值绝不出现在发往网关的报文里**。
    supportedLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    const { composer, patchSession } = setup();

    await composer.send(TASK_ID, { content: 'hi', presetModel: 'qwen3.5-27b', presetThinking: 'adaptive' });

    expect(patchThinkingCalls(patchSession)).toHaveLength(0);
    expect(JSON.stringify(patchSession.mock.calls)).not.toContain('adaptive');
  });

  it('模型默认档不是 off 时，回落成实际发出的那一档，并同步状态', async () => {
    // 例如 v4-flash 这类「关不掉思考」的模型：第一档就是 low
    supportedLevels = ['low', 'medium', 'high'];
    const { composer, patchSession, updateTaskMetadata } = setup();

    await composer.send(TASK_ID, { content: 'hi', presetModel: 'deepseek-v4-flash', presetThinking: 'adaptive' });

    const sent = patchThinkingCalls(patchSession);
    expect(sent).toEqual([{ thinkingLevel: 'low' }]);
    // 状态必须记**实际发出的**，不是用户原本请求的那个
    expect(updateTaskMetadata).toHaveBeenCalledWith(TASK_ID, { thinkingLevel: 'low' });
  });

  it('支持的档位原样透传（不能因为加守卫就改掉正常行为）', async () => {
    supportedLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    const { composer, patchSession } = setup();

    await composer.send(TASK_ID, { content: 'hi', presetModel: 'qwen3.5-27b', presetThinking: 'high' });

    const sent = patchThinkingCalls(patchSession);
    expect(sent).toEqual([{ thinkingLevel: 'high' }]);
  });

  it('⭐ Cephalon 批：目标模型 deepseek-v4-flash-cephalon 声明含 low/high/max ⇒ 三档原样透传', async () => {
    supportedLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
    const { composer, patchSession } = setup();

    for (const level of ['low', 'high', 'max'] as const) {
      patchSession.mockClear();
      await composer.send(TASK_ID, {
        content: 'hi',
        presetModel: 'deepseek-v4-flash-cephalon',
        presetThinking: level,
      });
      expect(patchThinkingCalls(patchSession)).toEqual([{ thinkingLevel: level }]);
    }
  });

  it('⭐ Cephalon 批：目标模型声明里没有该档（PPT 路由换模型后的真实风险）⇒ 回落该模型目录默认档，不硬发', async () => {
    supportedLevels = ['low', 'medium'];
    const { composer, patchSession, updateTaskMetadata } = setup();

    await composer.send(TASK_ID, { content: 'hi', presetModel: 'deepseek-v4-flash-cephalon', presetThinking: 'max' });

    expect(patchThinkingCalls(patchSession)).toEqual([{ thinkingLevel: 'low' }]);
    expect(updateTaskMetadata).toHaveBeenCalledWith(TASK_ID, { thinkingLevel: 'low' });
  });

  /**
   * ⭐ Cephalon 批（Task 4 验收缺口补验·实链接缝捕获）：`presetModel=glm-5.3-flash` 的
   * **客户端最终请求**（真实 composer 的参数合并／序列化出口）不得携带 `enable_search`。
   *
   * 捕获范围 = 送往网关的全部载荷：`sessions.patch`（模型钉选 + 思考档）+ `chat.send`
   * 派发载荷 + 任务元数据写入。模型内置搜索在网关侧按模型配置注入——**网关参数合并后
   * 的最终上游 HTTP body 由同批 `relay-mode-final-body.integration.test.ts` 用实际
   * 交付运行时 + 本地接收器捕获**（含旧 Qwen `enable_search=true` 正对照）；本用例覆盖
   * 客户端一侧，两者合起来才是完整链路。
   */
  it('⭐ Cephalon 批：glm-5.3-flash 的最终请求（patch + 派发 + 元数据）不含 enable_search', async () => {
    supportedLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
    const h = setup();

    const result = await h.composer.send(TASK_ID, {
      content: '把第三季度数据做一份周报',
      presetModel: 'glm-5.3-flash',
      presetThinking: 'high',
    });

    expect(result.ok).toBe(true);
    // 模型钉选与思考档都真实到达参数接缝
    const modelPatches = h.patchSession.mock.calls
      .map((c) => c[2] as { model?: string })
      .filter((p) => p?.model !== undefined);
    expect(modelPatches).toEqual([{ model: 'glm-5.3-flash' }]);
    expect(patchThinkingCalls(h.patchSession)).toEqual([{ thinkingLevel: 'high' }]);
    expect(h.updateTaskMetadata).toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ model: 'glm-5.3-flash' }));
    // 全部出站载荷逐字节扫一眼：不得出现 enable_search
    const wire = JSON.stringify([h.patchSession.mock.calls, h.sendMessage.mock.calls, h.updateTaskMetadata.mock.calls]);
    expect(wire).not.toContain('enable_search');
  });

  /**
   * ⭐ BUG-067 接线条（Task 4 复验整改）：hook 的"已采用"判据（读任务行最新 model）必须与
   * core 的真实接线一致——模型 patch 成功后**先更新 task.model**，后续派发返回失败或抛异常
   * 都返回 `ok:false` 但模型**已采用**；patch 被拒则不动任务模型（未采用）。
   */
  it('⭐ BUG-067 接线条：patch 成功后派发失败／抛异常 ⇒ ok:false 但任务已记新模型；patch 被拒 ⇒ 不记', async () => {
    // ① 派发返回失败：模型仍算已采用
    const h1 = setup();
    h1.sendMessage.mockResolvedValueOnce({ ok: false });
    expect((await h1.composer.send(TASK_ID, { content: 'hi', presetModel: 'glm-5.3-flash' })).ok).toBe(false);
    expect(h1.updateTaskMetadata).toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ model: 'glm-5.3-flash' }));

    // ② 派发抛异常：同上
    const h2 = setup();
    h2.sendMessage.mockImplementationOnce(async () => {
      throw new Error('dispatch boom');
    });
    expect((await h2.composer.send(TASK_ID, { content: 'hi', presetModel: 'glm-5.3-flash' })).ok).toBe(false);
    expect(h2.updateTaskMetadata).toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ model: 'glm-5.3-flash' }));

    // ③ patch 被拒：未采用，不许记模型
    const h3 = setup();
    h3.patchSession.mockResolvedValueOnce({ ok: false, error: 'pin rejected' });
    expect((await h3.composer.send(TASK_ID, { content: 'hi', presetModel: 'glm-5.3-flash' })).ok).toBe(false);
    expect(h3.updateTaskMetadata).not.toHaveBeenCalled();
  });

  it('拿不到能力信息时**照发**（「还不知道」≠「不支持」，不能悄悄改用户选的档位）', async () => {
    supportedLevels = undefined;
    const { composer, patchSession } = setup();

    await composer.send(TASK_ID, { content: 'hi', presetModel: 'qwen3.5-27b', presetThinking: 'high' });

    expect(patchThinkingCalls(patchSession)).toEqual([{ thinkingLevel: 'high' }]);
  });

  it('off 不发 patch（保持既有行为：off 是默认态）', async () => {
    supportedLevels = ['off', 'minimal', 'low'];
    const { composer, patchSession } = setup();

    await composer.send(TASK_ID, { content: 'hi', presetModel: 'qwen3.5-27b', presetThinking: 'off' });

    expect(patchThinkingCalls(patchSession)).toHaveLength(0);
  });

  it('模型只支持 off ⇒ 同样不发 patch，而不是发一个 off 上去', async () => {
    supportedLevels = ['off'];
    const { composer, patchSession } = setup();

    await composer.send(TASK_ID, { content: 'hi', presetModel: 'some-off-only', presetThinking: 'high' });

    expect(patchThinkingCalls(patchSession)).toHaveLength(0);
  });

  /**
   * `/think` 是**用户手打**的，等于把任意字符串直接送进网关 ——
   * 它以前**一个字都没校验**，所以 `adaptive` 那个洞在这里也开着一模一样的口子。
   */
  it('⭐ `/think <无效档位>` 被拦下，不发给网关，并且错误能被翻译成中文', async () => {
    supportedLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    const { composer, patchSession } = setup();

    const res = await composer.applySlashCommand(TASK_ID, 'think', 'adaptive');

    expect(res.ok).toBe(false);
    expect(patchThinkingCalls(patchSession)).toHaveLength(0);
    // 造的错误必须是**网关原话的形状**，否则 gateway-error-message 翻不出来
    // （正则 `thinkingLevel "X" is not supported for <model> (use ...)`）。
    expect(res.error).toMatch(/thinkingLevel "adaptive" is not supported for/i);
    expect(translateGatewayError(res.error)).toContain('不支持「adaptive」档思考');
  });

  it('`/think` 传有效档位照常生效', async () => {
    supportedLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    const { composer, patchSession, updateTaskMetadata } = setup();

    const res = await composer.applySlashCommand(TASK_ID, 'think', 'high');

    expect(res.ok).toBe(true);
    expect(patchThinkingCalls(patchSession)).toEqual([{ thinkingLevel: 'high' }]);
    expect(updateTaskMetadata).toHaveBeenCalledWith(TASK_ID, { thinkingLevel: 'high' });
  });
});

/**
 * ⭐「首条消息跑的是哪个模型」。
 *
 * 2026-09-17 实机：composer 显示 deepseek-v4-flash，实际生成消息的是 qwen3.5-27b ——
 * 网关侧和客户端对"默认"各有一套定义（已由 shared 常量收敛），而**任务级模型必须
 * 在 chat.send 之前 patch 进会话**：patch 晚一步，第一条消息就一定跑网关默认。
 * 这条测试钉的就是那个顺序。
 */
describe('chat-composer —— 发送前先把模型写进会话', () => {
  afterEach(() => {
    supportedLevels = undefined;
  });

  it('⭐ patchSession 必须发生在 sendMessage 之前（否则首条消息跑网关默认）', async () => {
    const h = setup();

    const res = await h.composer.send(TASK_ID, {
      content: '你好',
      presetModel: 'clawrouter/deepseek-v4-flash',
    });

    expect(res.ok).toBe(true);
    expect(h.patchSession).toHaveBeenCalledWith('gw-1', SESSION_KEY, { model: 'clawrouter/deepseek-v4-flash' });
    const patchOrder = h.patchSession.mock.invocationCallOrder[0];
    const sendOrder = h.sendMessage.mock.invocationCallOrder[0];
    expect(patchOrder).toBeLessThan(sendOrder);
  });

  it('模型写入失败 ⇒ 不发消息，并把用户消息回滚（别让消息跑在错误模型上）', async () => {
    const h = setup();
    h.patchSession.mockResolvedValueOnce({ ok: false, error: 'model not available' });

    const res = await h.composer.send(TASK_ID, { content: '你好', presetModel: 'clawrouter/nope' });

    expect(res.ok).toBe(false);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});

/**
 * 任务级模型**必须下发**，否则 composer 显示的就是谎话。
 *
 * 实机症状（2026-09-14 彩排）：composer 显示 `deepseek-v4-flash`，消息徽章却是 `QWEN3.5-27B`。
 * 徽章是对的（它只认网关逐条记录的 `model`）；错的是**第一条消息根本没带模型** ——
 * 网关用 `agents.defaults.model.primary` 跑，而界面显示的是任务级的另一个值。
 *
 * 根因：`chat.send` **不带模型字段**（模型是**会话级**的），而这里**只在 `presetModel`
 * 存在时**才 patch 会话 —— 用户直接打字发送（最常见的那条路）时模型从不下发。
 * 同一份文件里 `thinkingLevel` 是**每次发送都 patch** 的，模型却没有。
 */
describe('任务级模型下发', () => {
  /** `patchSession` 里带 model 的那些调用。 */
  const modelPatches = (patchSession: ReturnType<typeof vi.fn>): string[] =>
    patchSession.mock.calls
      .map((c) => (c[2] as { model?: string } | undefined)?.model)
      .filter((m): m is string => typeof m === 'string');

  it('⭐ 不带 presetModel 的普通发送，也要把**任务的模型**钉到会话上', async () => {
    const h = setup(); // 夹具里 task.model = 'qwen3.5-27b'

    await h.composer.send(TASK_ID, { content: '你好' });

    expect(
      modelPatches(h.patchSession),
      '不钉的话第一条消息一定跑网关默认，而界面显示的是另一个模型 —— 用户看到的就是"显示的不算数"',
    ).toContain('qwen3.5-27b');
  });

  it('⭐ 钉不上时**照发**：显示问题不能升级成发不出去', async () => {
    const h = setup();
    h.patchSession.mockResolvedValue({ ok: false, error: 'model not available' });

    const res = await h.composer.send(TASK_ID, { content: '你好' });

    expect(h.sendMessage, '宁可跑网关默认（徽章会显示真实模型），也不能把消息卡住').toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it('任务没有模型 ⇒ 不产生多余的 patch', async () => {
    const h = setup({ model: '' });

    await h.composer.send(TASK_ID, { content: '你好' });

    expect(modelPatches(h.patchSession)).toHaveLength(0);
    expect(h.sendMessage).toHaveBeenCalled();
  });

  it('presetModel 优先于任务模型（用户显式选的那一个说了算）', async () => {
    const h = setup();

    await h.composer.send(TASK_ID, { content: '你好', presetModel: 'deepseek-v4-flash' });

    const patched = modelPatches(h.patchSession);
    expect(patched).toContain('deepseek-v4-flash');
    expect(patched, '不要再用任务级的老值覆盖用户刚选的').not.toContain('qwen3.5-27b');
  });
});

/**
 * 用户 `@` 某个 worker 时，composer 会给 conductor 补一句话
 * （`[User directed message to …: "…"]`，见 `chat-composer.ts` 里那条注释）。
 *
 * 2026-09-20 发现：那句话里写的是 **裸 agentId** —— `options.mentions` 是
 * `useChatSend` 传进来的 `.map((a) => a.agentId)`，`join(', ')` 之后就成了
 * `[User directed message to rongying-tpl-78b62899: "…"]`。
 * 名字一直是有的（网关目录里就是「爆款内容教练」，房间快照里也有一份），
 * 只是没往这句话里送 ⇒ **人和模型看到的是两个名字**。
 * 这是 T-a7 同一家族的第**四**个面（前三个：消息头、团队页、`@` 选择器）。
 *
 * ⚠️ `mentions` **同时**是派活用的载荷（`resolveMentionTargets` 拿它找 sessionKey），
 *    所以这一刀**只改那句话**：目标与正文一个字节都不许动（下面第一条同时钉住这点）。
 */
describe('chat-composer —— 告诉 conductor「用户 @ 了谁」要用名字', () => {
  const CONDUCTOR_KEY = `${SESSION_KEY}:conductor`;

  afterEach(() => {
    mentionNameResolver = undefined;
  });

  /** 发给 conductor 那一句通知（正文里带 `[User directed message`）。 */
  const conductorNotes = (sendMessage: ReturnType<typeof vi.fn>): string[] =>
    sendMessage.mock.calls
      .filter((c) => c[1] === CONDUCTOR_KEY)
      .map((c) => c[2] as string)
      .filter((text) => text.startsWith('[User directed message'));

  it('⭐ conductor 收到的是**目录里的名字**，不是裸 agentId（复现原 bug）', async () => {
    mentionNameResolver = (agentId) => (agentId === 'worker' ? '爆款内容教练' : undefined);
    const h = setup({ ensemble: true });

    const res = await h.composer.send(TASK_ID, { content: '看看这个', mentions: ['worker'] });

    expect(res.ok).toBe(true);
    expect(conductorNotes(h.sendMessage)).toEqual(['[User directed message to 爆款内容教练: "看看这个"]']);
    // 载荷一个字节都不许动：worker 收到的仍然是用户原话，目标仍然是它的 sessionKey。
    expect(h.sendMessage).toHaveBeenCalledWith('gw-1', `${SESSION_KEY}:worker`, '看看这个', undefined, {
      userContent: '看看这个',
    });
  });

  it('⭐ 目录里查不到（目录没拉到 / agent 被删）⇒ 退回房间快照里的名字', async () => {
    mentionNameResolver = () => undefined;
    const h = setup({ ensemble: true });

    await h.composer.send(TASK_ID, { content: '看看这个', mentions: ['worker'] });

    expect(conductorNotes(h.sendMessage)).toEqual(['[User directed message to Worker: "看看这个"]']);
  });

  it('⚠️ 目录查不到、快照也是空串 ⇒ 退回裸 agentId（不能变成「to :」）', async () => {
    mentionNameResolver = () => undefined;
    const h = setup({
      ensemble: true,
      performers: [{ agentId: 'worker', agentName: '', sessionKey: `${SESSION_KEY}:worker` }],
    });

    await h.composer.send(TASK_ID, { content: '看看这个', mentions: ['worker'] });

    expect(conductorNotes(h.sendMessage)).toEqual(['[User directed message to worker: "看看这个"]']);
  });

  it('⚠️ 查名字时抛错 ⇒ 不炸派活（fail-soft），退回快照名，消息照发', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mentionNameResolver = () => {
      throw new Error('catalog exploded');
    };
    const h = setup({ ensemble: true });

    const res = await h.composer.send(TASK_ID, { content: '看看这个', mentions: ['worker'] });

    expect(res.ok).toBe(true);
    expect(h.sendMessage).toHaveBeenCalledWith('gw-1', `${SESSION_KEY}:worker`, '看看这个', undefined, {
      userContent: '看看这个',
    });
    expect(conductorNotes(h.sendMessage)).toEqual(['[User directed message to Worker: "看看这个"]']);
    expect(h.onError).not.toHaveBeenCalled();
    // 吞掉但**不静默**：留一条 warn，免得以后有人以为是"目录里就没名字"。
    expect(warn.mock.calls.flat().join(' ')).toContain('resolveAgentName failed');
    warn.mockRestore();
  });

  it('⚠️ 一次 @ 多个 ⇒ 名字按 mentions 的顺序逗号连起来', async () => {
    const names: Record<string, string> = { worker: '爆款内容教练', 'tpl-2': '深度研究助手' };
    mentionNameResolver = (agentId) => names[agentId];
    const h = setup({
      ensemble: true,
      performers: [
        { agentId: 'worker', agentName: 'worker', sessionKey: `${SESSION_KEY}:worker` },
        { agentId: 'tpl-2', agentName: 'tpl-2', sessionKey: `${SESSION_KEY}:worker2` },
      ],
    });

    await h.composer.send(TASK_ID, { content: '一起看', mentions: ['worker', 'tpl-2'] });

    expect(conductorNotes(h.sendMessage)).toEqual(['[User directed message to 爆款内容教练, 深度研究助手: "一起看"]']);
  });

  it('⚠️ 宿主没注入 resolveAgentName（别的调用方）⇒ 退回快照名，不许崩', async () => {
    const h = setup({ ensemble: true, withoutNameResolver: true });

    const res = await h.composer.send(TASK_ID, { content: '看看这个', mentions: ['worker'] });

    expect(res.ok).toBe(true);
    expect(conductorNotes(h.sendMessage)).toEqual(['[User directed message to Worker: "看看这个"]']);
  });

  it('⚠️ @ 的就是 conductor 自己 ⇒ 不发那句通知（既有行为，别顺手改）', async () => {
    mentionNameResolver = () => '工头';
    const h = setup({
      ensemble: true,
      performers: [{ agentId: 'boss', agentName: '老板', sessionKey: CONDUCTOR_KEY }],
    });

    await h.composer.send(TASK_ID, { content: '你看看', mentions: ['boss'] });

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(conductorNotes(h.sendMessage)).toEqual([]);
  });
});

/**
 * ⭐ 2026-09-24（独立复核 Important #1）：**这条 PWA 路径上两句话曾被压成一句。**
 *
 * `resolveTask` 原来是一个裸的 `catch { return null }`，于是「点名要的助手不在本机」
 * 被报成「助手无响应」—— 而前者有确定的下一步（换一个助手），后者只能重试。
 */
describe('chat-composer —— 待发任务被拒时说的是哪句话', () => {
  it('⭐ 助手不在本机 ⇒ 说「不在本机」，不许压成「无响应」', async () => {
    const h = setup({ pendingTaskRejection: new UnknownAgentError('team-agent-x') });

    const result = await h.composer.send(undefined, { content: 'hi' });

    expect(result).toEqual({ ok: false });
    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ description: 'errors.agentMissing' }));
    expect(h.sendMessage, '拒绝之后一个字都不该发出去').not.toHaveBeenCalled();
  });

  it('⚠️ 对照：其它错误仍然说「无响应」（既有行为，别顺手改）', async () => {
    const h = setup({ pendingTaskRejection: new Error('boom') });

    await h.composer.send(undefined, { content: 'hi' });

    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ description: 'errors.agentNotResponding' }));
  });

  it('⚠️ 对照：找不到指定任务时也是「无响应」（不是"不在本机"）', async () => {
    const h = setup();

    await h.composer.send('不存在的任务', { content: 'hi' });

    expect(h.onError).toHaveBeenCalledWith(expect.objectContaining({ description: 'errors.agentNotResponding' }));
  });
});

/**
 * 「电脑操控权限」两档在**发送链**上的行为（spec §2.5 / §2.6）。
 *
 * ⭐ 这一组的判据全部是**精确载荷**（`{permissionMode:'full'}` / 一次都不发），
 *    不是"patchSession 被调过" —— 后者会被 model / thinkingLevel 那两刀满足。
 */
describe('chat-composer × 电脑操控权限两档', () => {
  it('判据 1：宿主没接这个 dep ⇒ 一次都不发 permissionMode', async () => {
    const h = setup();
    await h.composer.send(TASK_ID, { content: 'hi' });
    expect(h.permissionPatches()).toEqual([]);
  });

  it('判据 1：接了但档位是安全、且没记过账 ⇒ 一次都不发', async () => {
    const h = setup({ computerAccess: { tier: 'safe', applied: new Map() } });
    await h.composer.send(TASK_ID, { content: 'hi' });
    expect(h.permissionPatches()).toEqual([]);
  });

  it('判据 3：全权档 ⇒ 发送时对这一条会话补 {permissionMode:"full"}', async () => {
    const h = setup({ computerAccess: { tier: 'full', applied: new Map() } });
    await h.composer.send(TASK_ID, { content: 'hi' });
    expect(h.permissionPatches()).toEqual([{ sessionKey: SESSION_KEY, mode: 'full' }]);
  });

  it('规则③：补成功之后记账 ⇒ 第二次发送不再补', async () => {
    const applied = new Map<string, AppliedPermissionRecord>();
    const h = setup({ computerAccess: { tier: 'full', applied } });
    await h.composer.send(TASK_ID, { content: '一' });
    await h.composer.send(TASK_ID, { content: '二' });
    expect(h.permissionPatches()).toEqual([{ sessionKey: SESSION_KEY, mode: 'full' }]);
    expect(applied.get(SESSION_KEY)?.mode).toBe('full');
  });

  it('⚠️ 规则③的边界：补刀**失败**就不许记账（否则永久哑掉）', async () => {
    const applied = new Map<string, AppliedPermissionRecord>();
    const h = setup({ computerAccess: { tier: 'full', applied } });
    // 第一刀（model 那条链）会先发一次 patch —— 让它成功，只让"权限那一刀"失败。
    h.patchSession.mockImplementation(async (_g: string, _k: string, patch: Record<string, unknown>) =>
      patch.permissionMode !== undefined ? { ok: false, error: 'nope' } : { ok: true },
    );
    await h.composer.send(TASK_ID, { content: '一' });
    expect(applied.has(SESSION_KEY), '失败不许记账').toBe(false);
    await h.composer.send(TASK_ID, { content: '二' });
    expect(h.permissionPatches().length, '下次还得再补').toBe(2);
  });

  it('判据 5：从全权切回安全 ⇒ 下一次发送补 {permissionMode:"guarded"} 收回', async () => {
    const applied = new Map<string, AppliedPermissionRecord>([['OTHER', { mode: 'full', gatewayId: 'gw-1' }]]);
    const h = setup({ computerAccess: { tier: 'safe', applied } });
    applied.set(SESSION_KEY, { mode: 'full', gatewayId: 'gw-1' });
    await h.composer.send(TASK_ID, { content: 'hi' });
    expect(h.permissionPatches()).toEqual([{ sessionKey: SESSION_KEY, mode: 'guarded' }]);
    // ⚠️ 收回之后记账**必须跟着变成 guarded**：还留着 'full' 的话，下次发送会
    //    以为"还是全权"而不再收回（账本说的与世上发生的不一致）。
    expect(applied.get(SESSION_KEY)?.mode).toBe('guarded');
  });

  it('§2.6：权限那一刀失败**不许拦住发送**（尽力而为，不是硬门）', async () => {
    const h = setup({ computerAccess: { tier: 'full', applied: new Map() } });
    h.patchSession.mockImplementation(async (_g: string, _k: string, patch: Record<string, unknown>) =>
      patch.permissionMode !== undefined ? { ok: false, error: 'nope' } : { ok: true },
    );
    await h.composer.send(TASK_ID, { content: 'hi' });
    expect(h.sendMessage).toHaveBeenCalled();
  });

  it('@群发时不碰权限（与 model/thinkingLevel 同一条豁免规则）', async () => {
    const h = setup({
      ensemble: true,
      computerAccess: { tier: 'full', applied: new Map() },
    });
    await h.composer.send(TASK_ID, { content: 'hi', mentions: ['worker'], mentionsOnly: true } as never);
    expect(h.permissionPatches()).toEqual([]);
  });
});

/**
 * ⭐ 停止按钮：网关答 `aborted:false` 时**必须自己收尾**。
 *
 * 2026-09-27 真机实测（U 盘上一次工具自测，任务 `a0d6c691`）：
 * `chat.abort → {"ok":true,"aborted":false,"runIds":[]}` —— 网关那边**没有可中止的 run**，
 * 所以它**不会再发** `aborted` 状态事件；而界面的"处理中"只能靠那个事件清掉。
 * 结果：**永远转圈、停止按钮点了没反应**，用户只能杀进程（他就是这么做的）。
 */
describe('停止按钮：没东西可中止时客户端自己收尾', () => {
  it('⭐ aborted:false ⇒ 自己清掉「处理中」', async () => {
    const { composer, abortChat, processingBySession, setProcessing, clearActiveTurn } = setup();
    processingBySession.add(SESSION_KEY);
    abortChat.mockResolvedValueOnce({ ok: true, result: { aborted: false, runIds: [] } });

    expect(await composer.abort(TASK_ID)).toEqual({ ok: true, result: { aborted: false, runIds: [] } });

    expect(setProcessing).toHaveBeenCalledWith(SESSION_KEY, false);
    expect(clearActiveTurn).toHaveBeenCalledWith(SESSION_KEY);
    expect(processingBySession.has(SESSION_KEY), '清完就不该还在处理中').toBe(false);
  });

  it('真中止了（aborted:true）⇒ 不抢网关的活，交给 aborted 事件收尾', async () => {
    const { composer, abortChat, setProcessing, clearActiveTurn } = setup();
    abortChat.mockResolvedValueOnce({ ok: true, result: { aborted: true, runIds: ['r1'] } });

    expect(await composer.abort(TASK_ID)).toEqual({ ok: true, result: { aborted: true, runIds: ['r1'] } });

    expect(setProcessing).not.toHaveBeenCalledWith(SESSION_KEY, false);
    expect(clearActiveTurn).not.toHaveBeenCalled();
  });

  it('应答形状不认识（没有 aborted 字段）⇒ 退回旧行为，**不猜**', async () => {
    const { composer, abortChat, setProcessing, clearActiveTurn } = setup();
    abortChat.mockResolvedValueOnce({ ok: true, result: { somethingElse: 1 } });

    expect(await composer.abort(TASK_ID)).toEqual({ ok: true, result: { somethingElse: 1 } });

    expect(setProcessing).not.toHaveBeenCalledWith(SESSION_KEY, false);
    expect(clearActiveTurn).not.toHaveBeenCalled();
  });

  it('调用失败（ok:false）⇒ 不动本地状态（那可能是网络问题，回合还在跑）', async () => {
    const { composer, abortChat, clearActiveTurn } = setup();
    abortChat.mockResolvedValueOnce({ ok: false, error: 'boom' });

    expect(await composer.abort(TASK_ID)).toEqual({ ok: false, error: 'boom' });

    expect(clearActiveTurn).not.toHaveBeenCalled();
  });

  it('returns the upstream receipt when an inactive room falls back to its ordinary session', async () => {
    const h = setup({ ensemble: true });
    h.deps.setRoomStatus = vi.fn();
    h.deps.getRoomState = () => undefined;
    const receipt = { ok: true, result: { aborted: true, runIds: ['run-1'] } };
    h.abortChat.mockResolvedValueOnce(receipt);
    expect(await h.composer.abort(TASK_ID)).toBe(receipt);
    expect(h.abortChat).toHaveBeenCalledExactlyOnceWith('gw-1', SESSION_KEY);
    expect(h.deps.markAbortedByUser).toHaveBeenCalledExactlyOnceWith(TASK_ID);
  });

  it('does not invent one confirmed receipt for a room with mixed abort outcomes', async () => {
    const h = setup({ ensemble: true });
    h.deps.setRoomStatus = vi.fn();
    h.abortChat.mockResolvedValueOnce({ ok: true, result: { aborted: true, runIds: ['run-1'] } });
    h.abortChat.mockResolvedValueOnce({ ok: false, error: 'offline' });
    expect(await h.composer.abort(TASK_ID)).toBeUndefined();
    expect(h.abortChat).toHaveBeenCalledTimes(2);
    expect(h.deps.setRoomStatus).toHaveBeenCalledWith(TASK_ID, 'stopping');
    expect(h.deps.setRoomStatus).toHaveBeenCalledWith(TASK_ID, 'stopped');
  });
});

/**
 * ⭐ 首轮产物索引：**发给模型，但不冒充用户发言**。
 *
 * 2026-09-27 真机反馈：每一轮消息里都顶着一大块 `<artifacts-index>…`。
 * 根因是它被拼进了 `content` —— 而 `content` 会**存库**并**渲染在用户自己的气泡里**，
 * 于是产品注入的背景被当成"用户说过的话"显示了出来。
 */
describe('首轮产物索引：只进网关，不进气泡', () => {
  const INDEX = '<artifacts-index>\nFiles produced earlier…\n- 数学第一课.pptx\n</artifacts-index>';

  it('⭐ contextPrefix 进网关正文，但 store 与落库里只有用户那句话', async () => {
    const { composer, sendMessage, addMessage } = setup();
    sendMessage.mockResolvedValueOnce({ ok: true });

    await composer.send(TASK_ID, { content: '你好', contextPrefix: INDEX });

    const sent = sendMessage.mock.calls[0]?.[2] as string;
    expect(sent, '模型必须看得见索引').toContain('<artifacts-index>');
    expect(sent, '用户那句话也得在').toContain('你好');
    expect(sendMessage.mock.calls[0]?.[4], '交付判断只能收到用户原话，不能用索引或旧失败诊断').toEqual({
      userContent: '你好',
    });

    const userAdd = addMessage.mock.calls.find((c) => c[1] === 'user');
    expect(userAdd?.[2], 'store 里不许有索引').toBe('你好');

    // ⚠️ 这里**不**断言 `persistMessage` 的 content：真代码取的是
    //    `pendingUserMessage.content`（= store 的返回值），而本文件的 `addMessage` 桩
    //    固定返回 `content: ''` ⇒ 那条断言测的是桩自己，不是产品行为。
    //    「落库不含索引」是由**上面那条**推出来的：落库的输入就是这个调用存进去的内容。
  });

  it('没有 contextPrefix 时行为不变（正文原样）', async () => {
    const { composer, sendMessage, addMessage } = setup();
    sendMessage.mockResolvedValueOnce({ ok: true });

    await composer.send(TASK_ID, { content: '你好' });

    expect(sendMessage.mock.calls[0]?.[2]).toBe('你好');
    expect(addMessage.mock.calls.find((c) => c[1] === 'user')?.[2]).toBe('你好');
  });
});
