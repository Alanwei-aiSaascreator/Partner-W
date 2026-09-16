import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();
const autoExtractArtifactsMock = vi.fn();
const captureTaskArtifactBaselineMock = vi.fn();
const reconcileTaskArtifactsMock = vi.fn();
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
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: vi.fn(() => undefined) }));
vi.mock('../src/main/artifact/auto-extract.js', () => ({ autoExtractArtifacts: autoExtractArtifactsMock }));
vi.mock('../src/main/artifact/reconcile.js', () => ({
  captureTaskArtifactBaseline: captureTaskArtifactBaselineMock,
  reconcileTaskArtifacts: reconcileTaskArtifactsMock,
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
});
