import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionKey, type Artifact, type SlidegenWarning } from '@clawwork/shared';
import type { generateSlidesFromMessage, SlidegenGenerateResult } from '../src/main/slidegen/generate.js';

const workspacePath = 'C:\\quality-test-workspace';
const taskId = 'quality-task';
const sessionKey = buildSessionKey(taskId, 'main');
const messageId = 'persisted-assistant';
const handleMap = new Map<string, (...args: unknown[]) => unknown>();
const sendMock = vi.fn();
const selectGetMock = vi.fn();
const extractMock = vi.fn();
const reconcileMock = vi.fn();
const documentsMock = vi.fn();
const htmlMock = vi.fn();
const slidesMock = vi.fn<typeof generateSlidesFromMessage>();
const collectReceiptsMock = vi.fn();
const reuseDeckMock = vi.fn();
const unconfirmedMock = vi.fn();
const outputCurrentMock = vi.fn();
const sqliteMock = vi.fn(() => null as unknown);
const nativeControlMock = vi.fn();
const nativeInputMock = vi.fn();
const nativeRenderMock = vi.fn();
const nativeReceiptMock = vi.fn();
const nativeReviewMock = vi.fn();
const nativeGuardMock = vi.fn();
const nativeGatewayMock = vi.fn();
const saveArtifactMock = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handleMap.set(channel, handler)),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => [{ webContents: { send: sendMock, isDestroyed: () => false } }]) },
}));
vi.mock('../src/main/db/index.js', () => ({
  isDbReady: vi.fn(() => true),
  getSqlite: sqliteMock,
  getDb: vi.fn(() => ({
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(() => ({ run: vi.fn() })) })) })),
    select: vi.fn((fields?: Record<string, unknown>) => {
      if (fields && 'taskId' in fields && 'sessionKey' in fields && 'role' in fields) {
        return { from: () => ({ where: () => ({ get: () => undefined }) }) };
      }
      return { from: vi.fn(() => ({ where: vi.fn(() => ({ get: selectGetMock })) })) };
    }),
  })),
}));
vi.mock('../src/main/ipc/team-meeting-handlers.js', () => ({ withTeamMeetingTaskDeletion: vi.fn() }));
vi.mock('../src/main/workspace/config.js', () => ({
  getWorkspacePath: vi.fn(() => workspacePath),
  // ⭐ 夹具补齐（2026-10-08 pre19）：delivery-activities（收尾活动的账号归属快照）读
  //    `readConfig()?.commercial`，本 mock 原只提供 getWorkspacePath → 运行时报
  //    "No readConfig export"。与真身形状对齐：workspacePath + 空 commercial。
  readConfig: vi.fn(() => ({ workspacePath, commercial: undefined })),
}));
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: nativeGatewayMock }));
vi.mock('../src/main/docgen/native-task-control.js', () => ({ nativeTaskControl: nativeControlMock }));
vi.mock('../src/main/docgen/native-tool-input.js', () => ({ nativeInputFromCompletedWrites: nativeInputMock }));
vi.mock('../src/main/docgen/native-file.js', () => ({ renderNativePptFile: nativeRenderMock }));
vi.mock('../src/main/slidegen/receipt.js', () => ({ readSlideGenerationReceipt: nativeReceiptMock }));
vi.mock('../src/main/slidegen/source-file.js', () => ({ readWorkspaceBytes: () => Buffer.from('{}') }));
vi.mock('../src/main/docgen/native-review.js', () => ({ reviewNativePpt: nativeReviewMock }));
vi.mock('../src/main/docgen/native-review-runtime.js', () => ({ nativeReviewPorts: () => undefined }));
vi.mock('../src/main/docgen/native-dispatch-guard.js', () => ({ requireNativeTestBudget: nativeGuardMock }));
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
}));
vi.mock('../src/main/artifact/auto-extract.js', () => ({ autoExtractArtifacts: extractMock }));
// B 包（2026-10-07）：收尾的"规范落位"走的就是它（复制进任务目录 + 登记）。
// ⚠️ `saveArtifactFromBuffer` 在这里用不到（三条生成链各自被 mock 了），给个空壳保持模块形状。
vi.mock('../src/main/artifact/save.js', () => ({
  saveArtifact: saveArtifactMock,
  saveArtifactFromBuffer: vi.fn(),
}));
vi.mock('../src/main/artifact/reconcile.js', () => ({
  captureTaskArtifactBaseline: vi.fn().mockResolvedValue({}),
  reconcileTaskArtifacts: reconcileMock,
}));
vi.mock('../src/main/docgen/generate.js', () => ({ generateDocumentsFromMessage: documentsMock }));
vi.mock('../src/main/htmlgen/generate.js', () => ({ generateHtmlPagesFromMessage: htmlMock }));
vi.mock('../src/main/slidegen/generate.js', () => ({ generateSlidesFromMessage: slidesMock }));
vi.mock('../src/main/slidegen/tool-receipts.js', () => ({
  collectToolSlideReceipts: collectReceiptsMock,
  reuseToolSlideDeck: reuseDeckMock,
  hasUnconfirmedSlideToolOutput: unconfirmedMock,
  isToolSlideOutputCurrent: outputCurrentMock,
}));
vi.mock('../src/main/artifact/agent-workspace.js', () => ({
  resolveAgentWorkspace: vi.fn().mockResolvedValue('C:\\agent-quality-workspace'),
}));
vi.mock('../src/main/slidegen/deck-file.js', () => ({
  captureDeckFileBaseline: () => ({}),
  changedDeckFiles: () => [],
  decksFromFiles: () => ({ text: '```slidegen\n// title: Existing\n<Slide></Slide>\n```', failures: [] }),
}));

const artifact: Artifact = {
  id: 'saved-deck',
  taskId,
  messageId,
  name: 'Product overview (2).pptx',
  type: 'file',
  filePath: `${taskId}/Product overview (2).pptx`,
  localPath: `${taskId}/Product overview (2).pptx`,
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  size: 1200,
  createdAt: '2026-09-30T00:00:00.000Z',
  availability: 'available',
};
const warning: SlidegenWarning = {
  code: 'layout-text-occluded',
  page: 4,
  element: 8,
  detail: 'Covered by element 9',
  artifactName: artifact.name,
};
const emptyReconciliation = { saved: [], existing: [], missing: [], skipped: [], budgetExhausted: false };

function warningResult(): SlidegenGenerateResult {
  return { saved: [artifact], failed: [], warnings: [warning] };
}

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function persistAssistant(canonicalId = messageId, incomingId = 'incoming-assistant', content = 'Done'): void {
  selectGetMock.mockReturnValueOnce({ id: canonicalId }).mockReturnValueOnce(undefined);
  expect(
    handleMap.get('data:create-message')!(
      {},
      {
        id: incomingId,
        taskId,
        sessionKey,
        role: 'assistant',
        content,
        timestamp: '2026-09-30T00:00:00.000Z',
      },
    ),
  ).toEqual({ ok: true });
}

function settlements() {
  return sendMock.mock.calls.filter(([channel]) => channel === 'artifact:delivery-settled').map(([, data]) => data);
}

async function waitForSettlement(count = 1): Promise<void> {
  await vi.waitFor(() => expect(settlements()).toHaveLength(count));
}

