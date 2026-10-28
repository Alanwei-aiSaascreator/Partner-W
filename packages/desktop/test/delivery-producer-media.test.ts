import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn(), rows: vi.fn(), events: [] as string[] }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../src/main/db/index.js', () => {
  const db = { select: () => ({ from: () => ({ where: () => ({ all: mocks.rows }) }) }) };
  return { getDb: () => db };
});
vi.mock('../src/main/workspace/config.js', () => ({ getWorkspacePath: () => '/workspace' }));
vi.mock('../src/main/artifact/save.js', () => ({ saveArtifactFromBuffer: mocks.save }));
vi.mock('../src/main/net/safe-fetch.js', () => ({ safeFetch: mocks.fetch }));
const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
const input = { workspacePath: '/workspace', taskId: 'task', messageId: 'message', content: '' };
const video = { fileName: 'video.mp4', mimeType: 'video/mp4', dataUrl: 'https://example.invalid/video.mp4' };
const onActivity = (phase: string) => {
  mocks.events.push(phase);
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.events.length = 0;
  mocks.rows.mockReturnValue([]);
  mocks.fetch.mockImplementation(async () => {
    mocks.events.push('fetch');
    return Buffer.from('video');
  });
  mocks.save.mockImplementation(async (params) => {
    mocks.events.push('save');
    return { ...params, name: params.fileName };
  });
});

it('reports download and save only at actual calls, including resolved managed tickets', async () => {
  const resolveMediaDownload = vi.fn(async () => {
    mocks.events.push('ticket');
    return video.dataUrl;
  });
  await autoExtractArtifacts({
    ...input,
    attachments: [{ ...video, artifactId: 'managed' }],
    resolveMediaDownload,
    onActivity,
  });
  expect(mocks.events).toEqual(['ticket', 'downloading-media', 'fetch', 'saving-artifacts', 'save']);
});

it('does not report downloading for inline data or work for an already saved source', async () => {
  const attachment = { fileName: 'inline.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,aGk=' };
  await autoExtractArtifacts({ ...input, attachments: [attachment], onActivity });
  expect(mocks.events).toEqual(['saving-artifacts', 'save']);
  mocks.rows.mockReturnValue([{ sourceKey: mocks.save.mock.calls[0]![0].sourceKey }]);
  mocks.events.length = 0;
  await autoExtractArtifacts({ ...input, attachments: [attachment], onActivity });
  expect(mocks.events).toEqual([]);
});

it('does not start a second activity when concurrent callers share the same job', async () => {
  let resolve!: (buffer: Buffer) => void;
  mocks.fetch.mockImplementation(
    () =>
      new Promise<Buffer>((done) => {
        resolve = done;
      }),
  );
  const duplicate = vi.fn();
  const first = autoExtractArtifacts({ ...input, attachments: [video], onActivity });
  const second = autoExtractArtifacts({ ...input, attachments: [video], onActivity: duplicate });
  resolve(Buffer.from('video'));
  await Promise.all([first, second]);
  expect(duplicate).not.toHaveBeenCalled();
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(mocks.save).toHaveBeenCalledOnce();
});

it('a notification exception does not turn a successful download into a media failure', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const result = await autoExtractArtifacts({
    ...input,
    attachments: [video],
    onActivity: () => {
      throw new Error('notification');
    },
  });
  expect(result.mediaFailures).toEqual([]);
  expect(mocks.save).toHaveBeenCalledOnce();
  warn.mockRestore();
});

it('failed downloads report no saving stage', async () => {
  mocks.fetch.mockRejectedValue(new Error('download rejected'));
  const result = await autoExtractArtifacts({ ...input, attachments: [video], onActivity });
  expect(result.mediaFailures).toHaveLength(1);
  expect(mocks.events).toEqual(['downloading-media']);
  expect(mocks.save).not.toHaveBeenCalled();
});
