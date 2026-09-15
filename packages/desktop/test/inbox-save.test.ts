import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('../src/main/workspace/init.js', () => ({
  ensureTaskDir: vi.fn(() => '/workspace/task-1'),
}));

import { mkdir, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { saveInboxAttachment } from '../src/main/inbox/save.js';

const mockMkdir = vi.mocked(mkdir);
const mockWriteFile = vi.mocked(writeFile);

describe('saveInboxAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the inbox dir and writes the attachment asynchronously', async () => {
    const buffer = Buffer.from('hello');

    const result = await saveInboxAttachment({
      workspacePath: '/workspace',
      taskId: 'task-1',
      fileName: 'note.txt',
      buffer,
    });

    const inboxDir = join('/workspace/task-1', 'inbox');
    expect(mockMkdir).toHaveBeenCalledWith(inboxDir, { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const writtenPath = String(mockWriteFile.mock.calls[0][0]);
    const writtenName = basename(writtenPath);
    expect(dirname(writtenPath)).toBe(resolve(inboxDir));
    expect(writtenName).toMatch(/^note(?:-[a-f0-9]{8})?\.txt$/);
    expect(mockWriteFile.mock.calls[0][1]).toBe(buffer);
    expect(result.localPath).toBe(['task-1', 'inbox', writtenName].join('/'));
  });
});
