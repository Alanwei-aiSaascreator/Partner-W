import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * BUG-058④（2026-10-14 M1）· **真实 data-handler 上的 fail-closed 钉子**。
 *
 * 施工图口径（`reviews/2026-10-14-remediation-artifact-audit.md` §058④）：
 * mtime 平局的两个合法候选，没有**可信目标**时不许猜（数组序 / 收包 completedAt /
 * 任意模型文本都不算证据）；模型要拿到**具名歧义**（并列候选 + 可执行的下一步），
 * 而且整轮不许落成"渲染成功"。
 *
 * 与 `native-tool-input.test.ts` 的分工：那边钉 helper 本体的 target 消歧语义
 * （显式目标命中/不在候选保持歧义/非平局不受干扰）；这里钉**接线的真实调用者**——
 * `data-handlers` 的 reconcile 链在 `sinceMs` 之外没有可信 target 时走的是什么路径。
 * `native-tool-input` 在本文件**不 mock**（真实现），候选来自真实临时工作区磁盘 +
 * 真实 sha/mtime 判据；`renderNativePptFile` 被 mock 只为了证明"没有发生任何渲染尝试"。
 *
 * ⚠️ 本文件同时钉住一个 2026-10-14 复核发现的邻接缺陷：helper 抛出的
 * `native-input-ambiguous`（含并列候选名 + 下一步）曾在后面的"无当前写入"兜底分支里被
 * `native-current-write-required` **覆盖**（"追加而不是覆盖"纪律在那一处的违例）——
 * 于是模型实际拿到的是没有候选名、没有下一步的裸码。本文件先红后绿。
 */

const handleMap = new Map<string, (...args: unknown[]) => unknown>();
const sendMock = vi.fn();
const selectGetMock = vi.fn();
const sqliteMock = vi.fn((): unknown => null);
const controlMock = vi.fn();
const renderMock = vi.fn();
const reviewMock = vi.fn();
const guardMock = vi.fn();
const gatewayMock = vi.fn();
const gatewaySendMock = vi.fn();
const extractMock = vi.fn();
const reconcileMock = vi.fn();
const baselineMock = vi.fn();
const saveMock = vi.fn();
const collectMock = vi.fn();
const reuseDeckMock = vi.fn();
const unconfirmedMock = vi.fn();
const outputCurrentMock = vi.fn();
const decksMock = vi.fn();
const debugLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

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
vi.mock('../src/main/ipc/team-meeting-handlers.js', () => ({
  withTeamMeetingTaskDeletion: vi.fn((_taskId: string, remove: () => void) => remove()),
}));
vi.mock('../src/main/workspace/config.js', () => ({
  getWorkspacePath: vi.fn(() => workspacePath),
  readConfig: vi.fn(() => ({ workspacePath, commercial: undefined })),
}));
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: gatewayMock }));
vi.mock('../src/main/docgen/native-task-control.js', () => ({ nativeTaskControl: controlMock }));
vi.mock('../src/main/docgen/native-file.js', () => ({ renderNativePptFile: renderMock }));
vi.mock('../src/main/docgen/native-review.js', () => ({ reviewNativePpt: reviewMock }));
vi.mock('../src/main/docgen/native-review-runtime.js', () => ({ nativeReviewPorts: () => undefined }));
vi.mock('../src/main/docgen/native-dispatch-guard.js', () => ({ requireNativeTestBudget: guardMock }));
vi.mock('../src/main/docgen/generate.js', () => ({
  generateDocumentsFromMessage: vi.fn(async () => ({ saved: [], failed: [] })),
}));
vi.mock('../src/main/htmlgen/generate.js', () => ({
  generateHtmlPagesFromMessage: vi.fn(async () => ({ saved: [], failed: [] })),
}));
vi.mock('../src/main/slidegen/generate.js', () => ({
  generateSlidesFromMessage: vi.fn(async () => ({ saved: [], failed: [], warnings: [] })),
}));
vi.mock('../src/main/slidegen/tool-receipts.js', () => ({
  collectToolSlideReceipts: collectMock,
  reuseToolSlideDeck: reuseDeckMock,
  hasUnconfirmedSlideToolOutput: unconfirmedMock,
  isToolSlideOutputCurrent: outputCurrentMock,
}));
vi.mock('../src/main/slidegen/receipt.js', () => ({ readSlideGenerationReceipt: vi.fn() }));
vi.mock('../src/main/slidegen/deck-file.js', () => ({
  captureDeckFileBaseline: () => ({}),
  changedDeckFiles: () => [],
  decksFromFiles: decksMock,
}));
vi.mock('../src/main/artifact/agent-workspace.js', () => ({
  // 助手目录解析不出来（网关离线/超时）⇒ agentRoot=null ⇒ 收据根回落应用工作区（真实临时目录）。
  resolveAgentWorkspace: vi.fn(async () => undefined),
}));
vi.mock('../src/main/artifact/auto-extract.js', () => ({ autoExtractArtifacts: extractMock }));
vi.mock('../src/main/artifact/save.js', () => ({ saveArtifact: saveMock, saveArtifactFromBuffer: vi.fn() }));
vi.mock('../src/main/artifact/reconcile.js', () => ({
  captureTaskArtifactBaseline: baselineMock,
  reconcileTaskArtifacts: reconcileMock,
}));
vi.mock('../src/main/debug/index.js', () => ({ getDebugLogger: vi.fn(() => debugLogger) }));

