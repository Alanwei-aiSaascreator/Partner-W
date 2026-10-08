import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAnalyticsReporter,
  initAnalyticsReporterForTest,
  stopAnalyticsReporter,
  type AnalyticsReporter,
} from '../src/main/analytics/reporter.js';
// ⚠️ 这两个常量与那个错误类都从**真模块**取，不走 `artifact/access.js` 的 mock ——
//    mock 只替掉"怎么读文件"，不该连带替掉"上限是多少"这个被测对象。
//    （它们所在的那个模块不 import electron，所以可以静态 import；换成从
//     `ipc/artifact-handlers.js` 取会撞上本文件 mock 工厂的 TDZ。）
import {
  ArtifactTooLargeError,
  MAX_PLAIN_BINARY_SOURCE_BYTES,
  MAX_PLAIN_TEXT_SOURCE_BYTES,
} from '../src/main/artifact/too-large.js';
import { resolve } from 'node:path';
import JSZip from 'jszip';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();
const allMock = vi.fn();
const whereMock = vi.fn(() => ({ all: allMock }));
const fromMock = vi.fn(() => ({ where: whereMock, all: allMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));
const getDbMock = vi.fn(() => ({ select: selectMock }));
const autoExtractArtifactsMock = vi.fn();
const getArtifactAvailabilityMock = vi.fn(() => 'available');
const showSaveDialogMock = vi.fn();
const copyArtifactToDestinationMock = vi.fn();
const inspectArtifactFileMock = vi.fn();
const readVerifiedArtifactFileMock = vi.fn();
const openPathMock = vi.fn();
const showItemInFolderMock = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleMap.set(channel, handler);
    }),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showSaveDialog: showSaveDialogMock },
  shell: { openPath: openPathMock, showItemInFolder: showItemInFolderMock },
}));

vi.mock('../src/main/db/index.js', () => ({
  getDb: getDbMock,
  getSqlite: vi.fn(() => null),
}));

/**
 * 网关客户端。**必须 mock**：真实的那个会拉进整个 `gateway-client.ts`（`ws` + electron），
 * 而这一组用例只关心"助手工作区解析成什么"，不关心 RPC 怎么发。
 */
const getGatewayClientMock = vi.fn((): unknown => null);
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: getGatewayClientMock }));

vi.mock('../src/main/workspace/config.js', () => ({
  getWorkspacePath: vi.fn(() => '/workspace'),
}));

vi.mock('../src/main/artifact/save.js', () => ({
  saveArtifact: vi.fn(),
  saveArtifactFromBuffer: vi.fn(),
}));

vi.mock('../src/main/artifact/auto-extract.js', () => ({
  autoExtractArtifacts: autoExtractArtifactsMock,
}));

vi.mock('../src/main/artifact/reconcile.js', () => ({
  getArtifactAvailability: getArtifactAvailabilityMock,
}));

vi.mock('../src/main/artifact/access.js', () => ({
  copyArtifactToDestination: copyArtifactToDestinationMock,
  inspectArtifactFile: inspectArtifactFileMock,
  readVerifiedArtifactFile: readVerifiedArtifactFileMock,
}));

vi.mock('../src/main/net/safe-fetch.js', () => ({
  safeFetch: vi.fn(),
}));

// ⚠️ 必须 mock：本文件静态 import 了 `analytics/reporter.js`，它会拉 `debug/index.js → electron`，
//    而本文件的 electron mock 工厂引用了未 hoist 的 const（showSaveDialogMock 等）⇒ 导入期 TDZ。
//    切断 debug 这条链就够了（handler 本身不用它，reporter 只在告警时用）。
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let analytics: AnalyticsReporter;

/** 最小合法 PPTX / PDF（打开前复核要读真字节判完整性）。 */
async function minimalPptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation/>');
  zip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld/>');
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
}

/** 最小合法 DOCX（BUG-042-b 用：文件是好的，只是系统里没有程序能打开它）。 */
async function minimalDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document/>');
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
}

