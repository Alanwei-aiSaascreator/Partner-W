import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSessionKey } from '@clawwork/shared';
import type { Message, MessageAttachment } from '@clawwork/shared';
import { createChatComposer } from '../src/services/chat-composer';
import type { ChatComposerDeps } from '../src/services/chat-composer';
import { translateGatewayError } from '../src/services/gateway-error-message.js';

const TASK_ID = 'abc';
const SESSION_KEY = buildSessionKey(TASK_ID);
const SEND_TIMEOUT_MS = 30_000;

type AddMessageOptions = { persist?: boolean; sessionKey?: string };

/**
 * `getSupportedThinkingLevels` 的可注入桩。
 * `undefined` = 「还不知道」（目录没加载完）—— 必须与「空数组」区分开。
 */
let supportedLevels: string[] | undefined = undefined;

function setup(options: { ensemble?: boolean } = {}) {
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

  const sendMessage = vi.fn().mockResolvedValue({ ok: true });
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
  const task = {
    id: TASK_ID,
    gatewayId: 'gw-1',
    sessionKey: SESSION_KEY,
    title: 'T',
    model: 'qwen3.5-27b',
    ensemble: options.ensemble,
  };
  const room = options.ensemble
    ? {
        taskId: TASK_ID,
        conductorSessionKey: `${SESSION_KEY}:conductor`,
        performers: [
          {
            agentId: 'worker',
            agentName: 'Worker',
            sessionKey: `${SESSION_KEY}:worker`,
            verifiedAt: '2026-09-16T00:00:00.000Z',
          },
        ],
        status: 'active' as const,
        conductorReady: true,
      }
    : undefined;

  const deps: ChatComposerDeps = {
    gateway: { sendMessage, abortChat, patchSession },
    getTaskStore: () => ({
      tasks: [task],
      commitPendingTask: () => task,
      updateTaskTitle: vi.fn(),
      updateTaskMetadata,
    }),
    getSupportedThinkingLevels: () => supportedLevels,
    getRoomState: () => room,
    getMessageStore: () => ({
      addMessage,
      removeMessage,
      setProcessing,
      clearMessages: vi.fn(),
    }),
    persistMessage,
    markAbortedByUser: vi.fn(),
    compactSession,
    resetSession,
    translate: (key: string) => key,
    onError: vi.fn(),
  };

  const composer = createChatComposer(deps);

  function systemOptions(): (AddMessageOptions | undefined)[] {
    return addMessage.mock.calls.filter((c) => c[1] === 'system').map((c) => c[4]);
  }

  return {
    composer,
    addMessage,
    systemOptions,
    sendMessage,
    compactSession,
    resetSession,
    patchSession,
    updateTaskMetadata,
    persistMessage,
    removeMessage,
    processingBySession,
    setProcessing,
    onError: deps.onError,
  };
}

describe('chat-composer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches task.sessionKey to system messages from emitError, send-timeout, compact, reset', async () => {
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
      const { composer, systemOptions, compactSession } = setup();
      compactSession.mockResolvedValueOnce({ ok: true });
      await composer.applySlashCommand(TASK_ID, 'compact');
      const system = systemOptions();
      expect(system).toHaveLength(1);
      expect(system[0]?.sessionKey).toBe(SESSION_KEY);
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
    expect(sendMessage).toHaveBeenCalledWith('gw-1', SESSION_KEY, 'first ensemble message', [
      { fileName: 'brief.pdf', mimeType: 'application/pdf', content: 'cGRm' },
    ]);
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
