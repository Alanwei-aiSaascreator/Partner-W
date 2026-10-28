import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeMp4Buffer } from './helpers/make-mp4.js';
import { resolve } from 'node:path';

vi.mock('fs', () => ({
  copyFileSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
  // M1（2026-10-06）：PPTX 登记前置门要读源文件做完整性校验——补进 mock表。
  readFileSync: vi.fn(),
  // 2026-09-25：产物落盘现在会先看"目录里有没有同名"（不撞就用干净名字）。
  // 这个 mock 里一律"没有" ⇒ 走干净名字那条路；这些用例断言的是 DB/复制/删除，不看名字。
  existsSync: vi.fn(() => false),
  // BUG-058②（2026-10-13）：重放命中要复核"目标本体可读"——非受检格式走 open/close 探针。
  openSync: vi.fn(() => 3),
  closeSync: vi.fn(),
}));

vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
}));

vi.mock('../src/main/db/index.js', () => ({
  getDb: vi.fn(),
  getSqlite: vi.fn(),
}));

vi.mock('../src/main/db/schema.js', () => ({
  artifacts: Symbol('artifacts'),
}));

vi.mock('../src/main/workspace/init.js', () => ({
  ensureTaskDir: vi.fn(() => '/workspace/tasks/task-1'),
}));

