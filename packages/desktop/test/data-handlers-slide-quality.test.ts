import { beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handleMap.set(channel, handler)),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => [{ webContents: { send: sendMock } }]) },
}));
vi.mock('../src/main/db/index.js', () => ({
  isDbReady: vi.fn(() => true),
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
vi.mock('../src/main/workspace/config.js', () => ({ getWorkspacePath: vi.fn(() => workspacePath) }));
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: vi.fn() }));
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
}));
vi.mock('../src/main/artifact/auto-extract.js', () => ({ autoExtractArtifacts: extractMock }));
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
  beforeEach(async () => {
    vi.resetModules();
    (await import('../src/main/workspace/scope.js')).setWorkspaceDatabaseOwner({});
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
    const { registerDataHandlers, beginArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();
    beginArtifactRun(workspacePath, taskId, sessionKey);
  });

  it('passes canonical completed run tools into receipt collection and keeps confirmed source warnings', async () => {
    const tools = [{ id: 'exec-1', name: 'exec', status: 'done', startedAt: '', result: 'machine report' }];
    const entries = [
      {
        receiptFile: '.royin-ppt-receipt-proof.json',
        source: '// title: Existing\n<Slide></Slide>',
        receipt: { sourceFile: 'report.slidegen' },
      },
    ];
    collectReceiptsMock.mockReturnValue({ receipts: entries, rejected: 0 });
    reuseDeckMock.mockReturnValue([warning]);
    slidesMock.mockImplementationOnce(async (input) => ({
      saved: [],
      failed: [],
      warnings: input.reuseExisting?.({ title: 'Existing', source: entries[0].source }) ?? [],
    }));
    reconcileMock.mockResolvedValue({ ...emptyReconciliation, saved: [artifact] });
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
});
