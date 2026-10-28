import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChunkDrafts } from '@clawwork/core';
import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';
import { replaceKbChunks, searchKbChunks, upsertKbSource } from '../src/main/db/kb.js';
import { globalSearch, toFtsPrefixQuery } from '../src/main/db/search.js';

/**
 * 查询归一化（`toFtsPrefixQuery`）—— 资料库关键词检索与**既有全局搜索**共用同一个入口。
 *
 * 要钉住的是"用户随手敲的东西不能让检索整个炸掉"：FTS5 的布尔操作符（AND/OR/NOT/NEAR）
 * 裸露地拼进 `MATCH` 是**语法错误**，而这两个入口以前是原样拼的 ⇒ 查询 `OR` 直接抛
 * `fts5: syntax error near "OR"`。修法是给这类 token 加引号当字面词：既不抛错，
 * 又能真的搜到正文里写着 OR 的那些行（比"整条丢弃"更好 —— 丢了他就永远搜不到）。
 */
vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

function requireSqlite() {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('工作区库未初始化');
  return sqlite;
}

/** 正文里**真的有** 'OR' 这个词（unicode61 会把它切成一个 token、并折叠成小写）。 */
const TEXT_WITH_OPERATOR = ['# 写法', '', '条件写成 A OR B，别写成 AND。'].join('\n');

function seedKbSource(id: string, text: string): string {
  const sqlite = requireSqlite();
  const upserted = upsertKbSource(sqlite, {
    id,
    kind: 'note',
    path: '',
    title: id,
    contentHash: `hash-${text.length}`,
    contentText: text,
    bytes: Buffer.byteLength(text, 'utf8'),
    addedAt: '2026-09-18T00:00:00.000Z',
  });
  replaceKbChunks(sqlite, upserted.source.id, buildChunkDrafts(text, { chunkSize: 200 }));
  return upserted.source.id;
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'clawwork-kb-fts-query-'));
  initDatabase(workspace);
});

afterEach(() => {
  closeDatabase();
  rmSync(workspace, { recursive: true, force: true });
});

describe('toFtsPrefixQuery：操作符不再让 MATCH 语法错误', () => {
  it('裸操作符被引号包起来当字面词（不是丢弃）', () => {
    expect(toFtsPrefixQuery('OR')).toBe('"OR"*');
    expect(toFtsPrefixQuery('AND')).toBe('"AND"*');
    expect(toFtsPrefixQuery('NOT')).toBe('"NOT"*');
    expect(toFtsPrefixQuery('NEAR')).toBe('"NEAR"*');
  });

  it('和别的词混在一起时只包裹操作符那一个 token，其余原样', () => {
    expect(toFtsPrefixQuery('AND 预算')).toBe('"AND"* 预算*');
    expect(toFtsPrefixQuery('  OR   预算  ')).toBe('"OR"* 预算*');
  });

  it('大小写敏感：小写的 or 在 FTS5 里是普通词，不加引号（行为一字不变）', () => {
    expect(toFtsPrefixQuery('or')).toBe('or*');
    expect(toFtsPrefixQuery('And 预算')).toBe('And* 预算*');
  });

  it('非操作符 token 一字不改（每个 token 各自前缀匹配）', () => {
    expect(toFtsPrefixQuery('render')).toBe('render*');
    expect(toFtsPrefixQuery('预算 收入')).toBe('预算* 收入*');
    expect(toFtsPrefixQuery('café')).toBe('café*');
  });

  it('空/太短/纯符号仍然返回 null（一个 FTS 查询都不发）', () => {
    for (const query of ['', '   ', 'a', '！？。']) expect(toFtsPrefixQuery(query)).toBeNull();
  });
});

describe('资料库关键词检索：操作符查询不炸，且能命中字面词', () => {
  it('正文里真的有 OR ⇒ 搜得到（不是返回空）', () => {
    seedKbSource('kb-note-or', TEXT_WITH_OPERATOR);

    const hits = searchKbChunks(requireSqlite(), 'OR');

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain('A OR B');
  });

  it('正文里没有 OR ⇒ 空结果，但**不抛错**（修复前这里抛 fts5 syntax error）', () => {
    seedKbSource('kb-note-plain', ['# 预算说明', '', '第三章讲的是收入与支出。'].join('\n'));

    for (const query of ['OR', 'AND', 'NOT', 'NEAR', 'AND 预算', 'NOT 预算']) {
      expect(searchKbChunks(requireSqlite(), query), `查询 ${query}`).toEqual([]);
    }
    // 同一个库、同一个函数：正常查询照样命中（不是"整条路坏了"）
    expect(searchKbChunks(requireSqlite(), '预算').length).toBeGreaterThan(0);
  });
});

describe('既有全局搜索走的是同一个 helper（同一个缺陷，一起修）', () => {
  function seedTask(id: string, title: string): void {
    requireSqlite()
      .prepare(
        `INSERT INTO tasks (id, session_key, session_id, title, status, created_at, updated_at, tags, artifact_dir, gateway_id)
         VALUES (?, ?, '', ?, 'active', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z', '[]', '', '')`,
      )
      .run(id, `session-${id}`, title);
  }

  it('globalSearch(OR) 不抛错，并且能搜到标题里写着 OR 的任务', () => {
    seedTask('task-plain', '季度预算复盘');
    seedTask('task-operator', 'OR 条件怎么写');

    const results = globalSearch(requireSqlite() as never, 'OR');

    expect(results.map((item) => item.id)).toContain('task-operator');
  });

  it('没有命中时 globalSearch(OR/AND/NOT) 返回空数组而不是异常', () => {
    // 标题故意**以**「预算」开头：unicode61 不切中文词，只有词首前缀才命中（见 kb-store 那条边界）
    seedTask('task-plain', '预算复盘');

    for (const query of ['OR', 'AND', 'NOT', 'AND 预算']) {
      expect(globalSearch(requireSqlite() as never, query), `查询 ${query}`).toEqual([]);
    }
    expect(globalSearch(requireSqlite() as never, '预算').length).toBeGreaterThan(0);
  });
});
