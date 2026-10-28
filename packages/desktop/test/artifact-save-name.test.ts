import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

/**
 * 产物落盘时的**文件名**（2026-09-25）。
 *
 * 现状：`uniqueFileName()` **总是**拼一个 `-<8位随机>`，于是「助手刚生成的那份报告」在
 * 产物面板里叫 `内测汇报-3f9c2a1b.pptx` —— 那是**要交给别人**的交付物，名字难看且不像话
 * （P2 的技能文案因此只能写"别向用户解释成我起的名字"）。
 *
 * 但那个随机后缀不是没来由的：它保证同一任务目录里**永不覆盖**。
 * ⇒ 这里改成**先看不撞**：目录里没有同名就照原样用，撞了才退到原来的随机后缀那套。
 * 不覆盖这条不变式仍然成立（撞名时照样改名），只是**绝大多数情况下**名字干净了。
 *
 * ⚠️ 用**真文件系统**（临时目录）测：现有 `artifact-save.test.ts` 把 `fs` 整个 mock 了，
 *    它验不了"目录里到底有没有同名文件"这件事。
 *
 * ⚠️ 2026-10-06（M1 登记前置门）：`saveArtifactFromBuffer` 现在要求 `.pptx` 是**结构完整的
 *    ZIP**（`artifact/verify.ts`：zip 可读 + `[Content_Types].xml` + `presentation.xml` +
 *    ≥1 slide）。本档夹具因此从"纯文本假 pptx"换成**最小合法包**；
 *    名字断言不变，内容断言改为 **buffer 等值**。
 */

const mocks = vi.hoisted(() => ({ randomUUID: vi.fn(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') }));

vi.mock('crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('crypto')>()),
  randomUUID: mocks.randomUUID,
}));

vi.mock('../src/main/db/index.js', () => ({ getDb: vi.fn(), getSqlite: vi.fn() }));
vi.mock('../src/main/db/schema.js', () => ({ artifacts: Symbol('artifacts') }));

import { saveArtifactFromBuffer } from '../src/main/artifact/save.js';
import { getDb, getSqlite } from '../src/main/db/index.js';

const mockGetDb = vi.mocked(getDb);
const mockGetSqlite = vi.mocked(getSqlite);

let workspace = '';
const taskId = 'task-1';

function mockDb(): void {
  const run = vi.fn();
  const values = vi.fn(() => ({ run }));
  const insert = vi.fn(() => ({ values }));
  mockGetDb.mockReturnValue({ insert } as unknown as ReturnType<typeof getDb>);
  // ⚠️ 2026-10-07 体检（P2-2/P2-4）之后 save 会先查"既有行"（原始 SQLite）并在陈旧时 DELETE ——
  //    这里一律"查不到"（本档钉的是磁盘撞名的名字规则，不是唯一约束语义）。
  mockGetSqlite.mockReturnValue({
    prepare: vi.fn(() => ({ get: vi.fn(), run: vi.fn() })),
  } as unknown as ReturnType<typeof getSqlite>);
}

/** 最小合法 PPTX（M1 门要求真 ZIP）；`label` 写进 presentation.xml 供内容等值断言。 */
async function pptx(label: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('ppt/presentation.xml', `<?xml version="1.0"?><!-- ${label} --><p:presentation/>`);
  zip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld/>');
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
}

function save(fileName: string, buffer: Buffer, task = taskId) {
  return saveArtifactFromBuffer({
    workspacePath: workspace,
    taskId: task,
    messageId: 'msg-1',
    fileName,
    buffer,
    artifactType: 'file',
  });
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'artifact-name-'));
  mockDb();
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe('产物文件名 —— 不撞就用干净名字', () => {
  it('⭐ 第一份 ⇒ 就叫「内测汇报.pptx」（不再无条件拼随机后缀）', async () => {
    const v1 = await pptx('v1');
    const artifact = await save('内测汇报.pptx', v1);

    expect(artifact.name).toBe('内测汇报.pptx');
    expect(existsSync(join(workspace, taskId, '内测汇报.pptx'))).toBe(true);
    expect(readFileSync(join(workspace, taskId, '内测汇报.pptx')).equals(v1)).toBe(true);
  });

  it('⭐ 第二份同名 ⇒ **才**退到带后缀的名字（不覆盖第一条不变式）', async () => {
    const v1 = await pptx('v1');
    const v2 = await pptx('v2');
    await save('内测汇报.pptx', v1);
    const second = await save('内测汇报.pptx', v2);

    expect(second.name).not.toBe('内测汇报.pptx');
    expect(second.name).toMatch(/^内测汇报-[a-f0-9]{8}\.pptx$/);
    expect(readFileSync(join(workspace, taskId, '内测汇报.pptx')).equals(v1), '第一份被覆盖了').toBe(true);
    expect(readFileSync(join(workspace, taskId, second.name)).equals(v2)).toBe(true);
  });

  it('不同名字互不影响（两份都干净）', async () => {
    const a = await save('甲.pptx', await pptx('a'));
    const b = await save('乙.pptx', await pptx('b'));

    expect([a.name, b.name]).toEqual(['甲.pptx', '乙.pptx']);
    expect(readdirSync(join(workspace, taskId)).sort()).toEqual(['乙.pptx', '甲.pptx']);
  });

  it('负对照：同名但**在不同任务**里 ⇒ 各用各的干净名字（撞名只看本任务目录）', async () => {
    const b = await pptx('b');
    await save('汇报.pptx', await pptx('a'));
    const other = await save('汇报.pptx', b, 'task-2');

    expect(other.name).toBe('汇报.pptx');
    expect(readFileSync(join(workspace, 'task-2', '汇报.pptx')).equals(b)).toBe(true);
  });
});
