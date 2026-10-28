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
// ⚠️ 用 `importOriginal` 展开真实模块，**不要**只列被 mock 的那一个导出：
//    工厂是**整模块替换**，生产代码一旦从本模块多 import 一个符号（2026-10-16 T23 就新增了
//    `nativeExecOrderFromTools`），别处拿到的是 `undefined` ⇒ 调用抛 TypeError ⇒ 被
//    `data-handlers` 里那圈 try/catch 吞掉 ⇒ 静默走降级分支、mock 一次都不触发。
//    本文件 5 条用例曾因此全红（spy 0 次调用）。展开后新增导出自动可用。
vi.mock('../src/main/docgen/native-tool-input.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/docgen/native-tool-input.js')>()),
  nativeInputFromCompletedWrites: nativeInputMock,
}));
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

/**
 * 真机 b4cf0d84 的形状（**便携单根** + 根层兜底扫描）：
 * 两份 pptx 由 `generate.cjs` 渲染完成并带收据；助手工作区 == 应用工作区（助手根那一趟不扫）；
 * "应用工作区根层"那条扫描把它们登记进库（`registered: true`）或什么都没登记（`registered: false`）。
 */
async function deliverRegisteredDecks(input: {
  registered: boolean;
  /** 行还在、**文件被删**：这是"产物打不开"的负对照（守卫必须继续报）。 */
  deleteDecks?: boolean;
}): Promise<{ workspace: string; names: readonly string[] }> {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const workspace = mkdtempSync(join(tmpdir(), 'deck-registered-'));
  // 真机上的两份成品：v1 与"改稿后重渲"的 v2（同名不同哈希后缀，收据各一条）
  const names = ['可莉角色介绍-923cd056.pptx', '可莉角色介绍-051b84c8.pptx'] as const;
  for (const name of names) writeFileSync(join(workspace, name), `bytes-of-${name}`);
  if (input.deleteDecks) for (const name of names) rmSync(join(workspace, name));

  const { getWorkspacePath } = await import('../src/main/workspace/config.js');
  vi.mocked(getWorkspacePath).mockReturnValue(workspace);
  // ⭐ 便携单根：助手工作区**就是**应用工作区 ⇒ 助手根那一趟不扫 ⇒ `agentIndexed` 恒空。
  const { resolveAgentWorkspace } = await import('../src/main/artifact/agent-workspace.js');
  vi.mocked(resolveAgentWorkspace).mockResolvedValue(workspace);

  collectReceiptsMock.mockReturnValue({
    receipts: names.map((name, index) => ({
      receiptFile: `.royin-ppt-receipt-0000000${index}-2222-3333-4444-55555555555${index}.json`,
      source: `\`\`\`slidegen\n// title: Deck ${index}\n<Slide></Slide>\n\`\`\``,
      receipt: {
        fileName: name,
        bytes: Buffer.byteLength(`bytes-of-${name}`),
        outputSha256: 'c'.repeat(64),
        sourceFile: index === 0 ? '可莉角色介绍.slidegen' : '可莉角色介绍-v2.slidegen',
        sourceSha256: 'a'.repeat(64),
        pages: 10,
      },
      outputDir: workspace,
    })),
    rejected: 0,
  });

  const rows = names.map((name, index) => ({
    ...artifact,
    id: `registered-deck-${index}`,
    name,
    filePath: join(workspace, name),
    localPath: name,
    root: 'workspace-root' as const,
    size: Buffer.byteLength(`bytes-of-${name}`),
  }));
  reconcileMock
    // ① 应用根扫的是 `<工作区>/<taskId>`：两份 pptx 都在**根层**，这一趟什么也收不到
    .mockResolvedValueOnce(emptyReconciliation)
    // ② 根层兜底扫描：真机上这一步把它们登记了（面板显示"可以使用"）
    .mockResolvedValueOnce({ ...emptyReconciliation, saved: input.registered ? rows : [] });
  // 「库里有这一行」的形态（`isRegisteredDeck` 查的就是它）
  sqliteMock.mockReturnValue({
    prepare: () => ({
      all: () => (input.registered ? names.map((name) => ({ file_path: join(workspace, name) })) : []),
    }),
  });

  const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
  const token = beginArtifactRun(workspace, taskId, sessionKey, { gatewayId: 'gateway-1' });
  bindArtifactRun(taskId, sessionKey, token, 'registered-run');
  selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce(undefined);
  handleMap.get('data:create-message')!(
    {},
    {
      id: 'registered-incoming',
      taskId,
      sessionKey,
      runId: 'registered-run',
      role: 'assistant',
      content: 'Done',
      timestamp: '2026-10-18T05:42:06.372Z',
    },
  );
  await waitForSettlement();
  return { workspace, names };
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
    // 文件已登记 ⇒ 不得再报「工作区里没有这些文件」。
    // ⭐ E4（2026-10-09 H1–H6 E 轮终审 §3 裁决后**预期变更**）：结构修订失败（渲染被拒）时
    //    **不许把 standalone 记成新父版本**——`last_receipt` 停在原已验证的父 A。
    //    旧断言（'unlinked-receipt.json'）正是本次裁决要修掉的"结构失败污染父链"。
    expect(control.last_receipt).toBe('parent-receipt.json');
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

    /**
     * ⭐ **2026-10-18 真机（任务 b4cf0d84）：已登记、面板里"可以使用"的 pptx 仍被判"未能自动确认"。**
     *
     * 现场顺序（日志 / 库 / 收据三方对齐）：
     *   ① 模型用 deck-layout 的 `generate.cjs` 渲染出两份 pptx（收据 2 条、rejected 0）；
     *   ② **便携单根**形态（助手工作区 == 应用工作区）⇒ 助手根那一趟**不扫** ⇒ `agentIndexed` 恒空；
     *   ③ "应用工作区根层"这条兜底扫描先把两份收走并登记（面板当场显示"可以使用"）；
     *   ④ 规范落位那一步见"库里已有这一行"⇒ 直接跳过 ⇒ `relocatedDecks` 也空；
     *   ⑤ 登记证明汇总为空 ⇒ 判 stale ⇒ 弹红框。**系统便签比登记晚 60ms**（05:42:14.206 vs .147）。
     *
     * 判据必须回到产品语义：**库里有没有一份指向这份成品真实路径的产物行**（= 用户能不能在
     * 面板里看到它），而不是"这一趟收尾流程有没有亲自搬过它"。
     */
    it('⭐ 便携单根 + 根层扫描已登记 ⇒ 不得再报"未能自动确认"（真机 b4cf0d84）', async () => {
      const { rmSync } = await import('node:fs');
      const { workspace } = await deliverRegisteredDecks({ registered: true });
      try {
        expect(saveArtifactMock).not.toHaveBeenCalled();
        expect(sendMock).not.toHaveBeenCalledWith('slidegen:failed', expect.anything());
        expect(sendMock).not.toHaveBeenCalledWith('artifact:claim-violation', expect.anything());
        expect(settlements().at(-1)?.status).not.toBe('failed');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    /** 负对照：**真的没有产物行**（也没搬过）⇒ 仍然必须报"未能自动确认"（守卫不许松）。 */
    it('⭐ 负对照：库里没有指向成品的产物行 ⇒ 仍然报"未能自动确认"', async () => {
      const { rmSync } = await import('node:fs');
      const { workspace } = await deliverRegisteredDecks({ registered: false });
      try {
        expect(sendMock).toHaveBeenCalledWith('slidegen:failed', [{ code: 'slidegen-output-unconfirmed' }]);
        expect(settlements().at(-1)?.status).toBe('failed');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    /** 负对照②：行还在、**文件被删**（打不开）⇒ 照样报"未能自动确认"。 */
    it('⭐ 负对照：登记行还在但文件已经不在了 ⇒ 仍然报"未能自动确认"', async () => {
      const { rmSync } = await import('node:fs');
      const { workspace } = await deliverRegisteredDecks({ registered: true, deleteDecks: true });
      try {
        expect(sendMock).toHaveBeenCalledWith('slidegen:failed', [{ code: 'slidegen-output-unconfirmed' }]);
        expect(settlements().at(-1)?.status).toBe('failed');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
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

    it('⭐ BUG-057（2026-10-09 复审）：助手目录 RPC 失败 ⇒ 收据确认链不许被拆（应用工作区仍是可信根）', async () => {
      // 现场形态：RPC 超时 / 网关离线 ⇒ `captureAgentRootBaseline` 回 null。
      // 旧行为：agentRoot 为 null 直接给空收据集合、**collector 根本不被调用** ⇒
      // 真产出（成品 + 收据都在应用工作区）被判 `slidegen-output-unconfirmed`。
      // 修法：根解析失败时主根回落应用工作区，照常校验收据与文件（成功标准一分未松）。
      const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createHash } = await import('node:crypto');
      const realWorkspace = mkdtempSync(join(tmpdir(), 'deck-rpc-fail-'));
      try {
        const bytes = Buffer.from('deck-bytes');
        writeFileSync(join(realWorkspace, 'deck.pptx'), bytes);
        const { getWorkspacePath } = await import('../src/main/workspace/config.js');
        vi.mocked(getWorkspacePath).mockReturnValue(realWorkspace);
        const { resolveAgentWorkspace } = await import('../src/main/artifact/agent-workspace.js');
        // RPC 失败（拒绝）⇒ 上层 catch 后按 null 处理 —— 与网关离线同形。
        vi.mocked(resolveAgentWorkspace).mockRejectedValueOnce(new Error('gateway rpc failed'));
        collectReceiptsMock.mockReturnValue({
          receipts: [
            {
              receiptFile: '.royin-ppt-receipt-77777777-2222-3333-4444-555555555555.json',
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
          id: 'rpc-fail-deck',
          name: 'deck.pptx',
          size: bytes.length,
          localPath: `${taskId}/deck.pptx`,
        });

        const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
        const token = beginArtifactRun(realWorkspace, taskId, sessionKey, { gatewayId: 'gateway-1' });
        bindArtifactRun(taskId, sessionKey, token, 'rpc-fail-run');
        selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce(undefined);
        handleMap.get('data:create-message')!(
          {},
          {
            id: 'rpc-fail-incoming',
            taskId,
            sessionKey,
            runId: 'rpc-fail-run',
            role: 'assistant',
            content: 'Done',
            timestamp: '2026-10-09T00:00:00.000Z',
          },
        );
        await waitForSettlement();

        // ① collector 必须仍被调用（旧行为：0 次），主根 = 应用工作区（可信根）之一
        expect(collectReceiptsMock).toHaveBeenCalled();
        expect(collectReceiptsMock).toHaveBeenCalledWith(
          expect.objectContaining({ workspacePath: realWorkspace, allowedReceiptRoots: [realWorkspace] }),
        );
        // ② 规范落位登记照常（产物面板就看这一行）
        expect(saveArtifactMock).toHaveBeenCalledWith(
          expect.objectContaining({
            fileName: 'deck.pptx',
            sourceKey: 'slidegen-cli:.royin-ppt-receipt-77777777-2222-3333-4444-555555555555.json',
          }),
        );
      } finally {
        rmSync(realWorkspace, { recursive: true, force: true });
      }
    });
  });

  /**
   * ⭐ **H3（2026-10-09 复审）：按收据解析根 · 登记证明移出可选 agent 扫描**。
   *
   * 现场形态：助手目录 RPC 超时 / 网关离线 ⇒ `captureAgentRootBaseline` 回 null。
   * 修前两处把整条链掐死：`:1105 if (!agentRoot …) break`（视觉审查一次都不跑）、
   * `remember` 被 `agentRoot &&` 挡在门外（`last_receipt` 永远是 null）⇒ 下一轮自动修订丢父版本。
   * 修后：每条收据在**它自己的根**上被审查/复核；登记证明（主根规范落位 ∪ 可选 agent 扫描）
   * 逐字段核对（`Map.has()` 不是证明），`remember` 不再挂在 agent 根上。
   */
  describe('H3：收据根解析 + 登记证据移出可选 agent 扫描', () => {
    /** 公共夹具：真实临时应用工作区 + 一条真字节对得上的 native 收据 + 受控态 mock。 */
    async function h3Fixture(suffix: string) {
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createHash } = await import('node:crypto');
      const realWorkspace = mkdtempSync(join(tmpdir(), `h3-${suffix}-`));
      const bytes = Buffer.from('deck-bytes');
      writeFileSync(join(realWorkspace, 'deck.pptx'), bytes);
      const { getWorkspacePath } = await import('../src/main/workspace/config.js');
      vi.mocked(getWorkspacePath).mockReturnValue(realWorkspace);
      vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
      const receiptFile = '.royin-ppt-receipt-77777777-2222-3333-4444-555555555555.json';
      const entry = {
        receiptFile,
        source: '{}',
        receipt: {
          sourceFormat: 'native-template-v5',
          revision: 0,
          sourceFile: '.royin-native-x/source.json',
          fileName: 'deck.pptx',
          bytes: bytes.length,
          outputSha256: createHash('sha256').update(bytes).digest('hex'),
        },
        outputDir: realWorkspace,
      };
      collectReceiptsMock.mockReturnValue({ receipts: [entry], rejected: 0 });
      // 与真库同形：`remember` 的 UPDATE 带 `active_token=? AND canceled=0` —— 旧 token / 已取消
      // 一律写不进去（这里如实模拟那句 WHERE，负例才有意义）。
      const control = { active_token: '', canceled: 0, last_receipt: null as string | null, auto_count: 0 };
      nativeControlMock.mockReturnValue({
        beginUser: (_task: string, token: string) => {
          control.active_token = token;
          control.canceled = 0;
        },
        // ⭐ E4：受控链的**自动纠偏**要开新 run（`beginAutomatic`）—— 观察"具名诊断进纠正通道"
        //    的用例需要它；不打开纠偏的用例走不到这里，加进来是惰性的。
        beginAutomatic: (_task: string, previous: string, token: string) => {
          if (control.canceled || control.active_token !== previous || control.auto_count >= 2) return false;
          control.active_token = token;
          control.auto_count++;
          return true;
        },
        cancel: (_task: string, token: string) => {
          if (control.active_token === token) control.canceled = 1;
        },
        get: () => control,
        remember: (_task: string, token: string, receipt: string) => {
          if (control.active_token !== token || control.canceled) return;
          control.last_receipt = receipt;
        },
      });
      sqliteMock.mockReturnValue({ prepare: () => ({ all: () => [], get: () => undefined }) });
      slidesMock.mockResolvedValue({ saved: [], failed: [], warnings: [] });
      nativeReviewMock.mockResolvedValue({ status: 'passed' });
      saveArtifactMock.mockResolvedValue({
        ...artifact,
        id: 'h3-deck',
        name: 'deck.pptx',
        size: bytes.length,
        localPath: `${taskId}/deck.pptx`,
      });
      const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
      /** 走一轮真实入口：起 run → 绑定 → create-message（整条收尾链在真实控制流里跑）。 */
      const deliver = (
        round: {
          runId: string;
          incomingId: string;
          messageId: string;
          timestamp: string;
          userContent: string;
        },
        // ⭐ E4：受控链的自动纠偏要拿到任务行的网关 id（`input.gatewayId`）才会发车 ——
        //    需要观察"具名诊断进了纠正通道"的用例把它打开（缺省不查任务行，与老用例一致）。
        options?: { gatewayRow?: boolean },
      ): string => {
        const token = beginArtifactRun(realWorkspace, taskId, sessionKey, {
          gatewayId: 'gateway-1',
          userContent: round.userContent,
        });
        bindArtifactRun(taskId, sessionKey, token, round.runId);
        selectGetMock
          .mockReturnValueOnce({ id: round.messageId })
          .mockReturnValueOnce(options?.gatewayRow ? { gid: 'gateway-1' } : undefined);
        handleMap.get('data:create-message')!(
          {},
          {
            id: round.incomingId,
            taskId,
            sessionKey,
            runId: round.runId,
            role: 'assistant',
            content: 'Done',
            timestamp: round.timestamp,
          },
        );
        return token;
      };
      return { realWorkspace, bytes, entry, receiptFile, control, deliver };
    }

    it('⭐ RPC 失败（agentRoot=null）：审查按收据自己的根跑 · 登记后 remember 落库 · 下一轮以它为父版本', async () => {
      const fixture = await h3Fixture('rpc-fail');
      const { createHash } = await import('node:crypto');
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { resolveAgentWorkspace } = await import('../src/main/artifact/agent-workspace.js');
      // ⭐ E4（2026-10-09 复审）：**两轮持续** RPC 失败（不是 Once）—— 修前第二轮会恢复默认
      //    助手根 mock（`C:\agent-quality-workspace`），刚好绕过"agentRoot=null 时受管修订
      //    进不去"这个断点（假绿）。持续拒绝与现场"网关离线 / RPC 超时"同形：两轮都拿不到助手根。
      vi.mocked(resolveAgentWorkspace).mockRejectedValue(new Error('gateway rpc failed'));
      try {
        fixture.deliver({
          runId: 'h3-run-1',
          incomingId: 'h3-incoming-1',
          messageId,
          timestamp: '2026-10-09T01:00:00.000Z',
          userContent: '做一份PPT',
        });
        await waitForSettlement();

        // ① 视觉审查跑起来了，工作区 = **这条收据自己的根**（修前：`!agentRoot ⇒ break`，0 次）
        expect(nativeReviewMock).toHaveBeenCalledWith(
          fixture.realWorkspace,
          fixture.receiptFile,
          undefined,
          expect.any(Function),
        );
        // ② 规范落位登记照常（产物面板那一行就靠它）
        expect(saveArtifactMock).toHaveBeenCalledWith(
          expect.objectContaining({ fileName: 'deck.pptx', sourceKey: `slidegen-cli:${fixture.receiptFile}` }),
        );
        // ③ 登记后的当前性复核读的也是这条收据自己的根（不是空串、不是别的根）
        expect(outputCurrentMock).toHaveBeenCalledWith(fixture.realWorkspace, expect.anything(), 'deck.pptx');
        // ④ 登记证明成立 ⇒ 父版本证据落库（修前：agent 分支把它挡掉，last_receipt=null）
        expect(fixture.control.last_receipt).toBe(fixture.receiptFile);
        expect(settlements().at(-1)?.status).toBe('succeeded');

        // ⑤ 二次修改：下一轮读回的就是 remember 落下的那条 —— 候选稿挂着别的父版本 ⇒
        //    受管重渲染接管，`previous` 必须是第一轮那条收据（父版本不丢）。
        const round2Bytes = Buffer.from('deck-v2-bytes');
        writeFileSync(join(fixture.realWorkspace, 'deck-v2.pptx'), round2Bytes);
        const round2ReceiptFile = '.royin-ppt-receipt-88888888-2222-3333-4444-555555555555.json';
        collectReceiptsMock.mockReturnValue({
          receipts: [
            {
              receiptFile: round2ReceiptFile,
              source: '{}',
              receipt: {
                sourceFormat: 'native-template-v5',
                revision: 0,
                sourceFile: 'candidate.native-ppt.json',
                fileName: 'deck-v2.pptx',
                bytes: round2Bytes.length,
                outputSha256: createHash('sha256').update(round2Bytes).digest('hex'),
              },
              outputDir: fixture.realWorkspace,
            },
          ],
          rejected: 0,
        });
        nativeRenderMock.mockResolvedValue({ fileCreated: true, receiptFile: 'h3-round2-receipt.json' });
        // 第二轮的新稿由助手工作区扫描登记（登记证明的第二种形态：agent 行）。
        reconcileMock.mockResolvedValue({
          ...emptyReconciliation,
          saved: [
            {
              ...artifact,
              id: 'h3-round2-agent-row',
              messageId: 'persisted-assistant-2',
              root: 'agent',
              name: 'deck-v2.pptx',
              size: round2Bytes.length,
              localPath: 'deck-v2.pptx',
              filePath: 'C:\\agent-quality-workspace\\deck-v2.pptx',
            },
          ],
        });
        // ⭐ E4：收据读回按**文件**分流 —— 受管修订在渲染前先读回父收据（A，revision 0），
        //    渲染后再读回 child（revision 1、父链指向 A）。混用一条会把"父链核验"变成
        //    永远对不上的假阴性；child 的 `outputSha256` 必须对得上盘上字节（规范落位要它）。
        nativeReceiptMock.mockImplementation((_root: string, file: string) =>
          file === fixture.receiptFile
            ? {
                sourceFormat: 'native-template-v5',
                revision: 0,
                sourceFile: '.royin-native-x/source.json',
                fileName: 'deck.pptx',
                bytes: fixture.bytes.length,
                outputSha256: createHash('sha256').update(fixture.bytes).digest('hex'),
              }
            : {
                sourceFormat: 'native-template-v5',
                revision: 1,
                sourceFile: 'candidate.native-ppt.json',
                fileName: 'deck-v2.pptx',
                bytes: round2Bytes.length,
                outputSha256: createHash('sha256').update(round2Bytes).digest('hex'),
                previousReceiptFile: fixture.receiptFile,
              },
        );
        saveArtifactMock.mockResolvedValue({
          ...artifact,
          // ⭐ E4（2026-10-09 复审）：第二轮登记行的身份必须是**这一轮的消息**
          //    （`persisted-assistant-2`）——沿用第一轮的 `persisted-assistant` 会让登记证明
          //    对不上，把真正的断点掩盖成"登记行不匹配"。
          id: 'h3-round2-deck',
          messageId: 'persisted-assistant-2',
          name: 'deck-v2.pptx',
          size: round2Bytes.length,
          localPath: `${taskId}/deck-v2.pptx`,
        });
        fixture.deliver({
          runId: 'h3-run-2',
          incomingId: 'h3-incoming-2',
          messageId: 'persisted-assistant-2',
          timestamp: '2026-10-09T01:05:00.000Z',
          userContent: '修改这份 PPT',
        });
        await waitForSettlement(2);
        // ⑥ 父收据在**候选自己的可信根**上被真实读回（不是拿同名 basename 猜父版本）
        expect(nativeReceiptMock).toHaveBeenCalledWith(fixture.realWorkspace, fixture.receiptFile);
        // ⑦ 受管重渲染的根 = 候选自己的可信根（agentRoot=null 时不回落空根、不是别根）
        expect(nativeRenderMock).toHaveBeenCalledWith(
          'candidate.native-ppt.json',
          fixture.realWorkspace,
          expect.objectContaining({ previous: fixture.receiptFile, sourceReceipt: round2ReceiptFile }),
        );
        // ⑧ 父版本证据只接**最终核验过**的受管收据（child 的父链回指第一轮那条）
        expect(fixture.control.last_receipt).toBe('h3-round2-receipt.json');
      } finally {
        const { rmSync } = await import('node:fs');
        rmSync(fixture.realWorkspace, { recursive: true, force: true });
      }
    });

    /**
     * ⭐ **E4（2026-10-09 复审）：生成出口的可信根**。
     *
     * 主进程旧行为：`:1039` 的本轮 write/edit 输入查找与 `:1098` 的生成出口都挂 `agentRoot` ——
     * 助手目录 RPC 失败（网关离线 / 超时）时整条受管生成**一次都不跑**，即使模型这一轮真的
     * 在本轮写了源文件、应用工作区就是那个可信根。
     */
    it('⭐ E4：RPC 失败（agentRoot=null）时本轮 write/edit 输入照常受管生成（同一可信根）', async () => {
      const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createHash } = await import('node:crypto');
      const { resolveAgentWorkspace } = await import('../src/main/artifact/agent-workspace.js');
      const { getWorkspacePath } = await import('../src/main/workspace/config.js');
      const realWorkspace = mkdtempSync(join(tmpdir(), 'h3-gen-root-'));
      const bytes = Buffer.from('generated-deck');
      writeFileSync(join(realWorkspace, 'deck.pptx'), bytes);
      vi.mocked(getWorkspacePath).mockReturnValue(realWorkspace);
      vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
      // 助手目录**持续**解析失败 ⇒ agentRoot=null（现场：网关离线 / RPC 超时）。
      vi.mocked(resolveAgentWorkspace).mockRejectedValue(new Error('gateway rpc failed'));
      const control = { active_token: '', canceled: 0, last_receipt: null as string | null, auto_count: 0 };
      sqliteMock.mockReturnValue({ prepare: () => ({ all: () => [], get: () => undefined }) });
      nativeControlMock.mockReturnValue({
        beginUser: (_task: string, token: string) => {
          control.active_token = token;
          control.canceled = 0;
        },
        get: () => control,
        remember: (_task: string, token: string, receipt: string) => {
          if (control.active_token === token && !control.canceled) control.last_receipt = receipt;
        },
      });
      collectReceiptsMock.mockReturnValue({ receipts: [], rejected: 0 });
      nativeInputMock.mockReturnValue('this-round.native-ppt.json');
      nativeRenderMock.mockResolvedValue({ fileCreated: true, receiptFile: 'gen-receipt.json' });
      nativeReceiptMock.mockReturnValue({
        sourceFormat: 'native-template-v5',
        revision: 0,
        sourceFile: 'this-round.native-ppt.json',
        fileName: 'deck.pptx',
        bytes: bytes.length,
        outputSha256: createHash('sha256').update(bytes).digest('hex'),
      });
      nativeReviewMock.mockResolvedValue({ status: 'passed' });
      slidesMock.mockResolvedValue({ saved: [], failed: [], warnings: [] });
      saveArtifactMock.mockResolvedValue({
        ...artifact,
        id: 'h3-gen-root-deck',
        name: 'deck.pptx',
        size: bytes.length,
        localPath: `${taskId}/deck.pptx`,
      });
      try {
        const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
        const token = beginArtifactRun(realWorkspace, taskId, sessionKey, {
          gatewayId: 'gateway-1',
          userContent: '做一份PPT',
        });
        bindArtifactRun(taskId, sessionKey, token, 'h3-gen-root-run');
        selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce(undefined);
        handleMap.get('data:create-message')!(
          {},
          {
            id: 'h3-gen-root-incoming',
            taskId,
            sessionKey,
            runId: 'h3-gen-root-run',
            role: 'assistant',
            content: 'Done',
            timestamp: '2026-10-09T05:00:00.000Z',
            toolCalls: [
              {
                id: 'write-source',
                name: 'write',
                status: 'done',
                startedAt: '',
                args: { path: 'this-round.native-ppt.json', content: '{}' },
              },
            ],
          },
        );
        await waitForSettlement();
        // ① 本轮 write/edit 输入查找用的是**可信根**（修前 `agentRoot &&` ⇒ 整条跳过，0 次）
        expect(nativeInputMock).toHaveBeenCalledWith(
          realWorkspace,
          expect.any(Array),
          expect.objectContaining({ sinceMs: expect.any(Number) }),
        );
        // ② 生成出口在**同一个根**上跑（修前 agentRoot=null ⇒ 一次都不渲）
        expect(nativeRenderMock).toHaveBeenCalledWith('this-round.native-ppt.json', realWorkspace, expect.any(Object));
        // ③ 生成条目带着自己的根 ⇒ 规范落位登记照常（产物面板就看这一行）
        expect(saveArtifactMock).toHaveBeenCalledWith(
          expect.objectContaining({ fileName: 'deck.pptx', sourceKey: 'slidegen-cli:gen-receipt.json' }),
        );
        expect(control.last_receipt).toBe('gen-receipt.json');
        expect(settlements().at(-1)?.status).toBe('succeeded');
      } finally {
        rmSync(realWorkspace, { recursive: true, force: true });
      }
    });

    /**
     * ⭐ **E4（2026-10-09 复审）：跨根父链不许猜**。
     *
     * 现场形态：第一轮 RPC 失败 ⇒ 父收据 A 落在应用工作区并被 remember；第二轮 RPC 恢复到
     * **另一个根**（agentDir）⇒ 候选渲在 agentDir，父收据 A 不在这个根上。受管重渲染只吃一个根
     * （源文件 + 源收据 + 父收据必须同根），读不回父就**具名失败**：不许拿同名 basename 猜父版本、
     * 不许假记父链，候选与原文件照常保留（standalone 仍是本轮的合法产出）。
     */
    it('⭐ E4：父收据在别的可信根 ⇒ 具名失败（不猜父版本）· 候选保留 · 诊断进纠正通道', async () => {
      const fixture = await h3Fixture('cross-parent');
      const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createHash } = await import('node:crypto');
      const { resolveAgentWorkspace } = await import('../src/main/artifact/agent-workspace.js');
      const agentDir = mkdtempSync(join(tmpdir(), 'h3-cross-parent-agent-'));
      // 第一轮：RPC 失败 ⇒ 收据 A 落在应用工作区并被 remember（父版本证据）。
      vi.mocked(resolveAgentWorkspace).mockRejectedValueOnce(new Error('gateway rpc failed'));
      try {
        fixture.deliver({
          runId: 'h3-cp-run-1',
          incomingId: 'h3-cp-incoming-1',
          messageId,
          timestamp: '2026-10-09T06:00:00.000Z',
          userContent: '做一份PPT',
        });
        await waitForSettlement();
        expect(fixture.control.last_receipt).toBe(fixture.receiptFile);

        // 第二轮：RPC **恢复**到另一个根 ⇒ 候选渲在 agentDir；父收据 A 只在应用工作区读得回来。
        vi.mocked(resolveAgentWorkspace).mockResolvedValue(agentDir);
        const round2Bytes = Buffer.from('cross-root-v2');
        writeFileSync(join(agentDir, 'deck-v2.pptx'), round2Bytes);
        const round2ReceiptFile = '.royin-ppt-receipt-99999999-2222-3333-4444-555555555555.json';
        collectReceiptsMock.mockReturnValue({
          receipts: [
            {
              receiptFile: round2ReceiptFile,
              source: '{}',
              receipt: {
                sourceFormat: 'native-template-v5',
                revision: 0,
                sourceFile: 'candidate.native-ppt.json',
                fileName: 'deck-v2.pptx',
                bytes: round2Bytes.length,
                outputSha256: createHash('sha256').update(round2Bytes).digest('hex'),
              },
              outputDir: agentDir,
            },
          ],
          rejected: 0,
        });
        // 收据读回按根分流：应用工作区拿得到 A（父），候选根拿不到任何收据。
        nativeReceiptMock.mockImplementation((root: string) => {
          if (root === fixture.realWorkspace)
            return {
              sourceFormat: 'native-template-v5',
              revision: 0,
              sourceFile: '.royin-native-x/source.json',
              fileName: 'deck.pptx',
              bytes: fixture.bytes.length,
              outputSha256: createHash('sha256').update(fixture.bytes).digest('hex'),
            };
          throw new Error('receipt-invalid');
        });
        // 这一轮的候选照常登记（agent 扫描行）⇒ 候选保留下来就是本轮的合法产出。
        reconcileMock.mockResolvedValue({
          ...emptyReconciliation,
          saved: [
            {
              ...artifact,
              id: 'h3-cp-agent-row',
              root: 'agent',
              messageId: 'persisted-assistant-2',
              name: 'deck-v2.pptx',
              size: round2Bytes.length,
              localPath: 'deck-v2.pptx',
              filePath: join(agentDir, 'deck-v2.pptx'),
            },
          ],
        });
        nativeReviewMock.mockResolvedValue({ status: 'passed' });
        nativeGuardMock.mockResolvedValue(undefined);
        const sendChatMessage = vi.fn().mockResolvedValue({ runId: 'h3-cp-correction' });
        nativeGatewayMock.mockReturnValue({ isConnected: true, sendChatMessage });

        fixture.deliver(
          {
            runId: 'h3-cp-run-2',
            incomingId: 'h3-cp-incoming-2',
            messageId: 'persisted-assistant-2',
            timestamp: '2026-10-09T06:05:00.000Z',
            userContent: '修改这份 PPT',
          },
          { gatewayRow: true },
        );
        await waitForSettlement(2);

        // ① 父收据不在候选根 ⇒ **不渲染**（受管重渲染只吃一个根，读不回父就不许赌）
        expect(nativeRenderMock).not.toHaveBeenCalled();
        // ② 具名诊断进了自动纠正通道（不是笼统的 parent-mismatch，也不是被吞掉的假成功）
        expect(sendChatMessage).toHaveBeenCalledOnce();
        expect(sendChatMessage.mock.calls[0]![1]).toContain('native-revision-parent-other-root');
        // ③ 候选保留（文件与登记都还在，不会被删）；但**父版本停在第一轮的 A**。
        //    ⭐ E4（2026-10-09 H1–H6 E 轮终审 §3 裁决后**预期变更**）：旧断言（= 候选 round2ReceiptFile）
        //       把"父在别的可信根、结构修订根本没走完"的轮次当成了父版本更新 —— 下一轮纠正会以这份
        //       候选为约束基准，而用户手里已验证的是 A。裁决：保留原父 A、结算至少 needs-review。
        expect(fixture.control.last_receipt).toBe(fixture.receiptFile);
      } finally {
        rmSync(fixture.realWorkspace, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it('⭐ 跨根同名收据：每条按自己的根复核（共用一个全局根会把另一条读成"不当前"）', async () => {
      const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createHash } = await import('node:crypto');
      const realWorkspace = mkdtempSync(join(tmpdir(), 'h3-cross-ws-'));
      const agentDir = mkdtempSync(join(tmpdir(), 'h3-cross-agent-'));
      try {
        vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
        const wsBytes = Buffer.from('workspace-deck');
        const agentBytes = Buffer.from('agent-deck');
        writeFileSync(join(realWorkspace, 'deck.pptx'), wsBytes);
        writeFileSync(join(agentDir, 'deck.pptx'), agentBytes);
        const { getWorkspacePath } = await import('../src/main/workspace/config.js');
        vi.mocked(getWorkspacePath).mockReturnValue(realWorkspace);
        const { resolveAgentWorkspace } = await import('../src/main/artifact/agent-workspace.js');
        vi.mocked(resolveAgentWorkspace).mockResolvedValue(agentDir);
        const control = { active_token: '', canceled: 0, last_receipt: null as string | null, auto_count: 0 };
        nativeControlMock.mockReturnValue({
          beginUser: (_task: string, token: string) => {
            control.active_token = token;
          },
          get: () => control,
          remember: (_task: string, token: string, receipt: string) => {
            if (control.active_token === token && !control.canceled) control.last_receipt = receipt;
          },
        });
        sqliteMock.mockReturnValue({ prepare: () => ({ all: () => [], get: () => undefined }) });
        slidesMock.mockResolvedValue({ saved: [], failed: [], warnings: [] });
        nativeReviewMock.mockResolvedValue({ status: 'passed' });
        const entryOf = (file: string, bytes: Buffer, outputDir: string) => ({
          receiptFile: file,
          source: '{}',
          receipt: {
            sourceFormat: 'native-template-v5' as const,
            revision: 0,
            sourceFile: `.royin-native-x/${file}`,
            fileName: 'deck.pptx',
            bytes: bytes.length,
            outputSha256: createHash('sha256').update(bytes).digest('hex'),
          },
          outputDir,
        });
        const agentEntry = entryOf(
          '.royin-ppt-receipt-aaaaaaaa-1111-2222-3333-444444444444.json',
          agentBytes,
          agentDir,
        );
        const workspaceEntry = entryOf(
          '.royin-ppt-receipt-bbbbbbbb-1111-2222-3333-444444444444.json',
          wsBytes,
          realWorkspace,
        );
        collectReceiptsMock.mockReturnValue({ receipts: [agentEntry, workspaceEntry], rejected: 0 });
        // 当前性复核必须"回条问条根"：拿一个全局根来问，另一条永远回 false（= 修前形态）。
        outputCurrentMock.mockImplementation(
          (root: string, entries: Array<{ outputDir?: string; receipt: { fileName: string } }>, file: string) =>
            entries.some((entry) => entry.outputDir === root && entry.receipt.fileName === file),
        );
        // 助手根那条由 agent 扫描登记；应用工作区那条由"规范落位"登记。
        reconcileMock.mockImplementation(async (scan: { rootKind?: string }) =>
          scan.rootKind === 'agent'
            ? {
                ...emptyReconciliation,
                saved: [
                  {
                    ...artifact,
                    id: 'agent-root-deck',
                    root: 'agent',
                    name: 'deck.pptx',
                    size: agentBytes.length,
                    localPath: 'deck.pptx',
                    filePath: join(agentDir, 'deck.pptx'),
                  },
                ],
              }
            : emptyReconciliation,
        );
        saveArtifactMock.mockResolvedValue({
          ...artifact,
          id: 'workspace-deck',
          name: 'deck.pptx',
          size: wsBytes.length,
          localPath: `${taskId}/deck.pptx`,
        });

        const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
        const token = beginArtifactRun(realWorkspace, taskId, sessionKey, {
          gatewayId: 'gateway-1',
          userContent: '做一份PPT',
        });
        bindArtifactRun(taskId, sessionKey, token, 'h3-cross-run');
        selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce(undefined);
        handleMap.get('data:create-message')!(
          {},
          {
            id: 'h3-cross-incoming',
            taskId,
            sessionKey,
            runId: 'h3-cross-run',
            role: 'assistant',
            content: 'Done',
            timestamp: '2026-10-09T02:00:00.000Z',
          },
        );
        await waitForSettlement();

        // ① 两条各自的根都出现过（共用一个全局根时只会出现一个）
        expect(new Set(outputCurrentMock.mock.calls.map(([root]) => root))).toEqual(new Set([agentDir, realWorkspace]));
        // ② 两边的登记证明都成立 ⇒ 交付不是失败；父版本证据 = 最后一条 native 收据
        expect(settlements().at(-1)?.status).not.toBe('failed');
        expect(control.last_receipt).toBe(workspaceEntry.receiptFile);
      } finally {
        rmSync(realWorkspace, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it('⭐ 视觉审查没过：父版本照记（自动修订不许丢父版本），交付判 needs-review', async () => {
      const fixture = await h3Fixture('review-revision');
      const { resolveAgentWorkspace } = await import('../src/main/artifact/agent-workspace.js');
      vi.mocked(resolveAgentWorkspace).mockRejectedValueOnce(new Error('gateway rpc failed'));
      nativeReviewMock.mockResolvedValue({ status: 'needs-revision', pages: [{ page: 1, issues: ['small-text'] }] });
      try {
        fixture.deliver({
          runId: 'h3-review-run',
          incomingId: 'h3-review-incoming',
          messageId,
          timestamp: '2026-10-09T03:00:00.000Z',
          userContent: '做一份PPT',
        });
        await waitForSettlement();
        expect(fixture.control.last_receipt).toBe(fixture.receiptFile);
        expect(settlements().at(-1)?.status).toBe('needs-review');
      } finally {
        const { rmSync } = await import('node:fs');
        rmSync(fixture.realWorkspace, { recursive: true, force: true });
      }
    });

    it.each(['wrong-output-sha', 'stale-registration', 'canceled', 'superseded-token'] as const)(
      '⭐ 负例（%s）：登记证明不成立 / 这一轮不再拥有 token ⇒ 一个字的父版本证据都不落',
      async (kind) => {
        const fixture = await h3Fixture(`negative-${kind}`);
        const { rmSync } = await import('node:fs');
        const { resolveAgentWorkspace } = await import('../src/main/artifact/agent-workspace.js');
        vi.mocked(resolveAgentWorkspace).mockRejectedValueOnce(new Error('gateway rpc failed'));
        if (kind === 'wrong-output-sha') fixture.entry.receipt.outputSha256 = 'f'.repeat(64);
        if (kind === 'stale-registration')
          saveArtifactMock.mockResolvedValue({
            ...artifact,
            id: 'mismatched-row',
            name: 'deck.pptx',
            size: fixture.bytes.length + 1,
            localPath: `${taskId}/deck.pptx`,
          });
        try {
          fixture.deliver({
            runId: 'h3-negative-run',
            incomingId: 'h3-negative-incoming',
            messageId,
            timestamp: '2026-10-09T04:00:00.000Z',
            userContent: '做一份PPT',
          });
          // 取消 / 旧 token：受控态里这一轮已经不再是活的（`isArtifactRunCanceled` 如实失效）——
          // 登记与父版本证据都不许再落（收据/成品仍在盘上，下一轮照常能读回）。
          if (kind === 'canceled') fixture.control.canceled = 1;
          if (kind === 'superseded-token') fixture.control.active_token = 'a-newer-run-token';
          await waitForSettlement();

          expect(fixture.control.last_receipt).toBeNull();
          if (kind === 'wrong-output-sha') {
            // 字节/哈希与收据对不上 ⇒ 一个字节都不搬（连登记都没有，自然无从 remember）
            expect(saveArtifactMock).not.toHaveBeenCalled();
            expect(settlements().at(-1)?.status).toBe('failed');
          }
          if (kind === 'stale-registration') {
            // 规范落位搬了，但登记行与收据对不上（size+1）⇒ **不算证明**（`Map.has()` 不是证明）
            expect(saveArtifactMock).toHaveBeenCalled();
            expect(settlements().at(-1)?.status).toBe('failed');
          }
          if (kind === 'canceled' || kind === 'superseded-token') {
            // 这一轮已不是活的 ⇒ 连登记都不做（更不会有父版本证据），交付如实判 canceled
            expect(saveArtifactMock).not.toHaveBeenCalled();
            expect(settlements().at(-1)?.status).toBe('canceled');
          }
        } finally {
          rmSync(fixture.realWorkspace, { recursive: true, force: true });
        }
      },
    );

    /**
     * ⭐ **E4（2026-10-09 H1–H6 E 轮终审 §3）：结构修订失败不许污染父链 · 不许结算成功**。
     *
     * 十条反例 = 三类结构失败（child 收据读不回 / 渲染器拒绝业务数据变化 / 父在别的可信根 /
     * 源生成读回的 child 指着无关父 C）× 四种外部环境（联网 / 离线 / 预算拒绝 / 自动纠正次数用尽）。
     * 走的全是**真身控制流**（真实 handler + 真实 run 生命周期 + 真实结算 + 续轮控制表），
     * 不是孤立单测：standalone 候选 B 已登记、结构修订没走完之后——
     *   ① B **不许**被记成"新父版本"（`last_receipt` 停在原已验证父 A）；
     *   ② 结算至少 needs-review（离线 / 预算不足 / 次数用尽时连自动纠正都发不出去，
     *      绝不许落 succeeded——那直接违背完成契约）；错误父的源生成按既有 missingKinds 门判 failed；
     *   ③ 候选文件与具名诊断都保留（失败不删文件、模型能拿到真因）。
     *
     * ⚠️ 纠正 run 的父版本（`nativeParentReceipt`）在**本文件**的等价证明：`nativeRegisteredReceipt`
     *    只在 `remember` 真把 B 写进控制表的那一支里被赋值（代码要求 `state.last_receipt === 本轮 B`），
     *    而这里 `control.last_receipt` 仍停在 A ⇒ 自动纠正取
     *    `nativeRegisteredReceipt ?? run.nativePreviousReceipt` = A。
     *    （对该字段的**直接**观察由审查侧取证套件 `E-round-review-E4.config.mjs` 的
     *    `beginArtifactRun` 观察钩子承担——那是审查期注入，不进产品源码。）
     */
    it.each([
      ['child-unverified', 'connected'],
      ['child-unverified', 'disconnected'],
      ['child-unverified', 'budget-refused'],
      ['child-unverified', 'auto-limit'],
      ['native-revision-data-changed', 'connected'],
      ['native-revision-data-changed', 'disconnected'],
      ['native-revision-data-changed', 'budget-refused'],
      ['native-revision-data-changed', 'auto-limit'],
      ['parent-other-root', 'connected'],
      ['source-child-wrong-parent', 'connected'],
    ] as const)(
      '⭐ E4：结构修订失败（%s / %s）保留原父 A · 不 succeeded · 候选文件与诊断保留',
      async (failure, channel) => {
        const fixture = await h3Fixture('E4-forensic');
        const fs = await import('node:fs');
        const path = await import('node:path');
        const os = await import('node:os');
        const { createHash } = await import('node:crypto');
        const { resolveAgentWorkspace } = await import('../src/main/artifact/agent-workspace.js');
        // 场景①：父 A 落在应用工作区，候选 B 落在**另一个可信根**（现场：RPC 恢复后助手目录变了）。
        const otherRoot =
          failure === 'parent-other-root' ? fs.mkdtempSync(path.join(os.tmpdir(), 'E4-other-root-')) : undefined;
        const candidateRoot = otherRoot ?? fixture.realWorkspace;
        // 现场同形：助手目录 RPC **持续**失败（网关离线 / RPC 超时）——受管修订只吃候选自己的可信根。
        vi.mocked(resolveAgentWorkspace).mockRejectedValue(new Error('continuous rpc failure'));
        // "child 读回"次数 = 真的去读那条 child 收据的次数（读失败也算：失败本身就是要断言的事实）。
        let childReads = 0;
        const childIdentities: Array<{ revision: number; previousReceiptFile?: string }> = [];
        try {
          // 第一轮：A 出片并被登记 ⇒ 用户手里已验证的父版本就是 A。
          fixture.deliver({
            runId: 'E4-first',
            incomingId: 'E4-first-incoming',
            messageId,
            timestamp: '2026-10-09T01:00:00Z',
            userContent: '做一份PPT',
          });
          await waitForSettlement();
          expect(fixture.control.last_receipt).toBe(fixture.receiptFile);
          if (otherRoot) vi.mocked(resolveAgentWorkspace).mockResolvedValue(otherRoot);
          const candidateBytes = Buffer.from('candidate-v2');
          fs.writeFileSync(path.join(candidateRoot, 'deck-v2.pptx'), candidateBytes);
          const standalone = '.royin-ppt-receipt-88888888-2222-3333-4444-555555555555.json';
          const candidate = {
            receiptFile: standalone,
            source: '{}',
            outputDir: candidateRoot,
            receipt: {
              sourceFormat: 'native-template-v5',
              revision: 0,
              sourceFile: 'candidate.native-ppt.json',
              fileName: 'deck-v2.pptx',
              bytes: candidateBytes.length,
              outputSha256: createHash('sha256').update(candidateBytes).digest('hex'),
            },
          };
          // 场景④：这一轮没有候选收据，模型直接写了源文件 ⇒ 走"带父输入生成"出口。
          const sourceGeneration = failure === 'source-child-wrong-parent';
          collectReceiptsMock.mockReturnValue({ receipts: sourceGeneration ? [] : [candidate], rejected: 0 });
          if (sourceGeneration) nativeInputMock.mockReturnValue('candidate.native-ppt.json');
          nativeReceiptMock.mockImplementation((root: string, file: string) => {
            if (file === fixture.receiptFile && root === fixture.realWorkspace) return fixture.entry.receipt;
            if (file === 'unverified-child.json') {
              childReads++;
              // child 收据读不回（child-unverified），或它自己说"我是 C 的改稿"（C 与本轮父 A 无关）
              // —— 两种都是不该被接受的修订结果。
              if (!sourceGeneration || root !== fixture.realWorkspace) throw Error('receipt-version-mismatch');
              childIdentities.push({ revision: 1, previousReceiptFile: 'unrelated-C.json' });
              return { ...candidate.receipt, revision: 1, previousReceiptFile: 'unrelated-C.json' };
            }
            throw Error('receipt-version-mismatch');
          });
          nativeRenderMock.mockResolvedValue(
            failure === 'native-revision-data-changed'
              ? { fileCreated: false, diagnostics: [{ code: 'native-revision-data-changed' }] }
              : { fileCreated: true, receiptFile: 'unverified-child.json' },
          );
          // 候选 B 照常登记（规范落位 / agent 扫描）⇒ 保留候选就是这一轮对用户**诚实的**产出。
          saveArtifactMock.mockResolvedValue({
            ...artifact,
            id: 'E4-standalone',
            messageId: 'persisted-assistant-2',
            name: 'deck-v2.pptx',
            size: candidateBytes.length,
            filePath: path.join(fixture.realWorkspace, taskId, 'deck-v2.pptx'),
            localPath: `${taskId}/deck-v2.pptx`,
          });
          reconcileMock.mockResolvedValue(
            otherRoot
              ? {
                  ...emptyReconciliation,
                  saved: [
                    {
                      ...artifact,
                      id: 'E4-agent-standalone',
                      messageId: 'persisted-assistant-2',
                      root: 'agent',
                      name: 'deck-v2.pptx',
                      size: candidateBytes.length,
                      filePath: path.join(candidateRoot, 'deck-v2.pptx'),
                      localPath: 'deck-v2.pptx',
                    },
                  ],
                }
              : emptyReconciliation,
          );
          const sendChatMessage = vi.fn().mockResolvedValue({ runId: 'E4-automatic' });
          nativeGatewayMock.mockReturnValue({ isConnected: channel !== 'disconnected', sendChatMessage });
          if (channel === 'auto-limit') fixture.control.auto_count = 2;
          if (channel === 'budget-refused') nativeGuardMock.mockRejectedValue(Error('budget-refused'));
          else nativeGuardMock.mockResolvedValue(undefined);
          fixture.deliver(
            {
              runId: 'E4-second',
              incomingId: 'E4-second-incoming',
              messageId: 'persisted-assistant-2',
              timestamp: '2026-10-09T01:05:00Z',
              userContent: '修改这份 PPT',
            },
            { gatewayRow: true },
          );
          await waitForSettlement(2);

          // ① 候选文件与候选登记都不许被删（失败必须保留现场）。
          expect(fs.existsSync(path.join(candidateRoot, 'deck-v2.pptx'))).toBe(true);
          // ② 渲染次数：父不在候选根 ⇒ 一次都不许赌；其余场景各一次。
          expect(nativeRenderMock).toHaveBeenCalledTimes(failure === 'parent-other-root' ? 0 : 1);
          if (failure === 'child-unverified') expect(childReads).toBe(1);
          if (failure === 'source-child-wrong-parent')
            expect(childIdentities).toEqual([{ revision: 1, previousReceiptFile: 'unrelated-C.json' }]);
          // ③ 父链不被污染：结构修订没走完 ⇒ B 不记为新父版本，原父 A 留着（纠正 run 的父=A，见上方注释）。
          expect(fixture.control.last_receipt).toBe(fixture.receiptFile);
          // ④ 结算真实：既有 failed 优先级更高（错误父的源生成撞 missingKinds 门），其余至少 needs-review。
          if (failure === 'source-child-wrong-parent') {
            expect(settlements().at(-1)?.status).toBe('failed');
          } else {
            expect(settlements().at(-1)?.status).toBe('needs-review');
          }
          // ⑤ 具名诊断活着进纠正通道（被顶掉模型就永远收不到真因）；通道不通/次数用尽时一条都不发。
          if (channel === 'connected') {
            expect(sendChatMessage).toHaveBeenCalledOnce();
            const expectedDiagnostic =
              failure === 'native-revision-data-changed'
                ? 'native-revision-data-changed'
                : failure === 'parent-other-root'
                  ? 'native-revision-parent-other-root'
                  : 'native-revision-unverified';
            expect(String(sendChatMessage.mock.calls[0]![1])).toContain(expectedDiagnostic);
          } else expect(sendChatMessage).not.toHaveBeenCalled();
        } finally {
          fs.rmSync(fixture.realWorkspace, { recursive: true, force: true });
          if (otherRoot) fs.rmSync(otherRoot, { recursive: true, force: true });
        }
      },
    );
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
    async function completeRunWith(userContent: string, deckContext = false): Promise<void> {
      const { beginArtifactRun, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
      const token = beginArtifactRun(workspacePath, taskId, sessionKey, {
        gatewayId: 'gateway-1',
        userContent,
        deckContext,
      });
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

    it.each([
      '另做一份PPT',
      '把这份 PPT 美化一下',
      // ⭐ 2026-10-09 复审反例（P1）：首次制作的实际措辞 —— 主进程旧口径（只认"另做/新的/改稿"）
      //    不命中，即使渲染层选到了 DeepSeek，docgen 的 pptx 硬门也不生效。
      //    判据已统一到 `@clawwork/shared` 的 `isDeckWorkRequest`（制作 ∨ 改稿 ∨ 全新的）。
      '把材料做成一份 PPT',
      '做一份公司介绍 PPT',
      'Generate a PPT',
    ])('⭐ 演示意图（%s）⇒ docgen 收到改道旗标（pptx 不进产品通道）', async (userContent) => {
      await completeRunWith(userContent);
      expect(documentsMock).toHaveBeenCalledWith(expect.objectContaining({ reroutePptxToSlidegen: true }));
    });

    // ⭐ H2（2026-10-09 合同）：裸改稿词（"美化/重新排版/调整…字号"）**不再单独成立** ——
    //    要么带演示名词（上表），要么有**可信上下文**（任务粘性标记 / 受控链上一版收据）。
    //    下面两条把两个方向钉死：有上下文照旧命中；无上下文不许把网页/Word/Excel 误标成 deck。
    it('⭐ H2：已有 deck 上下文（任务粘性标记）⇒ 省略改稿词照旧命中硬门', async () => {
      await completeRunWith('第一版不好看，重新排版', true);
      expect(documentsMock).toHaveBeenCalledWith(expect.objectContaining({ reroutePptxToSlidegen: true }));
    });

    it.each(['第一版不好看，重新排版', '美化这个网页', '调整 Excel 的字号'])(
      '⭐ H2 负例：无上下文的裸改稿词（%s）⇒ 不带改道旗标',
      async (userContent) => {
        await completeRunWith(userContent);
        expect(documentsMock).toHaveBeenCalledWith(expect.objectContaining({ reroutePptxToSlidegen: false }));
      },
    );

    it('⭐ H2：派发路径从任务行取粘性标记（deckRouted=true ⇒ deckContext 传入）', async () => {
      const { beginArtifactRunForGatewayDispatch, bindArtifactRun } = await import('../src/main/ipc/data-handlers.js');
      selectGetMock.mockReturnValueOnce({ id: taskId, deckRouted: true });
      const token = beginArtifactRunForGatewayDispatch({
        gatewayId: 'gateway-1',
        sessionKey,
        taskId,
        userContent: '第一版不好看，重新排版',
      });
      expect(token).toEqual(expect.any(String));
      bindArtifactRun(taskId, sessionKey, token!, 'deck-intent-dispatch');
      selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce(undefined);
      expect(
        handleMap.get('data:create-message')!(
          {},
          {
            id: 'deck-intent-dispatch-incoming',
            taskId,
            sessionKey,
            runId: 'deck-intent-dispatch',
            role: 'assistant',
            content: 'Done',
            timestamp: '2026-10-07T00:00:00.000Z',
          },
        ),
      ).toEqual({ ok: true });
      await waitForSettlement();
      expect(documentsMock).toHaveBeenCalledWith(expect.objectContaining({ reroutePptxToSlidegen: true }));
    });

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
