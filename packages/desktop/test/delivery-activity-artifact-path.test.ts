import { describe, expect, it, vi } from 'vitest';

/**
 * BUG-041 ④：交付活动（证据链）里"产物在哪个目录"改用 `root + local_path` **重新解析**。
 *
 * 为什么：`file_path` 是登记那一刻的绝对路径，**盘符一变（E: → G:）就是死路径** ——
 * 而这条链要按目录去读收据（slidegen receipt）来证明"这轮真的产出了什么"。
 * `root + local_path` 能跟着当前工作区走（与 `artifact-handlers.ts` 同款解析）。
 *
 * ⚠️ `root === 'agent'` **不猜**：助手工作区要去 RPC 问（这里是同步事务，问不了），
 *    猜错方向恰好是"把别的目录的文件当成这个任务的产物"。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\fake\\userdata') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
}));
vi.mock('better-sqlite3', () => ({
  default: class UnusedDatabase {
    constructor() {
      throw new Error('本用例不碰数据库');
    }
  },
}));

import { artifactDirectoryFor } from '../src/main/db/delivery-activities.js';

describe('artifactDirectoryFor', () => {
  it('⭐ workspace 根：按当前工作区 + local_path 解析（盘符变了也指对）', () => {
    expect(
      artifactDirectoryFor(
        {
          root: 'workspace',
          local_path: 'task-1/report.pptx',
          file_path: 'E:\\Partner-W工作区\\task-1\\report.pptx',
        },
        'G:\\Partner-W工作区',
      ),
    ).toBe('G:\\Partner-W工作区\\task-1');
  });

  it('⭐ agent 根：不猜 —— 保留老行为（dirname(file_path)）', () => {
    expect(
      artifactDirectoryFor(
        { root: 'agent', local_path: 'report.pptx', file_path: 'E:\\agent-ws\\report.pptx' },
        'G:\\Partner-W工作区',
      ),
    ).toBe('E:\\agent-ws');
  });

  it('没有工作区（配置读不到）⇒ 回落 file_path 的目录（老行为）', () => {
    expect(
      artifactDirectoryFor(
        { root: 'workspace', local_path: 'task-1/report.pptx', file_path: 'E:\\ws\\task-1\\report.pptx' },
        null,
      ),
    ).toBe('E:\\ws\\task-1');
  });

  it('⭐ 逃逸/绝对路径的 local_path ⇒ 回落 file_path（词法边界，绝不解析到工作区外）', () => {
    const file = 'E:\\ws\\task-1\\report.pptx';
    for (const localPath of ['..\\..\\Windows\\System32\\x.pptx', 'C:\\elsewhere\\x.pptx', '']) {
      expect(artifactDirectoryFor({ root: 'workspace', local_path: localPath, file_path: file }, 'G:\\ws')).toBe(
        'E:\\ws\\task-1',
      );
    }
  });
});
