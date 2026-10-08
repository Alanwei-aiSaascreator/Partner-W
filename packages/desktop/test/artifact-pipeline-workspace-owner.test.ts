import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  extract: vi.fn(),
  reconcile: vi.fn(),
  documents: vi.fn(),
  slides: vi.fn(),
  html: vi.fn(),
  gateway: vi.fn(),
  recover: vi.fn(),
  row: {} as Record<string, unknown>,
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(name, handler) },
  BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: mocks.send } }] },
}));
vi.mock('../src/main/db/index.js', () => {
  const db = {
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ run: () => undefined }) }) }),
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({ where: () => ({ get: () => (fields && 'role' in fields ? undefined : mocks.row) }) }),
    }),
  };
  return { getDb: () => db, getSqlite: () => null, isDbReady: () => true };
});
vi.mock('../src/main/workspace/config.js', () => ({ getWorkspacePath: () => 'C:\\workspace' }));
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: mocks.gateway }));
vi.mock('../src/main/artifact/recover-full-reply.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recoverFullReply: mocks.recover,
  historyFetcherFrom: () => vi.fn(),
}));
vi.mock('../src/main/ipc/team-meeting-handlers.js', () => ({ withTeamMeetingTaskDeletion: vi.fn() }));
vi.mock('../src/main/artifact/auto-extract.js', () => ({ autoExtractArtifacts: mocks.extract }));
vi.mock('../src/main/artifact/reconcile.js', () => ({
  captureTaskArtifactBaseline: async () => ({}),
  reconcileTaskArtifacts: mocks.reconcile,
}));
vi.mock('../src/main/docgen/generate.js', () => ({ generateDocumentsFromMessage: mocks.documents }));
vi.mock('../src/main/htmlgen/generate.js', () => ({ generateHtmlPagesFromMessage: mocks.html }));
vi.mock('../src/main/slidegen/generate.js', () => ({ generateSlidesFromMessage: mocks.slides }));
const msg = {
  id: 'message',
  taskId: 'task',
  sessionKey: 'session',
  runId: 'run',
  role: 'assistant',
  content: 'hello',
  timestamp: '2026-09-30T00:00:00Z',
};
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};
/**
 * **应用根**那条 reconcile 链的调用。
 *
 * ⚠️ 2026-10-07 起一轮收尾会跑**两条**链：应用根（缺省 `rootKind`）与
 *    **应用工作区根层**（第三个根，`rootKind:'workspace-root'`）。这些用例钉的是
 *    应用根那条链在不在/跑了几次，所以**按链**问 —— 数总次数会变成"第三条链在不在"。
 */
const appRootReconcileCalls = () =>
  mocks.reconcile.mock.calls.filter(
    ([input]) => ((input as { rootKind?: string }).rootKind ?? 'workspace') === 'workspace',
  );
async function setup(withRun = true) {
  const scope = await import('../src/main/workspace/scope.js');
  scope.setWorkspaceDatabaseOwner({});
  const handlers = await import('../src/main/ipc/data-handlers.js');
  handlers.registerDataHandlers();
  const token = withRun ? handlers.beginArtifactRun('C:\\workspace', msg.taskId, msg.sessionKey) : '';
  if (withRun) handlers.bindArtifactRun(msg.taskId, msg.sessionKey, token, msg.runId);
  return {
    ...handlers,
    scope,
    token,
    create: (content = msg.content) => mocks.handlers.get('data:create-message')!({}, { ...msg, content }),
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.handlers.clear();
  mocks.row = { ...msg, gid: 'gateway' };
  mocks.extract.mockResolvedValue({ mediaFailures: [] });
  mocks.gateway.mockReturnValue(undefined);
  mocks.reconcile.mockResolvedValue({ saved: [], existing: [], missing: [], skipped: [], budgetExhausted: false });
  mocks.documents.mockResolvedValue({ saved: [], failed: [] });
  mocks.html.mockResolvedValue({ saved: [], failed: [] });
  mocks.slides.mockResolvedValue({ saved: [], failed: [], warnings: [] });
});

