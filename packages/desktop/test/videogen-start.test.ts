import { beforeEach, expect, it, vi } from 'vitest';
import { setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';
const mocks = vi.hoisted(() => ({
  generation: 1,
  key: 'key-a' as string | null,
  send: vi.fn(),
  phase: vi.fn(),
  finish: vi.fn(),
  capture: vi.fn(),
  generate: vi.fn(async () => ({
    saved: [{ id: 'video' }],
    failed: [] as import('@clawwork/shared').VideogenFailure[],
  })),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [{ webContents: { send: mocks.send } }] } }));
vi.mock('../src/main/artifact/delivery-operation.js', () => ({
  captureArtifactDeliveryOperation: () => {
    mocks.capture();
    return { phase: mocks.phase, finish: mocks.finish };
  },
}));
vi.mock('../src/main/debug/index.js', () => ({ getDebugLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../src/main/commercial/relay-key.js', () => ({ getActiveRelayKey: () => mocks.key }));
vi.mock('../src/main/commercial/license-generation.js', () => ({ getLicenseGeneration: () => mocks.generation }));
vi.mock('../src/main/commercial/relay-config.js', () => ({ activeRelayBaseUrl: () => 'https://relay.example' }));
vi.mock('../src/main/artifact/save.js', () => ({ findReplayArtifact: () => null, saveArtifactFromBuffer: vi.fn() }));
vi.mock('../src/main/videogen/generate.js', () => ({ generateVideosFromMessage: mocks.generate }));
vi.mock('../src/main/videogen/client.js', () => ({ createVideogenRelayClient: () => ({}) }));
const { startVideogenJobs } = await import('../src/main/videogen/start.js');
const input = {
  workspacePath: 'C:/ws',
  taskId: 'task',
  sessionKey: 'session',
  messageId: 'message',
  content: '```videogen\n{"prompt":"flower"}\n```',
};
beforeEach(() => {
  vi.clearAllMocks();
  setWorkspaceDatabaseOwner({});
  mocks.generation = 1;
  mocks.key = 'key-a';
  mocks.generate.mockResolvedValue({ saved: [{ id: 'video' }], failed: [] });
});
it('a canceled source cannot even create a delivery operation', () => {
  startVideogenJobs({ ...input, sourceCurrent: () => false });
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it.each(['generation', 'key', 'source', 'workspace', 'throw'] as const)(
  'suppresses stale %s results and failure toasts',
  async (kind) => {
    let source = true;
    mocks.generate.mockImplementationOnce(async () => {
      if (kind === 'generation') mocks.generation++;
      if (kind === 'key') mocks.key = 'key-b';
      if (kind === 'source' || kind === 'throw') source = false;
      if (kind === 'workspace') setWorkspaceDatabaseOwner({});
      if (kind === 'throw') throw new Error('old failure');
      return { saved: [{ id: 'old-video' }], failed: [] };
    });
    startVideogenJobs({ ...input, messageId: kind, sourceCurrent: () => source });
    await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('canceled'));
    expect(mocks.send).not.toHaveBeenCalled();
  },
);
it('Seedance active dedupe is bounded to the run; a finished message can recover again', async () => {
  const recoverable = { ...input, content: '```videogen\n{"model":"seedance-2.5","prompt":"flower"}\n```' };
  startVideogenJobs(recoverable);
  startVideogenJobs(recoverable);
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('succeeded'));
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  startVideogenJobs(recoverable);
  await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
  expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ sourceCurrent: expect.any(Function) }));
});
it.each([
  { code: 'videogen-billing-pending' as const },
  { code: 'videogen-timeout' as const, waitedMs: 1 },
  { code: 'videogen-task-failed' as const, upstreamCode: null },
])('unknown outcome %j settles as needs-review', async (failure) => {
  mocks.generate.mockResolvedValueOnce({ saved: [], failed: [failure] });
  startVideogenJobs({ ...input, messageId: failure.code });
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('needs-review'));
});

it('retains the source run only while its background job is active and releases on cancellation', async () => {
  let current = true;
  let complete: () => void = () => {
    throw new Error('background not started');
  };
  mocks.generate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = () => resolve({ saved: [{ id: 'late' }], failed: [] });
      }),
  );
  const release = vi.fn(),
    retain = vi.fn(() => release);
  const retainedInput = { ...input, messageId: 'retained-source', sourceCurrent: () => current, retainSource: retain };
  startVideogenJobs(retainedInput);
  startVideogenJobs(retainedInput);
  expect(retain).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
  current = false;
  complete();
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('canceled'));
  expect(release).toHaveBeenCalledTimes(1);
  expect(mocks.send).not.toHaveBeenCalled();
  startVideogenJobs(retainedInput);
  expect(retain).toHaveBeenCalledTimes(1);
});
it('retained source releases when the background generator throws', async () => {
  const release = vi.fn();
  mocks.generate.mockRejectedValueOnce(new Error('fixture failure'));
  startVideogenJobs({ ...input, messageId: 'retained-throw', retainSource: () => release });
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
});

it('unknown H3 same-message replay never starts a second paid attempt but releases its source lease', async () => {
  const release = vi.fn(),
    retain = vi.fn(() => release);
  const { generateVideosFromMessage } = await vi.importActual<typeof import('../src/main/videogen/generate.js')>(
    '../src/main/videogen/generate.js',
  );
  const { createVideogenRelayClient } = await vi.importActual<typeof import('../src/main/videogen/client.js')>(
    '../src/main/videogen/client.js',
  );
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    throw new Error('provider acceptance ACK unknown');
  });
  const client = createVideogenRelayClient({ baseUrl: 'https://relay.example', relayKey: 'fixture', fetchImpl });
  mocks.generate.mockImplementationOnce(async () => generateVideosFromMessage({ ...input, client }));
  const legacy = { ...input, messageId: 'h3-unknown', retainSource: retain };
  startVideogenJobs(legacy);
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('needs-review'));
  expect(release).toHaveBeenCalledTimes(1);
  startVideogenJobs(legacy);
  await Promise.resolve();
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
  expect(retain).toHaveBeenCalledTimes(1);
});
