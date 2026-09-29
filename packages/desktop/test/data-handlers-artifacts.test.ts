import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();
const autoExtractArtifactsMock = vi.fn();
const captureTaskArtifactBaselineMock = vi.fn();
const reconcileTaskArtifactsMock = vi.fn();
const getGatewayClientMock = vi.fn();
const generateHtmlPagesFromMessageMock = vi.fn();
const webContentsSendMock = vi.fn();
const consoleErrorMock = vi.spyOn(console, 'error').mockImplementation(() => undefined);
const conflictRunMock = vi.fn();
const valuesMock = vi.fn(() => ({
  onConflictDoUpdate: vi.fn(() => ({ run: conflictRunMock })),
  run: vi.fn(),
}));
const selectGetMock = vi.fn();
const dbMock = {
  insert: vi.fn(() => ({ values: valuesMock })),
  select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ get: selectGetMock })) })) })),
  delete: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
};

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handleMap.set(channel, handler)),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => [{ webContents: { send: webContentsSendMock } }]) },
}));

vi.mock('../src/main/db/index.js', () => ({
  getDb: vi.fn(() => dbMock),
  isDbReady: vi.fn(() => true),
}));

vi.mock('../src/main/workspace/config.js', () => ({ getWorkspacePath: vi.fn(() => 'C:\\trusted-workspace') }));
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: getGatewayClientMock }));
vi.mock('../src/main/artifact/auto-extract.js', () => ({ autoExtractArtifacts: autoExtractArtifactsMock }));
vi.mock('../src/main/artifact/reconcile.js', () => ({
  captureTaskArtifactBaseline: captureTaskArtifactBaselineMock,
  reconcileTaskArtifacts: reconcileTaskArtifactsMock,
}));
vi.mock('../src/main/htmlgen/generate.js', () => ({
  generateHtmlPagesFromMessage: generateHtmlPagesFromMessageMock,
}));

