import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawHistoryMessage, SessionSyncDeps } from '@clawwork/core';
import { createMessageStore, createSessionSync } from '@clawwork/core';

/**
 * ⚠️ DOCX-205 合同（2026-10-10，终审）：**真实 sync → IPC 串接**回归。
 *
 * `data-handlers-terminal-boundary.test.ts` 覆盖的是 IPC 这一侧的分支（手工构造
 * payload）；本档补上另一侧的**串接**：payload 由**真实 `createSessionSync`**
 * 从真实历史归一化后产生（终态证据按条归属），按序喂进**真实 `data:create-message`**
 * handler —— 复刻"同一 run 较早可见正文段 + 末条 stop 最终 docgen"的失败形状，
 * 断言生成器收到的是**最终正文**而不是较早段（旧实现按 runId 广播证据时，
 * 最早一段先消费了 ArtifactRun，生成器拿到的是"我先整理材料，然后提交文档。"）。
 */

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

const TASK = 'task-1';
const SESSION = 'session-task-1';
const RUN = 'run-1';

const EARLIER_TEXT = '我先整理材料，然后提交文档。';
const docgenBody =
  '正确的做法是直接在我的回复正文里放 `docgen` 代码块：\n\n```docgen\n{\n  "kind": "docx",\n  "title": "验收文档-205",\n  "sections": [\n    {\n      "heading": "1.0.3 验收文档",\n      "bullets": [\n        "升级与发布链路已通过",\n        "文档由真实链路生成"\n      ]\n    }\n  ]\n}\n```\n';

/** 同 run 两段：较早可见正文段（无 stop）→ 末条 stop 最终正文（docgen）。 */
const HISTORY: RawHistoryMessage[] = [
  {
    role: 'assistant',
    timestamp: 1000,
    __openclaw: { runId: RUN },
    content: [{ type: 'text', text: EARLIER_TEXT }],
  },
  {
    role: 'assistant',
    timestamp: 2000,
    stopReason: 'stop',
    __openclaw: { runId: RUN },
    content: [{ type: 'text', text: docgenBody }],
  },
];

type CapturedPayload = Record<string, unknown> & { id: string; role: string; content: string };

/** 用真实 session-sync 跑一遍历史，收集它实际下发的持久化 payload（按序）。 */
async function runRealSync(): Promise<CapturedPayload[]> {
  const captured: CapturedPayload[] = [];
  const persist = vi.fn<SessionSyncDeps['persistence']['persistMessage']>(async (message) => {
    captured.push(message as unknown as CapturedPayload);
    return { ok: true };
  });
  const store = createMessageStore({ persistMessage: persist });
  const task = { id: TASK, gatewayId: 'gw-1', sessionKey: SESSION };
  const sync = createSessionSync({
    persistence: { persistMessage: persist, loadMessages: async () => ({ ok: true, rows: [] }) },
    gateway: {
      chatHistory: async () => ({ ok: true, result: { messages: HISTORY } }),
      syncSessions: async () => ({ ok: true, discovered: [] }),
    },
    getTaskStore: () => ({
      tasks: [task],
      hydrate: async () => {},
      adoptTasks: () => {},
      updateTaskMetadata: () => {},
    }),
    getMessageStore: () => ({ ...store.getState(), setState: store.setState }),
  });
  await sync.syncSessionMessages(TASK);
  return captured;
}

async function setupBoundRun() {
  const { beginArtifactRun, bindArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
  registerDataHandlers();
  const token = beginArtifactRun('C:\\trusted-workspace', TASK, SESSION, {
    userContent: '生成一份 Word 文档（用 docgen 交付），文件名 验收文档-205.docx',
  });
  bindArtifactRun(TASK, SESSION, token, RUN);
  return handleMap.get('data:create-message')!;
}

function docgenReceived(content: string): boolean {
  return docgenMock.mock.calls.some(([input]) => (input as { content?: string }).content === content);
}

describe('DOCX-205 sync→IPC 串接（真实归一化 payload 按序进真实 handler）', () => {
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

  it('⭐ 生成器收到的是**最终 docgen**而不是较早段；较早段不消费 run；重放不重复生成', async () => {
    const payloads = await runRealSync();
    // 探针前置事实：真实 sync 下发的恰两条，证据只落末段（终态归属修复的直接观测）。
    const assistants = payloads.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0]).not.toHaveProperty('terminal');
    expect(assistants[1].terminal).toMatchObject({ kind: 'final', runId: RUN, stopReason: 'stop' });

    const create = await setupBoundRun();
    for (const row of assistants) {
      selectGetMock.mockReturnValueOnce({ id: row.id }).mockReturnValueOnce({ gid: 'gateway-1' });
      create({}, row);
      await flushJobs();
    }

    // 串接结果：较早段既没触发生成、也没把 run 结算掉；最终 docgen 真实到达生成器。
    // ⚠️ 比对 payload 里**实际**的最终正文（归一化会 trim 可见正文的尾随空白，
    //    所以不能用原始常量做逐字比较——用 payload 自身内容才是"生成器收到最终正文"的正确判据）。
    const finalContent = String(assistants[1].content);
    expect(finalContent).toContain('```docgen');
    expect(docgenMock).not.toHaveBeenCalledWith(expect.objectContaining({ content: EARLIER_TEXT }));
    expect(docgenReceived(finalContent)).toBe(true);
    const generatorCalls = docgenMock.mock.calls.length;
    expect(generatorCalls).toBe(1);
    expect(reconcileCalls()).toHaveLength(1);

    // 重放同一批 payload（同步重试/重复对账的现实形状）：不得第二次生成。
    for (const row of assistants) {
      selectGetMock.mockReturnValueOnce({ id: row.id });
      create({}, row);
      await flushJobs();
    }
    expect(docgenMock.mock.calls.length).toBe(generatorCalls);
    expect(reconcileCalls()).toHaveLength(1);
  });
});