const taskId = 'amb-task';
const sessionKey = 'amb-session';
const messageId = 'persisted-assistant';
let workspacePath = '';

function settlements() {
  return sendMock.mock.calls.filter(([channel]) => channel === 'artifact:delivery-settled').map(([, data]) => data);
}

async function waitForSettlement(): Promise<void> {
  await vi.waitFor(() => expect(settlements()).toHaveLength(1));
}

type WriteCall = {
  id: string;
  name: string;
  status: 'done';
  startedAt: string;
  completedAt: string;
  args: { path: string; content: string };
};

function writeCall(id: string, path: string, content: string, completedAt: string): WriteCall {
  return {
    id,
    name: 'write',
    status: 'done',
    startedAt: '2026-10-14T00:00:00.000Z',
    completedAt,
    args: { path, content },
  };
}

/** ⭐ T23 源端半边：一条带**运行时执行记录**（`toolCallId` + 真实起止）的原生渲染 exec。 */
type ExecCall = {
  id: string;
  name: 'exec';
  status: 'done';
  startedAt: string;
  completedAt?: string;
  args: { command: string };
};

function execCall(id: string, file: string, completedAt?: string): ExecCall {
  const base = `node "C:/skills/deck-layout/scripts/generate.cjs" "${file}"`;
  return {
    id,
    name: 'exec',
    status: 'done',
    startedAt: completedAt ?? '',
    ...(completedAt ? { completedAt } : {}),
    args: { command: base },
  };
}

/**
 * ⭐ 2026-10-17 统一审核 §T23②：`cd "<...>/deck-layout" && node scripts/generate.cjs "<file>"`
 * —— 命令里**没有**连续的 `deck-layout/scripts/generate.cjs`，旧判据读不出目标（仍 fail-closed）。
 */
function execCallCd(id: string, file: string, completedAt?: string): ExecCall {
  const base = `cd "C:/skills/deck-layout" && node scripts/generate.cjs "${file}"`;
  return {
    id,
    name: 'exec',
    status: 'done',
    startedAt: completedAt ?? '',
    ...(completedAt ? { completedAt } : {}),
    args: { command: base },
  };
}

/**
 * 两个合法候选：磁盘字节与 write 证据逐字一致，且 mtime **完全相同**（平局）。
 *
 * ⚠️ 必须在 run 创建**之后**才写/打时间戳：`freshness` 判据是 `mtime >= run.createdAt`，
 *    先播种再建 run 会在冷启动（模块首次 import 慢）时把证据判旧 ⇒ 走成"没有候选"的
 *    另一条分支，测的就不是平局了（第一版就是栽在这）。
 */
function seedTiedCandidates(): void {
  writeFileSync(join(workspacePath, 'a.native-ppt.json'), 'A');
  writeFileSync(join(workspacePath, 'b.native-ppt.json'), 'B');
  const stamp = new Date(Date.now() + 1000);
  utimesSync(join(workspacePath, 'a.native-ppt.json'), stamp, stamp);
  utimesSync(join(workspacePath, 'b.native-ppt.json'), stamp, stamp);
}

