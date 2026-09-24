import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  copyFileSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
  // 2026-09-25：产物落盘现在会先看"目录里有没有同名"（不撞就用干净名字）。
  // 这个 mock 里一律"没有" ⇒ 走干净名字那条路；这些用例断言的是 DB/复制/删除，不看名字。
  existsSync: vi.fn(() => false),
}));

vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
}));

vi.mock('../src/main/db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../src/main/db/schema.js', () => ({
  artifacts: Symbol('artifacts'),
}));

vi.mock('../src/main/workspace/init.js', () => ({
  ensureTaskDir: vi.fn(() => '/workspace/tasks/task-1'),
}));

import { saveArtifact, saveArtifactFromBuffer } from '../src/main/artifact/save.js';
import { copyFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { getDb } from '../src/main/db/index.js';

const mockCopyFileSync = vi.mocked(copyFileSync);
const mockStatSync = vi.mocked(statSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockGetDb = vi.mocked(getDb);

const DB_ERROR = new Error('UNIQUE constraint failed');

function mockDbSuccess() {
  const run = vi.fn();
  const values = vi.fn(() => ({ run }));
  const insert = vi.fn(() => ({ values }));
  mockGetDb.mockReturnValue({ insert } as unknown as ReturnType<typeof getDb>);
  return { insert, values, run };
}

function mockDbFailure() {
  const run = vi.fn(() => {
    throw DB_ERROR;
  });
  const values = vi.fn(() => ({ run }));
  const insert = vi.fn(() => ({ values }));
  mockGetDb.mockReturnValue({ insert } as unknown as ReturnType<typeof getDb>);
  return { insert, values, run };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStatSync.mockReturnValue({ size: 1024 } as ReturnType<typeof statSync>);
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
