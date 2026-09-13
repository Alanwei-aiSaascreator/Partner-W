import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase, reinitDatabase, closeDatabase } from '../src/main/db/index.js';
import Database from 'better-sqlite3';

const mockDbInstance = {
  pragma: vi.fn(),
  exec: vi.fn(),
  close: vi.fn(),
};

vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => mockDbInstance),
}));

describe('initDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
  });

  it('opens database on first call', () => {
    expect(() => initDatabase('/tmp/workspace-a')).not.toThrow();
    expect(Database).toHaveBeenCalled();
  });

  // 消息级 model 列：老库靠这条 ALTER 补列（新库在 CREATE TABLE 里就有）。
  // 两份 DDL 缺一不可 —— 少了它，老用户升级后这一列永远不存在。
  it('adds the per-message model column on existing databases', () => {
    initDatabase('/tmp/workspace-a');

    // ⚠️ 别写成 `ADD COLUMN model` 就完事 —— tasks 表也有一列叫 model。
    const alterSql = mockDbInstance.exec.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('ALTER TABLE messages ADD COLUMN model'));

    expect(alterSql).toContain('ALTER TABLE messages ADD COLUMN model TEXT');
  });

  it('does not purge media-only assistant messages during startup cleanup', () => {
    initDatabase('/tmp/workspace-a');

    const cleanupSql = mockDbInstance.exec.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('DELETE FROM messages'));

    expect(cleanupSql).toContain("COALESCE(image_attachments, '') = ''");
    expect(cleanupSql).toContain("COALESCE(tool_calls, '') = ''");
    expect(cleanupSql).toContain('NOT EXISTS');
    expect(cleanupSql).toContain('artifacts.message_id = messages.id');
  });

  it('returns early when called with same path', () => {
    initDatabase('/tmp/workspace-a');
    vi.clearAllMocks();
    expect(() => initDatabase('/tmp/workspace-a')).not.toThrow();
    expect(Database).not.toHaveBeenCalled();
  });

  it('returns early when called with an equivalent resolved path', () => {
    initDatabase('/tmp/workspace-a');
    vi.clearAllMocks();
    expect(() => initDatabase('/tmp/workspace-a/')).not.toThrow();
    expect(Database).not.toHaveBeenCalled();
  });

  it('throws when called with different workspace path', () => {
    initDatabase('/tmp/workspace-a');
    expect(() => initDatabase('/tmp/workspace-b')).toThrow(
      'initDatabase called with different workspace path; use reinitDatabase to switch',
    );
  });

  it('allows init after close', () => {
    initDatabase('/tmp/workspace-a');
    closeDatabase();
    vi.clearAllMocks();
    expect(() => initDatabase('/tmp/workspace-b')).not.toThrow();
  });

  it('throws when init is called with old path after reinit with new path', () => {
    initDatabase('/tmp/workspace-a');
    reinitDatabase('/tmp/workspace-b');
    expect(() => initDatabase('/tmp/workspace-a')).toThrow(
      'initDatabase called with different workspace path; use reinitDatabase to switch',
    );
  });

  it('ignores duplicate column errors during ALTER TABLE migrations', () => {
    mockDbInstance.exec.mockImplementation((sql: string) => {
      if (sql.includes('ADD COLUMN')) {
        throw new Error('SQLITE_ERROR: duplicate column name: gateway_id');
      }
    });

    expect(() => initDatabase('/tmp/workspace-a')).not.toThrow();
  });

  it('propagates non-duplicate ALTER TABLE migration errors', () => {
    mockDbInstance.exec.mockImplementation((sql: string) => {
      if (sql.includes('ADD COLUMN')) {
        throw new Error('SQLITE_ERROR: near "BOGUS": syntax error');
      }
    });

    expect(() => initDatabase('/tmp/workspace-a')).toThrow('syntax error');
  });
});