describe('slide quality delivery settlement', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.resetModules();
    (await import('../src/main/workspace/scope.js')).setWorkspaceDatabaseOwner({});
    sqliteMock.mockReset().mockReturnValue(null);
    nativeControlMock.mockReset();
    nativeInputMock.mockReset();
    nativeRenderMock.mockReset();
    nativeReceiptMock.mockReset();
    nativeReviewMock.mockReset().mockResolvedValue({ status: 'not-performed' });
    nativeGuardMock.mockReset().mockRejectedValue(Error('budget-unavailable'));
    nativeGatewayMock.mockReset();
    saveArtifactMock.mockReset();
    handleMap.clear();
    sendMock.mockReset();
    selectGetMock.mockReset();
    extractMock.mockReset().mockResolvedValue(undefined);
    reconcileMock.mockReset().mockResolvedValue(emptyReconciliation);
    documentsMock.mockReset().mockResolvedValue({ saved: [], failed: [] });
    htmlMock.mockReset().mockResolvedValue({ saved: [], failed: [] });
    slidesMock.mockReset().mockResolvedValue(warningResult());
    collectReceiptsMock.mockReset().mockReturnValue({ receipts: [], rejected: 0 });
    reuseDeckMock.mockReset().mockReturnValue([]);
    unconfirmedMock.mockReset().mockReturnValue(false);
    outputCurrentMock.mockReset().mockReturnValue(true);
    const { registerDataHandlers, beginArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun(workspacePath, taskId, sessionKey);
  });

  it('manages native generation then review before registration, skips both old exporters and fences stop', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    const control = { active_token: '', canceled: 0, last_receipt: null as string | null, auto_count: 0 };
    sqliteMock.mockReturnValue({});
    nativeControlMock.mockReturnValue({
      beginUser: (_task: string, token: string) => {
        control.active_token = token;
        control.canceled = 0;
      },
      beginAutomatic: (_task: string, previous: string, token: string) => {
        if (control.canceled || control.active_token !== previous || control.auto_count >= 2) return false;
        control.active_token = token;
        control.auto_count++;
        return true;
      },
      get: () => control,
      cancel: (_task: string, token: string) => {
        if (control.active_token === token) control.canceled = 1;
      },
      remember: (_task: string, _token: string, receipt: string) => {
        control.last_receipt = receipt;
      },
    });
    nativeInputMock.mockReturnValue('current.native-ppt.json');
    nativeRenderMock.mockResolvedValue({ fileCreated: true, receiptFile: 'current-receipt.json' });
    nativeReceiptMock.mockReturnValue({
      sourceFormat: 'native-template-v5',
      fileName: artifact.name,
      sourceFile: '.royin-native/source.json',
      bytes: artifact.size,
    });
    const heldReview = deferred<{ status: string }>();
    nativeReviewMock.mockReturnValue(heldReview.promise);
    reconcileMock.mockResolvedValue({
      ...emptyReconciliation,
      saved: [
        {
          ...artifact,
          root: 'agent',
          localPath: artifact.name,
          filePath: 'C:\\agent-quality-workspace\\' + artifact.name,
        },
      ],
    });
    const { beginArtifactRun, bindArtifactRun, cancelArtifactRunsForTask } =
      await import('../src/main/ipc/data-handlers.js');
    const token = beginArtifactRun(workspacePath, taskId, sessionKey, {
      gatewayId: 'gateway-1',
      userContent: '做一份PPT',
    });
    bindArtifactRun(taskId, sessionKey, token, 'managed-native-run');
    selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'native-incoming',
        taskId,
        sessionKey,
        runId: 'managed-native-run',
        role: 'assistant',
        content: '正在生成',
        timestamp: '2026-10-02T00:00:00Z',
        toolCalls: [
          {
            id: 'write',
            name: 'write',
            status: 'done',
            startedAt: '',
            args: { path: 'current.native-ppt.json', content: '{}' },
          },
        ],
      },
    );
    await vi.waitFor(() => expect(nativeReviewMock).toHaveBeenCalledOnce());
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(settlements()).toHaveLength(0);
    heldReview.resolve({ status: 'passed' });
    await waitForSettlement();
    expect(nativeRenderMock).toHaveBeenCalledOnce();
    expect(documentsMock).toHaveBeenCalledWith(expect.objectContaining({ skipPptx: true }));
    expect(slidesMock.mock.calls.every(([input]) => input.content === '')).toBe(true);
    expect(control.last_receipt).toBe('current-receipt.json');
    // Successful local mocked review does not stand in for actual terminal visual acceptance.
    const follow = beginArtifactRun(workspacePath, taskId, sessionKey, { userContent: '再美观一点' });
    expect(control.active_token).toBe(follow);
    cancelArtifactRunsForTask(taskId);
    expect(control.canceled).toBe(1);
    expect(nativeGuardMock).not.toHaveBeenCalled();
  });

  it('keeps a registered native file pending review even without warnings', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    sqliteMock.mockReturnValue({});
    nativeControlMock.mockReturnValue({ get: () => undefined });
    const entries = [
      {
        receiptFile: 'native-proof',
        source: '{"template":"business-deck-v5"}',
        receipt: {
          sourceFormat: 'native-template-v5',
          sourceFile: '.royin-native-test/source.json',
          fileName: artifact.name,
          bytes: artifact.size,
        },
      },
    ];
    collectReceiptsMock.mockReturnValue({ receipts: entries, rejected: 0 });
    slidesMock.mockResolvedValue({ saved: [], failed: [], warnings: [] });
    reconcileMock.mockResolvedValue({
      ...emptyReconciliation,
      saved: [
        {
          ...artifact,
          root: 'agent',
          localPath: artifact.name,
          filePath: 'C:\\agent-quality-workspace\\' + artifact.name,
        },
      ],
    });
    const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    const token = beginArtifactRun(workspacePath, taskId, sessionKey, { gatewayId: 'gateway-1' });
    bindArtifactRun(taskId, sessionKey, token, 'native-run');
    selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'incoming',
        taskId,
        sessionKey,
        runId: 'native-run',
        role: 'assistant',
        content: 'Created',
        timestamp: '2026-09-30T00:00:00Z',
      },
    );
    await waitForSettlement();
    expect(collectReceiptsMock).toHaveBeenCalledWith(expect.objectContaining({ allowNative: true }));
    expect(documentsMock).toHaveBeenCalledWith(expect.objectContaining({ skipPptx: true }));
    expect(slidesMock.mock.calls[0]?.[0].content).not.toContain('.royin-native-test');
    expect(settlements()[0]).toMatchObject({ status: 'needs-review' });
    const agentReconcile = reconcileMock.mock.calls.find(([input]) => input.rootKind === 'agent')?.[0];
    expect(agentReconcile.isCandidateCurrent('input.native-ppt.json')).toBe(false);
    expect(sendMock).toHaveBeenCalledWith('artifact:saved', expect.objectContaining({ root: 'agent' }));
  });

  it.each(['把第二页改成蓝色', '再查一下天气', '请帮我生成一份PPT'])(
    'rejects controlled A dispatch without task SQLite before creating a run: %s',
    async (userContent) => {
      vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
      sqliteMock.mockReturnValue(null);
      const { beginArtifactRun } = await import('../src/main/ipc/data-handlers.js');
      expect(() =>
        beginArtifactRun(workspacePath, taskId, sessionKey, { gatewayId: 'gateway-1', userContent }),
      ).toThrow('native-task-state-unavailable');
      expect(nativeControlMock).not.toHaveBeenCalled();
      expect(nativeRenderMock).not.toHaveBeenCalled();
    },
  );

  it('preserves ordinary dispatch without SQLite when controlled A is disabled', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '0');
    sqliteMock.mockReturnValue(null);
    const { beginArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    expect(beginArtifactRun(workspacePath, taskId, sessionKey, { userContent: '再查一下天气' })).toEqual(
      expect.any(String),
    );
    expect(nativeControlMock).not.toHaveBeenCalled();
  });

  it('keeps an older controlled pending token retired after the newer run finishes', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    sqliteMock.mockReturnValue({});
    nativeControlMock.mockReturnValue({ get: () => undefined });
    slidesMock.mockResolvedValue({ saved: [], failed: [], warnings: [] });
    const { beginArtifactRun, bindArtifactRun, isArtifactRunPendingCurrent } =
      await import('../src/main/ipc/data-handlers.js');
    const older = beginArtifactRun(workspacePath, taskId, sessionKey, { userContent: '查询天气' });
    expect(isArtifactRunPendingCurrent(taskId, sessionKey, older)).toBe(true);
    const newer = beginArtifactRun(workspacePath, taskId, sessionKey, { userContent: '查询明天天气' });
    expect(isArtifactRunPendingCurrent(taskId, sessionKey, older)).toBe(false);
    bindArtifactRun(taskId, sessionKey, newer, 'newer-runtime-run');
    selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce(undefined);
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'newer-pending-incoming',
        taskId,
        sessionKey,
        runId: 'newer-runtime-run',
        role: 'assistant',
        content: 'Weather checked.',
        timestamp: new Date().toISOString(),
        toolCalls: [],
      },
    );
    await waitForSettlement();
    expect(isArtifactRunPendingCurrent(taskId, sessionKey, newer)).toBe(false);
    expect(isArtifactRunPendingCurrent(taskId, sessionKey, older)).toBe(false);
  });

  it('only admits an unbound current pending token and rejects it after session cancellation', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    sqliteMock.mockReturnValue({});
    nativeControlMock.mockReturnValue({ get: () => undefined });
    const { beginArtifactRun, bindArtifactRun, cancelArtifactRunsForSession, isArtifactRunPendingCurrent } =
      await import('../src/main/ipc/data-handlers.js');
    const token = beginArtifactRun(workspacePath, taskId, sessionKey, { userContent: '查询天气' });
    expect(isArtifactRunPendingCurrent(taskId, sessionKey, token)).toBe(true);
    expect(isArtifactRunPendingCurrent('other-task', sessionKey, token)).toBe(false);
    expect(isArtifactRunPendingCurrent(taskId, 'other-session', token)).toBe(false);
    bindArtifactRun(taskId, sessionKey, token, 'accepted-runtime-run');
    expect(isArtifactRunPendingCurrent(taskId, sessionKey, token)).toBe(false);
    const waiting = beginArtifactRun(workspacePath, taskId, sessionKey, { userContent: '查询明天天气' });
    expect(isArtifactRunPendingCurrent(taskId, sessionKey, waiting)).toBe(true);
    cancelArtifactRunsForSession(sessionKey);
    expect(isArtifactRunPendingCurrent(taskId, sessionKey, waiting)).toBe(false);
  });

  it('does not turn an ordinary follow-up into a PPT revision or inherit another task parent', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    const state = { last_receipt: 'parent-receipt.json', active_token: '', canceled: 0 };
    const beginUser = vi.fn((_id: string, token: string) => {
      state.active_token = token;
    });
    sqliteMock.mockReturnValue({});
    nativeControlMock.mockReturnValue({
      get: (id: string) => (id === taskId ? state : undefined),
      beginUser,
    });
    const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    slidesMock.mockResolvedValue({ saved: [], failed: [], warnings: [] });
    const weather = beginArtifactRun(workspacePath, taskId, sessionKey, {
      gatewayId: 'gateway-1',
      userContent: '再查一下天气',
    });
    bindArtifactRun(taskId, sessionKey, weather, 'weather-run');
    selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'weather-incoming',
        taskId,
        sessionKey,
        runId: 'weather-run',
        role: 'assistant',
        content: 'The weather is sunny.',
        timestamp: '2026-10-03T00:00:00Z',
      },
    );
    await waitForSettlement();
    expect(nativeRenderMock).not.toHaveBeenCalled();
    expect(settlements()[0].status).toBe('succeeded');
    const callsBeforeOtherTask = beginUser.mock.calls.length;
    beginArtifactRun(workspacePath, 'other-task', buildSessionKey('other-task', 'main'), {
      userContent: '再美观一点，文字不要这么挤，功能和数据不要乱改。',
    });
    expect(beginUser).toHaveBeenCalledTimes(callsBeforeOtherTask);
    beginArtifactRun(workspacePath, taskId, sessionKey, { userContent: '另外做一份新的PPT，风格再美观一点' });
    expect(beginUser).toHaveBeenCalledTimes(callsBeforeOtherTask + 1);
  });

  it.each(['再美观一点，文字不要这么挤，功能和数据不要乱改。', '把第二页改成蓝色', '把标题改短一点', '再查一下天气'])(
    'uses the same-task parent for real native output regardless of intent wording: %s',
    async (userContent) => {
      vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
      const control = { active_token: '', canceled: 0, last_receipt: 'parent-receipt.json', auto_count: 0 };
      sqliteMock.mockReturnValue({});
      nativeControlMock.mockReturnValue({
        get: () => control,
        beginUser: (_id: string, token: string) => {
          control.active_token = token;
        },
        remember: (_id: string, token: string, receipt: string) => {
          if (token === control.active_token) control.last_receipt = receipt;
        },
      });
      const entry = {
        receiptFile: 'unlinked-receipt.json',
        source: '{}',
        receipt: {
          sourceFormat: 'native-template-v5',
          templateContract: 'templateDeck-v2',
          revision: 0,
          sourceFile: '.royin-native-unlinked/source.json',
          fileName: 'unlinked.pptx',
          bytes: 123,
        },
      };
      collectReceiptsMock.mockReturnValue({ receipts: [entry], rejected: 0 });
      nativeRenderMock.mockResolvedValue({ fileCreated: true, receiptFile: 'linked-receipt.json' });
      nativeReceiptMock.mockReturnValue({
        ...entry.receipt,
        revision: 1,
        previousReceiptFile: 'parent-receipt.json',
        sourceFile: '.royin-native-linked/source.json',
        fileName: artifact.name,
        bytes: artifact.size,
      });
      reconcileMock.mockResolvedValue({
        ...emptyReconciliation,
        saved: [
          {
            ...artifact,
            root: 'agent',
            localPath: artifact.name,
            filePath: 'C:\\agent-quality-workspace\\' + artifact.name,
          },
        ],
      });
      const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
      const token = beginArtifactRun(workspacePath, taskId, sessionKey, {
        gatewayId: 'gateway-1',
        userContent,
      });
      bindArtifactRun(taskId, sessionKey, token, 'user-revision-run');
      selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'revision-incoming',
          taskId,
          sessionKey,
          runId: 'user-revision-run',
          role: 'assistant',
          content: 'Revised',
          timestamp: '2026-10-03T00:00:00Z',
        },
      );
      await waitForSettlement();
      expect(nativeRenderMock).toHaveBeenCalledWith(
        entry.receipt.sourceFile,
        'C:\\agent-quality-workspace',
        expect.objectContaining({ previous: 'parent-receipt.json', sourceReceipt: entry.receiptFile }),
      );
      expect(nativeInputMock).not.toHaveBeenCalled();
      expect(nativeReviewMock).toHaveBeenCalledWith(
        'C:\\agent-quality-workspace',
        'linked-receipt.json',
        undefined,
        expect.any(Function),
      );
      expect(control.last_receipt).toBe('linked-receipt.json');
      const agentReconcile = reconcileMock.mock.calls.find(([input]) => input.rootKind === 'agent')?.[0];
      expect(agentReconcile.isCandidateCurrent('unlinked.pptx')).toBe(false);
      expect(agentReconcile.isCandidateCurrent(artifact.name)).toBe(true);
      const workspaceReconcile = reconcileMock.mock.calls.find(([input]) => input.rootKind !== 'agent')?.[0];
      expect(workspaceReconcile.isCandidateCurrent('unlinked.pptx')).toBe(false);
      expect(workspaceReconcile.isCandidateCurrent(artifact.name)).toBe(false);
      expect(workspaceReconcile.isCandidateCurrent('notes.docx')).toBe(true);
      expect(entry.receipt.revision).toBe(0);
      expect(collectReceiptsMock.mock.results[0].value.receipts).toHaveLength(1);
      expect(unconfirmedMock).toHaveBeenCalledWith([], expect.arrayContaining([entry]));
    },
  );

  it('keeps the unlinked revision registrable and its diagnostics alive when the managed re-render is refused', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    const control = { active_token: '', canceled: 0, last_receipt: 'parent-receipt.json', auto_count: 0 };
    sqliteMock.mockReturnValue({});
    nativeControlMock.mockReturnValue({
      get: () => control,
      beginUser: (_id: string, token: string) => {
        control.active_token = token;
      },
      beginAutomatic: (_id: string, previous: string, token: string) => {
        if (control.canceled || control.active_token !== previous || control.auto_count >= 2) return false;
        control.active_token = token;
        control.auto_count++;
        return true;
      },
      remember: (_id: string, token: string, receipt: string) => {
        if (token === control.active_token) control.last_receipt = receipt;
      },
      cancel: (_id: string, token: string) => {
        if (token === control.active_token) control.canceled = 1;
      },
    });
    const entry = {
      receiptFile: 'unlinked-receipt.json',
      source: '{}',
      receipt: {
        sourceFormat: 'native-template-v5',
        templateContract: 'templateDeck-v2',
        revision: 0,
        sourceFile: '.royin-native-unlinked/source.json',
        fileName: 'unlinked.pptx',
        bytes: 123,
      },
    };
    collectReceiptsMock.mockReturnValue({ receipts: [entry], rejected: 0 });
    nativeRenderMock.mockResolvedValue({
      fileCreated: false,
      diagnostics: [{ code: 'native-revision-data-changed' }],
    });
    nativeReceiptMock.mockReturnValue({ ...entry.receipt });
    nativeReviewMock.mockResolvedValue({ status: 'passed' });
    // ⚠️ 必须在 reconcile 调用「当时」取 isCandidateCurrent：结算后自动纠偏会接管
    //    active_token，原 run 已不再是 current，事后再调这个回调只会拿到全 false。
    let unlinkedCurrentAtReconcile: boolean | undefined;
    reconcileMock.mockImplementation(
      async (input: { rootKind?: string; isCandidateCurrent?: (file: string) => boolean }) => {
        if (input.rootKind === 'agent') unlinkedCurrentAtReconcile = input.isCandidateCurrent?.('unlinked.pptx');
        return {
          ...emptyReconciliation,
          saved: [
            {
              ...artifact,
              name: 'unlinked.pptx',
              localPath: 'unlinked.pptx',
              filePath: 'C:\\agent-quality-workspace\\unlinked.pptx',
              root: 'agent',
              size: 123,
            },
          ],
        };
      },
    );
    nativeGuardMock.mockResolvedValue(undefined);
    const sendChatMessage = vi.fn().mockResolvedValue({ runId: 'refused-revision-correction' });
    nativeGatewayMock.mockReturnValue({ isConnected: true, sendChatMessage });
    const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    const token = beginArtifactRun(workspacePath, taskId, sessionKey, {
      gatewayId: 'gateway-1',
      userContent: '再美观一点，文字不要这么挤，功能和数据不要乱改。',
    });
    bindArtifactRun(taskId, sessionKey, token, 'refused-revision-run');
    selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'refused-revision-incoming',
        taskId,
        sessionKey,
        runId: 'refused-revision-run',
        role: 'assistant',
        content: 'Revised',
        timestamp: '2026-10-04T00:00:00Z',
      },
    );
    await waitForSettlement();
    expect(nativeRenderMock).toHaveBeenCalledWith(
      entry.receipt.sourceFile,
      'C:\\agent-quality-workspace',
      expect.objectContaining({ previous: 'parent-receipt.json', sourceReceipt: entry.receiptFile }),
    );
    // ⭐ 失败必须保留文件：standalone 不能被预先退役，reconcile 当时仍要把它当候选收走并登记。
    expect(unlinkedCurrentAtReconcile).toBe(true);
    expect(nativeReviewMock).toHaveBeenCalledWith(
      'C:\\agent-quality-workspace',
      'unlinked-receipt.json',
      undefined,
      expect.any(Function),
    );
    // 文件已登记 ⇒ 不得再报「工作区里没有这些文件」；同时 last_receipt 指向用户手里最新的这份。
    expect(control.last_receipt).toBe('unlinked-receipt.json');
    expect(
      sendMock.mock.calls.some(
        ([channel, data]) =>
          channel === 'artifact:claim-violation' && (data as { missing?: unknown[] }).missing?.length,
      ),
    ).toBe(false);
    // 诊断活着进自动纠正通道（不能被审查结果顶掉）。
    expect(sendChatMessage).toHaveBeenCalledOnce();
    expect(sendChatMessage.mock.calls[0]![1]).toContain('native-revision-data-changed');
  });

  it('reports an unregistered kind separately from physically missing files', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    const control = { active_token: '', canceled: 0, last_receipt: 'parent-receipt.json', auto_count: 0 };
    sqliteMock.mockReturnValue({});
    nativeControlMock.mockReturnValue({
      get: () => control,
      beginUser: (_id: string, token: string) => {
        control.active_token = token;
      },
      remember: (_id: string, token: string, receipt: string) => {
        if (token === control.active_token) control.last_receipt = receipt;
      },
    });
    const entry = {
      receiptFile: 'unlinked-receipt.json',
      source: '{}',
      receipt: {
        sourceFormat: 'native-template-v5',
        templateContract: 'templateDeck-v2',
        revision: 0,
        sourceFile: '.royin-native-unlinked/source.json',
        fileName: 'unlinked.pptx',
        bytes: 123,
      },
    };
    collectReceiptsMock.mockReturnValue({ receipts: [entry], rejected: 0 });
    nativeRenderMock.mockResolvedValue({
      fileCreated: false,
      diagnostics: [{ code: 'native-revision-data-changed' }],
    });
    nativeReceiptMock.mockReturnValue({ ...entry.receipt });
    nativeReviewMock.mockResolvedValue({ status: 'passed' });
    // 幻灯片通道也不许冒出一份 .pptx：本轮确实**什么都没登记**。
    slidesMock.mockResolvedValue({ saved: [], failed: [], warnings: [] });
    // 文件没有被登记：produced 为空 ⇒ 期望格式里缺 pptx。守门人必须分开说「没登记到」，
    // 不能说「工作区里没有这些文件」。
    reconcileMock.mockResolvedValue({ ...emptyReconciliation });
    const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    const token = beginArtifactRun(workspacePath, taskId, sessionKey, {
      gatewayId: 'gateway-1',
      userContent: '再美观一点，文字不要这么挤，功能和数据不要乱改。',
    });
    bindArtifactRun(taskId, sessionKey, token, 'unregistered-kind-run');
    selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'unregistered-kind-incoming',
        taskId,
        sessionKey,
        runId: 'unregistered-kind-run',
        role: 'assistant',
        content: 'Revised',
        timestamp: '2026-10-04T00:00:00Z',
      },
    );
    await waitForSettlement();
    const violation = sendMock.mock.calls.find(([channel]) => channel === 'artifact:claim-violation')?.[1] as
      | { missing: string[]; missingKinds?: string[] }
      | undefined;
    expect(violation?.missing).toEqual([]);
    expect(violation?.missingKinds).toEqual(['PPT/PPTX 演示文稿']);
    expect(settlements().at(-1)?.status).toBe('failed');
  });

  it.each([false, true])('does not send an automatic correction after its token is canceled: %s', async (stopped) => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    const control = { active_token: '', canceled: 0, last_receipt: null as string | null, auto_count: 0 };
    sqliteMock.mockReturnValue({});
    nativeControlMock.mockReturnValue({
      get: () => control,
      beginUser: (_id: string, token: string) => {
        control.active_token = token;
      },
      beginAutomatic: (_id: string, previous: string, token: string) => {
        if (previous !== control.active_token || control.canceled || control.auto_count >= 2) return false;
        control.active_token = token;
        control.auto_count++;
        control.canceled = Number(stopped);
        return true;
      },
      remember: (_id: string, _token: string, receipt: string) => {
        control.last_receipt = receipt;
      },
      cancel: (_id: string, token: string) => {
        if (token === control.active_token) control.canceled = 1;
      },
    });
    collectReceiptsMock.mockReturnValue({
      receipts: [
        {
          receiptFile: 'current-receipt.json',
          source: '{}',
          receipt: {
            sourceFormat: 'native-template-v5',
            revision: 0,
            sourceFile: '.royin-native-current/source.json',
            fileName: artifact.name,
            bytes: artifact.size,
          },
        },
      ],
      rejected: 0,
    });
    reconcileMock.mockResolvedValue({
      ...emptyReconciliation,
      saved: [
        {
          ...artifact,
          root: 'agent',
          localPath: artifact.name,
          filePath: 'C:\\agent-quality-workspace\\' + artifact.name,
        },
      ],
    });
    nativeReviewMock.mockResolvedValue({ status: 'needs-revision', pages: [{ page: 1, issues: ['small-text'] }] });
    nativeGuardMock.mockResolvedValue({});
    const sendChatMessage = vi.fn().mockResolvedValue({ runId: 'automatic-revision-run' });
    nativeGatewayMock.mockReturnValue({ isConnected: true, sendChatMessage });
    const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    const token = beginArtifactRun(workspacePath, taskId, sessionKey, {
      gatewayId: 'gateway-1',
      userContent: '做一份PPT',
    });
    bindArtifactRun(taskId, sessionKey, token, 'review-needed-run');
    selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'review-needed-incoming',
        taskId,
        sessionKey,
        runId: 'review-needed-run',
        role: 'assistant',
        content: 'Created',
        timestamp: '2026-10-03T00:00:00Z',
      },
    );
    await waitForSettlement();
    expect(control.auto_count).toBe(1);
    expect(sendChatMessage).toHaveBeenCalledTimes(stopped ? 0 : 1);
    expect(nativeGuardMock).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'newer-run'])(
    'keeps an old unknown-worded revision canceled when native output arrives late: %s',
    async (reason) => {
      vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
      const control = { active_token: '', canceled: 0, last_receipt: 'parent-receipt.json', auto_count: 0 };
      const beginUser = vi.fn((_id: string, token: string) => {
        control.active_token = token;
        control.canceled = 0;
      });
      const cancel = vi.fn((_id: string, token: string) => {
        if (control.active_token === token) control.canceled = 1;
      });
      sqliteMock.mockReturnValue({});
      nativeControlMock.mockReturnValue({ get: () => control, beginUser, cancel });
      collectReceiptsMock.mockReturnValue({
        receipts: [
          {
            receiptFile: 'late-receipt.json',
            source: '{}',
            receipt: {
              sourceFormat: 'native-template-v5',
              revision: 0,
              sourceFile: '.royin-native-late/source.json',
              fileName: 'late.pptx',
              bytes: 123,
            },
          },
        ],
        rejected: 0,
      });
      slidesMock.mockResolvedValue({ saved: [], failed: [], warnings: [] });
      const { beginArtifactRun, bindArtifactRun, cancelArtifactRun } = await import('../src/main/ipc/data-handlers.js');
      const token = beginArtifactRun(workspacePath, taskId, sessionKey, {
        gatewayId: 'gateway-1',
        userContent: '把第二页改成蓝色',
      });
      bindArtifactRun(taskId, sessionKey, token, 'late-native-run');
      if (reason === 'stop') cancelArtifactRun(taskId, sessionKey, token);
      else {
        control.last_receipt = 'newer-parent.json';
        beginArtifactRun(workspacePath, taskId, sessionKey, { gatewayId: 'gateway-1', userContent: '把标题改短一点' });
      }
      selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'late-native-incoming',
          taskId,
          sessionKey,
          runId: 'late-native-run',
          role: 'assistant',
          content: 'Changed',
          timestamp: '2026-10-03T00:00:00Z',
        },
      );
      await waitForSettlement();
      expect(beginUser).toHaveBeenCalledTimes(reason === 'stop' ? 1 : 2);
      if (reason === 'stop') expect(cancel).toHaveBeenCalledWith(taskId, token);
      else expect(control.last_receipt).toBe('newer-parent.json');
      expect(nativeRenderMock).not.toHaveBeenCalled();
      expect(nativeReviewMock).not.toHaveBeenCalled();
      expect(reconcileMock).not.toHaveBeenCalled();
      expect(settlements()[0].status).toBe('canceled');
    },
  );

  it('binds a verified current native write to the parent captured at dispatch without guessing files', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    const control = { active_token: '', canceled: 0, last_receipt: 'dispatch-parent.json', auto_count: 0 };
    sqliteMock.mockReturnValue({});
    nativeControlMock.mockReturnValue({
      get: () => control,
      beginUser: (_id: string, token: string) => {
        control.active_token = token;
      },
      remember: (_id: string, token: string, receipt: string) => {
        if (control.active_token === token) control.last_receipt = receipt;
      },
    });
    nativeInputMock.mockReturnValue('this-run.native-ppt.json');
    nativeRenderMock.mockResolvedValue({ fileCreated: true, receiptFile: 'current-write-receipt.json' });
    nativeReceiptMock.mockReturnValue({
      sourceFormat: 'native-template-v5',
      revision: 1,
      previousReceiptFile: 'dispatch-parent.json',
      sourceFile: '.royin-native-write/source.json',
      fileName: artifact.name,
      bytes: artifact.size,
    });
    reconcileMock.mockResolvedValue({
      ...emptyReconciliation,
      saved: [
        {
          ...artifact,
          root: 'agent',
          localPath: artifact.name,
          filePath: 'C:\\agent-quality-workspace\\' + artifact.name,
        },
      ],
    });
    const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    const token = beginArtifactRun(workspacePath, taskId, sessionKey, {
      gatewayId: 'gateway-1',
      userContent: '把第二页改成蓝色',
    });
    bindArtifactRun(taskId, sessionKey, token, 'current-write-run');
    control.last_receipt = 'late-task-parent.json';
    const tools = [
      {
        id: 'write-source',
        name: 'write',
        status: 'done',
        startedAt: '',
        args: { path: 'this-run.native-ppt.json' },
        result: 'Successfully wrote',
      },
    ];
    selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'current-write-incoming',
        taskId,
        sessionKey,
        runId: 'current-write-run',
        role: 'assistant',
        content: 'Updated source',
        toolCalls: tools,
        timestamp: '2026-10-03T00:00:00Z',
      },
    );
    await waitForSettlement();
    // ⭐ BUG-046 ③（pre19）：调用新增第三参 sinceMs=run.createdAt（freshness 守卫，
    //    见 native-tool-input.ts）——夹具对齐新签名，行为断言（渲染参数+收据绑定）不变。
    expect(nativeInputMock).toHaveBeenCalledExactlyOnceWith(
      'C:\\agent-quality-workspace',
      tools,
      expect.objectContaining({ sinceMs: expect.any(Number) }),
    );
    expect(nativeRenderMock).toHaveBeenCalledWith(
      'this-run.native-ppt.json',
      'C:\\agent-quality-workspace',
      expect.objectContaining({ previous: 'dispatch-parent.json' }),
    );
    expect(control.last_receipt).toBe('current-write-receipt.json');
  });

  it('does not adopt a task old parent for automatic correction of an explicit new deck', async () => {
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    const control = { active_token: '', canceled: 0, last_receipt: 'old-topic-receipt.json', auto_count: 0 };
    sqliteMock.mockReturnValue({});
    nativeControlMock.mockReturnValue({
      get: () => control,
      beginUser: (_id: string, token: string) => {
        control.active_token = token;
      },
      beginAutomatic: (_id: string, previous: string, token: string) => {
        if (previous !== control.active_token || control.canceled || control.auto_count >= 2) return false;
        control.active_token = token;
        control.auto_count++;
        return true;
      },
    });
    slidesMock.mockResolvedValue({ saved: [], failed: [], warnings: [] });
    nativeInputMock.mockReturnValue('new-topic.native-ppt.json');
    nativeRenderMock.mockResolvedValue({ fileCreated: false, diagnostics: [{ code: 'native-capacity' }] });
    nativeGuardMock.mockResolvedValueOnce({}).mockRejectedValue(Error('test-correction-stop'));
    const sendChatMessage = vi.fn().mockResolvedValue({ runId: 'new-topic-auto-run' });
    nativeGatewayMock.mockReturnValue({ isConnected: true, sendChatMessage });
    const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    const token = beginArtifactRun(workspacePath, taskId, sessionKey, {
      gatewayId: 'gateway-1',
      userContent: '请帮我生成另外一份新的PPT',
    });
    bindArtifactRun(taskId, sessionKey, token, 'new-topic-run');
    selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'new-topic-incoming',
        taskId,
        sessionKey,
        runId: 'new-topic-run',
        role: 'assistant',
        content: 'Attempted',
        timestamp: '2026-10-03T00:00:00Z',
      },
    );
    await waitForSettlement();
    expect(nativeRenderMock).toHaveBeenCalledOnce();
    expect(sendChatMessage).toHaveBeenCalledOnce();
    selectGetMock.mockReturnValueOnce({ id: 'automatic-assistant' }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      {
        id: 'new-topic-auto-incoming',
        taskId,
        sessionKey,
        runId: 'new-topic-auto-run',
        role: 'assistant',
        content: 'Attempted again',
        timestamp: '2026-10-03T00:01:00Z',
      },
    );
    await waitForSettlement(2);
    expect(nativeRenderMock).toHaveBeenCalledTimes(2);
    for (const [, , options] of nativeRenderMock.mock.calls) expect(options.previous).toBeUndefined();
    expect(control.last_receipt).toBe('old-topic-receipt.json');
  });

  it.each(['session', 'task', 'newer-dispatch', 'send-failed'] as const)(
    'settles automatic correction with %s during its budget wait',
    async (mode) => {
      vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
      const control = { active_token: '', canceled: 0, last_receipt: null as string | null, auto_count: 0 };
      sqliteMock.mockReturnValue({});
      const beginAutomatic = vi.fn((_task: string, previous: string, token: string) => {
        if (control.canceled || control.active_token !== previous || control.auto_count >= 2) return false;
        control.active_token = token;
        control.auto_count++;
        return true;
      });
      nativeControlMock.mockReturnValue({
        beginUser: (_task: string, token: string) => {
          control.active_token = token;
          control.canceled = 0;
        },
        beginAutomatic,
        get: () => control,
        cancel: (_task: string, token: string) => {
          if (control.active_token === token) control.canceled = 1;
        },
        remember: (_task: string, _token: string, receipt: string) => {
          control.last_receipt = receipt;
        },
      });
      slidesMock.mockResolvedValue({ saved: [], failed: [], warnings: [] });
      nativeInputMock.mockReturnValue('current.native-ppt.json');
      nativeRenderMock.mockResolvedValue({ fileCreated: false, diagnostics: [{ code: 'native-capacity-overflow' }] });
      const heldBudget = deferred<void>();
      nativeGuardMock.mockReturnValue(heldBudget.promise);
      const sendChatMessage = vi.fn().mockResolvedValue({ runId: 'unwanted-correction' });
      if (mode === 'send-failed') sendChatMessage.mockRejectedValue(Error('gateway-send-failed'));
      nativeGatewayMock.mockReturnValue({ isConnected: true, sendChatMessage });
      const { beginArtifactRun, bindArtifactRun, cancelArtifactRunsForSession, cancelArtifactRunsForTask } =
        await import('../src/main/ipc/data-handlers.js');
      const token = beginArtifactRun(workspacePath, taskId, sessionKey, {
        gatewayId: 'gateway-1',
        userContent: '做一份PPT',
      });
      bindArtifactRun(taskId, sessionKey, token, 'failing-native-run');
      selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
      const errorSpy = vi.spyOn(console, 'error');
      try {
        handleMap.get('data:create-message')!(
          {},
          {
            id: 'native-budget-incoming',
            taskId,
            sessionKey,
            runId: 'failing-native-run',
            role: 'assistant',
            content: 'Attempted',
            timestamp: '2026-10-04T00:00:00Z',
            toolCalls: [
              {
                id: 'write',
                name: 'write',
                status: 'done',
                startedAt: '',
                args: { path: 'current.native-ppt.json', content: '{}' },
              },
            ],
          },
        );
        await vi.waitFor(() => expect(nativeGuardMock).toHaveBeenCalledOnce());
        if (mode === 'session') cancelArtifactRunsForSession(sessionKey);
        else if (mode === 'task') cancelArtifactRunsForTask(taskId);
        else if (mode === 'newer-dispatch')
          beginArtifactRun(workspacePath, taskId, sessionKey, { userContent: '生成另一份新的PPT' });
        heldBudget.resolve();
        await new Promise<void>((complete) => setImmediate(complete));
        expect(errorSpy).not.toHaveBeenCalled();
        expect(settlements()).toHaveLength(1);
        if (mode === 'send-failed') {
          expect(sendChatMessage).toHaveBeenCalledOnce();
          expect(beginAutomatic).toHaveBeenCalledOnce();
          expect(control.auto_count).toBe(1);
          expect(settlements()[0]).toMatchObject({ status: 'failed' });
        } else {
          expect(sendChatMessage).not.toHaveBeenCalled();
          expect(beginAutomatic).not.toHaveBeenCalled();
          expect(control.auto_count).toBe(0);
          expect(settlements()[0]).toMatchObject({ status: 'canceled' });
          if (mode === 'newer-dispatch') expect(control.active_token).not.toBe(token);
          else expect(control.canceled).toBe(1);
        }
      } finally {
        heldBudget.resolve();
        errorSpy.mockRestore();
      }
    },
  );

  it('passes canonical completed run tools into receipt collection and keeps confirmed source warnings', async () => {
    const tools = [{ id: 'exec-1', name: 'exec', status: 'done', startedAt: '', result: 'machine report' }];
    const entries = [
      {
        receiptFile: '.royin-ppt-receipt-proof.json',
        source: '// title: Existing\n<Slide></Slide>',
        receipt: { sourceFile: 'report.slidegen', fileName: artifact.name, bytes: artifact.size },
      },
    ];
    collectReceiptsMock.mockReturnValue({ receipts: entries, rejected: 0 });
    reuseDeckMock.mockReturnValue([warning]);
    slidesMock.mockImplementationOnce(async (input) => ({
      saved: [],
      failed: [],
      warnings: input.reuseExisting?.({ title: 'Existing', source: entries[0].source }) ?? [],
    }));
    reconcileMock.mockResolvedValue({
      ...emptyReconciliation,
      saved: [
        {
          ...artifact,
          root: 'agent',
          localPath: artifact.name,
          filePath: 'C:\\agent-quality-workspace\\' + artifact.name,
        },
      ],
    });
    const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    const token = beginArtifactRun(workspacePath, taskId, sessionKey, { gatewayId: 'gateway-1' });
    bindArtifactRun(taskId, sessionKey, token, 'run-1');
    selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
    expect(
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'incoming',
          taskId,
          sessionKey,
          runId: 'run-1',
          role: 'assistant',
          content: 'Created',
          timestamp: '2026-09-30T00:00:00Z',
          toolCalls: tools,
        },
      ),
    ).toEqual({ ok: true });
    await waitForSettlement();
    expect(collectReceiptsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        sessionKey,
        runId: 'run-1',
        messages: [
          expect.objectContaining({ taskId, sessionKey, runId: 'run-1', role: 'assistant', toolCalls: tools }),
        ],
      }),
    );
    expect(slidesMock.mock.calls[0]?.[0].content).toContain('// title: Existing');
    expect(reuseDeckMock).toHaveBeenCalledWith(
      'C:\\agent-quality-workspace',
      entries,
      expect.objectContaining({ title: 'Existing' }),
    );
    expect(settlements()[0]).toMatchObject({ status: 'needs-review', slideWarnings: [warning] });
  });

  it.each(['unconfirmed', 'rejected'])(
    'pauses automatic generation for %s output but still reconciles the real file',
    async (kind) => {
      if (kind === 'unconfirmed') unconfirmedMock.mockReturnValue(true);
      else collectReceiptsMock.mockReturnValue({ receipts: [], rejected: 1 });
      reconcileMock.mockResolvedValue({ ...emptyReconciliation, saved: [artifact] });
      const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
      const token = beginArtifactRun(workspacePath, taskId, sessionKey, { gatewayId: 'gateway-1' });
      bindArtifactRun(taskId, sessionKey, token, 'run-1');
      selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        {
          id: 'incoming',
          taskId,
          sessionKey,
          runId: 'run-1',
          role: 'assistant',
          content: 'Created',
          timestamp: '2026-09-30T00:00:00Z',
        },
      );
      await waitForSettlement();
      expect(slidesMock).not.toHaveBeenCalled();
      expect(reconcileMock).toHaveBeenCalled();
      expect(sendMock).toHaveBeenCalledWith('artifact:saved', artifact);
      expect(sendMock).toHaveBeenCalledWith('slidegen:failed', [{ code: 'slidegen-output-unconfirmed' }]);
      expect(settlements()[0]).toMatchObject({ status: 'failed' });
    },
  );

  it('checks confirmed final versions at agent registration and discards stale file warnings', async () => {
    const entries = [
      { receiptFile: 'proof', source: 'source', receipt: { sourceFile: 'report.slidegen', fileName: artifact.name } },
    ];
    collectReceiptsMock.mockReturnValue({ receipts: entries, rejected: 0 });
    outputCurrentMock.mockReturnValue(false);
    const unrelated = { ...artifact, id: 'other', name: 'notes.txt' };
    reconcileMock.mockImplementation(async (input) => {
      if (input.rootKind !== 'agent') return emptyReconciliation;
      expect(input.isCandidateCurrent).toBeTypeOf('function');
      expect(input.isCandidateCurrent(artifact.name)).toBe(false);
      return { ...emptyReconciliation, saved: [unrelated], skipped: [artifact.name] };
    });
    const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    const token = beginArtifactRun(workspacePath, taskId, sessionKey, { gatewayId: 'gateway-1' });
    bindArtifactRun(taskId, sessionKey, token, 'run-1');
    selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
    handleMap.get('data:create-message')!(
      {},
      { id: 'incoming', taskId, sessionKey, runId: 'run-1', role: 'assistant', content: 'Done', timestamp: 'now' },
    );
    await waitForSettlement();
    expect(outputCurrentMock).toHaveBeenCalledWith('C:\\agent-quality-workspace', entries, artifact.name);
    expect(sendMock).toHaveBeenCalledWith('artifact:saved', unrelated);
    expect(sendMock).not.toHaveBeenCalledWith('slidegen:warned', [warning]);
    expect(sendMock).toHaveBeenCalledWith('slidegen:failed', [{ code: 'slidegen-output-unconfirmed' }]);
    expect(settlements()[0]).toMatchObject({ status: 'failed' });
    expect(settlements()[0]).not.toHaveProperty('slideWarnings');
  });

  it('prevents a canceled run from passing the pending reconciliation write guard', async () => {
    const { cancelArtifactRunsForSession } = await import('../src/main/ipc/data-handlers.js');
    reconcileMock.mockImplementation(async (input) => {
      expect(input.isCandidateCurrent).toBeTypeOf('function');
      expect(input.isCandidateCurrent('file.txt')).toBe(true);
      cancelArtifactRunsForSession(sessionKey);
      expect(input.isCandidateCurrent('file.txt')).toBe(false);
      return emptyReconciliation;
    });
    persistAssistant();
    await waitForSettlement();
    expect(settlements()[0]).toMatchObject({ status: 'canceled' });
  });

  it.each(['missing', 'old-message', 'wrong-task', 'wrong-root', 'wrong-path', 'wrong-size'])(
    'does not attach a confirmed receipt to a %s registered artifact',
    async (kind) => {
      const entries = [
        {
          receiptFile: 'proof',
          source: 'source',
          receipt: { sourceFile: 'report.slidegen', fileName: artifact.name, bytes: artifact.size },
        },
      ];
      collectReceiptsMock.mockReturnValue({ receipts: entries, rejected: 0 });
      const row = {
        ...artifact,
        root: 'agent',
        filePath: 'C:\\agent-quality-workspace\\' + artifact.name,
        localPath: artifact.name,
      };
      if (kind === 'old-message') row.messageId = 'earlier-assistant';
      if (kind === 'wrong-task') row.taskId = 'other-task';
      if (kind === 'wrong-root') row.root = 'workspace';
      if (kind === 'wrong-path') row.filePath = 'C:\\other-root\\' + artifact.name;
      if (kind === 'wrong-size') row.size += 1;
      reconcileMock.mockResolvedValue({ ...emptyReconciliation, saved: kind === 'missing' ? [] : [row] });
      const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
      const token = beginArtifactRun(workspacePath, taskId, sessionKey, { gatewayId: 'gateway-1' });
      bindArtifactRun(taskId, sessionKey, token, 'run-1');
      selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
      handleMap.get('data:create-message')!(
        {},
        { id: 'incoming', taskId, sessionKey, runId: 'run-1', role: 'assistant', content: 'Done', timestamp: 'now' },
      );
      await waitForSettlement();
      expect(settlements()[0]).toMatchObject({ status: 'failed' });
      expect(settlements()[0]).not.toHaveProperty('slideWarnings');
      expect(sendMock).toHaveBeenCalledWith('slidegen:failed', [{ code: 'slidegen-output-unconfirmed' }]);
    },
  );

  it('settles saved deck warnings with their filenames and canonical turn identity', async () => {
    const secondArtifact = {
      ...artifact,
      id: 'second-deck',
      name: 'Appendix.pptx',
      filePath: `${taskId}/Appendix.pptx`,
      localPath: `${taskId}/Appendix.pptx`,
    };
    const secondWarning: SlidegenWarning = {
      code: 'layout-out-of-bounds',
      page: 2,
      element: 3,
      detail: 'Outside slide width',
      artifactName: secondArtifact.name,
    };
    slidesMock.mockResolvedValueOnce({
      saved: [artifact, secondArtifact],
      failed: [],
      warnings: [warning, secondWarning],
    });
    persistAssistant();
    await waitForSettlement();

    expect(settlements()).toEqual([
      { taskId, sessionKey, messageId, status: 'needs-review', slideWarnings: [warning, secondWarning] },
    ]);
    expect(sendMock).toHaveBeenCalledWith('artifact:saved', artifact);
    expect(sendMock).toHaveBeenCalledWith('artifact:saved', secondArtifact);
    expect(sendMock).toHaveBeenCalledWith('slidegen:warned', [warning, secondWarning]);
    expect(sendMock).not.toHaveBeenCalledWith('artifact:claim-violation', expect.anything());
  });

  it.each(['sibling-deck', 'document', 'html', 'pipeline', 'reconciliation'])(
    'retains saved warnings but gives failure precedence for %s failure',
    async (failure) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        if (failure === 'sibling-deck')
          slidesMock.mockResolvedValueOnce({ ...warningResult(), failed: [{ code: 'slidegen-render-failed' }] });
        if (failure === 'document')
          documentsMock.mockResolvedValueOnce({ saved: [], failed: [{ code: 'request-invalid' }] });
        if (failure === 'html')
          htmlMock.mockResolvedValueOnce({ saved: [], failed: [{ code: 'htmlgen-block-invalid' }] });
        if (failure === 'pipeline') extractMock.mockRejectedValueOnce(new Error('Extraction failed'));
        if (failure === 'reconciliation') reconcileMock.mockRejectedValueOnce(new Error('Reconciliation failed'));
        persistAssistant();
        await waitForSettlement();

        expect(settlements()).toEqual([{ taskId, sessionKey, messageId, status: 'failed', slideWarnings: [warning] }]);
        expect(sendMock).toHaveBeenCalledWith('artifact:saved', artifact);
        expect(sendMock).toHaveBeenCalledWith('slidegen:warned', [warning]);
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it.each(['generation', 'reconciliation'])('suppresses quality notices when canceled during %s', async (stage) => {
    const { cancelArtifactRunsForSession } = await import('../src/main/ipc/data-handlers.js');
    const generation = deferred<SlidegenGenerateResult>();
    const reconciliation = deferred<typeof emptyReconciliation>();
    if (stage === 'generation') slidesMock.mockReturnValueOnce(generation.promise);
    else reconcileMock.mockReturnValueOnce(reconciliation.promise);
    persistAssistant();
    await vi.waitFor(() => expect(stage === 'generation' ? slidesMock : reconcileMock).toHaveBeenCalledTimes(1));
    expect(settlements()).toEqual([]);
    expect(sendMock).not.toHaveBeenCalledWith('slidegen:warned', expect.anything());

    cancelArtifactRunsForSession(sessionKey);
    generation.resolve({ ...warningResult(), failed: [{ code: 'slidegen-render-failed' }] });
    reconciliation.resolve(emptyReconciliation);
    await waitForSettlement();

    expect(settlements()).toEqual([{ taskId, sessionKey, messageId, status: 'canceled' }]);
    expect(sendMock).not.toHaveBeenCalledWith('slidegen:warned', expect.anything());
    expect(sendMock).not.toHaveBeenCalledWith('artifact:claim-violation', expect.anything());
    expect(sendMock).toHaveBeenCalledWith('artifact:saved', artifact);
  });

  it.each(['html', 'plain', 'clean-deck'])('does not leak warnings into a subsequent %s turn', async (kind) => {
    persistAssistant();
    await waitForSettlement();
    expect(settlements()[0]).toMatchObject({ status: 'needs-review', slideWarnings: [warning] });
    sendMock.mockClear();
    const { beginArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    beginArtifactRun(workspacePath, taskId, sessionKey);
    const nextArtifact = { ...artifact, id: 'next-artifact', messageId: 'next-assistant' };
    slidesMock.mockResolvedValueOnce({ saved: kind === 'clean-deck' ? [nextArtifact] : [], failed: [], warnings: [] });
    if (kind === 'html')
      htmlMock.mockResolvedValueOnce({ saved: [{ ...nextArtifact, name: 'index.html' }], failed: [] });
    persistAssistant('next-assistant', 'next-incoming', kind === 'html' ? '```htmlgen\n{}\n```' : 'All done');
    await waitForSettlement();

    expect(settlements()).toEqual([{ taskId, sessionKey, messageId: 'next-assistant', status: 'succeeded' }]);
    expect(sendMock).not.toHaveBeenCalledWith('slidegen:warned', expect.anything());
  });

  it('waits for generation and reconciliation and broadcasts saved files before settlement', async () => {
    const generation = deferred<SlidegenGenerateResult>();
    const reconciliation = deferred<typeof emptyReconciliation>();
    slidesMock.mockReturnValueOnce(generation.promise);
    reconcileMock.mockReturnValueOnce(reconciliation.promise);
    persistAssistant();
    await vi.waitFor(() => expect(slidesMock).toHaveBeenCalledTimes(1));
    expect(settlements()).toEqual([]);
    expect(sendMock).not.toHaveBeenCalledWith('artifact:saved', expect.anything());

    generation.resolve(warningResult());
    await vi.waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(1));
    expect(sendMock).toHaveBeenCalledWith('artifact:saved', artifact);
    expect(settlements()).toEqual([]);
    reconciliation.resolve(emptyReconciliation);
    await waitForSettlement();

    expect(settlements()[0]).toMatchObject({ status: 'needs-review', slideWarnings: [warning] });
    const channels = sendMock.mock.calls.map(([channel]) => channel);
    expect(channels.indexOf('artifact:saved')).toBeLessThan(channels.indexOf('artifact:delivery-settled'));
  });

  it('emits exactly one quality settlement for duplicate finalization while pending and completed', async () => {
    const { beginArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    beginArtifactRun(workspacePath, taskId, sessionKey);
    const generation = deferred<SlidegenGenerateResult>();
    slidesMock.mockReturnValueOnce(generation.promise);
    persistAssistant();
    await vi.waitFor(() => expect(slidesMock).toHaveBeenCalledTimes(1));
    persistAssistant(messageId, 'replayed-incoming');
    expect(settlements()).toEqual([]);
    generation.resolve(warningResult());
    await waitForSettlement();
    persistAssistant(messageId, 'completed-replay');

    expect(slidesMock).toHaveBeenCalledTimes(1);
    expect(settlements()).toEqual([
      { taskId, sessionKey, messageId, status: 'needs-review', slideWarnings: [warning] },
    ]);
    expect(sendMock.mock.calls.filter(([channel]) => channel === 'slidegen:warned')).toHaveLength(1);
  });

  /**
   * ⭐ **B 包（2026-10-07）：渲到哪都算。**
   *
   * 现场：模型把 CLI 的 cwd 设成了**应用工作区**（根层或子目录）—— 收据与成品都在那儿。
   * 收据读得回来了（`allowedReceiptRoots`），可成品落在**任何扫描根之外**：
   * 应用根扫 `<工作区>/<taskId>`、根层那条只扫**一层**、助手根扫助手工作区 ⇒ 三处都不覆盖，
   * 用户永远看不到它。这一步就是把它**复制进任务目录并登记**（现成的 saveArtifact 通道）。
   *
   * ⚠️ 判据里那条"先按收据自述的哈希与字节数核一遍"是刻意的：搬之前必须证明**搬的是
   *    那份被证明过的字节**，不是同名同路径的别的文件。
   */
  describe('B 包：跨根成品的规范落位', () => {
    it('⭐ 已确认收据的成品在扫描根之外 ⇒ 复制进任务目录 + 登记 + 推送，且不算"未确认"', async () => {
      const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createHash } = await import('node:crypto');
      const realWorkspace = mkdtempSync(join(tmpdir(), 'deck-relocate-'));
      const nested = join(realWorkspace, 'sub');
      try {
        const { mkdirSync } = await import('node:fs');
        mkdirSync(nested, { recursive: true });
        const bytes = Buffer.from('deck-bytes');
        writeFileSync(join(nested, 'deck.pptx'), bytes);
        const { getWorkspacePath } = await import('../src/main/workspace/config.js');
        vi.mocked(getWorkspacePath).mockReturnValue(realWorkspace);

        const entry = {
          receiptFile: '.royin-ppt-receipt-11111111-2222-3333-4444-555555555555.json',
          source: '```slidegen\n// title: Deck\n<Slide></Slide>\n```',
          receipt: {
            fileName: 'deck.pptx',
            bytes: bytes.length,
            outputSha256: createHash('sha256').update(bytes).digest('hex'),
            sourceFile: 'deck.slidegen',
            sourceSha256: 'a'.repeat(64),
            pages: 1,
          },
          outputDir: nested,
        };
        collectReceiptsMock.mockReturnValue({ receipts: [entry], rejected: 0 });
        saveArtifactMock.mockResolvedValue({
          ...artifact,
          id: 'relocated-deck',
          name: 'deck.pptx',
          size: bytes.length,
          localPath: `${taskId}/deck.pptx`,
        });

        const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
        const token = beginArtifactRun(realWorkspace, taskId, sessionKey, { gatewayId: 'gateway-1' });
        bindArtifactRun(taskId, sessionKey, token, 'relocate-run');
        selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce(undefined);
        handleMap.get('data:create-message')!(
          {},
          {
            id: 'relocate-incoming',
            taskId,
            sessionKey,
            runId: 'relocate-run',
            role: 'assistant',
            content: 'Done',
            timestamp: '2026-10-07T00:00:00.000Z',
          },
        );
        await waitForSettlement();

        expect(saveArtifactMock).toHaveBeenCalledWith(
          expect.objectContaining({
            workspacePath: realWorkspace,
            taskId,
            messageId,
            fileName: 'deck.pptx',
            sourceKey: `slidegen-cli:${entry.receiptFile}`,
          }),
        );
        expect(sendMock).toHaveBeenCalledWith(
          'artifact:saved',
          expect.objectContaining({ id: 'relocated-deck', name: 'deck.pptx' }),
        );
        // 搬成功了 ⇒ **不许**再冒一条"未确认"（它已经在任务目录里、有收据、字节对得上）
        expect(settlements().at(-1)?.status).not.toBe('failed');
        expect(sendMock).not.toHaveBeenCalledWith('slidegen:failed', expect.anything());
      } finally {
        rmSync(realWorkspace, { recursive: true, force: true });
      }
    });

    it('⭐ 成品已经在某条扫描根里（工作区**根层**，第三个根会收）⇒ 一步都不搬，绝不出现同一份两行', async () => {
      const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createHash } = await import('node:crypto');
      const realWorkspace = mkdtempSync(join(tmpdir(), 'deck-covered-'));
      try {
        const bytes = Buffer.from('deck-bytes');
        // 就放在**工作区根层**：第三个根（深度 0）会把它收走 ⇒ 这里再搬一次就会出现两行
        writeFileSync(join(realWorkspace, 'deck.pptx'), bytes);
        // 「已经收走了」在库里的形态 = 一行指向它的产物（本用例的扫描是桩，所以直接摆出这一行）
        sqliteMock.mockReturnValue({
          prepare: () => ({ all: () => [{ file_path: join(realWorkspace, 'deck.pptx') }] }),
        });
        const { getWorkspacePath } = await import('../src/main/workspace/config.js');
        vi.mocked(getWorkspacePath).mockReturnValue(realWorkspace);
        collectReceiptsMock.mockReturnValue({
          receipts: [
            {
              receiptFile: '.royin-ppt-receipt-77777777-2222-3333-4444-555555555555.json',
              source: '```slidegen\n// title: Deck\n<Slide></Slide>\n```',
              receipt: {
                fileName: 'deck.pptx',
                bytes: bytes.length,
                outputSha256: createHash('sha256').update(bytes).digest('hex'),
                sourceFile: 'deck.slidegen',
                sourceSha256: 'a'.repeat(64),
                pages: 1,
              },
              outputDir: realWorkspace,
            },
          ],
          rejected: 0,
        });

        const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
        const token = beginArtifactRun(realWorkspace, taskId, sessionKey, { gatewayId: 'gateway-1' });
        bindArtifactRun(taskId, sessionKey, token, 'covered-run');
        selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce(undefined);
        handleMap.get('data:create-message')!(
          {},
          {
            id: 'covered-incoming',
            taskId,
            sessionKey,
            runId: 'covered-run',
            role: 'assistant',
            content: 'Done',
            timestamp: '2026-10-07T00:00:02.000Z',
          },
        );
        await waitForSettlement();

        expect(saveArtifactMock).not.toHaveBeenCalled();
      } finally {
        rmSync(realWorkspace, { recursive: true, force: true });
      }
    });

    it('⭐ 成品与收据对不上（字节/哈希不符）⇒ 一个字节都不搬（宁可不搬，也不搬错）', async () => {
      const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const realWorkspace = mkdtempSync(join(tmpdir(), 'deck-relocate-mismatch-'));
      const nested = join(realWorkspace, 'sub');
      try {
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(nested, 'deck.pptx'), 'changed-after-the-receipt');
        const { getWorkspacePath } = await import('../src/main/workspace/config.js');
        vi.mocked(getWorkspacePath).mockReturnValue(realWorkspace);
        collectReceiptsMock.mockReturnValue({
          receipts: [
            {
              receiptFile: '.royin-ppt-receipt-99999999-2222-3333-4444-555555555555.json',
              source: '```slidegen\n// title: Deck\n<Slide></Slide>\n```',
              receipt: {
                fileName: 'deck.pptx',
                bytes: 10,
                outputSha256: 'b'.repeat(64),
                sourceFile: 'deck.slidegen',
                sourceSha256: 'a'.repeat(64),
                pages: 1,
              },
              outputDir: nested,
            },
          ],
          rejected: 0,
        });

        const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
        const token = beginArtifactRun(realWorkspace, taskId, sessionKey, { gatewayId: 'gateway-1' });
        bindArtifactRun(taskId, sessionKey, token, 'relocate-mismatch-run');
        selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce(undefined);
        handleMap.get('data:create-message')!(
          {},
          {
            id: 'relocate-mismatch-incoming',
            taskId,
            sessionKey,
            runId: 'relocate-mismatch-run',
            role: 'assistant',
            content: 'Done',
            timestamp: '2026-10-07T00:00:01.000Z',
          },
        );
        await waitForSettlement();

        expect(saveArtifactMock).not.toHaveBeenCalled();
        expect(sendMock).not.toHaveBeenCalledWith('artifact:saved', expect.objectContaining({ name: 'deck.pptx' }));
      } finally {
        rmSync(realWorkspace, { recursive: true, force: true });
      }
    });

    it('⭐ 便携单根（助手工作区 == 应用工作区）：收据照采、成品照常登记 —— 确认链不许被 null 根拆掉', async () => {
      // 真机现场（2026-10-08，W: 人工实测 pre20，用户原话"生成到盘里面了，但是产物显示是空的"）：
      // 助手工作区恰好 == 应用工作区（U 盘便携单根，真机主要形态）⇒ `captureAgentRootBaseline`
      // 旧行为 return null ⇒ ①原生收据**一份都收不到** ⇒ 整轮被误判 `slidegen-output-unconfirmed`
      // （"演示文稿未能自动确认"）②confirmedSlides 为空 ⇒ 规范落位不跑 ⇒ **产物面板永远是空的**，
      // 而成品与收据就好好躺在盘上。根没接上 ≠ 收据不存在。
      const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createHash } = await import('node:crypto');
      const realWorkspace = mkdtempSync(join(tmpdir(), 'deck-same-root-'));
      try {
        const bytes = Buffer.from('deck-bytes');
        writeFileSync(join(realWorkspace, 'deck.pptx'), bytes);
        const { getWorkspacePath } = await import('../src/main/workspace/config.js');
        vi.mocked(getWorkspacePath).mockReturnValue(realWorkspace);
        // 助手工作区解析结果 == 应用工作区（同一路径字符串 ⇒ 走到 same-as-workspace 分支）
        const { resolveAgentWorkspace } = await import('../src/main/artifact/agent-workspace.js');
        vi.mocked(resolveAgentWorkspace).mockResolvedValueOnce(realWorkspace);
        collectReceiptsMock.mockReturnValue({
          receipts: [
            {
              receiptFile: '.royin-ppt-receipt-88888888-2222-3333-4444-555555555555.json',
              source: '{}',
              receipt: {
                fileName: 'deck.pptx',
                bytes: bytes.length,
                outputSha256: createHash('sha256').update(bytes).digest('hex'),
                sourceFile: '.royin-native-x/source.json',
                sourceSha256: 'a'.repeat(64),
                pages: 1,
                sourceFormat: 'native-template-v5',
              },
              outputDir: realWorkspace,
            },
          ],
          rejected: 0,
        });
        saveArtifactMock.mockResolvedValue({
          ...artifact,
          id: 'same-root-deck',
          name: 'deck.pptx',
          size: bytes.length,
          localPath: `${taskId}/deck.pptx`,
        });

        const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
        const token = beginArtifactRun(realWorkspace, taskId, sessionKey, { gatewayId: 'gateway-1' });
        bindArtifactRun(taskId, sessionKey, token, 'same-root-run');
        selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce(undefined);
        handleMap.get('data:create-message')!(
          {},
          {
            id: 'same-root-incoming',
            taskId,
            sessionKey,
            runId: 'same-root-run',
            role: 'assistant',
            content: 'Done',
            timestamp: '2026-10-08T00:00:00.000Z',
          },
        );
        await waitForSettlement();

        // ① 收据必须被采集（旧行为：null 根 ⇒ collectToolSlideReceipts 根本不被调用）
        expect(collectReceiptsMock).toHaveBeenCalled();
        // ② 成品必须被规范落位登记（复制进任务目录 + 推送）—— 产物面板就看这一行
        expect(saveArtifactMock).toHaveBeenCalledWith(
          expect.objectContaining({
            workspacePath: realWorkspace,
            taskId,
            messageId,
            fileName: 'deck.pptx',
            sourceKey: `slidegen-cli:.royin-ppt-receipt-88888888-2222-3333-4444-555555555555.json`,
          }),
        );
        expect(sendMock).toHaveBeenCalledWith(
          'artifact:saved',
          expect.objectContaining({ id: 'same-root-deck', name: 'deck.pptx' }),
        );
        // ③ 同根 ⇒ **第二条（agent）扫描不跑**（同一目录会被扫两遍、两批产物撞 local_path）
        const agentScans = reconcileMock.mock.calls.filter(
          ([scan]) => (scan as { rootKind?: string }).rootKind === 'agent',
        );
        expect(agentScans).toHaveLength(0);
      } finally {
        rmSync(realWorkspace, { recursive: true, force: true });
      }
    });
  });

  /**
   * ⭐ **演示意图硬门（H0，2026-10-07）的接线**。
   *
   * 判据来自**本轮用户请求**（"另做一份PPT / 改稿 / 美化" — 与 native 门同一批正则），
   * 在 `beginArtifactRun` 那一瞬定下、存进 run —— 收尾时用户请求早就不在手上了，
   * 现场重算只会算错。
   *
   * ⚠️ 受控模式（native）**优先**：那时 docgen pptx 本来就是静默跳过（native 链自己出片），
   *    两个旗标同时成立也不许冒出一条"没生成"。
   */
  describe('演示意图硬门接线', () => {
    async function completeRunWith(userContent: string): Promise<void> {
      const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
      const token = beginArtifactRun(workspacePath, taskId, sessionKey, { gatewayId: 'gateway-1', userContent });
      bindArtifactRun(taskId, sessionKey, token, 'deck-intent-run');
      selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce(undefined);
      expect(
        handleMap.get('data:create-message')!(
          {},
          {
            id: 'deck-intent-incoming',
            taskId,
            sessionKey,
            runId: 'deck-intent-run',
            role: 'assistant',
            content: 'Done',
            timestamp: '2026-10-07T00:00:00.000Z',
          },
        ),
      ).toEqual({ ok: true });
      await waitForSettlement();
    }

    it.each(['另做一份PPT', '把这份 PPT 美化一下', '第一版不好看，重新排版'])(
      '⭐ 演示意图（%s）⇒ docgen 收到改道旗标（pptx 不进产品通道）',
      async (userContent) => {
        await completeRunWith(userContent);
        expect(documentsMock).toHaveBeenCalledWith(expect.objectContaining({ reroutePptxToSlidegen: true }));
      },
    );

    it('负对照：普通请求（不涉演示）⇒ 不带改道旗标，docgen 行为一字不变', async () => {
      await completeRunWith('把这份表格整理成 Excel');
      expect(documentsMock).toHaveBeenCalledWith(expect.objectContaining({ reroutePptxToSlidegen: false }));
    });

    it('⭐ 受控模式：两个旗标同时成立（受控优先，由 docgen 侧静默跳过）', async () => {
      vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
      sqliteMock.mockReturnValue({});
      nativeControlMock.mockReturnValue({
        beginUser: () => undefined,
        get: () => ({ active_token: 'deck-intent-run', last_receipt: null, auto_count: 0 }),
        cancel: () => undefined,
        remember: () => undefined,
      });
      collectReceiptsMock.mockReturnValue({ receipts: [], rejected: 0 });
      await completeRunWith('另做一份PPT');
      expect(documentsMock).toHaveBeenCalledWith(
        expect.objectContaining({ skipPptx: true, reroutePptxToSlidegen: true }),
      );
    });
  });
});
