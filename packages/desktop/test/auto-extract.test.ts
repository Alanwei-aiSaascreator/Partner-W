import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

const webContentsSendMock = vi.fn();
const dbAllMock = vi.fn();
const whereMock = vi.fn(() => ({ all: dbAllMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));
const capturedDb = { select: selectMock };
const getDbMock = vi.fn(() => capturedDb);
const getWorkspacePathMock = vi.fn(() => '/workspace');
const saveArtifactFromBufferMock = vi.fn();
const readOpenClawMediaFileMock = vi.fn();

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { send: webContentsSendMock } }]),
  },
}));

vi.mock('../src/main/db/index.js', () => ({
  getDb: getDbMock,
}));
vi.mock('../src/main/workspace/config.js', () => ({ getWorkspacePath: getWorkspacePathMock }));

vi.mock('../src/main/artifact/save.js', () => ({
  saveArtifactFromBuffer: saveArtifactFromBufferMock,
}));

const safeFetchMock = vi.fn();

vi.mock('../src/main/media/resolve.js', () => ({
  readOpenClawMediaFile: readOpenClawMediaFileMock,
}));

vi.mock('../src/main/net/safe-fetch.js', () => ({
  safeFetch: safeFetchMock,
}));

describe('autoExtractArtifacts', () => {
  it('distinguishes failed video sources when filenames are identical', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
    safeFetchMock.mockResolvedValueOnce(Buffer.from('saved video')).mockRejectedValueOnce(new Error('denied'));
    const attachments = ['first', 'second'].map((name) => ({
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      dataUrl: `https://example.invalid/${name}.mp4`,
    }));
    const result = await autoExtractArtifacts({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'same-basename',
      content: '',
      attachments,
    });
    expect(result.mediaFailures).toEqual([{ fileName: 'clip.mp4', reason: 'unavailable' }]);
    expect(result.failedMediaSourceKeys).toEqual([
      `attachment:${createHash('sha256').update(attachments[1]!.dataUrl).digest('hex').slice(0, 16)}`,
    ]);
    expect(result.savedMediaSourceKeys).toHaveLength(1);
    expect(JSON.stringify(result.mediaFailures)).not.toContain('example.invalid');
  });
  it.each(['database', 'workspace'])('discards pending media after %s replacement', async (replacement) => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
    let finish!: (buffer: Buffer) => void;
    safeFetchMock.mockReturnValueOnce(
      new Promise<Buffer>((resolve) => {
        finish = resolve;
      }),
    );
    const job = autoExtractArtifacts({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'old-workspace',
      content: '',
      attachments: [{ fileName: 'clip.mp4', dataUrl: 'https://example.invalid/clip.mp4', mimeType: 'video/mp4' }],
    });
    if (replacement === 'database') getDbMock.mockReturnValue({ select: selectMock });
    else getWorkspacePathMock.mockReturnValue('/replacement');
    finish(Buffer.from('video'));
    await job;
    expect(saveArtifactFromBufferMock).not.toHaveBeenCalled();
    expect(webContentsSendMock).not.toHaveBeenCalled();
  });
  it('retries enriched video metadata after the prior unsigned import finishes', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
    let failUnsigned!: (error: Error) => void;
    safeFetchMock.mockReturnValueOnce(
      new Promise<Buffer>((_resolve, reject) => {
        failUnsigned = reject;
      }),
    );
    const dataUrl = 'http://127.0.0.1:18789/api/chat/media/outgoing/session/video/full';
    const resolveMediaDownload = vi.fn().mockResolvedValue(`${dataUrl}?ticket=secret`);
    const params = {
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'enriched-video',
      content: '',
      gatewayHttpBase: 'http://127.0.0.1:18789',
      resolveMediaDownload,
      attachments: [{ fileName: 'clip.mp4', dataUrl, mimeType: 'video/mp4' }],
    };
    const initial = autoExtractArtifacts(params);
    const enriched = autoExtractArtifacts({
      ...params,
      attachments: [{ ...params.attachments[0]!, artifactId: 'artifact_managed_media_fixture' }],
    });
    expect(resolveMediaDownload).not.toHaveBeenCalled();
    failUnsigned(new Error('unsigned media denied'));
    expect((await initial).mediaFailures).toHaveLength(1);
    expect((await enriched).savedMediaSourceKeys).toHaveLength(1);
    expect(resolveMediaDownload).toHaveBeenCalledOnce();
    expect(saveArtifactFromBufferMock).toHaveBeenCalledOnce();
  });

  it('uses transient managed-video download tickets while deduplicating the original source', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
    const dataUrl = 'http://127.0.0.1:18789/api/chat/media/outgoing/session/video/full';
    const resolveMediaDownload = vi.fn().mockResolvedValue(`${dataUrl}?ticket=secret`);
    const params = {
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'ticket-video',
      content: '',
      gatewayHttpBase: 'http://127.0.0.1:18789',
      resolveMediaDownload,
      attachments: [
        { fileName: 'clip.mp4', dataUrl, mimeType: 'video/mp4', artifactId: 'artifact_managed_media_fixture' },
      ],
    };
    const result = await autoExtractArtifacts(params);
    expect(result).toMatchObject({
      savedMediaSourceKeys: [`attachment:${createHash('sha256').update(dataUrl).digest('hex').slice(0, 16)}`],
    });
    expect(resolveMediaDownload).toHaveBeenCalledWith(params.attachments[0]);
    expect(safeFetchMock).toHaveBeenCalledWith(
      `${dataUrl}?ticket=secret`,
      expect.objectContaining({ maxSize: 25 * 1024 * 1024 }),
    );
    expect(saveArtifactFromBufferMock.mock.calls[0][0].sourceKey).toBe(
      `attachment:${createHash('sha256').update(dataUrl).digest('hex').slice(0, 16)}`,
    );
    expect(JSON.stringify(saveArtifactFromBufferMock.mock.calls)).not.toContain('secret');
  });

  it('reports managed-video ticket denial without falling back to an unsigned fetch', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
    const params = {
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'denied-video',
      content: '',
      resolveMediaDownload: vi.fn().mockResolvedValue(null),
      attachments: [
        {
          fileName: 'clip.mp4',
          dataUrl: 'http://127.0.0.1:18789/api/chat/media/outgoing/session/video/full',
          mimeType: 'video/mp4',
          artifactId: 'artifact_managed_media_fixture',
        },
      ],
    };
    expect(await autoExtractArtifacts(params)).toEqual({
      mediaFailures: [{ fileName: 'clip.mp4', reason: 'unavailable' }],
      failedMediaSourceKeys: [
        `attachment:${createHash('sha256').update(params.attachments[0]!.dataUrl).digest('hex').slice(0, 16)}`,
      ],
    });
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('imports native gateway video media through safe fetch with the 25 MB media limit', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
    const dataUrl = 'http://127.0.0.1:18789/api/chat/media/outgoing/session/video/full';
    const result = await autoExtractArtifacts({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'native-video',
      content: '',
      gatewayHttpBase: 'http://127.0.0.1:18789',
      attachments: [{ fileName: 'clip.mp4', dataUrl, mimeType: 'video/mp4' }],
    });
    expect(safeFetchMock).toHaveBeenCalledWith(dataUrl, {
      trustedOrigin: 'http://127.0.0.1:18789',
      maxSize: 25 * 1024 * 1024,
    });
    expect(saveArtifactFromBufferMock).toHaveBeenCalledWith(
      // ⭐ BUG-120：视频附件现在登记成专属类型 `video`（改型前与 docx/pptx 一样是 'file'）。
      expect.objectContaining({ fileName: 'clip.mp4', artifactType: 'video' }),
    );
    expect(result).toEqual({
      mediaFailures: [],
      savedMediaSourceKeys: [`attachment:${createHash('sha256').update(dataUrl).digest('hex').slice(0, 16)}`],
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockReturnValue(capturedDb);
    getWorkspacePathMock.mockReturnValue('/workspace');
    dbAllMock.mockReturnValue([]);
    saveArtifactFromBufferMock.mockResolvedValue({
      id: 'artifact-1',
      taskId: 'task-1',
      messageId: 'msg-1',
      type: 'image',
      name: 'result.png',
      localPath: 'task-1/result.png',
      mimeType: 'image/png',
      size: 5,
      createdAt: '2026-03-16T00:00:00.000Z',
    });
    readOpenClawMediaFileMock.mockResolvedValue(Buffer.from('image').toString('base64'));
    safeFetchMock.mockResolvedValue(Buffer.from('image'));
  });

  it.each([
    'current.native-ppt.json',
    'UPPER.NATIVE-PPT.JSON',
    '.royin-ppt-receipt-private.json',
    '.ROYIN-PPT-RECEIPT-private.JSON',
    'current.native-ppt.json.tmp',
    'diagnostic.tmp',
    'diagnostic.PART',
    'diagnostic.partial',
    'diagnostic.lock',
    'draft.json~',
    '~$draft.json',
  ])('does not register the reserved intermediate fence %s', async (fileName) => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
    const params = {
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'reserved-fence',
      content: '```' + fileName + '\n{"private":true}\n```',
    };

    await autoExtractArtifacts(params);
    await autoExtractArtifacts(params);

    expect(saveArtifactFromBufferMock).not.toHaveBeenCalled();
    expect(webContentsSendMock).not.toHaveBeenCalled();
  });

  it.each(['report.json', 'source.json', '.custom.json', '.gitignore'])(
    'preserves the user-authored formal fence %s',
    async (fileName) => {
      const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
      const content = '{"userReport":true}';

      await autoExtractArtifacts({
        workspacePath: '/workspace',
        taskId: 'task-1',
        messageId: 'formal-fence',
        content: '```' + fileName + '\n' + content + '\n```',
      });

      expect(saveArtifactFromBufferMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ fileName, contentText: content, artifactType: 'code', buffer: Buffer.from(content) }),
      );
    },
  );

  it('saves assistant image attachments as image artifacts', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');

    await autoExtractArtifacts({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'msg-1',
      content: '',
      attachments: [
        {
          fileName: 'result.png',
          dataUrl: 'file:///Users/x/.openclaw/media/result.png',
          mimeType: 'image/png',
          sourcePath: '/Users/x/.openclaw/media/result.png',
        },
      ],
    });

    expect(readOpenClawMediaFileMock).toHaveBeenCalledWith('/Users/x/.openclaw/media/result.png');
    expect(saveArtifactFromBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: '/workspace',
        taskId: 'task-1',
        messageId: 'msg-1',
        fileName: 'result.png',
        buffer: Buffer.from('image'),
        artifactType: 'image',
        sourceKey: expect.stringMatching(/^attachment:/),
      }),
    );
    expect(webContentsSendMock).toHaveBeenCalledWith('artifact:saved', expect.objectContaining({ id: 'artifact-1' }));
  });

  it.each(['mp4', 'webm'])('saves %s attachments once as file artifacts and emits a saved event', async (extension) => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
    const sourcePath = `C:/qa/media/tool-video-generation/clip.${extension}`;
    const attachment = {
      fileName: `clip.${extension}`,
      dataUrl: `file:///${sourcePath}`,
      mimeType: `video/${extension}`,
      sourcePath,
    };
    const params = {
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'msg-video',
      content: '',
      attachments: [attachment, attachment],
    };
    saveArtifactFromBufferMock.mockResolvedValue({
      id: 'video-1',
      type: 'video',
      name: attachment.fileName,
      mimeType: attachment.mimeType,
      size: 5,
    });
    await autoExtractArtifacts(params);
    expect(readOpenClawMediaFileMock).toHaveBeenCalledWith(sourcePath);
    expect(saveArtifactFromBufferMock).toHaveBeenCalledExactlyOnceWith(
      // ⭐ BUG-120：视频附件登记成 `video`。
      expect.objectContaining({
        artifactType: 'video',
        fileName: `clip.${extension}`,
        sourceKey: expect.stringMatching(/^attachment:/),
      }),
    );
    expect(webContentsSendMock).toHaveBeenCalledExactlyOnceWith(
      'artifact:saved',
      expect.objectContaining({ id: 'video-1', mimeType: `video/${extension}` }),
    );
    dbAllMock.mockReturnValue([{ sourceKey: saveArtifactFromBufferMock.mock.calls[0][0].sourceKey }]);
    await autoExtractArtifacts(params);
    expect(saveArtifactFromBufferMock).toHaveBeenCalledTimes(1);
  });

  it('does not save or emit a video rejected by the verified media reader', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
    readOpenClawMediaFileMock.mockResolvedValue(null);
    const result = await autoExtractArtifacts({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'msg-video',
      content: '',
      attachments: [
        {
          fileName: 'clip.mp4',
          dataUrl: 'file:///outside/clip.mp4',
          sourcePath: '/outside/clip.mp4',
          mimeType: 'video/mp4',
        },
      ],
    });
    expect(readOpenClawMediaFileMock).toHaveBeenCalledOnce();
    expect(saveArtifactFromBufferMock).not.toHaveBeenCalled();
    expect(webContentsSendMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      mediaFailures: [{ fileName: 'clip.mp4', reason: 'unavailable' }],
      failedMediaSourceKeys: [
        `attachment:${createHash('sha256').update('/outside/clip.mp4').digest('hex').slice(0, 16)}`,
      ],
    });
  });

  it('returns a filename-only video failure when the verified reader throws', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
    readOpenClawMediaFileMock.mockRejectedValue(new Error('cannot read C:/private/clip.mp4'));
    const result = await autoExtractArtifacts({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'msg-video',
      content: '',
      attachments: [
        {
          fileName: 'C:/private/clip.mp4',
          dataUrl: 'file:///C:/private/clip.mp4',
          sourcePath: 'C:/private/clip.mp4',
          mimeType: 'video/mp4',
        },
      ],
    });
    expect(result).toEqual({
      mediaFailures: [{ fileName: 'clip.mp4', reason: 'unavailable' }],
      failedMediaSourceKeys: [
        `attachment:${createHash('sha256').update('C:/private/clip.mp4').digest('hex').slice(0, 16)}`,
      ],
    });
    expect(saveArtifactFromBufferMock).not.toHaveBeenCalled();
  });

  it('does not save duplicate attachment artifacts with the same source key', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');

    const sourcePath = '/Users/x/.openclaw/media/result.png';
    const key = `attachment:${createHash('sha256').update(sourcePath).digest('hex').slice(0, 16)}`;
    dbAllMock.mockReturnValue([{ name: 'result-a1b2c3d4.png', type: 'image', size: 5, sourceKey: key }]);

    await autoExtractArtifacts({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'msg-1',
      content: '',
      attachments: [
        {
          fileName: 'result.png',
          dataUrl: 'file:///Users/x/.openclaw/media/result.png',
          mimeType: 'image/png',
          sourcePath,
        },
      ],
    });

    expect(saveArtifactFromBufferMock).not.toHaveBeenCalled();
    expect(webContentsSendMock).not.toHaveBeenCalled();
  });

  it('does not re-save legacy attachment artifacts that predate source keys', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');

    dbAllMock.mockReturnValue([{ name: 'result-a1b2c3d4.png', type: 'image', size: 5, sourceKey: '' }]);

    await autoExtractArtifacts({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'msg-1',
      content: '',
      attachments: [
        {
          fileName: 'result.png',
          dataUrl: 'file:///Users/x/.openclaw/media/result.png',
          mimeType: 'image/png',
          sourcePath: '/Users/x/.openclaw/media/result.png',
        },
      ],
    });

    expect(saveArtifactFromBufferMock).not.toHaveBeenCalled();
    expect(webContentsSendMock).not.toHaveBeenCalled();
  });

  /**
   * ⭐ BUG-120（2026-10-17）：视频改型 `file → video` 时**最容易漏掉的一处**。
   *
   * `saveExtracted` 的"老行去重"判据里有一条 `artifact.type !== input.artifactType` ——
   * 库里的旧登记（sourceKey 时代之前的视频行）类型是 `file`，而新进来的附件类型变成了
   * `video` ⇒ 类型对不上 ⇒ **同一份片子被重复登记一次**（用户成果列表里冒出两条）。
   *
   * ⇒ video 与 file 是同一个去重家族，判据必须跨这两者成立。
   */
  it('⭐ BUG-120：视频改型后，旧登记的 file 行仍算同一份（去重语义不被破坏）', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
    const dataUrl = 'http://127.0.0.1:18789/api/chat/media/outgoing/session/video/full';
    const bytes = Buffer.from('video-bytes');
    safeFetchMock.mockResolvedValue(bytes);
    // 旧行：改型前登记的 file 行（没有 sourceKey ⇒ 走"老行去重"那条判据）
    dbAllMock.mockReturnValue([{ name: 'clip-a1b2c3d4.mp4', type: 'file', size: bytes.length, sourceKey: '' }]);

    await autoExtractArtifacts({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'legacy-video',
      content: '',
      gatewayHttpBase: 'http://127.0.0.1:18789',
      attachments: [{ fileName: 'clip.mp4', dataUrl, mimeType: 'video/mp4' }],
    });

    expect(saveArtifactFromBufferMock).not.toHaveBeenCalled();
  });

  it('对照：同一条判据对**不同**片子仍然放行（不是把整类都吞掉）', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');
    const dataUrl = 'http://127.0.0.1:18789/api/chat/media/outgoing/session/video/full';
    const bytes = Buffer.from('video-bytes');
    safeFetchMock.mockResolvedValue(bytes);
    // 老行同名但**大小不同** ⇒ 不是同一份，必须照常登记
    dbAllMock.mockReturnValue([{ name: 'clip-a1b2c3d4.mp4', type: 'file', size: bytes.length + 1, sourceKey: '' }]);

    await autoExtractArtifacts({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'legacy-video-2',
      content: '',
      gatewayHttpBase: 'http://127.0.0.1:18789',
      attachments: [{ fileName: 'clip.mp4', dataUrl, mimeType: 'video/mp4' }],
    });

    expect(saveArtifactFromBufferMock).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent extraction for the same message', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');

    let resolveRead: (value: string) => void = () => {};
    readOpenClawMediaFileMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRead = resolve;
      }),
    );

    const params = {
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'msg-1',
      content: '',
      attachments: [
        {
          fileName: 'result.png',
          dataUrl: 'file:///Users/x/.openclaw/media/result.png',
          mimeType: 'image/png',
          sourcePath: '/Users/x/.openclaw/media/result.png',
        },
      ],
    };

    const first = autoExtractArtifacts(params);
    const second = autoExtractArtifacts(params);
    expect(readOpenClawMediaFileMock).toHaveBeenCalledTimes(1);

    resolveRead(Buffer.from('image').toString('base64'));
    await Promise.all([first, second]);

    expect(saveArtifactFromBufferMock).toHaveBeenCalledTimes(1);
    expect(webContentsSendMock).toHaveBeenCalledTimes(1);
  });

  it('uses fallback .png extension for image URLs without a file extension', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');

    await autoExtractArtifacts({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'msg-1',
      content: '![my image](https://example.com/image) ![another](https://cdn.example.com/path/photo?w=800)',
      attachments: [],
    });

    expect(saveArtifactFromBufferMock).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'my_image.png' }));

    expect(saveArtifactFromBufferMock).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'another.png' }));

    expect(saveArtifactFromBufferMock).toHaveBeenCalledTimes(2);
  });

  it('preserves real extensions from markdown image URLs', async () => {
    const { autoExtractArtifacts } = await import('../src/main/artifact/auto-extract.js');

    await autoExtractArtifacts({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'msg-1',
      content:
        '![screenshot](https://example.com/screenshot.png) ![photo](https://cdn.example.com/photo.jpg?w=800) ![icon](https://cdn.example.com/icon.avif)',
      attachments: [],
    });

    expect(saveArtifactFromBufferMock).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'screenshot.png' }));
    expect(saveArtifactFromBufferMock).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'photo.jpg' }));
    expect(saveArtifactFromBufferMock).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'icon.avif' }));
  });
});