it.each(['extract', 'documents', 'html', 'slides', 'reconcile'] as const)(
  'does not broadcast old %s results after an owner replacement',
  async (stage) => {
    const run = await setup();
    let finish!: (result: unknown) => void;
    const blocked = mocks[stage];
    blocked.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    run.create();
    await flush();
    run.scope.setWorkspaceDatabaseOwner({});
    mocks.send.mockClear();
    finish(
      stage === 'extract'
        ? { mediaFailures: [{ fileName: 'old.mp4', reason: 'unavailable' }] }
        : stage !== 'reconcile'
          ? { saved: [{ name: 'old.pdf' }], failed: [{ code: 'request-invalid' }], warnings: [] }
          : { saved: [{ name: 'old.txt' }], existing: [], missing: [], skipped: [], budgetExhausted: false },
    );
    await flush();
    expect(mocks.send).not.toHaveBeenCalled();
  },
);

it('same mocked DB and path still reject stale history failure after opaque owner replacement', async () => {
  const run = await setup(false);
  let finish!: (result: unknown) => void;
  mocks.extract.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  run.create();
  await flush();
  run.scope.setWorkspaceDatabaseOwner({});
  mocks.send.mockClear();
  finish({ mediaFailures: [{ fileName: 'old.mp4', reason: 'unavailable' }] });
  await flush();
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each(['extract', 'documents', 'html', 'slides', 'reconcile'] as const)(
  'does not resume or settle an old pipeline after %s rejects',
  async (stage) => {
    const run = await setup();
    let reject!: (error: Error) => void;
    mocks[stage].mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    run.create();
    await flush();
    run.scope.setWorkspaceDatabaseOwner({});
    mocks.send.mockClear();
    reject(new Error('old workspace closed'));
    await flush();
    expect(mocks.send).not.toHaveBeenCalled();
    const next = run.beginArtifactRun('C:\\workspace', msg.taskId, msg.sessionKey);
    run.bindArtifactRun(msg.taskId, msg.sessionKey, next, msg.runId);
    run.create();
    await flush();
    expect(mocks.send).toHaveBeenCalledWith(
      'artifact:delivery-settled',
      expect.objectContaining({ status: 'succeeded' }),
    );
  },
);

it('old pending jobs cannot suppress a new run with identical task/message/run identities', async () => {
  const run = await setup();
  let finish!: (result: { mediaFailures: [] }) => void;
  mocks.extract.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  run.create();
  await flush();
  run.scope.setWorkspaceDatabaseOwner({});
  const next = run.beginArtifactRun('C:\\workspace', msg.taskId, msg.sessionKey);
  run.bindArtifactRun(msg.taskId, msg.sessionKey, next, msg.runId);
  run.create();
  await flush();
  expect(appRootReconcileCalls()).toHaveLength(1);
  mocks.send.mockClear();
  finish({ mediaFailures: [] });
  await flush();
  expect(appRootReconcileCalls()).toHaveLength(1);
  expect(mocks.send).not.toHaveBeenCalled();
});

it('completed-message deduplication belongs to the DB generation', async () => {
  const run = await setup();
  run.create();
  await flush();
  mocks.reconcile.mockClear();
  run.scope.setWorkspaceDatabaseOwner({});
  const next = run.beginArtifactRun('C:\\workspace', msg.taskId, msg.sessionKey);
  run.bindArtifactRun(msg.taskId, msg.sessionKey, next, msg.runId);
  run.create();
  await flush();
  expect(appRootReconcileCalls()).toHaveLength(1);
});

it('queued runs from a closed DB cannot claim messages in the new generation', async () => {
  const run = await setup();
  run.scope.setWorkspaceDatabaseOwner({});
  run.create();
  await flush();
  expect(mocks.reconcile).not.toHaveBeenCalled();
});
