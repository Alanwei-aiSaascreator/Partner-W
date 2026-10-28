import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  phase: vi.fn(),
  finish: vi.fn(),
  send: vi.fn(),
  generation: 1,
  key: 'customer-key' as string | null,
  generate: vi.fn(async () => ({
    saved: [{ id: 'image' }],
    failed: [] as import('@clawwork/shared').ImagegenFailure[],
  })),
  readLicense: vi.fn(async () => ({ ok: true, result: { activated: true, licenseId: 'license' } })),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] },
}));
vi.mock('../src/main/artifact/delivery-operation.js', () => ({
  captureArtifactDeliveryOperation: () => ({ phase: mocks.phase, finish: mocks.finish }),
}));
vi.mock('../src/main/commercial/relay-config.js', () => ({ activeRelayBaseUrl: () => 'https://relay.example' }));
vi.mock('../src/main/commercial/relay-key.js', () => ({ getActiveRelayKey: () => mocks.key }));
vi.mock('../src/main/commercial/license-generation.js', () => ({ getLicenseGeneration: () => mocks.generation }));
vi.mock('../src/main/commercial/license.js', () => ({ readLicenseStatus: mocks.readLicense }));
vi.mock('../src/main/imagegen/generate.js', () => ({ generateImagesFromMessage: mocks.generate }));
vi.mock('../src/main/imagegen/client.js', () => ({ createImagegenRelayClient: () => ({}) }));
const { startImagegenJobs } = await import('../src/main/imagegen/start.js');
const content = [
  '```imagegen',
  JSON.stringify({ operationId: 'mountain-001', model: 'qwen-image-plus', prompt: 'A mountain', size: '1328*1328' }),
  '```',
].join('\n');
const input = {
  workspacePath: 'C:/work',
  taskId: 'task',
  sessionKey: 'agent:main:clawwork:task:task',
  messageId: 'message',
  content,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.generation = 1;
  mocks.key = 'customer-key';
  mocks.generate.mockResolvedValue({ saved: [{ id: 'image' }], failed: [] });
});
it('production background starter delivers through artifact event and independent terminal activity', async () => {
  startImagegenJobs(input);
  startImagegenJobs(input);
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('succeeded', 'image'));
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.generate).toHaveBeenCalledWith(
    expect.objectContaining({ authScope: 'license', authCurrent: expect.any(Function) }),
  );
  expect(mocks.send).toHaveBeenCalledWith('artifact:saved', { id: 'image' });
});
it('authorization change during await never broadcasts old-account result', async () => {
  mocks.generate.mockImplementationOnce(async () => {
    mocks.generation++;
    return { saved: [{ id: 'old-image' }], failed: [] };
  });
  startImagegenJobs({ ...input, messageId: 'other' });
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('canceled'));
  expect(mocks.send).not.toHaveBeenCalled();
});
it('missing relay key reports unavailable without starting a paid job', async () => {
  mocks.key = null;
  startImagegenJobs({ ...input, messageId: 'disabled' });
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('failed'));
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledWith('imagegen:failed', [{ code: 'imagegen-unavailable' }]);
});
it('unknown result terminates as unconfirmed rather than a definite failure', async () => {
  mocks.generate.mockResolvedValueOnce({ saved: [], failed: [{ code: 'imagegen-request-unconfirmed' }] });
  startImagegenJobs({ ...input, messageId: 'unknown-state' });
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('needs-review'));
  expect(mocks.send).toHaveBeenCalledWith('imagegen:failed', [{ code: 'imagegen-request-unconfirmed' }]);
});

it('canceled source during license await cannot be adopted by a later run', async () => {
  let current = true;
  mocks.readLicense.mockImplementationOnce(async () => {
    current = false;
    return { ok: true, result: { activated: true, licenseId: 'license' } };
  });
  startImagegenJobs({ ...input, messageId: 'late-source', sourceCurrent: () => current });
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('canceled'));
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it('a rejected license read from a canceled source does not broadcast failure', async () => {
  let current = true;
  mocks.readLicense.mockImplementationOnce(async () => {
    current = false;
    throw new Error('late');
  });
  startImagegenJobs({ ...input, messageId: 'late-rejection', sourceCurrent: () => current });
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith('canceled'));
  expect(mocks.send).not.toHaveBeenCalled();
});

it('background source is retained once and released when cancellation settles', async () => {
  const release = vi.fn(),
    retain = vi.fn(() => release);
  let resolveLicense!: (value: { ok: boolean; result: { activated: boolean; licenseId: string } }) => void;
  let current = true;
  mocks.readLicense.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveLicense = resolve;
      }),
  );
  const retained = { ...input, messageId: 'retained', retainSource: retain, sourceCurrent: () => current };
  startImagegenJobs(retained);
  startImagegenJobs(retained);
  expect(retain).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
  current = false;
  resolveLicense({ ok: true, result: { activated: true, licenseId: 'license' } });
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  expect(mocks.finish).toHaveBeenCalledWith('canceled');
  expect(mocks.generate).not.toHaveBeenCalled();
});
