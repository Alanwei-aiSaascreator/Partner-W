import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  save: vi.fn(async (_params: Record<string, unknown>) => ({ id: 'image', availability: 'available' })),
  replay: vi.fn(() => null),
  current: true,
  decode: true,
  rows: new Map<string, { request_id: string; request_fingerprint: string }>(),
}));
vi.mock('../src/main/artifact/save.js', () => ({ saveArtifactFromBuffer: mock.save }));
vi.mock('../src/main/imagegen/replay.js', () => ({
  findImagegenReplay: mock.replay,
  publishImagegenArtifact: (_key: string, publish: () => Promise<unknown>) => publish(),
}));
vi.mock('../src/main/artifact/workspace-owner.js', () => ({
  captureArtifactWorkspaceOwner: () => ({
    current: () => mock.current,
    assertCurrent: () => {
      if (!mock.current) throw new Error('changed');
    },
  }),
}));
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => !mock.decode, getSize: () => ({ width: 1328, height: 1328 }) }),
  },
}));
vi.mock('../src/main/db/index.js', () => ({
  getSqlite: () => ({
    prepare: (sql: string) => ({
      get: (key: string) => mock.rows.get(key),
      run: (key: string, id: string, _taskId: string, requestFingerprint: string) => {
        if (sql.startsWith('INSERT') && !mock.rows.has(key))
          mock.rows.set(key, { request_id: id, request_fingerprint: requestFingerprint });
      },
    }),
  }),
}));
const { generateImagesFromMessage } = await import('../src/main/imagegen/generate.js');
const { resolveImagegenRequestId } = await import('../src/main/imagegen/request-identity.js');
const { extractImagegenBlocks } = await import('../src/main/imagegen/request.js');
const request = {
  model: 'qwen-image-plus' as const,
  prompt: 'A mountain',
  size: '1328*1328',
  operationId: 'mountain-first',
  title: 'Mountain',
};
const content = ['```imagegen', JSON.stringify(request), '```'].join('\n');
function client() {
  return {
    capabilities: vi.fn(async () => true),
    create: vi.fn<import('../src/main/imagegen/client.js').ImagegenRelayClient['create']>(async () => ({
      ok: true as const,
    })),
    query: vi.fn<import('../src/main/imagegen/client.js').ImagegenRelayClient['query']>(async () => ({
      status: 'finished' as const,
    })),
    download: vi.fn(async () => ({
      ok: true as const,
      bytes: Buffer.from(
        '89504e470d0a1a0a0000000d4948445200000530000005300802000000000000000000000049454e4400000000',
        'hex',
      ),
    })),
  };
}
beforeEach(() => {
  mock.save.mockClear();
  mock.replay.mockReset();
  mock.replay.mockReturnValue(null);
  mock.current = true;
  mock.decode = true;
  mock.rows.clear();
});
it('image request identity persists across message retry and excludes cosmetic title', () => {
  const a = resolveImagegenRequestId({ taskId: 'task', authScope: 'license-a', request });
  expect(
    resolveImagegenRequestId({ taskId: 'task', authScope: 'license-a', request: { ...request, title: 'renamed' } }),
  ).toBe(a);
  expect(
    resolveImagegenRequestId({
      taskId: 'task',
      authScope: 'license-a',
      request: { ...request, operationId: 'mountain-second' },
    }),
  ).not.toBe(a);
  expect(resolveImagegenRequestId({ taskId: 'task', authScope: 'license-b', request })).not.toBe(a);
  expect(mock.rows.size).toBe(3);
});
it('rejects malformed, unsupported and multiple blocks before any generation', () => {
  expect(extractImagegenBlocks(content).requests).toHaveLength(1);
  for (const input of [
    content + '\n' + content,
    '```imagegen\n{}',
    content.replace('1328*1328', '4K'),
    content.replace('qwen-image-plus', 'unknown'),
  ])
    expect(extractImagegenBlocks(input).failures.length).toBeGreaterThan(0);
});
it('production generator uses stable id, decodes bytes before existing artifact registration', async () => {
  const c = client();
  const result = await generateImagesFromMessage({
    workspacePath: 'C:/work',
    authScope: 'license-a',
    taskId: 'task',
    messageId: 'message',
    content,
    client: c,
  });
  expect(result.saved).toHaveLength(1);
  expect(result.failed).toEqual([]);
  expect(c.create).toHaveBeenCalledWith(request, expect.stringMatching(/^[0-9a-f-]{36}$/));
  expect(mock.save).toHaveBeenCalledWith(
    expect.objectContaining({ artifactType: 'image', sourceKey: expect.stringMatching(/^imagegen:/) }),
  );
  const firstId = c.create.mock.calls[0][1];
  await generateImagesFromMessage({
    workspacePath: 'C:/work',
    authScope: 'license-a',
    taskId: 'task',
    messageId: 'retry-message',
    content,
    client: c,
  });
  expect(c.create).toHaveBeenCalledTimes(1);
  expect(c.query).toHaveBeenLastCalledWith(firstId);
});
it('closed capability makes zero paid requests', async () => {
  const c = client();
  c.capabilities.mockResolvedValue(false);
  const result = await generateImagesFromMessage({
    workspacePath: 'C:/work',
    authScope: 'license-a',
    taskId: 'task',
    messageId: 'message',
    content,
    client: c,
  });
  expect(c.create).not.toHaveBeenCalled();
  expect(result.failed).toEqual([{ code: 'imagegen-unavailable' }]);
  expect(mock.save).not.toHaveBeenCalled();
});
it('undecodable image and changed workspace never register artifacts', async () => {
  const c = client();
  mock.decode = false;
  const result = await generateImagesFromMessage({
    workspacePath: 'C:/work',
    authScope: 'license-a',
    taskId: 'task',
    messageId: 'message',
    content,
    client: c,
  });
  expect(result.failed).toEqual([{ code: 'imagegen-image-invalid' }]);
  expect(mock.save).not.toHaveBeenCalled();
  mock.decode = true;
  c.download.mockImplementation(async () => {
    mock.current = false;
    return {
      ok: true,
      bytes: Buffer.from(
        '89504e470d0a1a0a0000000d4948445200000530000005300802000000000000000000000049454e4400000000',
        'hex',
      ),
    };
  });
  const switched = await generateImagesFromMessage({
    workspacePath: 'C:/work',
    authScope: 'license-a',
    taskId: 'task',
    messageId: 'message',
    content,
    client: c,
  });
  expect(switched.saved).toEqual([]);
  expect(mock.save).not.toHaveBeenCalled();
});

