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
import { join } from 'node:path';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
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
  it('imagegen same-length corrupt files are unsafe in list/get and cannot open; unrelated PNG keeps existing behavior', async () => {
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();
    allMock.mockReturnValue([
      {
        id: 'imagegen-id',
        taskId: 'task-1',
        messageId: 'old-message',
        name: 'generated.png',
        localPath: 'task-1/generated.png',
        sourceKey: 'imagegen:operation:spec',
        size: 45,
      },
    ]);
    getArtifactAvailabilityMock.mockReturnValue('available');
    readVerifiedArtifactFileMock.mockResolvedValue(Buffer.alloc(45, 120));
    await expect(handleMap.get('artifact:list')?.({}, { taskId: 'task-1' })).resolves.toMatchObject({
      ok: true,
      result: [{ id: 'imagegen-id', availability: 'unsafe' }],
    });
    await expect(handleMap.get('artifact:get')?.({}, { id: 'imagegen-id' })).resolves.toMatchObject({
      ok: true,
      result: { availability: 'unsafe' },
    });
    await expect(
      handleMap.get('artifact:open-file')?.({}, { artifactId: 'imagegen-id', taskId: 'task-1' }),
    ).resolves.toMatchObject({ ok: false });
    expect(openPathMock).not.toHaveBeenCalled();
    readVerifiedArtifactFileMock.mockClear();
    allMock.mockReturnValue([
      {
        id: 'ordinary',
        taskId: 'task-1',
        name: 'photo.png',
        localPath: 'task-1/photo.png',
        sourceKey: 'download',
        size: 45,
      },
    ]);
    await expect(handleMap.get('artifact:list')?.({}, { taskId: 'task-1' })).resolves.toMatchObject({
      ok: true,
      result: [{ availability: 'available' }],
    });
    expect(readVerifiedArtifactFileMock).not.toHaveBeenCalled();
  });

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

  /**
   * ⭐ D5「另存」与「打开」必须同一套 M1 判据（2026-10-15 F owner）。
   *
   * 打开那条路（`artifact:open-file`）登记后**复核字节**：受检格式（pptx/docx/xlsx/pdf/mp4）
   * 与 imagegen PNG 若在登记之后被写坏 / 半截 / 外部改坏，点开一律拒（图14/16 同族）。
   * 但**另存**原来只 `copyArtifactToDestination` 直拷，判据缺一档 ⇒ 同一份坏件
   * 「打不开却能导出成保存成功」= 失败条目伪装可下载。这里把两条路钉成同一判据。
   */
  describe('artifact:save-as 另存前复核（与打开同一条判据）', () => {
    const deck = [{ id: 'a1', taskId: 'task-1', name: 'deck.pptx', localPath: 'task-1/deck.pptx' }];

    it('⭐ 受检格式字节是坏的（登记后被写坏/半截）⇒ 拒绝另存，绝不导出一份打不开的文件', async () => {
      allMock.mockReturnValue(deck);
      inspectArtifactFileMock.mockResolvedValue({
        availability: 'available',
        absolutePath: '/workspace/task-1/deck.pptx',
      });
      readVerifiedArtifactFileMock.mockResolvedValue(Buffer.from('PK broken, not a zip'));
      showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:\\Exports\\deck.pptx' });
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(handleMap.get('artifact:save-as')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
        ok: false,
        error: 'artifact invalid',
      });
      expect(copyArtifactToDestinationMock).not.toHaveBeenCalled();
    });

    it('受检格式字节是好的 ⇒ 照常另存（不把这条门变成所有文件的拒绝）', async () => {
      allMock.mockReturnValue(deck);
      inspectArtifactFileMock.mockResolvedValue({
        availability: 'available',
        absolutePath: '/workspace/task-1/deck.pptx',
      });
      readVerifiedArtifactFileMock.mockResolvedValue(Buffer.from(await minimalPptx()));
      showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:\\Exports\\deck.pptx' });
      copyArtifactToDestinationMock.mockResolvedValue({ status: 'saved', filePath: 'C:\\Exports\\deck.pptx' });
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(
        handleMap.get('artifact:save-as')?.({}, { artifactId: 'a1', taskId: 'task-1' }),
      ).resolves.toMatchObject({ ok: true });
      expect(copyArtifactToDestinationMock).toHaveBeenCalled();
    });

    it('负对照：不受检的扩展名（.txt）⇒ 一个字节都不读（不把这条门扩成所有文件的读门）', async () => {
      allMock.mockReturnValue([{ id: 'a1', taskId: 'task-1', name: 'report.txt', localPath: 'task-1/report.txt' }]);
      showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:\\Exports\\report.txt' });
      copyArtifactToDestinationMock.mockResolvedValue({ status: 'saved', filePath: 'C:\\Exports\\report.txt' });
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await handleMap.get('artifact:save-as')?.({}, { artifactId: 'a1', taskId: 'task-1' });
      expect(readVerifiedArtifactFileMock).not.toHaveBeenCalled();
      expect(copyArtifactToDestinationMock).toHaveBeenCalled();
    });

    /**
     * ⭐ D5（2026-10-16 审计反例 SAVE_RACE）：**导出的必须是校验过的那份字节**。
     *
     * 校验与导出若各读一次盘，两次之间源文件被编辑器截断 ⇒ 导出一份打不开的坏件却回
     * `saved`（审计实测 `originalValid=true → ok=true,status=saved → exportedValid=false`，
     * 导出 60B）。这里把"复制器的源"钉成**校验时那份字节的快照**：源文件此后怎么变都不影响。
     */
    it('⭐ D5：弹框之后才去读源文件等于导出未校验的字节 ⇒ 复制源必须是校验过的那份快照', async () => {
      allMock.mockReturnValue(deck);
      const checked = Buffer.from(await minimalPptx());
      readVerifiedArtifactFileMock.mockResolvedValue(checked);
      showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:\\Exports\\deck.pptx' });
      let stagedRoot = '';
      let stagedLocal = '';
      let stagedBytes: Buffer | undefined;
      copyArtifactToDestinationMock.mockImplementation(async (root: string, localPath: string) => {
        stagedRoot = root;
        stagedLocal = localPath;
        stagedBytes = readFileSync(join(root, localPath));
        return { status: 'saved', filePath: 'C:\\Exports\\deck.pptx' };
      });
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(
        handleMap.get('artifact:save-as')?.({}, { artifactId: 'a1', taskId: 'task-1' }),
      ).resolves.toMatchObject({ ok: true, result: { status: 'saved' } });
      // 复制器读的是**校验时抓到的字节**（快照落在 tmpdir，与 `artifact:save` 的受信前缀同档）
      expect(stagedRoot).toBe(realpathSync(tmpdir()));
      expect(stagedBytes?.equals(checked)).toBe(true);
      // 快照用完即删（不许在临时目录里留产物）
      expect(existsSync(join(stagedRoot, stagedLocal))).toBe(false);
    });

    it('⭐ D5 负对照：另存**到源文件自己**仍拒绝（快照换掉源身份后按路径等价补判）', async () => {
      allMock.mockReturnValue(deck);
      copyArtifactToDestinationMock.mockReset();
      readVerifiedArtifactFileMock.mockResolvedValue(Buffer.from(await minimalPptx()));
      showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: resolve('/workspace', 'task-1/deck.pptx') });
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(handleMap.get('artifact:save-as')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
        ok: false,
        error: 'destination matches source',
      });
      expect(copyArtifactToDestinationMock).not.toHaveBeenCalled();
    });

    /**
     * ⭐ BUG-090 残余（2026-10-16 r14 独立终审）：**"另存到了源文件自己"要按真实文件身份判**。
     *
     * D5 的快照路把"源"换成了 tmpdir 里的暂存件（另一个 inode），于是"同一文件"只剩
     * `resolve()` **字符串等价**一条判据 —— 而它在 Windows 上**大小写敏感**：
     * `report.docx` 与 `REPORT.DOCX` 是**同一个文件**（同 dev/ino）却被放行 ⇒ 保存框停留
     * 期间用户在编辑器里新写的那份字节，被 395B 的旧快照覆盖回去，还回 `saved`
     * （审计实测 `keptEdit=false / revertedToSnapshot=true`）。
     * 旧 `copyArtifactToDestination` 的 dev/ino 判据对**同一身份**是拒绝的 —— 这道保护
     * 不许因为"另存必须先校验"而丢掉。这里用**真实文件**钉住它。
     *
     * ⚠️ 别名的造法与平台无关、形状相同（不同路径字符串 / 同一个 inode）：
     *    Windows 用大小写翻转（同一目录项），其他平台用硬链接。两边都是"同身份、异路径"。
     */
    it('⭐ BUG-090 残余：路径别名（同一文件身份）⇒ 拒绝，绝不拿旧快照覆盖用户新编辑', async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-alias-')));
      const sourcePath = join(root, 'report.docx');
      const original = Buffer.from(await minimalDocx());
      writeFileSync(sourcePath, original);
      const aliasPath = join(root, 'REPORT.DOCX');
      if (process.platform === 'win32') {
        // Windows/NTFS 大小写不敏感 ⇒ 上面那个拼写**已经**是同一个文件
      } else {
        linkSync(sourcePath, aliasPath); // 硬链接：异路径、同 dev/ino
      }
      expect(statSync(aliasPath, { bigint: true }).ino).toBe(statSync(sourcePath, { bigint: true }).ino);

      const { getWorkspacePath } = await import('../src/main/workspace/config.js');
      const previousWorkspace = vi.mocked(getWorkspacePath).getMockImplementation() ?? (() => '/workspace');
      vi.mocked(getWorkspacePath).mockReturnValue(root);
      try {
        allMock.mockReturnValue([
          { id: 'a1', taskId: 'task-1', name: 'report.docx', localPath: 'report.docx', root: 'workspace' },
        ]);
        readVerifiedArtifactFileMock.mockResolvedValue(original);
        // 保存框停留期间用户改了源文件（同一个文件对象，就地写回）
        const edited = Buffer.concat([original, Buffer.from('NEW USER EDIT')]);
        showSaveDialogMock.mockImplementation(async () => {
          writeFileSync(sourcePath, edited);
          return { canceled: false, filePath: aliasPath };
        });
        const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
        registerArtifactHandlers();

        await expect(handleMap.get('artifact:save-as')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
          ok: false,
          error: 'destination matches source',
        });
        expect(readFileSync(aliasPath).equals(edited), '用户新编辑必须活着').toBe(true);
        expect(copyArtifactToDestinationMock).not.toHaveBeenCalled();
      } finally {
        vi.mocked(getWorkspacePath).mockImplementation(previousWorkspace);
        rmSync(root, { recursive: true, force: true });
      }
    });
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

  /**
   * ⭐ 独立复核（2026-10-09）：`artifact:preview` 的**超限**不许落成"读不了"。
   *
   * 识别格式的大文件（如 45MB PDF）此前走通用 catch ⇒ `{ok:false}` ⇒ 界面显示
   * 「无法读取这份文件的内容」—— 把"文件是好的、只是我们不肯整份搬"偷换成"读不了"
   * （尺寸丢失，验收点 4 明令禁止的偷换）。修法：识别 `ArtifactTooLargeError` ⇒
   * 回 `unsupported`，让渲染层走文本/图片老路 —— 那条路的同一档尺寸门会如实报出
   * `{ tooLarge, size }`（"有多大、请用系统程序打开"）。
   */
  describe('artifact:preview 的上限', () => {
    it('⭐ 超限（识别格式，如大 PDF）⇒ 回 unsupported（交回老路报尺寸），不是 ok:false', async () => {
      allMock.mockReturnValue([{ id: 'a1', taskId: 'task-1', name: '扫描件.pdf', localPath: 'task-1/扫描件.pdf' }]);
      readVerifiedArtifactFileMock.mockRejectedValue(new ArtifactTooLargeError(45 * 1024 * 1024));
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(handleMap.get('artifact:preview')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
        ok: true,
        result: { kind: 'unsupported' },
      });
    });

    it('对照：非超限失败照旧 ok:false（解析失败仍是"读不了"）', async () => {
      allMock.mockReturnValue([{ id: 'a1', taskId: 'task-1', name: '坏.pdf', localPath: 'task-1/坏.pdf' }]);
      readVerifiedArtifactFileMock.mockRejectedValue(new Error('artifact unsafe'));
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();

      await expect(handleMap.get('artifact:preview')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
        ok: false,
        error: 'artifact unsafe',
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

  /**
   * ⭐ BUG-056③（2026-10-13 S 包 patch，P 接入）：`artifact:save-image-url` 的 `file://` 边界。
   *
   * 旧实现是**词法** `startsWith(resolve(ws) + sep)`：`<ws>-evil\a.png` 这种**同前缀相邻目录**
   * 会被放行；工作区内的 junction/符号链接指向外部时，词法判据也看不见真实落点。
   * 新判据：`fileURLToPath` 解码 → workspace 与目标各自的 `realpath` → 相对包含
   * （出界/同前缀相邻目录/根自身都拒）→ 只读**检查过的 canonical 目标**（`isFile`）。
   *
   * 残余（如实）：realpath→read 之间仍有极窄的交换窗口（Windows 无 O_NOFOLLOW 等价物），
   * 已把风险收窄，但不宣称并发替换被彻底消除。
   */
  describe('artifact:save-image-url 的 file:// 边界（BUG-056③）', () => {
    async function saveImageUrl(url: string): Promise<{ ok: boolean; error?: string }> {
      const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
      registerArtifactHandlers();
      return (await handleMap.get('artifact:save-image-url')?.({}, { taskId: 'task-1', messageId: 'm1', url })) as {
        ok: boolean;
        error?: string;
      };
    }
    async function mockWorkspace(ws: string): Promise<void> {
      const { getWorkspacePath } = await import('../src/main/workspace/config.js');
      vi.mocked(getWorkspacePath).mockReturnValue(ws);
    }

    it('⭐ 工作区内的中文文件名 URL 允许（fileURLToPath 解码后 canonical 在根内）', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'img-ws-中文-'));
      try {
        await mockWorkspace(ws);
        const image = join(ws, '图 像.png');
        writeFileSync(image, 'png-bytes');
        const reply = await saveImageUrl(pathToFileURL(image).href);
        expect(reply).toEqual(expect.objectContaining({ ok: true }));
        // 保存的是**解码后目标**的字节（不是 URL 串）
        const { saveArtifactFromBuffer } = await import('../src/main/artifact/save.js');
        const saved = vi.mocked(saveArtifactFromBuffer).mock.calls.at(-1)?.[0] as { buffer?: Buffer };
        expect(saved.buffer?.toString('utf8')).toBe('png-bytes');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('⭐ 同前缀相邻目录（<ws>-evil）拒绝 —— 词法 startsWith 的原始误放行', async () => {
      const parent = mkdtempSync(join(tmpdir(), 'img-parent-'));
      try {
        const ws = join(parent, 'workspace');
        const evil = join(parent, 'workspace-evil');
        mkdirSync(ws);
        mkdirSync(evil);
        writeFileSync(join(evil, 'a.png'), 'evil-bytes');
        await mockWorkspace(ws);
        // ① 同前缀相邻目录
        await expect(saveImageUrl(pathToFileURL(join(evil, 'a.png')).href)).resolves.toEqual({
          ok: false,
          error: 'file path outside workspace',
        });
        // ② 完全在外的普通绝对路径（负对照：旧判据本就拒，这里钉住新判据同样拒）
        mkdirSync(join(parent, 'elsewhere'), { recursive: true });
        writeFileSync(join(parent, 'elsewhere', 'plain.png'), 'x');
        await expect(saveImageUrl(pathToFileURL(join(parent, 'elsewhere', 'plain.png')).href)).resolves.toEqual({
          ok: false,
          error: 'file path outside workspace',
        });
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });

    it('⭐ 工作区内的 link 指向外部 ⇒ canonical 出界 ⇒ 拒绝（不是"在根里"就算数）', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'img-link-ws-'));
      const outside = mkdtempSync(join(tmpdir(), 'img-link-out-'));
      try {
        await mockWorkspace(ws);
        writeFileSync(join(outside, 'secret.png'), 'secret-bytes');
        const link = join(ws, 'pictures');
        const kind = process.platform === 'win32' ? 'junction' : 'dir';
        try {
          symlinkSync(outside, link, kind);
        } catch {
          // 无权限建链接（如未开开发者模式的 Windows）⇒ 本用例失去被测对象，明确跳过
          return;
        }
        await expect(saveImageUrl(pathToFileURL(join(link, 'secret.png')).href)).resolves.toEqual({
          ok: false,
          error: 'file path outside workspace',
        });
      } finally {
        rmSync(ws, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('⭐ 文件不存在 ⇒ 明确失败 file not found（不猜、回落）', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'img-missing-'));
      try {
        await mockWorkspace(ws);
        await expect(saveImageUrl(pathToFileURL(join(ws, '不存在.png')).href)).resolves.toEqual({
          ok: false,
          error: 'file not found',
        });
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('⭐ 目标是目录 ⇒ 明确失败 not a file（canonical 在根内也不读）', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'img-dir-'));
      try {
        await mockWorkspace(ws);
        const directory = join(ws, 'assets');
        mkdirSync(directory);
        await expect(saveImageUrl(pathToFileURL(directory).href)).resolves.toEqual({
          ok: false,
          error: 'not a file',
        });
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('⭐ 工作区自身（relation 为空）也拒绝，不把根目录当图片', async () => {
      const ws = mkdtempSync(join(tmpdir(), 'img-self-'));
      try {
        await mockWorkspace(ws);
        await expect(saveImageUrl(pathToFileURL(ws).href)).resolves.toEqual({
          ok: false,
          error: 'file path outside workspace',
        });
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });
});
