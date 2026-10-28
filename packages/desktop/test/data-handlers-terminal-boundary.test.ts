import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();
const autoExtractArtifactsMock = vi.fn();
const getSqliteMock = vi.fn((): unknown => null);
const captureTaskArtifactBaselineMock = vi.fn();
const reconcileTaskArtifactsMock = vi.fn();
const getGatewayClientMock = vi.fn();
const getWorkspacePathMock = vi.fn(() => 'C:\\trusted-workspace');
const generateHtmlPagesFromMessageMock = vi.fn();
const webContentsSendMock = vi.fn();
const docgenMock = vi.fn();
const valuesMock = vi.fn(() => ({
  onConflictDoUpdate: vi.fn(() => ({ run: vi.fn() })),
  run: vi.fn(),
}));
const selectGetMock = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handleMap.set(channel, handler)),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { isDestroyed: () => false, send: webContentsSendMock } }]),
  },
}));

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

vi.mock('../src/main/db/index.js', () => ({
  getDb: () => dbMock,
  getSqlite: () => getSqliteMock(),
  isDbReady: () => true,
}));

vi.mock('../src/main/ipc/team-meeting-handlers.js', () => ({
  withTeamMeetingTaskDeletion: vi.fn((_taskId: string, remove: () => void) => remove()),
}));

vi.mock('../src/main/workspace/config.js', () => ({ getWorkspacePath: getWorkspacePathMock }));
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: getGatewayClientMock }));
vi.mock('../src/main/artifact/auto-extract.js', () => ({ autoExtractArtifacts: autoExtractArtifactsMock }));
vi.mock('../src/main/artifact/reconcile.js', () => ({
  captureTaskArtifactBaseline: captureTaskArtifactBaselineMock,
  reconcileTaskArtifacts: reconcileTaskArtifactsMock,
}));
vi.mock('../src/main/docgen/generate.js', () => ({ generateDocumentsFromMessage: docgenMock }));
vi.mock('../src/main/htmlgen/generate.js', () => ({
  generateHtmlPagesFromMessage: generateHtmlPagesFromMessageMock,
}));
vi.mock('../src/main/slidegen/generate.js', () => ({
  generateSlidesFromMessage: vi.fn().mockResolvedValue({ saved: [], failed: [], warnings: [] }),
}));

async function flushJobs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function reconcileCalls() {
  return reconcileTaskArtifactsMock.mock.calls.filter(
    ([input]) => ((input as { rootKind?: string }).rootKind ?? 'workspace') === 'workspace',
  );
}

const docgenBody =
  '正确的做法是直接在我的回复正文里放 `docgen` 代码块：\n\n```docgen\n{\n  "kind": "docx",\n  "title": "验收文档-205",\n  "sections": [\n    {\n      "heading": "1.0.3 验收文档",\n      "bullets": [\n        "升级与发布链路已通过",\n        "图片识别可用",\n        "文档由真实链路生成"\n      ]\n    }\n  ]\n}\n```\n';

