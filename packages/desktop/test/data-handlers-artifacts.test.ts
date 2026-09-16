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

  it('captures a trusted baseline for the user turn and reconciles once after extraction for the final assistant write', async () => {
    const { registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    const createMessage = handleMap.get('data:create-message')!;

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
      baseline: { 'before.txt': 'signature' },
      runStartedAt: '2026-09-16T00:00:00.000Z',
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
    const { registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
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

  it('logs reconciliation failure without changing successful assistant persistence', async () => {
    reconcileTaskArtifactsMock.mockRejectedValueOnce(new Error('scan failed'));
    const { registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
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
  });
});
