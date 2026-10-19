import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();
const autoExtractArtifactsMock = vi.fn();
/**
 * `getSqlite()` 默认 null（无库=多数用例的常态）；BUG-038 的用例把它换成
 * 一个带 `prepare().all()` 的桩，喂"本任务已登记的产物名"。
 */
const getSqliteMock = vi.fn((): unknown => null);
const captureTaskArtifactBaselineMock = vi.fn();
const reconcileTaskArtifactsMock = vi.fn();
const getGatewayClientMock = vi.fn();
const getWorkspacePathMock = vi.fn(() => 'C:\\trusted-workspace');
const generateHtmlPagesFromMessageMock = vi.fn();
const startImagegenJobsMock = vi.fn();
const webContentsSendMock = vi.fn();
const consoleErrorMock = vi.spyOn(console, 'error').mockImplementation(() => undefined);
const conflictRunMock = vi.fn();
const valuesMock = vi.fn(() => ({
  onConflictDoUpdate: vi.fn(() => ({ run: conflictRunMock })),
  run: vi.fn(),
}));
const selectGetMock = vi.fn();
const withTeamMeetingTaskDeletionMock = vi.fn((_taskId: string, remove: () => void) => remove());
const dbMock = {
  insert: vi.fn(() => ({ values: valuesMock })),
  select: vi.fn((fields?: Record<string, unknown>) => {
    if (fields && 'taskId' in fields && 'sessionKey' in fields && 'role' in fields) {
      return { from: () => ({ where: () => ({ get: () => undefined }) }) };
    }
    return { from: vi.fn(() => ({ where: vi.fn(() => ({ get: selectGetMock })) })) };
  }),
  delete: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
};

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handleMap.set(channel, handler)),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { isDestroyed: () => false, send: webContentsSendMock } }]),
  },
}));

vi.mock('../src/main/db/index.js', () => ({
  getDb: vi.fn(() => dbMock),
  getSqlite: getSqliteMock,
  isDbReady: vi.fn(() => true),
}));

vi.mock('../src/main/ipc/team-meeting-handlers.js', () => ({
  withTeamMeetingTaskDeletion: withTeamMeetingTaskDeletionMock,
}));

vi.mock('../src/main/workspace/config.js', () => ({ getWorkspacePath: getWorkspacePathMock }));
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: getGatewayClientMock }));
vi.mock('../src/main/artifact/auto-extract.js', () => ({ autoExtractArtifacts: autoExtractArtifactsMock }));
vi.mock('../src/main/artifact/reconcile.js', () => ({
  captureTaskArtifactBaseline: captureTaskArtifactBaselineMock,
  reconcileTaskArtifacts: reconcileTaskArtifactsMock,
}));
vi.mock('../src/main/htmlgen/generate.js', () => ({
  generateHtmlPagesFromMessage: generateHtmlPagesFromMessageMock,
}));

vi.mock('../src/main/imagegen/start.js', () => ({ startImagegenJobs: startImagegenJobsMock }));

async function flushJobs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

/**
 * 按**链**取 `reconcileTaskArtifacts` 的调用。
 *
 * ⚠️ 2026-10-07 起，一轮收尾会跑**两条**链：应用根（缺省 `rootKind`）与
 *    **应用工作区根层**（第三个根，`rootKind:'workspace-root'`）；助手工作区解析得出来时
 *    再多一条 `'agent'`。所以"这一轮跑了几次"必须**按链**问，而不是数总次数 ——
 *    数总数会让这些用例的语义变成"第三条链在不在"，而不是"这条链的时序对不对"。
 */
function reconcileCalls(rootKind?: 'workspace' | 'agent' | 'workspace-root') {
  const wanted = rootKind ?? 'workspace';
  return reconcileTaskArtifactsMock.mock.calls.filter(
    ([input]) => ((input as { rootKind?: string }).rootKind ?? 'workspace') === wanted,
  );
}

/**
 * 给**应用根**那条基线排一条队列；**第三个根**（应用工作区根层）一律回空快照。
 *
 * ⚠️ 这些用例钉的是应用根那条链的时序/归属（哪一轮拿哪份基线），根层那趟不该干扰它们：
 *    真按调用顺序往下发 `mockResolvedValueOnce`，根层那趟会把下一轮的值吃掉。
 */
function appRootBaselines(...baselines: Array<Record<string, string> | Error>): void {
  const queue = [...baselines];
  captureTaskArtifactBaselineMock.mockImplementation(async (input: { rootKind?: string }) => {
    if (input.rootKind === 'workspace-root') return {};
    const next = queue.shift() ?? { 'before.txt': 'signature' };
    if (next instanceof Error) throw next;
    return next;
  });
}