async function runAmbiguousTurn(tools: Array<WriteCall | ExecCall>): Promise<{ prompt: string }> {
  const { beginArtifactRun, registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
  registerDataHandlers();
  beginArtifactRun(workspacePath, taskId, sessionKey, {
    gatewayId: 'gateway-1',
    userContent: '做一份PPT',
  });
  seedTiedCandidates();
  selectGetMock.mockReturnValueOnce({ id: messageId }).mockReturnValueOnce({ gid: 'gateway-1' });
  handleMap.get('data:create-message')!(
    {},
    {
      id: 'incoming-assistant',
      taskId,
      sessionKey,
      role: 'assistant',
      content: '源文件已写好。',
      timestamp: '2026-10-14T00:00:01.000Z',
      toolCalls: tools,
    },
  );
  await waitForSettlement();
  return { prompt: String(gatewaySendMock.mock.calls.at(-1)?.[1] ?? '') };
}

describe('BUG-058④ · 无可信目标时 mtime 平局必须 fail-closed（真实 reconcile 链）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    if (workspacePath) rmSync(workspacePath, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.resetModules();
    (await import('../src/main/workspace/scope.js')).setWorkspaceDatabaseOwner({});
    workspacePath = mkdtempSync(join(tmpdir(), 'native-amb-'));
    handleMap.clear();
    sendMock.mockReset();
    selectGetMock.mockReset();
    gatewaySendMock.mockReset();
    gatewayMock.mockReset().mockReturnValue({ isConnected: true, sendChatMessage: gatewaySendMock });
    collectMock.mockReset().mockReturnValue({ receipts: [], rejected: 0 });
    reuseDeckMock.mockReset().mockReturnValue([]);
    unconfirmedMock.mockReset().mockReturnValue(false);
    outputCurrentMock.mockReset().mockReturnValue(true);
    decksMock.mockReset().mockReturnValue({ text: '', failures: [] });
    extractMock.mockReset().mockResolvedValue(undefined);
    baselineMock.mockReset().mockResolvedValue({});
    reconcileMock
      .mockReset()
      .mockResolvedValue({ saved: [], existing: [], missing: [], skipped: [], budgetExhausted: false });
    renderMock.mockReset();
    reviewMock.mockReset().mockResolvedValue({ status: 'not-performed' });
    guardMock.mockReset().mockResolvedValue(undefined);
    // 本任务**从未登记过任何产物**（首次生成场景）——正是"兜底分支"最容易盖掉歧义诊断的形状。
    sqliteMock.mockReset().mockReturnValue({ prepare: () => ({ all: () => [] as unknown[] }) });
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    const control = { active_token: '', canceled: 0, last_receipt: null as string | null, auto_count: 0 };
    controlMock.mockReset().mockReturnValue({
      beginUser: (_task: string, token: string) => {
        control.active_token = token;
        control.canceled = 0;
      },
      beginAutomatic: (_task: string, previous: string, token: string) => {
        if (previous !== control.active_token || control.canceled || control.auto_count >= 2) return false;
        control.active_token = token;
        control.auto_count += 1;
        return true;
      },
      get: () => control,
      cancel: (_task: string, token: string) => {
        if (control.active_token === token) control.canceled = 1;
      },
      remember: () => undefined,
    });
  });

  it('⭐ 双候选同 mtime（数组序 A→B）⇒ 不渲染、不猜；模型拿到带候选名与下一步的 native-input-ambiguous', async () => {
    const { prompt } = await runAmbiguousTurn([
      writeCall('w1', 'a.native-ppt.json', 'A', '2026-10-14T00:00:03.000Z'),
      writeCall('w2', 'b.native-ppt.json', 'B', '2026-10-14T00:00:02.000Z'),
    ]);

    // ① 没有任何"挑一个渲染"的尝试（helper 抛歧义 ⇒ 渲染出口根本没被调用）。
    expect(renderMock).not.toHaveBeenCalled();
    // ② 具名歧义到达模型：并列候选 + 可执行的下一步（不是裸码，也不是假成功）。
    expect(prompt).toContain('native-input-ambiguous');
    expect(prompt).toContain('a.native-ppt.json');
    expect(prompt).toContain('b.native-ppt.json');
    expect(prompt).toContain('指定目标文件');
    // ③ 这一轮不许落成"成功"（没登记到 pptx ⇒ failed；任何成功口径都是假成功）。
    expect(settlements().at(-1)?.status).toBe('failed');
  });

  it('⭐ 数组序与收包 completedAt 同时反转 ⇒ 结论不变（同样歧义、同样不渲染）', async () => {
    const { prompt } = await runAmbiguousTurn([
      writeCall('w2', 'b.native-ppt.json', 'B', '2026-10-14T00:00:03.000Z'),
      writeCall('w1', 'a.native-ppt.json', 'A', '2026-10-14T00:00:02.000Z'),
    ]);

    expect(renderMock).not.toHaveBeenCalled();
    expect(prompt).toContain('native-input-ambiguous');
    expect(prompt).toContain('a.native-ppt.json');
    expect(prompt).toContain('b.native-ppt.json');
    expect(settlements().at(-1)?.status).toBe('failed');
  });

  /**
   * ⭐ T23 源端半边（2026-10-16）：**平局有确定出口**。
   *
   * 两条 exec 指名**不同**目标时，产物侧半边（单条指名）无从裁决；这里钉的是
   * **运行时执行记录透传**那条线：run 收尾把 agent `item` 帧的 `toolCallId`/`startedAt`/
   * `endedAt`（落在工具调用上）压成 `execOrder` 交给 helper，取**最后真的跑过**那条 exec
   * 的目标 ⇒ 不再报歧义、也不再 fail-closed。
   */
  it('⭐ 源端身份透传：两条 exec 指名不同目标 + 运行时执行顺序 ⇒ 平局有确定出口（不再歧义）', async () => {
    const { prompt } = await runAmbiguousTurn([
      writeCall('w1', 'a.native-ppt.json', 'A', '2026-10-14T00:00:02.000Z'),
      writeCall('w2', 'b.native-ppt.json', 'B', '2026-10-14T00:00:03.000Z'),
      execCall('x1', 'a.native-ppt.json', '2026-10-14T00:00:04.000Z'),
      execCall('x2', 'b.native-ppt.json', '2026-10-14T00:00:05.000Z'),
    ]);

    // 具名歧义**不再**发给模型（运行时顺序把它裁掉了）。
    expect(prompt).not.toContain('native-input-ambiguous');
    // ⭐ 钉住**赢家**（2026-10-17 统一审核 §T23①）：只断言"不含 ambiguous"是**弱理由** ——
    //    把裁决改成"取最早"（或取另一条 exec 的目标）它照样绿。真正的证据是**最终渲染用的是哪一份**：
    //    生产出口 `renderNativePptFile(source, …)` 的第一个实参就是裁出来的源文件。运行时顺序里
    //    x2（指名 b）最后跑 ⇒ 必须渲染 b，**绝不能**是 a。改裁决（取最早/取数组首）这里立刻变红。
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(renderMock.mock.calls[0]?.[0]).toBe('b.native-ppt.json');
    expect(renderMock.mock.calls[0]?.[0]).not.toBe('a.native-ppt.json');
  });

  /**
   * ⭐ 反例（钉"取最早也变红"）：把**数组序**与**运行时序**都摆成"最早那条 = a"的反面。
   * 数组里 b 的 exec 在前、a 的 exec 在后；运行时刻 **a 最后跑** ⇒ 赢家必须是 a。
   * 任何"取第一条 / 取最早"的实现都会给出 b ⇒ 本用例变红。（见交付报告：临时把 `index > latest.index`
   * 改成 `index < latest.index` 会当场红，跑给我看过。）
   */
  it('⭐ 反例（取最早必红）：运行时 a 最后跑 ⇒ 渲染 a（不是 b，也不是数组序第一条）', async () => {
    const { prompt } = await runAmbiguousTurn([
      writeCall('w1', 'a.native-ppt.json', 'A', '2026-10-14T00:00:02.000Z'),
      writeCall('w2', 'b.native-ppt.json', 'B', '2026-10-14T00:00:03.000Z'),
      // 数组序：b 的 exec 在前，a 的 exec 在后。
      execCall('x2', 'b.native-ppt.json', '2026-10-14T00:00:04.000Z'),
      execCall('x1', 'a.native-ppt.json', '2026-10-14T00:00:05.000Z'),
    ]);

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(renderMock.mock.calls[0]?.[0]).toBe('a.native-ppt.json');
    expect(prompt).not.toContain('native-input-ambiguous');
  });

  /**
   * ⭐ 2026-10-17 统一审核 §T23②（生产路径）：模型 `cd "<...>/deck-layout"` 再 `node
   * scripts/generate.cjs` 时，命令里没有连续的 `deck-layout/scripts/generate.cjs` ⇒ 旧判据
   * 读不出目标、仍 fail-closed。补上"cd + 相对调用"识别后，这条**本该有的出口**要用得上：
   * 单条 cd 形态的 exec 指名 b ⇒ 渲染 b，不再歧义。
   */
  it('⭐ cd + 相对调用形态：单条这类 exec 指名 b ⇒ 渲染 b（旧判据读不出、仍 fail-closed）', async () => {
    const { prompt } = await runAmbiguousTurn([
      writeCall('w1', 'a.native-ppt.json', 'A', '2026-10-14T00:00:02.000Z'),
      writeCall('w2', 'b.native-ppt.json', 'B', '2026-10-14T00:00:03.000Z'),
      execCallCd('x1', 'b.native-ppt.json', '2026-10-14T00:00:04.000Z'),
    ]);

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(renderMock.mock.calls[0]?.[0]).toBe('b.native-ppt.json');
    expect(prompt).not.toContain('native-input-ambiguous');
  });

  it('⭐ 反例（不放松 fail-closed）：cd 的目录**不是** deck-layout ⇒ 读不出目标 ⇒ 仍具名歧义、不渲染', async () => {
    const { prompt } = await runAmbiguousTurn([
      writeCall('w1', 'a.native-ppt.json', 'A', '2026-10-14T00:00:02.000Z'),
      writeCall('w2', 'b.native-ppt.json', 'B', '2026-10-14T00:00:03.000Z'),
      {
        id: 'x1',
        name: 'exec',
        status: 'done',
        startedAt: '2026-10-14T00:00:04.000Z',
        completedAt: '2026-10-14T00:00:04.000Z',
        args: { command: 'cd "C:/skills/other-dir" && node scripts/generate.cjs "b.native-ppt.json"' },
      },
    ]);

    expect(renderMock).not.toHaveBeenCalled();
    expect(prompt).toContain('native-input-ambiguous');
    expect(settlements().at(-1)?.status).toBe('failed');
  });

  /**
   * ⭐ 反例（无身份必须不选）：同样的两条 exec，但**没有运行时记录**（`startedAt` 空、
   * 无 `completedAt`）⇒ `execOrder` 为空 ⇒ 与从前一字不差地保持具名歧义、不渲染、不猜。
   */
  it('⭐ 反例：同一组 exec 但缺运行时时间戳 ⇒ 无执行顺序 ⇒ 仍 fail-closed 具名歧义', async () => {
    const { prompt } = await runAmbiguousTurn([
      writeCall('w1', 'a.native-ppt.json', 'A', '2026-10-14T00:00:02.000Z'),
      writeCall('w2', 'b.native-ppt.json', 'B', '2026-10-14T00:00:03.000Z'),
      execCall('x1', 'a.native-ppt.json'),
      execCall('x2', 'b.native-ppt.json'),
    ]);

    expect(renderMock).not.toHaveBeenCalled();
    expect(prompt).toContain('native-input-ambiguous');
    expect(settlements().at(-1)?.status).toBe('failed');
  });

  /**
   * ⭐ 负对照（给"歧义诊断不许被覆盖"这条修复上保险）：**没有任何候选**（模型这轮根本没写出
   * 能通过 sha/freshness 的 .native-ppt.json）时，`native-current-write-required` 照旧发出 ——
   * 修复只保护"上游已具名的诊断"，不许把这条本来就该说的诊断一并吞掉。
   */
  it('⭐ 负对照：没有任何候选（无本轮写入）⇒ 裸码 native-current-write-required 照旧发出', async () => {
    const { prompt } = await runAmbiguousTurn([
      // 盘上没有对应文件 ⇒ helper 返回 undefined（不是歧义）⇒ 兜底诊断原样。
      writeCall('w1', 'missing.native-ppt.json', 'X', '2026-10-14T00:00:03.000Z'),
    ]);

    expect(renderMock).not.toHaveBeenCalled();
    expect(prompt).toContain('native-current-write-required');
    expect(prompt).not.toContain('native-input-ambiguous');
    expect(settlements().at(-1)?.status).toBe('failed');
  });
});