import { saveArtifact, saveArtifactFromBuffer } from '../src/main/artifact/save.js';
import { ArtifactIntegrityError } from '../src/main/artifact/verify.js';
import { copyFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { getDb, getSqlite } from '../src/main/db/index.js';
import JSZip from 'jszip';

const mockCopyFileSync = vi.mocked(copyFileSync);
const mockStatSync = vi.mocked(statSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockGetDb = vi.mocked(getDb);
const mockGetSqlite = vi.mocked(getSqlite);

const DB_ERROR = new Error('UNIQUE constraint failed');

/**
 * 唯一索引冲突的真身（`artifacts_task_local_path` / `artifacts_source_dedup` 都长这样）。
 * ⚠️ 判据是**前缀**：列清单随索引不同，见 `artifact/unique-error.ts`。
 */
const DB_UNIQUE_ERROR = new Error('UNIQUE constraint failed: artifacts.task_id, artifacts.root, artifacts.local_path');

/**
 * 假的 DB 表：
 *  · `insert().values().run()` —— drizzle 那条（登记本体）；
 *  · `sqlite.prepare(sql).get(...)` —— 既有行结算/冲突复核（原始 SQL，行是 snake_case，
 *    与 `artifactFromRow` 同一口径）；
 *  · `sqlite.prepare(sql).run(...)` —— 清陈旧行。
 *
 * ⚠️ 2026-10-07 体检（P2-2/P2-4）之后 save 会先做"既有行结算"——
 *    这个 mock 表原先只有 `insert`，不补就会在调用点当场 TypeError。
 *
 * `rows` = 逐次 SELECT 的返回行（按调用顺序消费，用完即空；空位 = 查不到）——
 * 用例因此能精确摆出"结算时查不到、冲突复核时查到赢家"这种时序。
 */
function mockDb(options: { rows?: Array<Record<string, unknown> | undefined>; insertThrows?: Error } = {}) {
  let selectCall = 0;
  const rows = options.rows ?? [];
  const get = vi.fn(() => rows[selectCall++]);
  const deleteRun = vi.fn();
  const prepare = vi.fn((sql: string) => (String(sql).startsWith('DELETE') ? { run: deleteRun } : { get }));
  mockGetSqlite.mockReturnValue({ prepare } as unknown as ReturnType<typeof getSqlite>);

  const insertThrows = options.insertThrows;
  const run = vi.fn(() => {
    if (insertThrows) throw insertThrows;
  });
  const values = vi.fn(() => ({ run }));
  const insert = vi.fn(() => ({ values }));
  mockGetDb.mockReturnValue({ insert } as unknown as ReturnType<typeof getDb>);

  return { insert, values, run, prepare, deleteRun, get };
}

function mockDbSuccess() {
  return mockDb();
}

function mockDbFailure() {
  return mockDb({ insertThrows: DB_ERROR });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStatSync.mockReturnValue({ size: 1024, isFile: () => true } as ReturnType<typeof statSync>);
});

describe('saveArtifact', () => {
  const params = {
    workspacePath: '/workspace',
    taskId: 'task-1',
    messageId: 'msg-1',
    sourcePath: '/tmp/upload.png',
  };

  it('returns artifact on success', async () => {
    mockDbSuccess();
    const result = await saveArtifact(params);

    expect(result.taskId).toBe('task-1');
    expect(result.messageId).toBe('msg-1');
    expect(result.mimeType).toBe('image/png');
    expect(result.filePath).toBe(resolve('/workspace/tasks/task-1', 'upload.png'));
    expect(mockCopyFileSync).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('removes copied file when DB insert fails', async () => {
    mockDbFailure();

    await expect(saveArtifact(params)).rejects.toThrow(DB_ERROR);

    expect(mockCopyFileSync).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    const destPath = mockUnlinkSync.mock.calls[0][0];
    expect(String(destPath)).toContain('task-1');
  });

  it('still throws DB error when unlink also fails', async () => {
    mockDbFailure();
    mockUnlinkSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    await expect(saveArtifact(params)).rejects.toThrow(DB_ERROR);
  });
});

describe('saveArtifactFromBuffer', () => {
  it.each(['mp4', 'webm'])('assigns the correct MIME to a generated %s file', async (extension) => {
    mockDbSuccess();
    const result = await saveArtifactFromBuffer({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'msg-1',
      fileName: `clip.${extension}`,
      // ⚠️ .mp4 进了登记前置门（2026-10-12 视频接入）——假字节 'video' 会被拒；
      //    .webm 不在受检名单，垃圾字节照旧放行（本用例顺带钉住这个边界）。
      buffer: extension === 'mp4' ? makeMp4Buffer() : Buffer.from('video'),
      artifactType: 'file',
    });
    expect(result).toMatchObject({ type: 'file', mimeType: `video/${extension}` });
  });

  const params = {
    workspacePath: '/workspace',
    taskId: 'task-1',
    messageId: 'msg-1',
    fileName: 'output.json',
    buffer: Buffer.from('{"ok":true}'),
    artifactType: 'file' as const,
  };

  it('returns artifact on success', async () => {
    mockDbSuccess();
    const result = await saveArtifactFromBuffer(params);

    expect(result.taskId).toBe('task-1');
    expect(result.mimeType).toBe('application/json');
    expect(result.filePath).toBe(resolve('/workspace/tasks/task-1', 'output.json'));
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('removes written file when DB insert fails', async () => {
    mockDbFailure();

    await expect(saveArtifactFromBuffer(params)).rejects.toThrow(DB_ERROR);

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    const destPath = mockUnlinkSync.mock.calls[0][0];
    expect(String(destPath)).toContain('task-1');
  });

  it('still throws DB error when unlink also fails', async () => {
    mockDbFailure();
    mockUnlinkSync.mockImplementation(() => {
      throw new Error('EPERM');
    });

    await expect(saveArtifactFromBuffer(params)).rejects.toThrow(DB_ERROR);
  });
});

/** M1（2026-10-06）：PPTX 登记前置门——坏文件不落盘、不登记；好文件照常走。 */
describe('M1 登记前置门（PPTX 完整性）', () => {
  async function validPptx(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
    zip.file('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation/>');
    zip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld/>');
    return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
  }

  const bufferParams = {
    workspacePath: '/workspace',
    taskId: 'task-1',
    messageId: 'msg-1',
    fileName: 'deck.pptx',
    artifactType: 'file' as const,
  };

  it('坏 buffer：拒绝、不写盘、不登记、无残留清理动作', async () => {
    const db = mockDbSuccess();

    await expect(
      saveArtifactFromBuffer({ ...bufferParams, buffer: Buffer.from('PK broken, not a zip') }),
    ).rejects.toThrow(ArtifactIntegrityError);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('好 buffer：照常写盘并登记', async () => {
    const db = mockDbSuccess();
    const result = await saveArtifactFromBuffer({ ...bufferParams, buffer: await validPptx() });

    expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('复制路径：源文件是坏 pptx → 复制之前就拒绝', async () => {
    mockDbSuccess();
    mockReadFileSync.mockReturnValue(Buffer.from('PK broken, not a zip'));

    await expect(
      saveArtifact({
        workspacePath: '/workspace',
        taskId: 'task-1',
        messageId: 'msg-1',
        sourcePath: '/tmp/deck.pptx',
      }),
    ).rejects.toThrow(ArtifactIntegrityError);

    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  it('复制路径：好 pptx → 复制并登记', async () => {
    const db = mockDbSuccess();
    // `Buffer.from(...)` 的返回类型是 `Buffer<ArrayBuffer>`（= mock 期望的 NonSharedBuffer）；
    // JSZip 的 `Buffer<ArrayBufferLike>` 直接塞会 TS2345（vitest 不做类型检查，门禁会）。
    mockReadFileSync.mockReturnValue(Buffer.from(await validPptx()));

    const result = await saveArtifact({
      workspacePath: '/workspace',
      taskId: 'task-1',
      messageId: 'msg-1',
      sourcePath: '/tmp/deck.pptx',
    });

    expect(result.name).toBe('deck.pptx');
    expect(mockCopyFileSync).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  /**
   * ⭐ docx 并入同一道门（2026-10-06，用户反馈 #9："新 docx 打不开/乱码"）。
   * 判据与 pptx 同构，走的是同一个派发入口 —— 这里钉的是**写入路径的接线**。
   */
  async function validDocx(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document/>');
    return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
  }

  it('坏 docx buffer（纯文本改名）→ 拒绝、不写盘、不登记', async () => {
    const db = mockDbSuccess();

    await expect(
      saveArtifactFromBuffer({
        ...bufferParams,
        fileName: '总结.docx',
        buffer: Buffer.from('这是模型写的纯文本，只是名字叫 .docx'),
      }),
    ).rejects.toThrow(ArtifactIntegrityError);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('好 docx buffer → 照常写盘并登记', async () => {
    const db = mockDbSuccess();
    const result = await saveArtifactFromBuffer({ ...bufferParams, fileName: '总结.docx', buffer: await validDocx() });

    expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('复制路径：源文件是文本改名的 .docx → 复制之前就拒绝', async () => {
    mockDbSuccess();
    mockReadFileSync.mockReturnValue(Buffer.from('这不是文档'));

    await expect(
      saveArtifact({
        workspacePath: '/workspace',
        taskId: 'task-1',
        messageId: 'msg-1',
        sourcePath: '/tmp/总结.docx',
      }),
    ).rejects.toThrow(ArtifactIntegrityError);

    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });
});

/**
 * 唯一约束语义（2026-10-07 体检 P2-2 / P2-4）。
 *
 * 真索引（better-sqlite3 + 真文件系统）那条路在 Electron 探针里
 * （`test/artifact-save-index.test.ts`）；这里钉的是**决策本身**：
 * 什么时候返回既有行、什么时候清陈旧行、什么时候才允许删刚写的文件。
 */
describe('唯一约束 = "它已经存在"（重放 / 陈旧行 / 竞态）', () => {
  const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'prior-id',
    task_id: 'task-1',
    message_id: 'msg-1',
    type: 'file',
    name: 'output.json',
    file_path: resolve('/workspace/tasks/task-1', 'output.json'),
    local_path: 'task-1/output.json',
    root: 'workspace',
    mime_type: 'application/json',
    size: 11,
    source_key: 'docgen:docx:abc123',
    content_text: '',
    created_at: '2026-10-07T00:00:00.000Z',
    ...overrides,
  });

  const params = {
    workspacePath: '/workspace',
    taskId: 'task-1',
    messageId: 'msg-1',
    fileName: 'output.json',
    buffer: Buffer.from('{"ok":true}'),
    artifactType: 'file' as const,
    sourceKey: 'docgen:docx:abc123',
  };

  it('⭐ 重放（同 message + 同 sourceKey 已在、目标本体仍有效）⇒ 返回既有行，不写第二份、不再登记', async () => {
    mockExistsSync.mockReturnValue(true);
    // BUG-058②（2026-10-13）：命中口径收紧为"目标本体复核"——大小与行一致、可读
    // （非受检格式走 open/close 探针）；夹具跟着真实盘上形态对齐。
    mockStatSync.mockReturnValue({ size: 11, isFile: () => true } as ReturnType<typeof statSync>);
    const db = mockDb({ rows: [row()] });

    const result = await saveArtifactFromBuffer(params);

    expect(result.id).toBe('prior-id');
    expect(result.name).toBe('output.json');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('⭐ 同源旧行的文件**没了** ⇒ 删掉陈旧行，这次的新文件顶上（不报"已存在"）', async () => {
    mockExistsSync.mockReturnValue(false);
    const db = mockDb({ rows: [row()] }); // 重放查询命中（文件没了）⇒ 清行；落点查询空

    const result = await saveArtifactFromBuffer(params);

    expect(db.deleteRun).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(result.id).not.toBe('prior-id');
  });

  it('⭐ "有行无文件"占着落点名（P2-2 的原始场景）⇒ 清旧行再登记，**不删刚写的好文件**', async () => {
    mockExistsSync.mockReturnValue(false);
    const db = mockDb({ rows: [row({ id: 'stale-id', source_key: '' })] });

    const result = await saveArtifactFromBuffer({ ...params, sourceKey: undefined });

    expect(db.deleteRun).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync, '刚写的好文件不许被删').not.toHaveBeenCalled();
    expect(result.filePath).toBe(resolve('/workspace/tasks/task-1', 'output.json'));
  });

  it('⭐ 竞态：INSERT 撞唯一约束、复核查到赢家 ⇒ 返回赢家行，**不删刚写的新文件**', async () => {
    mockExistsSync.mockReturnValue(false);
    const db = mockDb({
      // ① 落点结算查询空 ② 冲突后复核命中赢家
      rows: [undefined, row({ id: 'winner-id', name: 'output.json' })],
      insertThrows: DB_UNIQUE_ERROR,
    });

    const result = await saveArtifactFromBuffer({ ...params, sourceKey: undefined });

    expect(result.id).toBe('winner-id');
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(db.deleteRun).not.toHaveBeenCalled();
  });

  it('负对照：唯一约束但复核**查不到**赢家 ⇒ 回落到"删文件 + 抛"（不留孤儿）', async () => {
    mockExistsSync.mockReturnValue(false);
    mockDb({ rows: [], insertThrows: DB_UNIQUE_ERROR });

    await expect(saveArtifactFromBuffer({ ...params, sourceKey: undefined })).rejects.toThrow(DB_UNIQUE_ERROR);

    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
  });

  it('负对照：普通 DB 故障（非唯一约束）仍然删文件 + 抛 —— 重放语义不许把真故障吞掉', async () => {
    mockExistsSync.mockReturnValue(false);
    mockDb({ insertThrows: new Error('database is locked') });

    await expect(saveArtifactFromBuffer({ ...params, sourceKey: undefined })).rejects.toThrow('database is locked');

    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
  });
});

/**
 * ⭐ BUG-058②（2026-10-13 计划 P2）：**保存路径（源文件那条）**的同键重放探测
 * 必须在**读源字节之前** —— 重放的源可能已被清理（slidegen-cli 落位路），
 * 旧顺序先做完整性门 ⇒ 拿"源不在了"否掉一份**已经存好**的产物、整轮 failed。
 *
 * 命中口径同时收紧：同 task/message/sourceKey **且目标本体仍然有效**
 * （可读 / 大小 / 受检格式字节完整）—— 目标被改坏不当重放。
 *
 * 真文件系统 + 真 SQLite 的语义在 `artifact-save-index.test.ts` 的
 * `save-source-replay` 场景（探针里跑 `saveArtifact` 本体）。
 */
describe('⭐ BUG-058② · 同键重放：读源字节之前探测', () => {
  const sourcePath = '/tmp/snapshot/deck.pptx';
  const targetPath = resolve('/workspace/tasks/task-1', 'deck.pptx');
  const params = {
    workspacePath: '/workspace',
    taskId: 'task-1',
    messageId: 'msg-1',
    sourcePath,
    sourceKey: 'docgen:pptx:hash-1',
  };
  const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'prior-deck',
    task_id: 'task-1',
    message_id: 'msg-1',
    type: 'file',
    name: 'deck.pptx',
    file_path: targetPath,
    local_path: 'task-1/deck.pptx',
    root: 'workspace',
    mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 42,
    source_key: 'docgen:pptx:hash-1',
    content_text: '',
    created_at: '2026-10-13T00:00:00.000Z',
    ...overrides,
  });

  async function validPptx(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
    zip.file('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation/>');
    zip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld/>');
    return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
  }

  it('⭐ 命中（同 task/message/sourceKey + 目标本体有效）⇒ 返回既有行；不读源、不复制、不写库', async () => {
    const pptxBytes = Buffer.from(await validPptx());
    const db = mockDb({ rows: [row()] });
    mockExistsSync.mockReturnValue(true);
    // 目标本体的盘上形态与行记账一致（size 42 = row().size），受检格式字节有效。
    mockStatSync.mockReturnValue({ size: 42, isFile: () => true } as ReturnType<typeof statSync>);
    // 源已清理：任何对 sourcePath 的读取都当场炸 —— 探测若在读源之后，这条必红。
    mockReadFileSync.mockImplementation(((file: string) => {
      if (file === sourcePath) throw new Error('ENOENT');
      if (file === targetPath) return pptxBytes;
      throw new Error(`unexpected read: ${file}`);
    }) as typeof readFileSync);

    const result = await saveArtifact(params);

    expect(result.id).toBe('prior-deck');
    expect(mockReadFileSync.mock.calls.map((call) => call[0])).not.toContain(sourcePath);
    expect(mockCopyFileSync).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    // ⭐ T20：探测键是 (task, sourceKey) —— 跨 assistant 消息的同源去重（不再带 messageId）
    expect(db.get).toHaveBeenCalledWith('task-1', 'docgen:pptx:hash-1');
  });

  it('⭐ 目标被改坏（受检格式字节坏）+ 新源有效 ⇒ 不当重放：清陈旧行、重材化，不伪成功', async () => {
    const pptxBytes = Buffer.from(await validPptx());
    // 探测（miss，目标坏）→ 结算 ①（同键行，目标坏 ⇒ 清行）→ 结算 ③（落点空）
    const db = mockDb({ rows: [row(), row(), undefined] });
    mockExistsSync.mockReturnValue(true);
    // size 与行记账一致（42）⇒ 判别只落在"字节完整性"这一层，不被大小短路。
    mockStatSync.mockReturnValue({ size: 42, isFile: () => true } as ReturnType<typeof statSync>);
    mockReadFileSync.mockImplementation(((file: string) => {
      if (file === targetPath) return Buffer.from('PK broken, not a zip'); // 目标被外部改坏
      return pptxBytes; // 源仍然有效
    }) as typeof readFileSync);

    const result = await saveArtifact(params);

    expect(result.id).not.toBe('prior-deck'); // 坏目标不许冒充"已存在"
    expect(db.deleteRun).toHaveBeenCalledTimes(1); // 陈旧行清掉
    expect(mockCopyFileSync).toHaveBeenCalledTimes(1); // 用新源重材化
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('⭐ 目标也缺 + 源已清理 ⇒ 如实失败（不伪成功、不删行、不复制）', async () => {
    const db = mockDb({ rows: [row()] });
    mockStatSync.mockImplementation(((file: string) => {
      if (file === targetPath) throw new Error('ENOENT');
      return { size: 1024, isFile: () => true } as ReturnType<typeof statSync>;
    }) as typeof statSync);
    mockReadFileSync.mockImplementation((() => {
      throw new Error('ENOENT');
    }) as typeof readFileSync);

    await expect(saveArtifact(params)).rejects.toThrow(ArtifactIntegrityError);

    expect(db.deleteRun).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(mockCopyFileSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('⭐ 异键不豁免：没有同键行时照走完整性门（源已清理 ⇒ unreadable）', async () => {
    const db = mockDb({ rows: [undefined] });
    mockReadFileSync.mockImplementation((() => {
      throw new Error('ENOENT');
    }) as typeof readFileSync);

    await expect(saveArtifact({ ...params, sourceKey: 'docgen:pptx:other' })).rejects.toThrow(ArtifactIntegrityError);

    expect(db.insert).not.toHaveBeenCalled();
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  it('⭐ 坏新源不落盘、不删原有效行：完整性门先于任何写/删', async () => {
    const db = mockDb({ rows: [undefined, undefined, undefined] });
    mockReadFileSync.mockImplementation((() => Buffer.from('这不是文档')) as unknown as typeof readFileSync);

    await expect(saveArtifact({ ...params, sourceKey: 'docgen:pptx:hash-2' })).rejects.toThrow(ArtifactIntegrityError);

    expect(mockCopyFileSync).not.toHaveBeenCalled();
    expect(db.deleteRun).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});