describe('artifact handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleMap.clear();
    // 埋点走真的 reporter 单例（同 context-handlers.test.ts 的写法）
    analytics = createAnalyticsReporter({
      storage: { read: () => null, write: () => {} },
      send: vi.fn(async () => ({ ok: true, inserted: 0 })),
    });
    initAnalyticsReporterForTest(analytics);
  });

  afterEach(() => {
    stopAnalyticsReporter();
  });

  it('lists artifacts without triggering auto-extract side effects', async () => {
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    allMock.mockReturnValue([
      {
        id: 'a1',
        taskId: 'task-1',
        messageId: 'msg-1',
        type: 'image',
        name: 'image-1---abc-11111111.png',
        localPath: 'task-1/image-1---abc-11111111.png',
        mimeType: 'image/png',
        size: 10,
        createdAt: '2026-03-16T00:00:00.000Z',
      },
      {
        id: 'a2',
        taskId: 'task-1',
        messageId: 'msg-1',
        type: 'image',
        name: 'image-1---abc-22222222.png',
        localPath: 'task-1/image-1---abc-22222222.png',
        mimeType: 'image/png',
        size: 10,
        createdAt: '2026-03-16T00:00:01.000Z',
      },
    ]);

    const listArtifacts = handleMap.get('artifact:list');
    expect(listArtifacts).toBeTypeOf('function');

    await expect(listArtifacts?.({}, { taskId: 'task-1' })).resolves.toEqual({
      ok: true,
      result: [
        expect.objectContaining({ id: 'a1', availability: 'available' }),
        expect.objectContaining({
          id: 'a2',
          availability: 'available',
          filePath: resolve('/workspace', 'task-1/image-1---abc-22222222.png'),
        }),
      ],
    });
    expect(getArtifactAvailabilityMock).toHaveBeenCalledTimes(2);
    expect(autoExtractArtifactsMock).not.toHaveBeenCalled();
  });

  it('returns an explicit cancelled result without copying', async () => {
    allMock.mockReturnValue([
      {
        id: 'a1',
        taskId: 'task-1',
        name: 'report.txt',
        localPath: 'task-1/report.txt',
      },
    ]);
    showSaveDialogMock.mockResolvedValue({ canceled: true });
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    await expect(handleMap.get('artifact:save-as')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
      ok: true,
      result: { status: 'cancelled' },
    });
    expect(copyArtifactToDestinationMock).not.toHaveBeenCalled();
  });

  it('copies the database-owned artifact selected by id', async () => {
    allMock.mockReturnValue([
      {
        id: 'a1',
        taskId: 'task-1',
        name: 'report.txt',
        localPath: 'task-1/report.txt',
      },
    ]);
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:\\Exports\\report.txt' });
    copyArtifactToDestinationMock.mockResolvedValue({ status: 'saved', filePath: 'C:\\Exports\\report.txt' });
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    await expect(handleMap.get('artifact:save-as')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
      ok: true,
      result: { status: 'saved', filePath: 'C:\\Exports\\report.txt' },
    });
    expect(copyArtifactToDestinationMock).toHaveBeenCalledWith(
      '/workspace',
      'task-1/report.txt',
      'C:\\Exports\\report.txt',
    );
  });

  it('rejects a mismatched task before opening or revealing an artifact', async () => {
    allMock.mockReturnValue([{ id: 'a1', taskId: 'task-2', name: 'report.txt', localPath: 'task-2/report.txt' }]);
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    await expect(handleMap.get('artifact:open-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
      ok: false,
      error: 'artifact not found',
    });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('refuses missing or unsafe artifacts before opening them', async () => {
    allMock.mockReturnValue([{ id: 'a1', taskId: 'task-1', name: 'report.txt', localPath: 'task-1/report.txt' }]);
    inspectArtifactFileMock.mockResolvedValue({ availability: 'unsafe' });
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    await expect(handleMap.get('artifact:open-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
      ok: false,
      error: 'artifact unsafe',
    });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('reads artifact bytes through the verified handle helper instead of a checked path', async () => {
    allMock.mockReturnValue([{ id: 'a1', taskId: 'task-1', name: 'report.txt', localPath: 'task-1/report.txt' }]);
    readVerifiedArtifactFileMock.mockResolvedValue(Buffer.from('trusted'));
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    await expect(handleMap.get('artifact:read-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
      ok: true,
      result: { content: 'trusted', encoding: 'utf-8' },
    });
    // ⭐ 现在必须**带着上限**读：这条路的内容会整份进 `hljs.highlight`（同步），
    //    没有上限就是"文件一大界面就卡死"。上限值本身由下面两条钉。
    expect(readVerifiedArtifactFileMock).toHaveBeenCalledWith('/workspace', 'task-1/report.txt', {
      maxBytes: MAX_PLAIN_TEXT_SOURCE_BYTES,
    });
  });

  /**
   * 文本读法的上限（2026-09-27）。
   *
   * 这个缺口原来长这样：`.html` 超过 4 MiB ⇒ 富预览回 `unsupported` ⇒ 界面掉到
   * `artifact:read-file` ⇒ **那条路没有 `maxBytes`** ⇒ 几十兆整份读成字符串、
   * 跨 IPC、再整份进同步高亮。于是"太大所以不给富预览"变成了"太大所以卡死"。
   *
   * 判据两条（正反各一）：
   *  1. 正常大小 ⇒ 照旧给内容（不许把这条路整个掐掉）；
   *  2. 超限 ⇒ 回 `{ tooLarge, size }` 这个**结构化**结果，且**一个字节的内容都不给**
   *     —— 那正是"不整份进高亮链"在协议层的样子。
   */
  describe('artifact:read-file 的上限', () => {
    const htmlArtifact = [{ id: 'a1', taskId: 'task-1', name: '大页面.html', localPath: 'task-1/大页面.html' }];

    it('⭐ 上限是**分档**的：文本 4 MiB、二进制松十倍（照片不能卡在 4 MiB）', () => {
      expect(MAX_PLAIN_TEXT_SOURCE_BYTES).toBe(4 * 1024 * 1024);
      expect(MAX_PLAIN_BINARY_SOURCE_BYTES).toBe(40 * 1024 * 1024);
      expect(MAX_PLAIN_BINARY_SOURCE_BYTES).toBeGreaterThan(MAX_PLAIN_TEXT_SOURCE_BYTES);
    });

    it('正：没超限 ⇒ 照旧给内容（这条路不许被上限整个掐死）', async () => {
      allMock.mockReturnValue(htmlArtifact);
      readVerifiedArtifactFileMock.mockResolvedValue(Buffer.from('<p>小页面</p>'));
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(handleMap.get('artifact:read-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
        ok: true,
        result: { content: '<p>小页面</p>', encoding: 'utf-8' },
      });
    });

    it('反：超限 ⇒ `{ tooLarge, size }`，**没有 `content`**（不整份进高亮链）', async () => {
      allMock.mockReturnValue(htmlArtifact);
      readVerifiedArtifactFileMock.mockRejectedValue(new ArtifactTooLargeError(30 * 1024 * 1024));
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      const result = (await handleMap.get('artifact:read-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })) as {
        ok: boolean;
        result?: Record<string, unknown>;
      };

      // ⚠️ 不是 `ok: false`：文件是好的，是我们不肯搬 —— 界面要说另一句话。
      expect(result.ok).toBe(true);
      expect(result.result).toEqual({ tooLarge: true, size: 30 * 1024 * 1024 });
      // 载荷里**不许**出现内容：出现即等于说"我们读出来了"
      expect(result.result).not.toHaveProperty('content');
      expect(JSON.stringify(result)).not.toContain('大页面');
    });

    it('⭐ 非超限的错误照旧如实报错（别把"文件坏了"也吞成"太大"）', async () => {
      allMock.mockReturnValue(htmlArtifact);
      readVerifiedArtifactFileMock.mockRejectedValue(new Error('artifact unsafe'));
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(handleMap.get('artifact:read-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
        ok: false,
        error: 'artifact unsafe',
      });
    });

    it('二进制（图片）走的是那条松的上限', async () => {
      allMock.mockReturnValue([{ id: 'a1', taskId: 'task-1', name: '照片.png', localPath: 'task-1/照片.png' }]);
      readVerifiedArtifactFileMock.mockResolvedValue(Buffer.from('png'));
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await handleMap.get('artifact:read-file')?.({}, { artifactId: 'a1', taskId: 'task-1' });

      expect(readVerifiedArtifactFileMock).toHaveBeenCalledWith('/workspace', 'task-1/照片.png', {
        maxBytes: MAX_PLAIN_BINARY_SOURCE_BYTES,
      });
    });
  });

  it('revalidates identity immediately before passing a path to the shell', async () => {
    allMock.mockReturnValue([{ id: 'a1', taskId: 'task-1', name: 'report.txt', localPath: 'task-1/report.txt' }]);
    inspectArtifactFileMock
      .mockResolvedValueOnce({ availability: 'available', absolutePath: '/workspace/task-1/report.txt' })
      .mockResolvedValueOnce({ availability: 'unsafe' });
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    await expect(handleMap.get('artifact:open-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
      ok: false,
      error: 'artifact unsafe',
    });
    expect(inspectArtifactFileMock).toHaveBeenCalledTimes(2);
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('★ 另存为成功记一次 artifact_saved；取消对话框不记', async () => {
    allMock.mockReturnValue([{ id: 'a1', taskId: 'task-1', name: 'report.txt', localPath: 'task-1/report.txt' }]);
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:\\Exports\\report.txt' });
    copyArtifactToDestinationMock.mockResolvedValue({ status: 'saved', filePath: 'C:\\Exports\\report.txt' });
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    await handleMap.get('artifact:save-as')?.({}, { artifactId: 'a1', taskId: 'task-1' });
    expect(analytics.peek().map((e) => e.event)).toEqual(['artifact_saved']);

    // 取消也返回 ok:true（与 context:import-files 同一个坑）——「打开又关掉」不算保存
    showSaveDialogMock.mockResolvedValue({ canceled: true });
    await handleMap.get('artifact:save-as')?.({}, { artifactId: 'a1', taskId: 'task-1' });
    expect(analytics.peek().map((e) => e.event)).toEqual(['artifact_saved']);
  });

  it('★ 聊天里保存代码块 / 保存图片也记 artifact_saved（用户真实的保存入口）', async () => {
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    await handleMap.get('artifact:save-content')?.(
      {},
      { taskId: 'task-1', messageId: 'm1', content: 'const a = 1;', language: 'ts' },
    );
    expect(analytics.peek().map((e) => e.event)).toEqual(['artifact_saved']);

    const { safeFetch } = await import('../src/main/net/safe-fetch.js');
    vi.mocked(safeFetch).mockResolvedValue(Buffer.from('img'));
    await handleMap.get('artifact:save-image-url')?.(
      {},
      { taskId: 'task-1', messageId: 'm1', url: 'https://x.test/a.png' },
    );
    expect(analytics.peek().map((e) => e.event)).toEqual(['artifact_saved', 'artifact_saved']);
  });

  /**
   * ⭐ **第二个根的读面**（2026-09-27）。
   *
   * 现场：助手用 exec 在它自己的工作区里生成 pptx / html，产物面板却是空的
   * （真机 `.clawwork.db` 实测 `COUNT(*) = 0`）。
   *
   * 「扫到并登记」只是前半程 —— 读面（打开 / 跳转 / 预览 / 另存为）也必须按
   * **它自己的根**解析。否则那一行的 availability 会被算成 `unsafe`，
   * 而 `ArtifactCard` 是**三个按钮全部**看 availability ⇒ 卡片在手但一个都点不动。
   */
  it('⭐ root:agent 的产物按**助手工作区**解析，不是应用工作区', async () => {
    allMock
      // ① loadArtifactForAction 取到的那一行 —— root 是 agent
      .mockReturnValueOnce([
        { id: 'agent-1', taskId: 'task-1', name: 'deck.pptx', localPath: 'deck.pptx', root: 'agent' },
      ])
      // ② agentWorkspaceForTask 查任务拿 gatewayId + sessionKey
      .mockReturnValueOnce([{ gatewayId: 'gw-1', sessionKey: 'agent:main:clawwork:task-1' }]);
    getGatewayClientMock.mockReturnValueOnce({
      listAgentFiles: async () => ({ agentId: 'main', workspace: '/agent-ws', files: [] }),
    });
    inspectArtifactFileMock.mockResolvedValue({
      availability: 'available',
      absolutePath: '/agent-ws/deck.pptx',
    });
    readVerifiedArtifactFileMock.mockResolvedValue(Buffer.from(await minimalPptx()));

    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();
    await handleMap.get('artifact:open-file')?.({}, { artifactId: 'agent-1' });

    // ⭐ 判据是**根**：必须拿 /agent-ws 去解析，而不是 /workspace
    expect(inspectArtifactFileMock).toHaveBeenCalledWith('/agent-ws', 'deck.pptx');
  });

  it('root 缺省（老行）⇒ 仍然按应用工作区解析 —— 老行为一字不改', async () => {
    allMock.mockReturnValueOnce([
      { id: 'old-1', taskId: 'task-1', name: 'report.pdf', localPath: 'task-1/report.pdf' },
    ]);
    inspectArtifactFileMock.mockResolvedValue({
      availability: 'available',
      absolutePath: '/workspace/task-1/report.pdf',
    });
    readVerifiedArtifactFileMock.mockResolvedValue(Buffer.from('%PDF-1.7\n%%EOF\n'));

    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();
    await handleMap.get('artifact:open-file')?.({}, { artifactId: 'old-1' });

    expect(inspectArtifactFileMock).toHaveBeenCalledWith('/workspace', 'task-1/report.pdf');
    // 老行**不该**去问助手工作区（一次网关调用都不发）
    expect(getGatewayClientMock).not.toHaveBeenCalled();
  });

  /**
   * ⭐ 2026-10-07 体检 P2-6：**打开前复核**。
   *
   * 登记门只覆盖"新变更"那两条路径；已登记、此后没再被动过的坏件（写坏/崩溃半截/外部改坏）
   * 会永远留在列表里，而 `shell.openPath` 这条路以前**不复核** —— "能点开但打不开"就在这儿回归。
   */
  describe('artifact:open-file 打开前复核', () => {
    const deck = [{ id: 'a1', taskId: 'task-1', name: 'deck.pptx', localPath: 'task-1/deck.pptx' }];

    it('⭐ 受检格式字节是坏的 ⇒ 拒绝并回 `artifact invalid`（不回落到"让它打开试试"）', async () => {
      allMock.mockReturnValue(deck);
      inspectArtifactFileMock.mockResolvedValue({
        availability: 'available',
        absolutePath: '/workspace/task-1/deck.pptx',
      });
      readVerifiedArtifactFileMock.mockResolvedValue(Buffer.from('PK broken, not a zip'));
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(handleMap.get('artifact:open-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
        ok: false,
        error: 'artifact invalid',
      });
      expect(openPathMock).not.toHaveBeenCalled();
    });

    it('受检格式字节是好的 ⇒ 照常交给系统打开', async () => {
      allMock.mockReturnValue(deck);
      inspectArtifactFileMock.mockResolvedValue({
        availability: 'available',
        absolutePath: '/workspace/task-1/deck.pptx',
      });
      readVerifiedArtifactFileMock.mockResolvedValue(Buffer.from(await minimalPptx()));
      openPathMock.mockResolvedValue('');
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(handleMap.get('artifact:open-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
        ok: true,
      });
      expect(openPathMock).toHaveBeenCalledWith('/workspace/task-1/deck.pptx');
    });

    it('不受检的扩展名（.txt）⇒ 一个字节都不读（不把这条门变成所有文件的读门）', async () => {
      allMock.mockReturnValue([{ id: 'a1', taskId: 'task-1', name: 'report.txt', localPath: 'task-1/report.txt' }]);
      inspectArtifactFileMock.mockResolvedValue({
        availability: 'available',
        absolutePath: '/workspace/task-1/report.txt',
      });
      openPathMock.mockResolvedValue('');
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await handleMap.get('artifact:open-file')?.({}, { artifactId: 'a1', taskId: 'task-1' });

      expect(readVerifiedArtifactFileMock).not.toHaveBeenCalled();
      expect(openPathMock).toHaveBeenCalled();
    });
  });

  /**
   * ⭐⭐ BUG-042-b（2026-10-08 亲验）：**打开失败的原因说错话**。
   *
   * 机器里没装 Word/WPS 时 `shell.openPath` 回的是系统错误串，界面却统一说
   * 「文件可能已损坏或未写完」—— 文件明明是好的，用户会白白重做一遍。
   * 判据：**没有可打开它的程序**（系统的 "No application…" / "Failed to open…" 族）
   * ⇒ 回稳定的机器可读标记 `artifact no-opener`（界面据此说"装个程序再试"）；
   * 只有"打开前复核"判坏件的 `artifact invalid` 才是"损坏"。
   * 认不出的系统错误**原样回**（不发明结论）。
   */
  describe('artifact:open-file 打开失败分类（BUG-042-b）', () => {
    const doc = [{ id: 'a1', taskId: 'task-1', name: '报告.docx', localPath: 'task-1/报告.docx' }];

    beforeEach(async () => {
      allMock.mockReturnValue(doc);
      inspectArtifactFileMock.mockResolvedValue({
        availability: 'available',
        absolutePath: '/workspace/task-1/报告.docx',
      });
      readVerifiedArtifactFileMock.mockResolvedValue(await minimalDocx());
    });

    it.each([
      'No application is associated with the specified file for this operation.',
      'Failed to open document',
      'This file does not have a program associated with it for performing this action. Please install a program or, if one is already installed, create an association in the Default Programs control panel.',
    ])('⭐ 没有可打开它的程序 ⇒ 稳定标记 `artifact no-opener`：%s', async (systemMessage) => {
      openPathMock.mockResolvedValue(systemMessage);
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(handleMap.get('artifact:open-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
        ok: false,
        error: 'artifact no-opener',
      });
    });

    it('⭐ 认不出的系统错误 ⇒ 原样回（不许冒充任何一类结论）', async () => {
      openPathMock.mockResolvedValue('Access is denied.');
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(handleMap.get('artifact:open-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
        ok: false,
        error: 'Access is denied.',
      });
    });

    it('⭐ 负对照：坏件复核不过 ⇒ 仍是 `artifact invalid`（不许被分类成 no-opener）', async () => {
      readVerifiedArtifactFileMock.mockResolvedValue(Buffer.from('不是 zip 的文本'));
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(handleMap.get('artifact:open-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
        ok: false,
        error: 'artifact invalid',
      });
      expect(openPathMock).not.toHaveBeenCalled();
    });
  });

  /**
   * ⭐ 2026-10-07 体检 P2-3：根解析不出来是 **`unknown`（连接中）**，不是 `missing`（缺失）。
   *
   * 助手工作区依赖网关 RPC；冷启动那几十秒里它是真的"读不到"，而旧口径把这一瞬说成
   * "文件缺失"并让整族折进折叠区（渲染层）。IPC 层必须先把这两件事分开。
   */
  it('⭐ 助手工作区解析不出来（网关没连上）⇒ availability = unknown，不是 missing', async () => {
    allMock.mockReturnValue([
      { id: 'agent-1', taskId: 'task-1', name: 'deck.pptx', localPath: 'deck.pptx', root: 'agent' },
    ]);
    // getGatewayClient 默认 null ⇒ agentWorkspaceForTask 拿不到工作区
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    const result = (await handleMap.get('artifact:list')?.({}, { taskId: 'task-1' })) as {
      ok: boolean;
      result: Array<{ availability: string }>;
    };

    expect(result.result[0].availability).toBe('unknown');
    expect(getArtifactAvailabilityMock, '根解析不出来时不许去判"文件在不在"').not.toHaveBeenCalled();
  });
});