async function flushJobs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe('assistant artifact reconciliation boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    handleMap.clear();
    autoExtractArtifactsMock.mockReset().mockResolvedValue(undefined);
    captureTaskArtifactBaselineMock.mockReset().mockResolvedValue({ 'before.txt': 'signature' });
    reconcileTaskArtifactsMock.mockReset().mockResolvedValue({
      saved: [{ id: 'artifact-1', localPath: 'task-1/result.pdf' }],
      existing: [],
      missing: [],
      skipped: [],
      budgetExhausted: false,
    });
    getGatewayClientMock.mockReset().mockReturnValue(undefined);
    generateHtmlPagesFromMessageMock.mockReset().mockResolvedValue({ saved: [], failed: [] });
    webContentsSendMock.mockReset();
    conflictRunMock.mockReset();
    valuesMock.mockClear();
    selectGetMock.mockReset();
    consoleErrorMock.mockClear();
  });

  it('uses the gateway-start baseline even when output appears before the user message is persisted', async () => {
    const files = new Set<string>();
    captureTaskArtifactBaselineMock.mockImplementation(async () =>
      Object.fromEntries([...files].map((name) => [name, 'signature'])),
    );
    const { beginArtifactRunForGatewayDispatch, registerDataHandlers } =
      await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    const createMessage = handleMap.get('data:create-message')!;

    selectGetMock.mockReturnValueOnce({ id: 'task-1' });
    expect(
      beginArtifactRunForGatewayDispatch({
        gatewayId: 'gateway-1',
        sessionKey: 'session-task-1',
        taskId: 'task-1',
        userContent: 'make a PDF',
      }),
    ).toEqual(expect.any(String));
    files.add('created-after-gateway-accept.pdf');

    selectGetMock.mockReturnValueOnce({ id: 'user-1' });
    expect(
      createMessage(
        {},
        {
          id: 'user-1',
          taskId: 'task-1',
          role: 'user',
          content: 'make a PDF',
          timestamp: '2026-09-16T00:00:00.000Z',
          sessionKey: 'session-task-1',
        },
      ),
    ).toEqual({ ok: true });
    await flushJobs();
    expect(captureTaskArtifactBaselineMock).toHaveBeenCalledTimes(1);
    expect(captureTaskArtifactBaselineMock).toHaveBeenCalledWith({
      workspacePath: 'C:\\trusted-workspace',
      taskId: 'task-1',
    });

    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });
    expect(
      createMessage(
        {},
        {
          id: 'assistant-incoming',
          taskId: 'task-1',
          role: 'assistant',
          content: '完成',
          timestamp: '2026-09-16T00:00:02.000Z',
          sessionKey: 'session-task-1',
          toolCalls: [{ id: 'tool-1', status: 'done' }],
        },
      ),
    ).toEqual({ ok: true });
    await flushJobs();

    expect(autoExtractArtifactsMock).toHaveBeenCalledTimes(1);
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledWith({
      workspacePath: 'C:\\trusted-workspace',
      taskId: 'task-1',
      messageId: 'assistant-persisted',
      baseline: {},
    });
    expect(autoExtractArtifactsMock.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileTaskArtifactsMock.mock.invocationCallOrder[0],
    );
    expect(webContentsSendMock).toHaveBeenCalledWith('artifact:saved', expect.objectContaining({ id: 'artifact-1' }));

    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });
    expect(
      createMessage(
        {},
        {
          id: 'assistant-replay',
          taskId: 'task-1',
          role: 'assistant',
          content: '完成',
          timestamp: '2026-09-16T00:00:02.000Z',
          sessionKey: 'session-task-1',
        },
      ),
    ).toEqual({ ok: true });
    await flushJobs();
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile while a tool call is still running', async () => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-running' });

    const result = handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-running',
        taskId: 'task-1',
        role: 'assistant',
        content: 'working',
        timestamp: '2026-09-16T00:00:01.000Z',
        sessionKey: 'session-task-1',
        toolCalls: [{ id: 'tool-1', status: 'running' }],
      },
    );
    expect(result).toEqual({ ok: true });
    await flushJobs();
    expect(autoExtractArtifactsMock).not.toHaveBeenCalled();
    expect(reconcileTaskArtifactsMock).not.toHaveBeenCalled();
  });

  it('finalizes a tool-only assistant message and clears the completed run', async () => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'tool-only-final' }).mockReturnValueOnce({ gid: 'gateway-1' });

    expect(
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'tool-only-final',
          taskId: 'task-1',
          role: 'assistant',
          content: '',
          timestamp: '2026-09-16T00:00:02.000Z',
          sessionKey: 'session-task-1',
          toolCalls: [{ id: 'tool-1', status: 'done' }],
        },
      ),
    ).toEqual({ ok: true });
    await flushJobs();
    expect(autoExtractArtifactsMock).toHaveBeenCalledTimes(1);
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledTimes(1);

    selectGetMock.mockReturnValueOnce({ id: 'tool-only-replay' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'tool-only-replay',
        taskId: 'task-1',
        role: 'assistant',
        content: '',
        timestamp: '2026-09-16T00:00:03.000Z',
        sessionKey: 'session-task-1',
        toolCalls: [{ id: 'tool-2', status: 'done' }],
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledTimes(1);
  });

  it('does not clear a newer retry run when an older reconciliation finishes later', async () => {
    captureTaskArtifactBaselineMock
      .mockResolvedValueOnce({ 'a-before.txt': 'a' })
      .mockResolvedValueOnce({ 'b-before.txt': 'b' });
    let finishFirst!: (value: unknown) => void;
    reconcileTaskArtifactsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-first' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-first',
        taskId: 'task-1',
        role: 'assistant',
        content: 'first',
        timestamp: '2026-09-16T00:00:01.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-retry' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-retry',
        taskId: 'task-1',
        role: 'assistant',
        content: 'retry',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledTimes(2);
    expect(reconcileTaskArtifactsMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ baseline: { 'a-before.txt': 'a' } }),
    );
    expect(reconcileTaskArtifactsMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({ baseline: { 'b-before.txt': 'b' } }),
    );
    finishFirst({ saved: [], existing: [], missing: [], skipped: [], budgetExhausted: false });
    await flushJobs();
  });

  it('consumes same-session runs FIFO when B begins before A terminal persistence', async () => {
    captureTaskArtifactBaselineMock
      .mockResolvedValueOnce({ 'a-before.txt': 'a' })
      .mockResolvedValueOnce({ 'b-before.txt': 'b' });
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');

    for (const [id, content] of [
      ['assistant-a', 'A done'],
      ['assistant-b', 'B done'],
    ]) {
      selectGetMock.mockReturnValueOnce({ id }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id,
          taskId: 'task-1',
          role: 'assistant',
          content,
          timestamp: `2026-09-16T00:00:0${id.endsWith('a') ? '1' : '2'}.000Z`,
          sessionKey: 'session-task-1',
        },
      );
      await flushJobs();
    }

    expect(reconcileTaskArtifactsMock).toHaveBeenCalledTimes(2);
    expect(reconcileTaskArtifactsMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ baseline: { 'a-before.txt': 'a' } }),
    );
    expect(reconcileTaskArtifactsMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({ baseline: { 'b-before.txt': 'b' } }),
    );
  });

  it('strictly binds out-of-order terminal messages to gateway run ids', async () => {
    captureTaskArtifactBaselineMock
      .mockResolvedValueOnce({ 'a-before.txt': 'a' })
      .mockResolvedValueOnce({ 'b-before.txt': 'b' });
    const { beginArtifactRun, bindArtifactRun, registerDataHandlers } =
      await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    const tokenA = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    const tokenB = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    bindArtifactRun('task-1', 'session-task-1', tokenA, 'run-a');
    bindArtifactRun('task-1', 'session-task-1', tokenB, 'run-b');

    for (const [id, runId] of [
      ['assistant-b', 'run-b'],
      ['assistant-a', 'run-a'],
    ]) {
      selectGetMock.mockReturnValueOnce({ id }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id,
          taskId: 'task-1',
          role: 'assistant',
          content: `${runId} done`,
          timestamp: `2026-09-16T00:00:0${runId === 'run-a' ? '1' : '2'}.000Z`,
          sessionKey: 'session-task-1',
          runId,
        },
      );
      await flushJobs();
    }

    expect(reconcileTaskArtifactsMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ messageId: 'assistant-b', baseline: { 'b-before.txt': 'b' } }),
    );
    expect(reconcileTaskArtifactsMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({ messageId: 'assistant-a', baseline: { 'a-before.txt': 'a' } }),
    );
  });

  it('does not let a completed assistant replay consume the following run', async () => {
    captureTaskArtifactBaselineMock
      .mockResolvedValueOnce({ 'a-before.txt': 'a' })
      .mockResolvedValueOnce({ 'b-before.txt': 'b' });
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');

    selectGetMock.mockReturnValueOnce({ id: 'assistant-a' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-a-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: 'A done',
        timestamp: '2026-09-16T00:00:01.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-a' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-a-replay',
        taskId: 'task-1',
        role: 'assistant',
        content: 'A done',
        timestamp: '2026-09-16T00:00:01.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    selectGetMock.mockReturnValueOnce({ id: 'assistant-b' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-b',
        taskId: 'task-1',
        role: 'assistant',
        content: 'B done',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    expect(reconcileTaskArtifactsMock).toHaveBeenCalledTimes(2);
    expect(reconcileTaskArtifactsMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({ messageId: 'assistant-b', baseline: { 'b-before.txt': 'b' } }),
    );
  });

  it('fails the session closed when completed-message dedupe TTL expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    captureTaskArtifactBaselineMock
      .mockResolvedValueOnce({ 'a-before.txt': 'a' })
      .mockResolvedValueOnce({ 'b-before.txt': 'b' });
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-a' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-a',
        taskId: 'task-1',
        role: 'assistant',
        content: 'A',
        timestamp: '2026-09-16T00:00:01.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(25 * 60 * 60 * 1000);
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-b' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-b',
        taskId: 'task-1',
        role: 'assistant',
        content: 'B',
        timestamp: '2026-09-17T01:00:01.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('bounds completed-message dedupe and fails evicted sessions closed', async () => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    for (let index = 0; index < 2050; index += 1) {
      const taskId = `dedupe-task-${index}`;
      const sessionKey = `dedupe-session-${index}`;
      beginArtifactRun('C:\\trusted-workspace', taskId, sessionKey);
      selectGetMock.mockReturnValueOnce({ id: `assistant-${index}` }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id: `assistant-${index}`,
          taskId,
          role: 'assistant',
          content: 'done',
          timestamp: `2026-09-16T00:00:00.${String(index).padStart(4, '0')}Z`,
          sessionKey,
        },
      );
      await flushMicrotasks();
    }
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledTimes(2050);

    beginArtifactRun('C:\\trusted-workspace', 'dedupe-task-0', 'dedupe-session-0');
    selectGetMock.mockReturnValueOnce({ id: 'after-limit' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'after-limit',
        taskId: 'dedupe-task-0',
        role: 'assistant',
        content: 'must fail closed',
        timestamp: '2026-09-17T00:00:00.000Z',
        sessionKey: 'dedupe-session-0',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledTimes(2050);
  });

  it('keeps an expired run as a tombstone so its late final cannot steal B', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    captureTaskArtifactBaselineMock
      .mockResolvedValueOnce({ 'a-before.txt': 'a' })
      .mockResolvedValueOnce({ 'b-before.txt': 'b' });
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    now.mockReturnValue(16 * 60 * 1000);
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');

    selectGetMock.mockReturnValueOnce({ id: 'assistant-a' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-a',
        taskId: 'task-1',
        role: 'assistant',
        content: 'late A',
        timestamp: '2026-09-16T00:00:01.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).not.toHaveBeenCalled();

    selectGetMock.mockReturnValueOnce({ id: 'assistant-b' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-b',
        taskId: 'task-1',
        role: 'assistant',
        content: 'B',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'assistant-b', baseline: { 'b-before.txt': 'b' } }),
    );
    now.mockRestore();
  });

  it('consumes a failed-baseline slot without stealing the following run', async () => {
    captureTaskArtifactBaselineMock
      .mockRejectedValueOnce(new Error('baseline failed'))
      .mockResolvedValueOnce({ 'b-before.txt': 'b' });
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');

    selectGetMock.mockReturnValueOnce({ id: 'assistant-a' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-a',
        taskId: 'task-1',
        role: 'assistant',
        content: 'A done',
        timestamp: '2026-09-16T00:00:01.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).not.toHaveBeenCalled();

    selectGetMock.mockReturnValueOnce({ id: 'assistant-b' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-b',
        taskId: 'task-1',
        role: 'assistant',
        content: 'B done',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseline: { 'b-before.txt': 'b' } }),
    );
  });

  it('keeps failed dispatch A as a tombstone and leaves same-session B queued', async () => {
    captureTaskArtifactBaselineMock
      .mockResolvedValueOnce({ 'a-before.txt': 'a' })
      .mockResolvedValueOnce({ 'b-before.txt': 'b' });
    const { beginArtifactRun, cancelArtifactRun, registerDataHandlers } =
      await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    const tokenA = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    cancelArtifactRun('task-1', 'session-task-1', tokenA);

    selectGetMock.mockReturnValueOnce({ id: 'assistant-a-late' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-a-late',
        taskId: 'task-1',
        role: 'assistant',
        content: 'A arrived after an uncertain failure',
        timestamp: '2026-09-16T00:00:01.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).not.toHaveBeenCalled();

    selectGetMock.mockReturnValueOnce({ id: 'assistant-b' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-b',
        taskId: 'task-1',
        role: 'assistant',
        content: 'B done',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'assistant-b', baseline: { 'b-before.txt': 'b' } }),
    );
  });

  it('correlates a late terminal run id to the oldest unbound tombstone', async () => {
    captureTaskArtifactBaselineMock
      .mockResolvedValueOnce({ 'a-before.txt': 'a' })
      .mockResolvedValueOnce({ 'b-before.txt': 'b' })
      .mockResolvedValueOnce({ 'c-before.txt': 'c' });
    const { beginArtifactRun, bindArtifactRun, cancelArtifactRun, registerDataHandlers } =
      await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    const tokenA = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    cancelArtifactRun('task-1', 'session-task-1', tokenA);
    const tokenB = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    bindArtifactRun('task-1', 'session-task-1', tokenB, 'run-b');

    for (const [id, runId] of [
      ['assistant-a', 'run-a'],
      ['assistant-b', 'run-b'],
    ]) {
      selectGetMock.mockReturnValueOnce({ id }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id,
          taskId: 'task-1',
          role: 'assistant',
          content: id,
          timestamp: `2026-09-16T00:00:0${id.endsWith('a') ? '1' : '2'}.000Z`,
          sessionKey: 'session-task-1',
          runId,
        },
      );
      await flushJobs();
    }

    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-c' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-c',
        taskId: 'task-1',
        role: 'assistant',
        content: 'C',
        timestamp: '2026-09-16T00:00:03.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    expect(reconcileTaskArtifactsMock).toHaveBeenCalledTimes(2);
    expect(reconcileTaskArtifactsMock.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ messageId: 'assistant-b', baseline: { 'b-before.txt': 'b' } }),
      expect.objectContaining({ messageId: 'assistant-c', baseline: { 'c-before.txt': 'c' } }),
    ]);
  });

  it('logs reconciliation failure without changing successful assistant persistence', async () => {
    reconcileTaskArtifactsMock.mockRejectedValueOnce(new Error('scan failed'));
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'user-1' });
    expect(
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'user-1',
          taskId: 'task-1',
          role: 'user',
          content: 'make it',
          timestamp: '2026-09-16T00:00:00.000Z',
          sessionKey: 'session-task-1',
        },
      ),
    ).toEqual({ ok: true });
    await flushJobs();
    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });

    const result = handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: 'done',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    expect(result).toEqual({ ok: true });
    await flushJobs();
    expect(consoleErrorMock).toHaveBeenCalledWith(
      '[artifact_reconcile_failed]',
      expect.objectContaining({ taskId: 'task-1', messageId: 'assistant-persisted', error: expect.any(Error) }),
    );

    selectGetMock.mockReturnValueOnce({ id: 'assistant-after-failure' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-after-failure',
        taskId: 'task-1',
        role: 'assistant',
        content: 'replayed',
        timestamp: '2026-09-16T00:00:03.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).toHaveBeenCalledTimes(1);
  });

  it('expires old runs and bounds the registry so abandoned sends cannot live forever', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-ttl', 'session-expired');
    now.mockReturnValue(24 * 60 * 60 * 1000);
    beginArtifactRun('C:\\trusted-workspace', 'task-live', 'session-live');

    selectGetMock.mockReturnValueOnce({ id: 'expired-final' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'expired-final',
        taskId: 'task-ttl',
        role: 'assistant',
        content: 'late',
        timestamp: '2026-09-17T00:00:00.000Z',
        sessionKey: 'session-expired',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).not.toHaveBeenCalled();

    for (let index = 0; index < 140; index += 1) {
      beginArtifactRun('C:\\trusted-workspace', `task-${index}`, `bounded-${index}`);
    }
    selectGetMock.mockReturnValueOnce({ id: 'evicted-final' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'evicted-final',
        taskId: 'task-0',
        role: 'assistant',
        content: 'too old',
        timestamp: '2026-09-17T00:00:01.000Z',
        sessionKey: 'bounded-0',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).not.toHaveBeenCalled();

    beginArtifactRun('C:\\trusted-workspace', 'task-0', 'bounded-0');
    selectGetMock.mockReturnValueOnce({ id: 'desynchronized-final' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'desynchronized-final',
        taskId: 'task-0',
        role: 'assistant',
        content: 'must fail closed',
        timestamp: '2026-09-17T00:00:02.000Z',
        sessionKey: 'bounded-0',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it('cancels a claimed run before reconciliation begins', async () => {
    let resolveBaseline!: (value: { [key: string]: string }) => void;
    captureTaskArtifactBaselineMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBaseline = resolve;
      }),
    );
    const { beginArtifactRun, cancelArtifactRunsForSession, registerDataHandlers } =
      await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-aborted' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-aborted',
        taskId: 'task-1',
        role: 'assistant',
        content: 'done',
        timestamp: '2026-09-16T00:00:01.000Z',
        sessionKey: 'session-task-1',
      },
    );
    cancelArtifactRunsForSession('session-task-1');
    resolveBaseline({ 'before.txt': 'before' });
    await flushJobs();
    expect(reconcileTaskArtifactsMock).not.toHaveBeenCalled();
  });

  it('⭐ 有文件没生成时推一次 docgen:failed —— 用户不该只看到"我做好了"', async () => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });

    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: ['好的。', '', '```docgen', '{ 不是 json', '```', '', '已经放好了。'].join('\n'),
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    expect(webContentsSendMock).toHaveBeenCalledWith('docgen:failed', [{ code: 'request-invalid' }]);
  });

  it('两份都坏也只推**一次**（一次会话一条提示，不是每份弹一个）', async () => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });

    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: ['```docgen', '{ 坏的', '```', '', '```docgen', '{ 也坏的', '```'].join('\n'),
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    const calls = webContentsSendMock.mock.calls.filter((call) => call[0] === 'docgen:failed');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual([{ code: 'request-invalid' }, { code: 'request-invalid' }]);
  });

  it('⭐ 换行被拒 ⇒ 推的是**带位置的结构化原因**（界面才说得出"第几页第几条"）', async () => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });

    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: [
          '好的。',
          '',
          '```docgen',
          JSON.stringify({
            kind: 'pptx',
            title: '内测汇报',
            slides: [{ title: '本月完成', bullets: ['第一条\r\n第二条'] }],
          }),
          '```',
        ].join('\n'),
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    const calls = webContentsSendMock.mock.calls.filter((call) => call[0] === 'docgen:failed');
    expect(calls, '一次消息只推一次').toHaveLength(1);
    expect(calls[0][1]).toEqual([{ code: 'presentation-slide-bullet-multiline', format: 'pptx', page: 1, bullet: 1 }]);
  });

  it('负对照：普通回复（没有 docgen 块）**一次都不该推** docgen:failed', async () => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });

    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: '今天天气不错。',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    expect(webContentsSendMock.mock.calls.filter((call) => call[0] === 'docgen:failed')).toHaveLength(0);
  });

  it('⭐ 用户明确要 PPT、但本轮只有 markdown/html ⇒ 结果守卫必须报缺 PPTX', async () => {
    reconcileTaskArtifactsMock.mockResolvedValue({
      saved: [
        { id: 'snippet', name: 'snippet.md', localPath: 'task-1/snippet.md' },
        { id: 'preview', name: 'preview.html', localPath: 'task-1/preview.html' },
      ],
      existing: [],
      updated: [],
      missing: [],
      skipped: [],
      budgetExhausted: false,
    });
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1', {
      userContent: '请帮我做一份产品发布会 PPT',
    });
    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });

    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: '方案已经整理完毕。',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    expect(webContentsSendMock).toHaveBeenCalledWith('artifact:claim-violation', {
      taskId: 'task-1',
      missing: ['PPT/PPTX 演示文稿'],
    });
  });

  it('用户明确要 PPT 且本轮新增了 pptx ⇒ 不报结果缺失', async () => {
    reconcileTaskArtifactsMock.mockResolvedValue({
      saved: [{ id: 'deck', name: 'deck.pptx', localPath: 'task-1/deck.pptx' }],
      existing: [],
      updated: [],
      missing: [],
      skipped: [],
      budgetExhausted: false,
    });
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1', {
      userContent: '给我生成一份 PPTX 演示文稿',
    });
    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });

    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: '已完成。',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    expect(webContentsSendMock).not.toHaveBeenCalledWith('artifact:claim-violation', expect.anything());
  });

  it('用户明确要 HTML 但本轮没有网页 ⇒ 结果守卫明确报缺 HTML', async () => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1', {
      userContent: '帮我生成一个 HTML 网页',
    });
    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });

    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: '内容已整理完成。',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    expect(webContentsSendMock).toHaveBeenCalledWith('artifact:claim-violation', {
      taskId: 'task-1',
      missing: ['HTML 网页'],
    });
  });

  it('用户明确要 HTML 且本轮新增了真实 .html ⇒ 不报结果缺失', async () => {
    reconcileTaskArtifactsMock.mockResolvedValue({
      saved: [{ id: 'page', name: 'report.html', localPath: 'task-1/report.html' }],
      existing: [],
      updated: [],
      missing: [],
      skipped: [],
      budgetExhausted: false,
    });
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1', {
      userContent: '帮我生成一个 HTML 网页',
    });
    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });

    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: '已完成。',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    expect(webContentsSendMock).not.toHaveBeenCalledWith('artifact:claim-violation', expect.anything());
  });

  it('clears every artifact run for a deleted task', async () => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-deleted', 'session-deleted');
    expect(handleMap.get('data:delete-task')!({}, { id: 'task-deleted' })).toEqual({ ok: true });

    selectGetMock.mockReturnValueOnce({ id: 'late-assistant' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'late-assistant',
        taskId: 'task-deleted',
        role: 'assistant',
        content: 'late',
        timestamp: '2026-09-17T00:00:02.000Z',
        sessionKey: 'session-deleted',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).not.toHaveBeenCalled();
  });

  /**
   * ⭐ **第二个根**接上了没有（2026-09-27）。
   *
   * 现场：助手用 exec 在它自己的工作区里生成 pptx / html，产物面板却是空的 ——
   * 真机 `.clawwork.db` 实测 `SELECT COUNT(*) FROM artifacts` = **0**。
   *
   * ⚠️ 这两条**必须**走真实的 `resolveAgentWorkspace`（只把网关客户端换成桩），
   *    否则验的是"我们 mock 得对"，而不是"接线真的接上了"。
   */
  it('⭐ 助手工作区解析得出来 ⇒ 第二条 reconcile 会跑，且带 rootKind:agent', async () => {
    const { getGatewayClient } = await import('../src/main/ws/index.js');
    vi.mocked(getGatewayClient).mockReturnValue({
      listAgentFiles: async () => ({ agentId: 'main', workspace: 'C:\\agent-ws', files: [] }),
    } as never);

    const { beginArtifactRunForGatewayDispatch, registerDataHandlers } =
      await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    const createMessage = handleMap.get('data:create-message')!;
    const sessionKey = 'agent:main:clawwork:task-1';

    selectGetMock.mockReturnValueOnce({ id: 'task-1' });
    beginArtifactRunForGatewayDispatch({
      gatewayId: 'gateway-1',
      sessionKey,
      taskId: 'task-1',
      userContent: 'create a file',
    });
    await flushJobs(); // 让第二条基线跑完

    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });
    createMessage(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: '完成',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey,
        toolCalls: [{ id: 'tool-1', status: 'done' }],
      },
    );
    await flushJobs();

    const agentCall = reconcileTaskArtifactsMock.mock.calls.find(
      (call) => (call[0] as { rootKind?: string }).rootKind === 'agent',
    );
    expect(agentCall, '第二条 reconcile 没跑 —— 第二个根没接上').toBeTruthy();
    expect(agentCall?.[0]).toMatchObject({ workspacePath: 'C:\\agent-ws', rootKind: 'agent' });
    // 应用根那条照旧跑：两条**各跑各的**，不是二选一。
    expect(
      reconcileTaskArtifactsMock.mock.calls.some((call) => (call[0] as { rootKind?: string }).rootKind === undefined),
    ).toBe(true);
  });

  it('⭐ 助手根登记出来的产物会**推送**给界面（不推的话面板还是空的）', async () => {
    const { getGatewayClient } = await import('../src/main/ws/index.js');
    vi.mocked(getGatewayClient).mockReturnValue({
      listAgentFiles: async () => ({ agentId: 'main', workspace: 'C:\\agent-ws', files: [] }),
    } as never);
    // ⚠️ **只给 agent 那条**返回产物。用一个对所有调用都返回同样结果的 mock，
    //    这条用例会被**第一条** reconcile 推的那一份满足 —— 于是"拆掉第二条 reconcile"
    //    它照样绿（这正是变异验证第一次跑出来的结果：假绿）。
    reconcileTaskArtifactsMock.mockImplementation(async (input: { rootKind?: string }) =>
      input.rootKind === 'agent'
        ? {
            saved: [{ id: 'agent-artifact', name: 'deck.pptx', root: 'agent', localPath: 'deck.pptx' }],
            existing: [],
            updated: [],
            missing: [],
            skipped: [],
            budgetExhausted: false,
          }
        : { saved: [], existing: [], updated: [], missing: [], skipped: [], budgetExhausted: false },
    );

    const { beginArtifactRunForGatewayDispatch, registerDataHandlers } =
      await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    const createMessage = handleMap.get('data:create-message')!;
    const sessionKey = 'agent:main:clawwork:task-1';

    selectGetMock.mockReturnValueOnce({ id: 'task-1' });
    beginArtifactRunForGatewayDispatch({
      gatewayId: 'gateway-1',
      sessionKey,
      taskId: 'task-1',
      userContent: 'create a file',
    });
    await flushJobs();

    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });
    createMessage(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: '完成',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey,
        toolCalls: [{ id: 'tool-1', status: 'done' }],
      },
    );
    await flushJobs();

    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:saved',
      expect.objectContaining({ id: 'agent-artifact', root: 'agent' }),
    );
  });

  /**
   * ⭐ RED **E**（规格原文）：**docgen 与 slidegen 两条链都要覆盖** ——
   * "不允许一条链修好、另一条链仍然 8K 截断"。
   *
   * 场景就是正式包 1.0.2 的真机形状：助手把整份源码写进回复 ⇒ 运行时在投影时
   * 截到 8,000 字符、末尾追加 `...(truncated)...` ⇒ **开头围栏在、结尾围栏没了**。
   *
   * 这里 `getGatewayClient` 被 mock 成 `undefined`（该文件顶部**本来就这么 mock**），
   * 也就是"取不回完整原文"那一档 ⇒ 正确处置是**一份都不生成**，并推一条可重试的失败。
   * ⭐ 关键断言是"**没有生成**"：如果哪条链偷偷拿截断文本去排版，这里会红。
   */
  describe('被显示层截断的回复：三条结构化产物链都覆盖，且绝不拿截断文本生成', () => {
    /** 造一条被截断的回复：**开头围栏在、结尾围栏没了**。 */
    const cutReply = (fence: 'slidegen' | 'docgen'): string =>
      `版面我排好了。\n\`\`\`${fence}\n// title: 长演示\n<Slide>\n  …写到这里被切断了\n\n...(truncated)...`;

    /** 走一遍真实的收尾路径。 */
    async function persistAssistant(content: string): Promise<void> {
      const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
      registerDataHandlers();
      beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
      selectGetMock.mockReturnValueOnce({ id: 'assistant-cut' }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'assistant-cut',
          taskId: 'task-1',
          role: 'assistant',
          content,
          timestamp: '2026-09-28T00:00:01.000Z',
          sessionKey: 'session-task-1',
        },
      );
      await flushJobs();
    }

    it('⭐ slidegen 链：取不回完整原文 ⇒ 推 slidegen-reply-unavailable，**不出片**', async () => {
      await persistAssistant(cutReply('slidegen'));
      expect(webContentsSendMock).toHaveBeenCalledWith('slidegen:failed', [{ code: 'slidegen-reply-unavailable' }]);
    });

    it('⭐ docgen 链：**同一条规则** ⇒ 推 docgen-reply-unavailable（不是只有 slidegen 修好了）', async () => {
      await persistAssistant(cutReply('docgen'));
      expect(webContentsSendMock).toHaveBeenCalledWith('docgen:failed', [{ code: 'docgen-reply-unavailable' }]);
    });

    it('⭐ 负对照：只写了 PPT 的长回复**不该**弹出"文件没能生成"（那是假失败）', async () => {
      await persistAssistant(cutReply('slidegen'));
      expect(webContentsSendMock).not.toHaveBeenCalledWith('docgen:failed', expect.anything());
    });

    it('⭐ 负对照：**没被截断**的普通回复不受影响（一次网关请求都不发）', async () => {
      await persistAssistant('就是一句普通回复，没有任何围栏，也没有截断标记。');
      expect(webContentsSendMock).not.toHaveBeenCalledWith('slidegen:failed', expect.anything());
      expect(webContentsSendMock).not.toHaveBeenCalledWith('docgen:failed', expect.anything());
    });

    it('⭐ HTML 链使用按 runId 取回的完整原文，不把 8K 显示截断文本交给生成器', async () => {
      const sessionKey = 'session-task-1';
      const runId = 'run-html-1';
      const displayContent = '网页正在生成\n```htmlgen\n{"kind":"html"\n\n...(truncated)...';
      const fullContent = [
        '网页正在生成',
        '```htmlgen',
        '{"kind":"html","title":"完整网页","template":"brief","sections":[{"kind":"narrative","paragraphs":["完整内容"]}]}',
        '```',
      ].join('\n');
      getGatewayClientMock.mockReturnValue({
        httpBase: 'http://gateway.test',
        getChatHistory: vi.fn().mockResolvedValue({
          messages: [{ role: 'assistant', content: fullContent, __openclaw: { runId } }],
        }),
      });

      const { beginArtifactRun, bindArtifactRun, registerDataHandlers } =
        await import('../src/main/ipc/data-handlers.js');
      registerDataHandlers();
      const token = beginArtifactRun('C:\\trusted-workspace', 'task-1', sessionKey);
      bindArtifactRun('task-1', sessionKey, token, runId);
      selectGetMock.mockReturnValueOnce({ id: 'assistant-html' }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'assistant-html',
          taskId: 'task-1',
          role: 'assistant',
          runId,
          content: displayContent,
          timestamp: '2026-09-28T00:00:01.000Z',
          sessionKey,
        },
      );
      await flushJobs();

      expect(generateHtmlPagesFromMessageMock).toHaveBeenCalledWith(expect.objectContaining({ content: fullContent }));
    });

    it('⭐ 大写 `HTMLGEN` 开头围栏也会进入完整原文恢复', async () => {
      const sessionKey = 'session-task-1';
      const runId = 'run-html-uppercase';
      const displayContent = '网页正在生成\n```HTMLGEN\n{"kind":"html"\n\n...(truncated)...';
      const fullContent = [
        '```HTMLGEN',
        '{"kind":"html","title":"大写围栏","template":"brief","sections":[{"kind":"narrative","paragraphs":["全文"]}]}',
        '```',
      ].join('\n');
      getGatewayClientMock.mockReturnValue({
        getChatHistory: vi.fn().mockResolvedValue({
          messages: [{ role: 'assistant', content: fullContent, __openclaw: { runId } }],
        }),
      });

      const { beginArtifactRun, bindArtifactRun, registerDataHandlers } =
        await import('../src/main/ipc/data-handlers.js');
      registerDataHandlers();
      const token = beginArtifactRun('C:\\trusted-workspace', 'task-1', sessionKey);
      bindArtifactRun('task-1', sessionKey, token, runId);
      selectGetMock.mockReturnValueOnce({ id: 'assistant-html-uppercase' }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'assistant-html-uppercase',
          taskId: 'task-1',
          role: 'assistant',
          runId,
          content: displayContent,
          timestamp: '2026-09-28T00:00:02.000Z',
          sessionKey,
        },
      );
      await flushJobs();

      expect(generateHtmlPagesFromMessageMock).toHaveBeenCalledWith(expect.objectContaining({ content: fullContent }));
    });
  });
});