async function setupRun(userContent?: string) {
  const { beginArtifactRun, bindArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
  registerDataHandlers();
  const token = beginArtifactRun(
    'C:\\trusted-workspace',
    'task-1',
    'session-task-1',
    userContent ? { userContent } : undefined,
  );
  bindArtifactRun('task-1', 'session-task-1', token, 'run-1');
  return handleMap.get('data:create-message')!;
}

const common = {
  taskId: 'task-1',
  sessionKey: 'session-task-1',
  runId: 'run-1',
  role: 'assistant',
  timestamp: '2026-10-10T00:00:00Z',
};

const evidence = { kind: 'final' as const, runId: 'run-1', stopReason: 'stop', source: 'history' };

function docgenReceived(content: string): boolean {
  return docgenMock.mock.calls.some(([input]) => (input as { content?: string }).content === content);
}

describe('DOCX-205 terminal boundary (fixed contract)', () => {
  beforeEach(async () => {
    vi.resetModules();
    (await import('../src/main/workspace/scope.js')).setWorkspaceDatabaseOwner(dbMock);
    handleMap.clear();
    autoExtractArtifactsMock.mockReset().mockResolvedValue({
      mediaFailures: [],
      savedMediaSourceKeys: [],
      failedMediaSourceKeys: [],
    });
    captureTaskArtifactBaselineMock.mockReset().mockResolvedValue({});
    reconcileTaskArtifactsMock.mockReset().mockResolvedValue({
      saved: [],
      existing: [],
      missing: [],
      skipped: [],
      budgetExhausted: false,
    });
    getGatewayClientMock.mockReset().mockReturnValue(undefined);
    generateHtmlPagesFromMessageMock.mockReset().mockResolvedValue({ saved: [], failed: [] });
    docgenMock.mockReset().mockResolvedValue({ saved: [], failed: [] });
    webContentsSendMock.mockReset();
    getSqliteMock.mockReset().mockReturnValue(null);
    selectGetMock.mockReset().mockReturnValue({ id: 'persisted', gid: 'gateway-1' });
  });

  it('compat: a direct final body without sync marker still reaches the generator', async () => {
    const create = await setupRun();
    selectGetMock.mockReturnValueOnce({ id: 'terminal' }).mockReturnValueOnce({ gid: 'gateway-1' });
    create({}, { ...common, id: 'terminal', content: docgenBody });
    await flushJobs();
    expect(docgenReceived(docgenBody)).toBe(true);
  });

  it('compat: an empty-content read snapshot does not suppress the later final body', async () => {
    const create = await setupRun();
    selectGetMock.mockReturnValueOnce({ id: 'intermediate' }).mockReturnValueOnce({ gid: 'gateway-1' });
    create({}, { ...common, id: 'intermediate', content: '', toolCalls: [{ id: 'read-1', status: 'done' }] });
    await flushJobs();
    expect(docgenMock).not.toHaveBeenCalled();
    selectGetMock.mockReturnValueOnce({ id: 'terminal' }).mockReturnValueOnce({ gid: 'gateway-1' });
    create({}, { ...common, id: 'terminal', content: docgenBody });
    await flushJobs();
    expect(docgenReceived(docgenBody)).toBe(true);
  });

  it('sync strict: a content-bearing intermediate snapshot does not consume the run', async () => {
    const create = await setupRun('生成一份 Word 文档（用 docgen 交付），文件名 验收文档-205.docx');
    selectGetMock.mockReturnValueOnce({ id: 'intermediate' }).mockReturnValueOnce({ gid: 'gateway-1' });
    create(
      {},
      {
        ...common,
        id: 'intermediate',
        content: '我先读一下技能文件，然后生成文档。',
        toolCalls: [{ id: 'read-1', status: 'done' }],
        sync: true,
      },
    );
    await flushJobs();
    expect(docgenMock).not.toHaveBeenCalled();
    expect(webContentsSendMock).not.toHaveBeenCalledWith('artifact:delivery-settled', expect.anything());
    selectGetMock.mockReturnValueOnce({ id: 'terminal' }).mockReturnValueOnce({ gid: 'gateway-1' });
    create({}, { ...common, id: 'terminal', content: docgenBody, sync: true, terminal: evidence });
    await flushJobs();
    expect(docgenReceived(docgenBody)).toBe(true);
  });

  it('sync: a tool-only terminal with evidence still delivers (not starved)', async () => {
    const create = await setupRun();
    selectGetMock.mockReturnValueOnce({ id: 'tool-only' }).mockReturnValueOnce({ gid: 'gateway-1' });
    create(
      {},
      {
        ...common,
        id: 'tool-only',
        content: '',
        toolCalls: [{ id: 'tool-1', status: 'done' }],
        sync: true,
        terminal: evidence,
      },
    );
    await flushJobs();
    expect(autoExtractArtifactsMock).toHaveBeenCalledTimes(1);
    expect(reconcileCalls()).toHaveLength(1);
  });

  it('sync: an evidenced terminal bound to another run reports unconfirmed instead of delivering', async () => {
    const create = await setupRun('生成一份 Word 文档（用 docgen 交付），文件名 验收文档-205.docx');
    selectGetMock.mockReturnValueOnce({ id: 'stale' });
    create(
      {},
      {
        ...common,
        id: 'stale',
        runId: 'run-other',
        content: docgenBody,
        sync: true,
        terminal: { kind: 'final', runId: 'run-other', stopReason: 'stop', source: 'history' },
      },
    );
    await flushJobs();
    expect(docgenMock).not.toHaveBeenCalled();
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:delivery-settled',
      expect.objectContaining({ messageId: 'stale', status: 'needs-review' }),
    );
  });

  it('sync: a bare empty final settles nothing; the late evidenced terminal delivers once', async () => {
    const create = await setupRun();
    selectGetMock.mockReturnValueOnce({ id: 'bare' });
    create({}, { ...common, id: 'bare', content: '', sync: true });
    await flushJobs();
    expect(autoExtractArtifactsMock).not.toHaveBeenCalled();
    expect(docgenMock).not.toHaveBeenCalled();
    selectGetMock.mockReturnValueOnce({ id: 'late' }).mockReturnValueOnce({ gid: 'gateway-1' });
    create({}, { ...common, id: 'late', content: docgenBody, sync: true, terminal: evidence });
    await flushJobs();
    expect(docgenReceived(docgenBody)).toBe(true);
    // 重放同一终态不产生第二条交付。
    selectGetMock.mockReturnValueOnce({ id: 'late' });
    create({}, { ...common, id: 'late', content: docgenBody, sync: true, terminal: evidence });
    await flushJobs();
    expect(reconcileCalls()).toHaveLength(1);
  });

  it('sync: a promise-only message fails the expected docx kind instead of succeeding', async () => {
    const create = await setupRun('生成一份 Word 文档（用 docgen 交付），文件名 验收文档-205.docx');
    selectGetMock.mockReturnValueOnce({ id: 'promise' }).mockReturnValueOnce({ gid: 'gateway-1' });
    create(
      {},
      {
        ...common,
        id: 'promise',
        content: '内容已提交，稍后会在右侧「产物」面板中出现 **验收文档-205.docx**。',
        sync: true,
        terminal: evidence,
      },
    );
    await flushJobs();
    // 生成器可以收到请求（正文里没有合法围栏块），但**不得**登记为成功交付：
    // 结算必须是 failed + 具名缺项，而不是把"内容已提交"当成交付完成。
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:delivery-settled',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'artifact:claim-violation',
      expect.objectContaining({ missingKinds: expect.arrayContaining([expect.any(String)]) }),
    );
  });
});