it('authorization changed during generation cannot deliver an old-account image', async () => {
  const c = client();
  let current = true;
  c.query.mockImplementation(async () => {
    current = false;
    return { status: 'finished' };
  });
  const result = await generateImagesFromMessage({
    workspacePath: 'C:/work',
    authScope: 'license-a',
    authCurrent: () => current,
    taskId: 'task',
    messageId: 'message',
    content,
    client: c,
  });
  expect(result.saved).toEqual([]);
  expect(mock.save).not.toHaveBeenCalled();
  expect(c.download).not.toHaveBeenCalled();
});

it('persisted unknown request recovers by GET only even after capabilities close', async () => {
  const c = client();
  c.create.mockResolvedValueOnce({ ok: false, code: 'imagegen-request-unconfirmed' });
  const input = {
    workspacePath: 'C:/work',
    authScope: 'license-a',
    taskId: 'task',
    messageId: 'unknown',
    content,
    client: c,
  };
  expect((await generateImagesFromMessage(input)).failed).toEqual([{ code: 'imagegen-request-unconfirmed' }]);
  c.capabilities.mockResolvedValue(false);
  const recovered = await generateImagesFromMessage({ ...input, messageId: 'recovery' });
  expect(recovered.saved).toHaveLength(1);
  expect(c.create).toHaveBeenCalledTimes(1);
  expect(c.capabilities).toHaveBeenCalledTimes(1);
  expect(c.query).toHaveBeenCalledTimes(1);
});
it('a modified prompt under a persisted operation cannot fetch an old image or create a new charge', async () => {
  const c = client();
  resolveImagegenRequestId({ taskId: 'task', authScope: 'license-a', request });
  const changed = content.replace('A mountain', 'A different mountain');
  const result = await generateImagesFromMessage({
    workspacePath: 'C:/work',
    authScope: 'license-a',
    taskId: 'task',
    messageId: 'retry',
    content: changed,
    client: c,
  });
  expect(result.failed).toEqual([{ code: 'imagegen-block-invalid' }]);
  expect(c.create).not.toHaveBeenCalled();
  expect(c.query).not.toHaveBeenCalled();
  expect(mock.save).not.toHaveBeenCalled();
});
it('upstream queue is waited out, never surfaced as a failure', async () => {
  // 并发满了（上游 429）时用户应当看到"还在生成"，而不是错误。
  const c = client();
  c.create
    .mockResolvedValueOnce({ ok: true, queued: true, retryAfterSeconds: 1 })
    .mockResolvedValueOnce({ ok: true, queued: false });
  const result = await generateImagesFromMessage({
    workspacePath: 'C:/work',
    authScope: 'license-a',
    taskId: 'task',
    messageId: 'queued',
    content,
    client: c,
    sleep: async () => {},
  });
  expect(result.saved).toHaveLength(1);
  expect(result.failed).toEqual([]);
  expect(c.create).toHaveBeenCalledTimes(2);
  // 排队重试必须复用同一个 requestId（否则会在上游重复下单、重复扣费）
  expect(c.create.mock.calls[1][1]).toBe(c.create.mock.calls[0][1]);
});
it('a queued poll keeps waiting instead of failing', async () => {
  const c = client();
  c.query
    .mockResolvedValueOnce({ status: 'queued', retryAfterSeconds: 1 })
    .mockResolvedValueOnce({ status: 'finished' });
  const result = await generateImagesFromMessage({
    workspacePath: 'C:/work',
    authScope: 'license-a',
    taskId: 'task',
    messageId: 'queued-poll',
    content,
    client: c,
    sleep: async () => {},
  });
  expect(result.saved).toHaveLength(1);
  expect(result.failed).toEqual([]);
  expect(c.download).toHaveBeenCalledTimes(1);
});
it('an explicit new operation creates a separate image while replays retain the same identity', async () => {
  const c = client();
  const input = {
    workspacePath: 'C:/work',
    authScope: 'license-a',
    taskId: 'task',
    messageId: 'first',
    content,
    client: c,
  };
  await generateImagesFromMessage(input);
  await generateImagesFromMessage({
    ...input,
    messageId: 'new',
    content: content.replace('mountain-first', 'mountain-second'),
  });
  expect(c.create).toHaveBeenCalledTimes(2);
  expect(c.create.mock.calls[0][1]).not.toBe(c.create.mock.calls[1][1]);
  expect(mock.save.mock.calls[0][0].fileName).not.toBe(mock.save.mock.calls[1][0].fileName);
});
