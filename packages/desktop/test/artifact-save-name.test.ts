import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
 */

const mocks = vi.hoisted(() => ({ randomUUID: vi.fn(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') }));

vi.mock('crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('crypto')>()),
  randomUUID: mocks.randomUUID,
}));

vi.mock('../src/main/db/index.js', () => ({ getDb: vi.fn() }));
vi.mock('../src/main/db/schema.js', () => ({ artifacts: Symbol('artifacts') }));

import { saveArtifactFromBuffer } from '../src/main/artifact/save.js';
import { getDb } from '../src/main/db/index.js';

const mockGetDb = vi.mocked(getDb);

let workspace = '';
const taskId = 'task-1';

function mockDb(): void {
  const run = vi.fn();
  const values = vi.fn(() => ({ run }));
  const insert = vi.fn(() => ({ values }));
  mockGetDb.mockReturnValue({ insert } as unknown as ReturnType<typeof getDb>);
}

function save(fileName: string, content: string) {
  return saveArtifactFromBuffer({
    workspacePath: workspace,
    taskId,
    messageId: 'msg-1',
    fileName,
    buffer: Buffer.from(content),
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
    const artifact = await save('内测汇报.pptx', 'v1');

    expect(artifact.name).toBe('内测汇报.pptx');
    expect(existsSync(join(workspace, taskId, '内测汇报.pptx'))).toBe(true);
    expect(readFileSync(join(workspace, taskId, '内测汇报.pptx'), 'utf8')).toBe('v1');
  });

  it('⭐ 第二份同名 ⇒ **才**退到带后缀的名字（不覆盖第一条不变式）', async () => {
    await save('内测汇报.pptx', 'v1');
    const second = await save('内测汇报.pptx', 'v2');

    expect(second.name).not.toBe('内测汇报.pptx');
    expect(second.name).toMatch(/^内测汇报-[a-f0-9]{8}\.pptx$/);
    expect(readFileSync(join(workspace, taskId, '内测汇报.pptx'), 'utf8'), '第一份被覆盖了').toBe('v1');
    expect(readFileSync(join(workspace, taskId, second.name), 'utf8')).toBe('v2');
  });

  it('不同名字互不影响（两份都干净）', async () => {
    const a = await save('甲.pptx', 'a');
    const b = await save('乙.pptx', 'b');

    expect([a.name, b.name]).toEqual(['甲.pptx', '乙.pptx']);
    expect(readdirSync(join(workspace, taskId)).sort()).toEqual(['乙.pptx', '甲.pptx']);
  });

  it('负对照：同名但**在不同任务**里 ⇒ 各用各的干净名字（撞名只看本任务目录）', async () => {
    await save('汇报.pptx', 'a');
    const other = await saveArtifactFromBuffer({
      workspacePath: workspace,
      taskId: 'task-2',
      messageId: 'msg-2',
      fileName: '汇报.pptx',
      buffer: Buffer.from('b'),
      artifactType: 'file',
    });

    expect(other.name).toBe('汇报.pptx');
    expect(readFileSync(join(workspace, 'task-2', '汇报.pptx'), 'utf8')).toBe('b');
  });
});