describe('assistant artifact reconciliation boundary', () => {
  it('settles the failed source after same-name video metadata retry without requiring the already saved source', async () => {
    const { beginArtifactRun, bindArtifactRun, registerDataHandlers } =
      await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    const token = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    bindArtifactRun('task-1', 'session-task-1', token, 'run-old');
    const attachments = ['first', 'second'].map((name) => ({
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      dataUrl: `file:///runtime/${name}.mp4`,
    }));
    const key = (index: number) =>
      `attachment:${createHash('sha256').update(attachments[index]!.dataUrl).digest('hex').slice(0, 16)}`;
    const msg = {
      id: 'same-name',
      taskId: 'task-1',
      sessionKey: 'session-task-1',
      runId: 'run-old',
      role: 'assistant',
      content: '',
      timestamp: '2026-09-30T00:00:00Z',
      attachments,
    };
    autoExtractArtifactsMock.mockResolvedValueOnce({
      mediaFailures: [{ fileName: 'clip.mp4', reason: 'unavailable' }],
      savedMediaSourceKeys: [key(0)],
      failedMediaSourceKeys: [key(1)],
    });
    selectGetMock.mockReturnValueOnce({ id: msg.id }).mockReturnValueOnce({ gid: 'gateway-1' });
    const handler = handleMap.get('data:create-message')!;
    handler({}, msg);
    await flushJobs();
    webContentsSendMock.mockClear();
    autoExtractArtifactsMock.mockResolvedValueOnce({ mediaFailures: [], savedMediaSourceKeys: [key(1)] });
    selectGetMock
      .mockReturnValueOnce({ id: msg.id })
      .mockReturnValueOnce({ gid: 'gateway-1' })
      .mockReturnValueOnce(msg);
    handler({}, { ...msg, attachments: [{ ...attachments[1]!, artifactId: 'artifact_managed_media_second' }] });
    await flushJobs();
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:delivery-settled',
      expect.objectContaining({ status: 'succeeded' }),
    );
  });
  it.each(['document', 'another-video'])(
    'preserves %s failure after a successful video-only metadata retry',
    async (kind) => {
      const { beginArtifactRun, bindArtifactRun, registerDataHandlers } =
        await import('../src/main/ipc/data-handlers.js');
      registerDataHandlers();
      const token = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
      bindArtifactRun('task-1', 'session-task-1', token, 'run-old');
      const msg = {
        id: 'mixed-delivery',
        taskId: 'task-1',
        sessionKey: 'session-task-1',
        runId: 'run-old',
        role: 'assistant',
        timestamp: '2026-09-30T00:00:00Z',
        content: kind === 'document' ? '```docgen\n{ bad json\n```' : '',
        attachments: [{ fileName: 'clip.mp4', mimeType: 'video/mp4', dataUrl: 'file:///runtime/clip.mp4' }],
      };
      if (kind === 'another-video')
        msg.attachments.push({ fileName: 'other.mp4', mimeType: 'video/mp4', dataUrl: 'file:///runtime/other.mp4' });
      selectGetMock.mockReturnValueOnce({ id: msg.id }).mockReturnValueOnce({ gid: 'gateway-1' });
      autoExtractArtifactsMock.mockResolvedValueOnce({
        mediaFailures:
          kind === 'document'
            ? [{ fileName: 'clip.mp4', reason: 'unavailable' }]
            : [
                { fileName: 'clip.mp4', reason: 'unavailable' },
                { fileName: 'other.mp4', reason: 'unavailable' },
              ],
      });
      const handler = handleMap.get('data:create-message')!;
      handler({}, msg);
      await flushJobs();
      if (kind === 'document') expect(webContentsSendMock).toHaveBeenCalledWith('docgen:failed', expect.anything());
      webContentsSendMock.mockClear();
      autoExtractArtifactsMock.mockResolvedValueOnce({
        mediaFailures: kind === 'another-video' ? [{ fileName: 'other.mp4', reason: 'unavailable' }] : [],
        savedMediaSourceKeys: [
          `attachment:${createHash('sha256').update(msg.attachments[0]!.dataUrl).digest('hex').slice(0, 16)}`,
        ],
      });
      selectGetMock
        .mockReturnValueOnce({ id: msg.id })
        .mockReturnValueOnce({ gid: 'gateway-1' })
        .mockReturnValueOnce(msg);
      handler({}, { ...msg, attachments: [{ ...msg.attachments[0]!, artifactId: 'artifact_managed_media_fixture' }] });
      await flushJobs();
      expect(webContentsSendMock).not.toHaveBeenCalledWith(
        'artifact:delivery-settled',
        expect.objectContaining({ status: 'succeeded' }),
      );
      if (kind === 'another-video') {
        const other = msg.attachments[1]!;
        autoExtractArtifactsMock.mockResolvedValueOnce({
          mediaFailures: [],
          savedMediaSourceKeys: [`attachment:${createHash('sha256').update(other.dataUrl).digest('hex').slice(0, 16)}`],
        });
        selectGetMock
          .mockReturnValueOnce({ id: msg.id })
          .mockReturnValueOnce({ gid: 'gateway-1' })
          .mockReturnValueOnce(msg);
        handler({}, { ...msg, attachments: [{ ...other, artifactId: 'artifact_managed_media_other' }] });
        await flushJobs();
        expect(webContentsSendMock).toHaveBeenCalledWith(
          'artifact:delivery-settled',
          expect.objectContaining({ status: 'succeeded' }),
        );
        webContentsSendMock.mockClear();
        const fresh = ['first', 'second'].map((name) => ({
          fileName: `${name}.mp4`,
          mimeType: 'video/mp4',
          dataUrl: `file:///runtime/${name}.mp4`,
        }));
        async function retry(attachments: typeof fresh, result: unknown) {
          autoExtractArtifactsMock.mockResolvedValueOnce(result);
          selectGetMock
            .mockReturnValueOnce({ id: msg.id })
            .mockReturnValueOnce({ gid: 'gateway-1' })
            .mockReturnValueOnce(msg);
          handler({}, { ...msg, attachments });
          await flushJobs();
        }
        await retry(fresh, {
          mediaFailures: fresh.map((attachment) => ({ fileName: attachment.fileName, reason: 'unavailable' })),
        });
        const key = (index: number) =>
          `attachment:${createHash('sha256').update(fresh[index]!.dataUrl).digest('hex').slice(0, 16)}`;
        await retry([fresh[0]!], { mediaFailures: [], savedMediaSourceKeys: [key(0)] });
        expect(webContentsSendMock).not.toHaveBeenCalledWith(
          'artifact:delivery-settled',
          expect.objectContaining({ status: 'succeeded' }),
        );
        await retry([fresh[1]!], { mediaFailures: [], savedMediaSourceKeys: [key(1)] });
        expect(webContentsSendMock).toHaveBeenCalledWith(
          'artifact:delivery-settled',
          expect.objectContaining({ status: 'succeeded' }),
        );
      }
    },
  );
  it('imports late metadata for a completed message while preserving the next queued turn', async () => {
    const { beginArtifactRun, bindArtifactRun, registerDataHandlers } =
      await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    const oldToken = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    bindArtifactRun('task-1', 'session-task-1', oldToken, 'run-old');
    let finish!: (result: unknown) => void;
    autoExtractArtifactsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const msg = {
      id: 'assistant-video',
      taskId: 'task-1',
      sessionKey: 'session-task-1',
      runId: 'run-old',
      role: 'assistant',
      content: '',
      timestamp: '2026-09-30T00:00:00.000Z',
      attachments: [{ fileName: 'clip.mp4', dataUrl: 'file:///runtime/clip.mp4', mimeType: 'video/mp4' }],
    };
    const handler = handleMap.get('data:create-message')!;
    selectGetMock.mockReturnValueOnce({ id: msg.id }).mockReturnValueOnce({ gid: 'gateway-1' });
    handler({}, msg);
    await flushMicrotasks();
    const nextToken = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    bindArtifactRun('task-1', 'session-task-1', nextToken, 'run-new');
    const enriched = {
      ...msg,
      attachments: [{ ...msg.attachments[0]!, artifactId: 'artifact_managed_media_fixture' }],
    };
    selectGetMock
      .mockReturnValueOnce({ id: msg.id })
      .mockReturnValueOnce({ gid: 'gateway-1' })
      .mockReturnValueOnce(msg);
    handler({}, enriched);
    await flushMicrotasks();
    expect(autoExtractArtifactsMock).toHaveBeenCalledTimes(2);
    expect(autoExtractArtifactsMock.mock.calls[1]![0].attachments[0].artifactId).toBe('artifact_managed_media_fixture');
    finish({ mediaFailures: [] });
    await flushJobs();
    selectGetMock.mockReturnValueOnce({ id: 'next-message' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handler({}, { ...msg, id: 'next-message', runId: 'run-new', timestamp: '2026-09-30T00:00:01.000Z' });
    await flushJobs();
    // 两轮各跑一遍**应用根**那条链（第三个根那条另算 —— 见 `reconcileCalls`）。
    expect(reconcileCalls()).toHaveLength(2);
  });
  it.each(['database', 'workspace', 'run'])(
    'discards old history failure after %s replacement',
    async (replacement) => {
      const { registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
      registerDataHandlers();
      let finish!: (result: unknown) => void;
      autoExtractArtifactsMock.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const msg = {
        id: 'assistant-video',
        taskId: 'task-1',
        sessionKey: 'session-task-1',
        runId: 'run-old',
        role: 'assistant',
        content: '',
        timestamp: '2026-09-30T00:00:00.000Z',
        attachments: [{ fileName: 'clip.mp4', dataUrl: 'file:///runtime/clip.mp4', mimeType: 'video/mp4' }],
      };
      selectGetMock.mockReturnValueOnce({ id: msg.id }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!({}, msg);
      if (replacement === 'database') {
        const { getDb } = await import('../src/main/db/index.js');
        vi.mocked(getDb).mockReturnValueOnce({ ...dbMock } as unknown as ReturnType<typeof getDb>);
      }
      if (replacement === 'workspace') getWorkspacePathMock.mockReturnValue('C:\\replacement');
      selectGetMock.mockReturnValue({ ...msg, runId: replacement === 'run' ? 'run-new' : msg.runId });
      finish({ mediaFailures: [{ fileName: 'clip.mp4', reason: 'unavailable' }] });
      await flushJobs();
      expect(webContentsSendMock).not.toHaveBeenCalledWith('artifact:delivery-settled', expect.anything());
      expect(webContentsSendMock).not.toHaveBeenCalledWith('artifact:claim-violation', expect.anything());
    },
  );
  it.each(['same-run', 'changed-run', 'changed-task', 'changed-session', 'wrong-source', 'no-saved-media'])(
    'settles a failed history media retry only after real saved evidence with %s ownership',
    async (ownership) => {
      const { registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
      registerDataHandlers();
      const msg = {
        id: 'assistant-video',
        taskId: 'task-1',
        role: 'assistant',
        content: '',
        timestamp: '2026-09-30T00:00:00.000Z',
        sessionKey: 'session-task-1',
        runId: 'run-old',
        attachments: [{ fileName: 'clip.mp4', dataUrl: 'file:///runtime/media/clip.mp4', mimeType: 'video/mp4' }],
      };
      const handler = handleMap.get('data:create-message')!;
      autoExtractArtifactsMock.mockResolvedValueOnce({
        mediaFailures: [{ fileName: 'clip.mp4', reason: 'unavailable' }],
      });
      selectGetMock
        .mockReturnValueOnce({ id: msg.id })
        .mockReturnValueOnce({ gid: 'gateway-1' })
        .mockReturnValueOnce(msg);
      handler({}, msg);
      await flushJobs();
      expect(webContentsSendMock).toHaveBeenCalledWith(
        'artifact:delivery-settled',
        expect.objectContaining({ status: 'failed' }),
      );
      webContentsSendMock.mockClear();
      autoExtractArtifactsMock.mockResolvedValueOnce({
        mediaFailures: [],
        ...(ownership === 'no-saved-media'
          ? {}
          : {
              savedMediaSourceKeys: [
                ownership === 'wrong-source'
                  ? 'attachment:unrelated'
                  : `attachment:${createHash('sha256').update(msg.attachments[0]!.dataUrl).digest('hex').slice(0, 16)}`,
              ],
            }),
      });
      selectGetMock
        .mockReturnValueOnce({ id: msg.id })
        .mockReturnValueOnce({ gid: 'gateway-1' })
        .mockReturnValueOnce({
          taskId: ownership === 'changed-task' ? 'task-other' : msg.taskId,
          sessionKey: ownership === 'changed-session' ? 'session-other' : msg.sessionKey,
          runId: ownership === 'changed-run' ? 'run-new' : msg.runId,
        });
      handler({}, msg);
      await flushJobs();
      const successes = webContentsSendMock.mock.calls.filter(
        ([channel, result]) => channel === 'artifact:delivery-settled' && result.status === 'succeeded',
      );
      expect(successes).toHaveLength(ownership === 'same-run' ? 1 : 0);
      if (ownership === 'same-run')
        expect(successes[0]![1]).toMatchObject({ taskId: msg.taskId, sessionKey: msg.sessionKey, messageId: msg.id });
    },
  );

  it.each([true, false])(
    'resolves managed video tickets using only the task gateway and session, active run=%s',
    async (activeRun) => {
      const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
      registerDataHandlers();
      if (activeRun) beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
      const artifactId = 'artifact_managed_media_fixture';
      const dataUrl = 'http://127.0.0.1:18789/api/chat/media/outgoing/session-task-1/video/full';
      const sendReq = vi.fn().mockResolvedValue({
        artifact: {
          id: artifactId,
          sessionKey: 'session-task-1',
          source: 'session-transcript',
          download: { mode: 'url' },
        },
        url: `${dataUrl}?ticket=secret&download=1`,
      });
      getGatewayClientMock.mockImplementation((id) =>
        id === 'gateway-1' ? { httpBase: 'http://127.0.0.1:18789', sendReq } : undefined,
      );
      selectGetMock.mockReturnValueOnce({ id: 'assistant-video' }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'assistant-video',
          taskId: 'task-1',
          role: 'assistant',
          content: '',
          timestamp: '2026-09-30T00:00:00.000Z',
          sessionKey: 'session-task-1',
          attachments: [{ fileName: 'clip.mp4', dataUrl, mimeType: 'video/mp4', artifactId }],
        },
      );
      await flushJobs();
      const resolveMediaDownload = autoExtractArtifactsMock.mock.calls[0][0].resolveMediaDownload;
      expect(resolveMediaDownload).toBeTypeOf('function');
      const attachment = { fileName: 'clip.mp4', dataUrl, mimeType: 'video/mp4', artifactId };
      await expect(resolveMediaDownload(attachment)).resolves.toBe(`${dataUrl}?ticket=secret&download=1`);
      expect(sendReq).toHaveBeenCalledWith('artifacts.download', { sessionKey: 'session-task-1', artifactId });
      sendReq.mockResolvedValue({
        artifact: {
          id: artifactId,
          sessionKey: 'session-task-1',
          source: 'session-transcript',
          download: { mode: 'url' },
        },
        url: '/api/chat/media/outgoing/session-task-1/video/full?ticket=secret&download=1',
      });
      await expect(resolveMediaDownload(attachment)).resolves.toBe(`${dataUrl}?ticket=secret&download=1`);
      sendReq.mockClear();
      await expect(
        resolveMediaDownload({ ...attachment, dataUrl: dataUrl.replace('session-task-1', 'other-session') }),
      ).resolves.toBeNull();
      await expect(
        resolveMediaDownload({ ...attachment, dataUrl: dataUrl.replace('127.0.0.1:18789', 'evil.example') }),
      ).resolves.toBeNull();
      expect(sendReq).not.toHaveBeenCalled();
      for (const invalid of [
        {
          artifact: {
            id: 'wrong',
            sessionKey: 'session-task-1',
            source: 'session-transcript',
            download: { mode: 'url' },
          },
          url: `${dataUrl}?ticket=secret`,
        },
        {
          artifact: {
            id: artifactId,
            sessionKey: 'other-session',
            source: 'session-transcript',
            download: { mode: 'url' },
          },
          url: `${dataUrl}?ticket=secret`,
        },
        {
          artifact: {
            id: artifactId,
            sessionKey: 'session-task-1',
            source: 'session-transcript',
            download: { mode: 'url' },
          },
          url: 'https://evil.example/file?ticket=secret',
        },
        {
          artifact: {
            id: artifactId,
            sessionKey: 'session-task-1',
            source: 'session-transcript',
            download: { mode: 'url' },
          },
          url: `${dataUrl}/other?ticket=secret`,
        },
        {
          artifact: {
            id: artifactId,
            sessionKey: 'session-task-1',
            source: 'session-transcript',
            download: { mode: 'url' },
          },
          url: `${dataUrl}?ticket=secret#fragment`,
        },
      ]) {
        sendReq.mockResolvedValue(invalid);
        await expect(resolveMediaDownload(attachment)).resolves.toBeNull();
      }
    },
  );

  it('passes the configured gateway origin when importing late history media without an active run', async () => {
    const { registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    getGatewayClientMock.mockReturnValue({ httpBase: 'http://127.0.0.1:18789' });
    selectGetMock.mockReturnValueOnce({ id: 'assistant-video' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-video',
        taskId: 'task-1',
        role: 'assistant',
        content: '',
        timestamp: '2026-09-30T00:00:00.000Z',
        sessionKey: 'session-task-1',
        attachments: [
          {
            fileName: 'clip.mp4',
            dataUrl: 'http://127.0.0.1:18789/api/chat/media/outgoing/session/video/full',
            mimeType: 'video/mp4',
          },
        ],
      },
    );
    await flushJobs();
    expect(autoExtractArtifactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayHttpBase: 'http://127.0.0.1:18789' }),
    );
  });

  it.each([true, false])('reports failed video imports with an active run=%s', async (activeRun) => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    if (activeRun) beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    autoExtractArtifactsMock.mockResolvedValue({ mediaFailures: [{ fileName: 'clip.mp4', reason: 'unavailable' }] });
    selectGetMock.mockReturnValueOnce({ id: 'assistant-video' }).mockReturnValueOnce({ gid: 'gateway-1' });
    if (!activeRun) selectGetMock.mockReturnValueOnce({ taskId: 'task-1', sessionKey: 'session-task-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-video',
        taskId: 'task-1',
        role: 'assistant',
        content: 'Video ready',
        timestamp: '2026-09-30T00:00:00.000Z',
        sessionKey: 'session-task-1',
        attachments: [
          {
            fileName: 'clip.mp4',
            dataUrl: 'file:///runtime/media/clip.mp4',
            sourcePath: '/runtime/media/clip.mp4',
            mimeType: 'video/mp4',
          },
        ],
      },
    );
    await flushJobs();
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:claim-violation',
      expect.objectContaining({
        taskId: 'task-1',
        sessionKey: 'session-task-1',
        messageId: 'assistant-video',
        mediaFailures: [{ fileName: 'clip.mp4', reason: 'unavailable' }],
      }),
    );
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:delivery-settled',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  beforeEach(async () => {
    vi.resetModules();
    (await import('../src/main/workspace/scope.js')).setWorkspaceDatabaseOwner(dbMock);
    handleMap.clear();
    getWorkspacePathMock.mockReturnValue('C:\\trusted-workspace');
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
    startImagegenJobsMock.mockReset();
    webContentsSendMock.mockReset();
    conflictRunMock.mockReset();
    valuesMock.mockClear();
    selectGetMock.mockReset();
    consoleErrorMock.mockClear();
    withTeamMeetingTaskDeletionMock.mockReset().mockImplementation((_taskId, remove) => remove());
    dbMock.delete.mockClear();
    getSqliteMock.mockReset().mockReturnValue(null);
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
    // 起跑那一刻采**两份**基线：应用根（任务目录）与**应用工作区根层**（第三个根，2026-10-07）。
    // 两份都必须在"用户消息落库之前"这一刻拿到 —— 晚一刻就会把这一轮新写的文件当成"之前就有"。
    expect(captureTaskArtifactBaselineMock).toHaveBeenCalledTimes(2);
    expect(captureTaskArtifactBaselineMock).toHaveBeenCalledWith({
      workspacePath: 'C:\\trusted-workspace',
      taskId: 'task-1',
    });
    expect(captureTaskArtifactBaselineMock).toHaveBeenCalledWith({
      workspacePath: 'C:\\trusted-workspace',
      taskId: 'task-1',
      rootKind: 'workspace-root',
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
      isCandidateCurrent: expect.any(Function),
      workspacePath: 'C:\\trusted-workspace',
      taskId: 'task-1',
      messageId: 'assistant-persisted',
      baseline: {},
    });
    expect(autoExtractArtifactsMock.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileTaskArtifactsMock.mock.invocationCallOrder[0],
    );
    expect(webContentsSendMock).toHaveBeenCalledWith('artifact:saved', expect.objectContaining({ id: 'artifact-1' }));
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:delivery-settled',
      expect.objectContaining({ taskId: 'task-1', status: 'succeeded' }),
    );

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
    expect(reconcileCalls()).toHaveLength(1);
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

  it('does not let a tool-only snapshot consume the run; the following terminal finalizes and clears it', async () => {
    // ⚠️ DOCX-205 合同（2026-10-10）：本用例原先钉的是"工具消息直接消耗 run"——那正是
    //    交付链被中间快照抢先取走的缺陷形态（见合同 §3）。修正后的合同：工具全 done
    //    而无正文/附件的快照**不消费** run；真正的整轮终态（同 run 的最终正文）
    //    照常交付并把 run 清掉。
    const { beginArtifactRun, bindArtifactRun, registerDataHandlers } =
      await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    const token = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    bindArtifactRun('task-1', 'session-task-1', token, 'run-1');
    selectGetMock.mockReturnValueOnce({ id: 'tool-only-snapshot' });

    expect(
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'tool-only-snapshot',
          taskId: 'task-1',
          role: 'assistant',
          content: '',
          timestamp: '2026-09-16T00:00:02.000Z',
          sessionKey: 'session-task-1',
          runId: 'run-1',
          toolCalls: [{ id: 'tool-1', status: 'done' }],
        },
      ),
    ).toEqual({ ok: true });
    await flushJobs();
    expect(autoExtractArtifactsMock).not.toHaveBeenCalled();
    expect(reconcileCalls()).toHaveLength(0);

    selectGetMock.mockReturnValueOnce({ id: 'tool-only-final' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'tool-only-final',
        taskId: 'task-1',
        role: 'assistant',
        content: '交付完成',
        timestamp: '2026-09-16T00:00:03.000Z',
        sessionKey: 'session-task-1',
        runId: 'run-1',
      },
    );
    await flushJobs();
    expect(autoExtractArtifactsMock).toHaveBeenCalledTimes(1);
    expect(reconcileCalls()).toHaveLength(1);

    selectGetMock.mockReturnValueOnce({ id: 'tool-only-replay' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'tool-only-replay',
        taskId: 'task-1',
        role: 'assistant',
        content: '交付完成',
        timestamp: '2026-09-16T00:00:04.000Z',
        sessionKey: 'session-task-1',
        runId: 'run-1',
      },
    );
    await flushJobs();
    expect(reconcileCalls()).toHaveLength(1);
  });

  it('does not clear a newer retry run when an older reconciliation finishes later', async () => {
    appRootBaselines({ 'a-before.txt': 'a' }, { 'b-before.txt': 'b' });
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
    expect(reconcileCalls()).toHaveLength(2);
    expect(reconcileCalls()[0]![0]).toEqual(expect.objectContaining({ baseline: { 'a-before.txt': 'a' } }));
    expect(reconcileCalls()[1]![0]).toEqual(expect.objectContaining({ baseline: { 'b-before.txt': 'b' } }));
    finishFirst({ saved: [], existing: [], missing: [], skipped: [], budgetExhausted: false });
    await flushJobs();
  });

  it('consumes same-session runs FIFO when B begins before A terminal persistence', async () => {
    appRootBaselines({ 'a-before.txt': 'a' }, { 'b-before.txt': 'b' });
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

    expect(reconcileCalls()).toHaveLength(2);
    expect(reconcileCalls()[0]![0]).toEqual(expect.objectContaining({ baseline: { 'a-before.txt': 'a' } }));
    expect(reconcileCalls()[1]![0]).toEqual(expect.objectContaining({ baseline: { 'b-before.txt': 'b' } }));
  });

  it('strictly binds out-of-order terminal messages to gateway run ids', async () => {
    appRootBaselines({ 'a-before.txt': 'a' }, { 'b-before.txt': 'b' });
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

    expect(reconcileCalls()[0]![0]).toEqual(
      expect.objectContaining({ messageId: 'assistant-b', baseline: { 'b-before.txt': 'b' } }),
    );
    expect(reconcileCalls()[1]![0]).toEqual(
      expect.objectContaining({ messageId: 'assistant-a', baseline: { 'a-before.txt': 'a' } }),
    );
  });

  it.each([false, true])(
    'keeps an accepted long run correlated after the send TTL, explicit cancel=%s',
    async (canceled) => {
      const { beginArtifactRun, bindArtifactRun, cancelArtifactRun, registerDataHandlers } =
        await import('../src/main/ipc/data-handlers.js');
      registerDataHandlers();
      vi.useFakeTimers();
      try {
        const token = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1', {
          userContent: '生成 Word',
        });
        bindArtifactRun('task-1', 'session-task-1', token, 'accepted-long-run');
        if (canceled) cancelArtifactRun('task-1', 'session-task-1', token);
        await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
        beginArtifactRun('C:\\trusted-workspace', 'task-other', 'session-other');
      } finally {
        vi.useRealTimers();
      }
      selectGetMock.mockReturnValueOnce({ id: 'long-final' }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'long-final',
          taskId: 'task-1',
          role: 'assistant',
          runId: 'accepted-long-run',
          content: '```docgen\n{"kind":"docx"}\n```',
          timestamp: '2026-09-29T00:20:00.000Z',
          sessionKey: 'session-task-1',
        },
      );
      await flushJobs();
      expect(reconcileCalls()).toHaveLength(canceled ? 0 : 1);
      const visibleFailures = webContentsSendMock.mock.calls.filter(
        ([channel]) => channel === 'artifact:claim-violation',
      );
      expect(visibleFailures).toHaveLength(canceled ? 0 : 1);
    },
  );

  it('does not let a completed assistant replay consume the following run', async () => {
    appRootBaselines({ 'a-before.txt': 'a' }, { 'b-before.txt': 'b' });
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

    expect(reconcileCalls()).toHaveLength(2);
    expect(reconcileCalls()[1]![0]).toEqual(
      expect.objectContaining({ messageId: 'assistant-b', baseline: { 'b-before.txt': 'b' } }),
    );
  });

  it('fails the session closed when completed-message dedupe TTL expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    appRootBaselines({ 'a-before.txt': 'a' }, { 'b-before.txt': 'b' });
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
    expect(reconcileCalls()).toHaveLength(1);

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
    expect(reconcileCalls()).toHaveLength(1);
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
    // 按**链**数：应用根那条正好每条完成消息一次（第三个根那条另有各一次，见 `reconcileCalls`）。
    expect(reconcileCalls()).toHaveLength(2050);

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
    expect(reconcileCalls()).toHaveLength(2050);
  });

  it('keeps an expired run as a tombstone so its late final cannot steal B', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    appRootBaselines({ 'a-before.txt': 'a' }, { 'b-before.txt': 'b' });
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
    appRootBaselines(new Error('baseline failed'), { 'b-before.txt': 'b' });
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
    // 没采到基线的那一轮，**应用根**那条链一次都不跑（第三个根那条有它自己的基线，另算）。
    expect(reconcileCalls()).toHaveLength(0);

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
    // B 拿到的是**它自己**那份基线（A 的失败没有被后面的轮次捡走）
    expect(reconcileCalls()[0]?.[0]).toEqual(expect.objectContaining({ baseline: { 'b-before.txt': 'b' } }));
  });

  it('keeps failed dispatch A as a tombstone and leaves same-session B queued', async () => {
    appRootBaselines({ 'a-before.txt': 'a' }, { 'b-before.txt': 'b' });
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
    expect(reconcileCalls()).toHaveLength(0);

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
    expect(reconcileCalls()[0]?.[0]).toEqual(
      expect.objectContaining({ messageId: 'assistant-b', baseline: { 'b-before.txt': 'b' } }),
    );
  });

  it('correlates a late terminal run id to the oldest unbound tombstone', async () => {
    appRootBaselines({ 'a-before.txt': 'a' }, { 'b-before.txt': 'b' }, { 'c-before.txt': 'c' });
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

    expect(reconcileCalls().map((call) => call[0])).toEqual([
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
    expect(reconcileCalls()).toHaveLength(1);
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

  it('documents the restart boundary: history without an in-memory run does not regenerate structured artifacts', async () => {
    const { registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    selectGetMock.mockReturnValueOnce({ id: 'history-only' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'history-only',
        taskId: 'task-1',
        role: 'assistant',
        content: '```htmlgen\n{"kind":"html"}\n```',
        timestamp: '2026-09-29T00:00:00.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(autoExtractArtifactsMock).toHaveBeenCalledTimes(1);
    expect(generateHtmlPagesFromMessageMock).not.toHaveBeenCalled();
    expect(reconcileTaskArtifactsMock).not.toHaveBeenCalled();
    expect(webContentsSendMock).not.toHaveBeenCalledWith('artifact:claim-violation', expect.anything());
  });

  it('documents the 15-minute boundary: canceled baseline drops reconciliation and failure persistence, not generator validation', async () => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    vi.useFakeTimers();
    try {
      beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
    } finally {
      vi.useRealTimers();
    }
    selectGetMock.mockReturnValueOnce({ id: 'late-after-expiry' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'late-after-expiry',
        taskId: 'task-1',
        role: 'assistant',
        content: '```docgen\n{"kind":"docx"}\n```',
        timestamp: '2026-09-29T00:00:00.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(webContentsSendMock).toHaveBeenCalledWith('docgen:failed', [{ code: 'request-invalid' }]);
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:delivery-settled',
      expect.objectContaining({ messageId: 'late-after-expiry', status: 'canceled' }),
    );
    expect(reconcileTaskArtifactsMock).not.toHaveBeenCalled();
    expect(webContentsSendMock).not.toHaveBeenCalledWith('artifact:claim-violation', expect.anything());
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
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:claim-violation',
      expect.objectContaining({
        messageId: 'assistant-persisted',
        docFailures: [{ code: 'request-invalid' }],
      }),
    );
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:delivery-settled',
      expect.objectContaining({ messageId: 'assistant-persisted', status: 'failed' }),
    );
  });

  it('persists HTML validation failure even without a filename claim', async () => {
    generateHtmlPagesFromMessageMock.mockResolvedValue({
      saved: [],
      failed: [{ code: 'htmlgen-unsupported-field', field: 'style' }],
    });
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-html' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-html',
        taskId: 'task-1',
        role: 'assistant',
        content: '```htmlgen\n{"style":"x"}\n```',
        timestamp: '2026-09-29T00:00:00.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:claim-violation',
      expect.objectContaining({
        messageId: 'assistant-html',
        htmlFailures: [{ code: 'htmlgen-unsupported-field', field: 'style' }],
      }),
    );
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

    // ⭐ 2026-10-04：未登记到成果列表的格式走**独立字段** `missingKinds` —— 不再与
    //    "物理上找不到的文件"混成同一句话（真机：文件在盘上却被说成"工作区里没有"）。
    //    这条守卫的力度**不变**：明确要了 PPT、本轮没产出，就必须报。
    expect(webContentsSendMock).toHaveBeenCalledWith('artifact:claim-violation', {
      taskId: 'task-1',
      sessionKey: 'session-task-1',
      messageId: 'assistant-persisted',
      missing: [],
      missingKinds: ['PPT/PPTX 演示文稿'],
    });
  });

  /**
   * ⭐ BUG-047 残余（2026-10-14 M1）· main 侧接线：claim-guard 的动词短语判据在
   * `data-handlers` 收尾链上**真实生效**（不是只改 helper 的单测）。
   *
   * 负例：没有交付声称的纯建议句（`然后重新渲染生成一份新的.pptx文件`）——
   * 从前它被当真实交付名 ⇒ 判 missing ⇒ 弹「说好的文件不在」。现在不发 missing。
   * 正例（下一条）：同一句话发生在"用户明确要 PPT"的轮次里时，**仍然必须**报缺 PPTX ——
   * 收窄的只是"文件名声称"，不改真实成功判据。
   */
  it('⭐ BUG-047 残余：纯建议句（重新渲染生成一份新的.pptx）不发 missing、不发整条 claim-violation', async () => {
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
        content: '这一页的槽位还是不齐，然后重新渲染生成一份新的.pptx文件即可。',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    expect(webContentsSendMock).not.toHaveBeenCalledWith('artifact:claim-violation', expect.anything());
  });

  it('⭐ BUG-047 残余正对照：用户明确要 PPT 且无登记 ⇒ 同一句建议照旧必须报缺 PPTX', async () => {
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
        content: '槽位还是不齐，然后重新渲染生成一份新的.pptx文件即可。',
        timestamp: '2026-09-16T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();

    expect(webContentsSendMock).toHaveBeenCalledWith('artifact:claim-violation', {
      taskId: 'task-1',
      sessionKey: 'session-task-1',
      messageId: 'assistant-persisted',
      missing: [],
      missingKinds: ['PPT/PPTX 演示文稿'],
    });
  });

  it('includes parser diagnostics in the visible delivery event even without a filename claim', async () => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });
    const source = '// title: report\n<Slide><Text>body</Slide>';
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: '```slidegen\n' + source + '\n```',
        timestamp: '2026-09-29T00:00:02.000Z',
        sessionKey: 'session-task-1',
      },
    );
    await flushJobs();
    expect(webContentsSendMock).toHaveBeenCalledWith('artifact:claim-violation', {
      taskId: 'task-1',
      sessionKey: 'session-task-1',
      messageId: 'assistant-persisted',
      missing: [],
      slideFailures: [
        {
          code: 'slidegen-unparsable',
          diagnostic: {
            code: 'dsl-close-mismatch',
            offset: source.indexOf('</Slide>'),
            detail: 'expected </Text> but found </Slide>',
          },
        },
      ],
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

    // 同上：格式缺失经 `missingKinds` 独立上报，守卫力度不变。
    expect(webContentsSendMock).toHaveBeenCalledWith('artifact:claim-violation', {
      taskId: 'task-1',
      sessionKey: 'session-task-1',
      messageId: 'assistant-persisted',
      missing: [],
      missingKinds: ['HTML 网页'],
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

  /**
   * ⭐⭐ BUG-038（2026-10-08 亲验）：claim-guard 的**假失败**。
   *
   * 模型在后续轮次里**引用本任务已经登记过的产物名**（"已生成 report.docx，在上一版基础上补充…"）时，
   * 那份文件本来就不该在本轮变新 —— 旧判据拿 `sinceMs` 一把否定 ⇒ 每轮弹「说好的文件不在」。
   * 判据修正：名字**在本任务已登记的 artifact 集合里** ⇒ 不计入 missing。
   * ⚠️ 守卫强度对**未登记**的名字照旧（下一条负对照）。
   */
  describe('⭐ claim-guard 已登记名豁免（BUG-038）', () => {
    const registeredSqlite = (names: string[]) =>
      getSqliteMock.mockReturnValue({
        prepare: vi.fn(() => ({ all: vi.fn(() => names.map((name) => ({ name }))) })),
      });

    async function persistClaim(content: string): Promise<void> {
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
          content,
          timestamp: '2026-10-08T00:00:02.000Z',
          sessionKey: 'session-task-1',
        },
      );
      await flushJobs();
    }

    it('⭐ 引用的名字在本任务已登记 ⇒ 不推「说好的文件不在」', async () => {
      registeredSqlite(['report.docx']);
      await persistClaim('已生成 report.docx，在上一版基础上补充了结论一节。');
      expect(webContentsSendMock).not.toHaveBeenCalledWith('artifact:claim-violation', expect.anything());
    });

    it('⭐ 负对照：同一条回复，名字**没登记过** ⇒ 照旧报 missing（守卫强度不许松）', async () => {
      registeredSqlite(['other.docx']);
      await persistClaim('已生成 report.docx，在上一版基础上补充了结论一节。');
      expect(webContentsSendMock).toHaveBeenCalledWith(
        'artifact:claim-violation',
        expect.objectContaining({ messageId: 'assistant-persisted', missing: ['report.docx'] }),
      );
    });

    it('⭐ 负对照：没有库（getSqlite 为 null）⇒ 老行为一字不变', async () => {
      await persistClaim('已生成 report.docx，在上一版基础上补充了结论一节。');
      expect(webContentsSendMock).toHaveBeenCalledWith(
        'artifact:claim-violation',
        expect.objectContaining({ messageId: 'assistant-persisted', missing: ['report.docx'] }),
      );
    });
  });

  /**
   * ⭐⭐ BUG-042-c（2026-10-08 亲验的 C1 静默丢弃）：**写出来的不是有效文档**。
   *
   * 真机形状：模型自己把 JSON / 纯文本改名成 `.docx` 写进工作区，回复说"已生成"。
   * 文件**在**盘上（不算 missing）、登记门按字节拒收（只进 `skipped`）—— 从前界面上
   * **一条提示都没有**。现在：如实说"写出的文件不是有效文档"（走既有 claim 通道）。
   */
  describe('⭐ 假文档（写出来但不是有效格式）不再静默（BUG-042-c）', () => {
    async function validDocxBytes(): Promise<Buffer> {
      const zip = new JSZip();
      zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
      zip.file('word/document.xml', '<?xml version="1.0"?><w:document/>');
      return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
    }

    /** 走一遍真实收尾：工作区里放一份"这一轮写的" 季度报告.docx，回复声称已生成它。 */
    async function persistClaim(workspace: string, bytes: string | Buffer, userContent?: string): Promise<void> {
      reconcileTaskArtifactsMock.mockResolvedValue({
        saved: [],
        existing: [],
        updated: [],
        missing: [],
        skipped: [],
        budgetExhausted: false,
      });
      // ⚠️ 收尾链的 `workspacePath` 走的是 `getWorkspacePath()`（不是 begin 时传的那个）：
      //    两个都指到临时目录，这条链才是在**真实的工作区**上核对。
      getWorkspacePathMock.mockReturnValue(workspace);
      const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
      registerDataHandlers();
      beginArtifactRun(workspace, 'task-1', 'session-task-1', userContent ? { userContent } : undefined);
      // 文件在"本轮开始之后"出现（与真机一致：模型这一轮写出来的）。
      writeFileSync(join(workspace, '季度报告.docx'), bytes);
      selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'assistant-incoming',
          taskId: 'task-1',
          role: 'assistant',
          content: '已生成 季度报告.docx，请查收。',
          timestamp: '2026-10-08T00:00:02.000Z',
          sessionKey: 'session-task-1',
        },
      );
      await flushJobs();
    }

    it('⭐ JSON 伪装成 .docx ⇒ 报 invalidArtifacts，整轮判 failed', async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'claim-invalid-ws-'));
      try {
        await persistClaim(workspace, '{"kind":"docx","sections":[]}');
        expect(webContentsSendMock).toHaveBeenCalledWith(
          'artifact:claim-violation',
          expect.objectContaining({ messageId: 'assistant-persisted', invalidArtifacts: ['季度报告.docx'] }),
        );
        expect(webContentsSendMock).toHaveBeenCalledWith(
          'artifact:delivery-settled',
          expect.objectContaining({ messageId: 'assistant-persisted', status: 'failed' }),
        );
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('⭐ 用户明确要 Word 但拿到的是假件 ⇒ 只说"不是有效文档"，不再叠一句更含糊的"成果没有登记"', async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'claim-invalid-kinds-ws-'));
      try {
        await persistClaim(workspace, '{"kind":"docx","sections":[]}', '给我做一份 Word 文档');
        const violation = webContentsSendMock.mock.calls.find(
          ([channel]) => channel === 'artifact:claim-violation',
        )?.[1];
        expect(violation).toMatchObject({ invalidArtifacts: ['季度报告.docx'] });
        // 取舍写在案：含义更准的那条胜出（两层说的是同一件事，先弹更含糊的会误导）。
        expect(violation?.missingKinds).toBeUndefined();
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('⭐ 负对照：盘上那份是真 .docx ⇒ 一条失败都不报（别把正常的打成假文档）', async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'claim-valid-ws-'));
      try {
        await persistClaim(workspace, await validDocxBytes());
        expect(webContentsSendMock).not.toHaveBeenCalledWith('artifact:claim-violation', expect.anything());
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });
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

  it('keeps task data and artifact tracking when an active meeting blocks deletion', async () => {
    const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun('C:\\trusted-workspace', 'task-retained', 'session-retained');
    withTeamMeetingTaskDeletionMock.mockImplementationOnce(() => {
      throw new Error('Task belongs to an active meeting');
    });
    expect(handleMap.get('data:delete-task')!({}, { id: 'task-retained' })).toEqual({
      ok: false,
      error: 'Task belongs to an active meeting',
    });
    expect(dbMock.delete).not.toHaveBeenCalled();
    selectGetMock.mockReturnValueOnce({ id: 'accepted-assistant' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'accepted-assistant',
        taskId: 'task-retained',
        role: 'assistant',
        content: 'done',
        timestamp: '2026-09-30T00:00:00.000Z',
        sessionKey: 'session-retained',
      },
    );
    await flushJobs();
    expect(reconcileTaskArtifactsMock).toHaveBeenCalled();
  });

  it.each(['workspace', 'agent'])(
    'notifies saved and updated %s artifacts once per id, using fresh metadata',
    async (rootKind) => {
      getGatewayClientMock.mockReturnValue({
        listAgentFiles: async () => ({ agentId: 'main', workspace: 'C:\\agent-ws', files: [] }),
      });
      const old = { id: 'same-id', taskId: 'task-1', name: 'report.docx', localPath: 'task-1/report.docx', size: 10 };
      const updated = { ...old, size: 20 };
      const onlyUpdated = { ...old, id: 'updated-only', size: 30 };
      reconcileTaskArtifactsMock.mockImplementation(async (input: { rootKind?: string }) => ({
        saved: (input.rootKind ?? 'workspace') === rootKind ? [old] : [],
        updated: (input.rootKind ?? 'workspace') === rootKind ? [updated, onlyUpdated] : [],
        existing: [],
        missing: [],
        skipped: [],
        budgetExhausted: false,
      }));
      const { beginArtifactRunForGatewayDispatch, registerDataHandlers } =
        await import('../src/main/ipc/data-handlers.js');
      registerDataHandlers();
      const sessionKey = 'agent:main:clawwork:task-1';
      selectGetMock.mockReturnValueOnce({ id: 'task-1' });
      beginArtifactRunForGatewayDispatch({
        gatewayId: 'gateway-1',
        sessionKey,
        taskId: 'task-1',
        userContent: 'Update a Word document',
      });
      await flushJobs();
      selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'assistant-incoming',
          taskId: 'task-1',
          role: 'assistant',
          content: 'Done',
          timestamp: '2026-09-29T00:00:00.000Z',
          sessionKey,
        },
      );
      await flushJobs();
      const delivered = webContentsSendMock.mock.calls
        .filter(([channel]) => channel === 'artifact:saved')
        .map(([, item]) => item);
      expect(delivered).toEqual([updated, onlyUpdated]);
    },
  );

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

  /**
   * ⭐ **第三个根**：应用工作区**根层**（2026-10-07）。
   *
   * 现场：模型用 exec / CLI 把成品写到 `荣盈魔方工作区\荣盈互动公司介绍-v2-ade3018a.pptx`。
   * 前两条链（`<工作区>/<taskId>`、助手工作区）一个都不覆盖 ⇒ 文件明明生成了、
   * 产物面板里却什么都没有，**连失败提示都没有**（claim-guard 找得到，所以不算"丢了"）。
   *
   * ⚠️ 与应用根那条**同刻起跑**（`beginArtifactRun` 里）：它要抓的是"这一轮开始之前"
   *    根层就有哪些文件 —— 晚一刻就会把用户自己的文件当成这一轮的产物。
   */
  it('⭐ 第三个根：应用工作区根层同刻起跑，收尾跑第三条 reconcile 并推送', async () => {
    reconcileTaskArtifactsMock.mockImplementation(async (input: { rootKind?: string }) =>
      input.rootKind === 'workspace-root'
        ? {
            saved: [
              {
                id: 'workspace-root-artifact',
                name: '荣盈互动公司介绍-v2-ade3018a.pptx',
                root: 'workspace-root',
                localPath: '荣盈互动公司介绍-v2-ade3018a.pptx',
              },
            ],
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
    const sessionKey = 'session-task-1';

    selectGetMock.mockReturnValueOnce({ id: 'task-1' });
    beginArtifactRunForGatewayDispatch({
      gatewayId: 'gateway-1',
      sessionKey,
      taskId: 'task-1',
      userContent: '做一份公司介绍 PPT',
    });
    await flushJobs();

    // 起跑那一刻就采根层基线（与应用根基线同一刻、**独立**的一趟）
    expect(captureTaskArtifactBaselineMock).toHaveBeenCalledWith({
      workspacePath: 'C:\\trusted-workspace',
      taskId: 'task-1',
      rootKind: 'workspace-root',
    });

    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });
    createMessage(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: '完成',
        timestamp: '2026-10-07T00:00:02.000Z',
        sessionKey,
        toolCalls: [{ id: 'tool-1', status: 'done' }],
      },
    );
    await flushJobs();

    expect(reconcileTaskArtifactsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: 'C:\\trusted-workspace',
        taskId: 'task-1',
        rootKind: 'workspace-root',
      }),
    );
    // 根层收上来的产物必须**推给界面**（不推的话面板还是空的）
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:saved',
      expect.objectContaining({ id: 'workspace-root-artifact', root: 'workspace-root' }),
    );
  });

  /**
   * ⭐ 第三个根的**fail-closed** 面（2026-10-07）。
   *
   * 根层基线采不到（根不可信 / IO 出错）时，那一趟**一次都不许扫** —— "没有基线就裸扫"
   * 会把这一轮开始前就躺在根层的用户文件当成这一轮的产物。同时它必须是**软的**：
   * 与"没有第二个根"同一条处置，绝不把整轮交付判成失败。
   */
  it('⭐ 第三个根：根层基线采不到 ⇒ 那一趟不扫（绝无基线裸扫），也不拖垮整轮交付', async () => {
    captureTaskArtifactBaselineMock.mockImplementation(async (input: { rootKind?: string }) => {
      if (input.rootKind === 'workspace-root') throw new Error('workspace root unavailable');
      return { 'before.txt': 'signature' };
    });
    const { beginArtifactRunForGatewayDispatch, registerDataHandlers } =
      await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    selectGetMock.mockReturnValueOnce({ id: 'task-1' });
    beginArtifactRunForGatewayDispatch({
      gatewayId: 'gateway-1',
      sessionKey: 'session-task-1',
      taskId: 'task-1',
      userContent: '做一份公司介绍 PPT',
    });
    await flushJobs();

    selectGetMock.mockReturnValueOnce({ id: 'assistant-persisted' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'assistant-incoming',
        taskId: 'task-1',
        role: 'assistant',
        content: '完成',
        timestamp: '2026-10-07T00:00:03.000Z',
        sessionKey: 'session-task-1',
        toolCalls: [{ id: 'tool-1', status: 'done' }],
      },
    );
    await flushJobs();

    // 应用根那条照跑；根层那条**一次都没有**
    expect(reconcileCalls()).toHaveLength(1);
    expect(reconcileCalls('workspace-root')).toHaveLength(0);
    // 而且是软失败：整轮交付仍然按时结算（不是 failed、更不是悬着）
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:delivery-settled',
      expect.objectContaining({ taskId: 'task-1', status: 'succeeded' }),
    );
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
    it.each([
      ['Generate a Word document', 'docgen', '{"kind":"docx"}', 'docgen:failed', 'request-invalid'],
      [
        'Generate a PPT presentation',
        'slidegen',
        '// title: recovered\n<Slide><Text>x</Slide>',
        'slidegen:failed',
        'slidegen-unparsable',
      ],
      ['Generate an HTML file', 'htmlgen', '{"kind":"html"}', '', ''],
    ])(
      'recovers a fence after the display cutoff for intent: %s',
      async (userContent, fence, body, failureChannel, failureCode) => {
        const displayContent = 'x'.repeat(8000) + '...(truncated)...';
        const fullContent = 'x'.repeat(8100) + `\n\`\`\`${fence}\n${body}\n\`\`\``;
        const getChatHistory = vi.fn().mockResolvedValue({
          messages: [{ role: 'assistant', content: fullContent, __openclaw: { runId: 'late-fence' } }],
        });
        getGatewayClientMock.mockReturnValue({ getChatHistory });
        const { beginArtifactRun, bindArtifactRun, registerDataHandlers } =
          await import('../src/main/ipc/data-handlers.js');
        registerDataHandlers();
        const token = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1', { userContent });
        bindArtifactRun('task-1', 'session-task-1', token, 'late-fence');
        selectGetMock.mockReturnValueOnce({ id: 'assistant-late' }).mockReturnValueOnce({ gid: 'gateway-1' });
        handleMap.get('data:create-message')!(
          {},
          {
            id: 'assistant-late',
            taskId: 'task-1',
            role: 'assistant',
            content: displayContent,
            runId: 'late-fence',
            timestamp: '2026-09-29T00:00:00.000Z',
            sessionKey: 'session-task-1',
          },
        );
        await flushJobs();
        expect(getChatHistory).toHaveBeenCalledWith('session-task-1', 7, 500000);
        expect(generateHtmlPagesFromMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({ content: fullContent }),
        );
        if (failureChannel)
          expect(webContentsSendMock).toHaveBeenCalledWith(failureChannel, [
            expect.objectContaining({ code: failureCode }),
          ]);
      },
    );

    it.each(['cancel', 'license-switch'])(
      'does not start paid media after %s during a preceding await',
      async (change) => {
        let release!: (value: { saved: []; failed: [] }) => void;
        generateHtmlPagesFromMessageMock.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        );
        const content =
          '```imagegen\n' +
          JSON.stringify({ operationId: 'picture-one', model: 'qwen-image-plus', prompt: 'A cat', size: '1328*1328' }) +
          '\n```';
        await persistAssistant(content);
        expect(generateHtmlPagesFromMessageMock).toHaveBeenCalledTimes(1);
        if (change === 'cancel')
          (await import('../src/main/ipc/data-handlers.js')).cancelArtifactRunsForSession('session-task-1');
        else (await import('../src/main/commercial/license-generation.js')).advanceLicenseGeneration();
        release({ saved: [], failed: [] });
        await flushJobs();
        expect(startImagegenJobsMock).not.toHaveBeenCalled();
      },
    );

    it('retains cancellation ownership for background media without blocking the next chat turn', async () => {
      let sourceCurrent: (() => boolean) | undefined;
      let release: (() => void) | undefined;
      startImagegenJobsMock.mockImplementationOnce(
        (input: { sourceCurrent: () => boolean; retainSource?: () => () => void }) => {
          sourceCurrent = input.sourceCurrent;
          release = input.retainSource?.();
        },
      );
      await persistAssistant('```imagegen\n{"operationId":"picture-one"}\n```');
      expect(release).toBeTypeOf('function');
      expect(sourceCurrent?.()).toBe(true);
      const api = await import('../src/main/ipc/data-handlers.js');
      expect(api.isArtifactTurnInFlight('task-1', 'session-task-1')).toBe(false);
      api.cancelArtifactRunsForSession('session-task-1');
      expect(sourceCurrent?.()).toBe(false);
      release?.();
      release?.();
      expect(api.isArtifactTurnInFlight('task-1', 'session-task-1')).toBe(false);
    });

    it('starts image generation through message finalization with the exact task scope', async () => {
      const content =
        '```imagegen\n{"operationId":"picture-one","model":"qwen-image-plus","prompt":"A cat","size":"1328*1328"}\n```';
      await persistAssistant(content);
      expect(startImagegenJobsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: 'C:\\trusted-workspace',
          taskId: 'task-1',
          sessionKey: 'session-task-1',
          messageId: 'assistant-cut',
          content,
        }),
      );
    });

    it('does not start an image request from a truncated reply when full content is unavailable', async () => {
      await persistAssistant('```imagegen\n{"operationId":"picture-one"\n...(truncated)...');
      expect(startImagegenJobsMock).not.toHaveBeenCalled();
      expect(webContentsSendMock).toHaveBeenCalledWith('imagegen:failed', [{ code: 'imagegen-block-invalid' }]);
    });

    it('recovers image request content by the current run before starting it', async () => {
      const content =
        '```imagegen\n{"operationId":"picture-one","model":"qwen-image-plus","prompt":"A cat","size":"1328*1328"}\n```';
      const getChatHistory = vi.fn().mockResolvedValue({
        messages: [
          {
            role: 'assistant',
            content,
            __openclaw: { runId: 'image-run' },
          },
        ],
      });
      getGatewayClientMock.mockReturnValue({ getChatHistory });
      const { beginArtifactRun, bindArtifactRun, registerDataHandlers } =
        await import('../src/main/ipc/data-handlers.js');
      registerDataHandlers();
      const token = beginArtifactRun('C:\\trusted-workspace', 'task-1', 'session-task-1');
      bindArtifactRun('task-1', 'session-task-1', token, 'image-run');
      selectGetMock.mockReturnValueOnce({ id: 'assistant-image' }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'assistant-image',
          taskId: 'task-1',
          role: 'assistant',
          sessionKey: 'session-task-1',
          runId: 'image-run',
          timestamp: '2026-10-15T00:00:00Z',
          content: '```imagegen\n{"operationId":"picture-one"\n...(truncated)...',
        },
      );
      await flushJobs();
      expect(getChatHistory).toHaveBeenCalledWith('session-task-1', 7, 500000);
      expect(startImagegenJobsMock).toHaveBeenCalledWith(expect.objectContaining({ content, runId: 'image-run' }));
    });

    it('does not fetch history for truncated ordinary chat without an artifact request', async () => {
      const getChatHistory = vi.fn();
      getGatewayClientMock.mockReturnValue({ getChatHistory });
      await persistAssistant('x'.repeat(8000) + '...(truncated)...');
      expect(getChatHistory).not.toHaveBeenCalled();
    });
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
