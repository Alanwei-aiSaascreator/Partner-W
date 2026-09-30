import { beforeEach, expect, it, vi } from 'vitest';
import type { ArtifactDeliveryActivity, ArtifactDeliveryPhase } from '@clawwork/shared';

type ProducerInput = { onActivity?: (phase: ArtifactDeliveryPhase) => void };
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
  return { getDb: () => db, isDbReady: () => true };
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
const frames = () =>
  mocks.send.mock.calls
    .filter(([name]) => name === 'artifact:delivery-activity')
    .map(([, payload]) => payload as ArtifactDeliveryActivity);
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

it('continues after model completion and finishes using the actual pipeline outcome', async () => {
  let complete!: (result: { mediaFailures: [] }) => void;
  mocks.extract.mockImplementation((input: ProducerInput) => {
    input.onActivity?.('downloading-media');
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const run = await setup();
  run.create();
  expect(frames().map((item) => item.status)).toEqual(['active']);
  complete({ mediaFailures: [] });
  await flush();
  expect(frames().map((item) => [item.phase, item.status])).toEqual([
    ['downloading-media', 'active'],
    ['reconciling-artifacts', 'active'],
    ['reconciling-artifacts', 'succeeded'],
  ]);
  expect(new Set(frames().map((item) => item.operationId)).size).toBe(1);
});

it.each(['failed', 'canceled'] as const)('preserves actual %s terminal state', async (status) => {
  const run = await setup();
  mocks.extract.mockImplementation(async (input: ProducerInput) => {
    input.onActivity?.('saving-artifacts');
    if (status === 'canceled') run.cancelArtifactRun(msg.taskId, msg.sessionKey, run.token);
    return { mediaFailures: status === 'failed' ? [{ fileName: 'video.mp4', reason: 'unavailable' }] : [] };
  });
  run.create();
  await flush();
  expect(frames().at(-1)?.status).toBe(status);
});

it('a scope replacement during a producer await cannot revive old activity', async () => {
  let complete!: (value: { mediaFailures: [] }) => void;
  let callback!: ProducerInput['onActivity'];
  mocks.extract.mockImplementation((input: ProducerInput) => {
    callback = input.onActivity;
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const run = await setup();
  run.create();
  run.scope.setWorkspaceDatabaseOwner({});
  callback?.('saving-artifacts');
  complete({ mediaFailures: [] });
  await flush();
  expect(frames()).toEqual([]);
});

it('history retries use independent operations and do not stay active after rejection', async () => {
  const run = await setup(false);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.extract.mockImplementationOnce(async (input: ProducerInput) => {
    input.onActivity?.('downloading-media');
    throw new Error('download failed');
  });
  run.create();
  await flush();
  mocks.extract.mockImplementationOnce(async (input: ProducerInput) => {
    input.onActivity?.('saving-artifacts');
    return { mediaFailures: [] };
  });
  run.create();
  await flush();
  expect(frames().map((item) => item.status)).toEqual(['active', 'failed', 'active', 'succeeded']);
  expect(frames()[0]?.operationId).not.toBe(frames()[2]?.operationId);
  error.mockRestore();
});

it('a history replay that performs no actual work emits no activity', async () => {
  const run = await setup(false);
  run.create();
  await flush();
  expect(frames()).toEqual([]);
});

it('unexpected recovery rejection terminates started work as failed', async () => {
  const run = await setup();
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.gateway.mockReturnValue({ httpBase: 'http://127.0.0.1:18789' });
  mocks.extract.mockImplementation(async (input: ProducerInput) => {
    input.onActivity?.('saving-artifacts');
    return { mediaFailures: [] };
  });
  mocks.recover.mockRejectedValue(new Error('unexpected history failure'));
  run.create('```docgen\n{}\n```');
  await flush();
  expect(frames().map((item) => item.status)).toEqual(['active', 'failed']);
  error.mockRestore();
});

it('a callback retained past settlement cannot restart an operation', async () => {
  const run = await setup();
  let callback: ProducerInput['onActivity'];
  mocks.extract.mockImplementation(async (input: ProducerInput) => {
    callback = input.onActivity;
    input.onActivity?.('saving-artifacts');
    return { mediaFailures: [] };
  });
  run.create();
  await flush();
  const count = frames().length;
  callback?.('downloading-media');
  expect(frames()).toHaveLength(count);
});

it('keeps review warnings as needs-review rather than successful completion', async () => {
  const run = await setup();
  mocks.slides.mockResolvedValue({
    saved: [],
    failed: [],
    warnings: [{ code: 'slidegen-element-out-of-bounds', page: 1 }],
  });
  run.create();
  await flush();
  expect(frames().at(-1)?.status).toBe('needs-review');
});
