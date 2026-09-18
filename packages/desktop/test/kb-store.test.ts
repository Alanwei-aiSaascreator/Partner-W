import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChunkDrafts } from '@clawwork/core';
import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';
import {
  countKbChunks,
  deleteKbSource,
  findKbSourceByPath,
  getKbSource,
  kbChunkId,
  kbChunkStateCounts,
  listEmbeddableKbChunks,
  listKbChunks,
  markKbChunksStale,
  readKbMeta,
  replaceKbChunks,
  saveKbChunkEmbeddings,
  searchKbChunks,
  upsertKbSource,
  writeKbMeta,
} from '../src/main/db/kb.js';
import { KB_TABLES } from '../src/main/db/kb-schema.js';

/**
 * 资料库落库层跑在**真 SQLite** 上（DDL / FTS5 触发器 / 外键 / 事务全都是真执行）。
 *
 * ⚠️ 为什么必须用 `node:sqlite` 替身：`better-sqlite3` 是按 Electron ABI 编的，
 *    vitest 里加载即崩（详见 test/helpers/node-sqlite-shim.ts）。替身只换驱动，
 *    SQL 一行不打折 —— 否则"FTS 命中""级联删除""事务回滚"这些断言全是空话。
 */
vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

function requireSqlite() {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('工作区库未初始化');
  return sqlite;
}

const NOTE_TEXT = ['# 预算说明', '', '第三章讲的是收入与支出。', '', '## 收入', '', '收入主要来自软件订阅。'].join(
  '\n',
);

function seedSource(input: { id?: string; kind?: 'file' | 'artifact' | 'note'; path?: string; text?: string }) {
  const sqlite = requireSqlite();
  const text = input.text ?? NOTE_TEXT;
  const upserted = upsertKbSource(sqlite, {
    id: input.id ?? 'kb-note-1',
    kind: input.kind ?? 'note',
    path: input.path ?? '',
    title: '预算说明',
    contentHash: `hash-${text.length}`,
    contentText: text,
    bytes: Buffer.byteLength(text, 'utf8'),
    addedAt: '2026-09-18T00:00:00.000Z',
  });
  const drafts = buildChunkDrafts(text, { chunkSize: 40, chunkOverlap: 10 });
  replaceKbChunks(sqlite, upserted.source.id, drafts);
  return { sourceId: upserted.source.id, drafts };
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'clawwork-kb-store-'));
  initDatabase(workspace);
});

afterEach(() => {
  closeDatabase();
  rmSync(workspace, { recursive: true, force: true });
});

describe('kb 表结构（工作区库，不是服务器）', () => {
  it('三张表都建好，列名与设计一致', () => {
    const sqlite = requireSqlite();
    const columnsOf = (table: string): string[] =>
      (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);

    for (const table of KB_TABLES) {
      const found = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      expect(found, `缺表 ${table}`).toBeTruthy();
    }

    expect(columnsOf('kb_meta')).toEqual(['id', 'embedding_model', 'dim', 'updated_at']);
    expect(columnsOf('kb_sources')).toEqual([
      'id',
      'kind',
      'path',
      'title',
      'content_hash',
      'content_text',
      'added_at',
      'bytes',
    ]);
    expect(columnsOf('kb_chunks')).toEqual([
      'id',
      'source_id',
      'ordinal',
      'text',
      'token_estimate',
      'vector',
      'embedding_model',
      'state',
    ]);
    expect(columnsOf('kb_chunks_fts')).toContain('text');
  });

  it('kind / state 有 CHECK 兜底，写脏值当场报错', () => {
    const sqlite = requireSqlite();

    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO kb_sources (id, kind, path, title, content_hash, content_text, added_at, bytes)
           VALUES ('x', 'cloud', '', 't', 'h', 'c', '2026-09-18T00:00:00.000Z', 0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);

    seedSource({});
    const chunkId = kbChunkId('kb-note-1', 0);
    expect(() => sqlite.prepare(`UPDATE kb_chunks SET state = 'vectorized' WHERE id = ?`).run(chunkId)).toThrow(
      /CHECK constraint failed/i,
    );
  });

  it('同一份资料重复入库落到同一行（(kind, path) 唯一）', () => {
    const sqlite = requireSqlite();
    const first = seedSource({ id: 'kb-file-1', kind: 'file', path: '/udisk/预算.md' });
    const second = upsertKbSource(sqlite, {
      id: 'kb-file-2', // 不同的 id
      kind: 'file',
      path: '/udisk/预算.md',
      title: '预算.md',
      contentHash: 'hash-2',
      contentText: '改过的正文',
      bytes: 12,
    });

    expect(second.created).toBe(false);
    expect(second.contentChanged).toBe(true);
    expect(second.source.id).toBe(first.sourceId); // 落回原来那一行
    expect(getKbSource(sqlite, 'kb-file-2')).toBeNull();
    expect(findKbSourceByPath(sqlite, 'file', '/udisk/预算.md')?.contentText).toBe('改过的正文');
  });

  it('重新打开同一个工作区库：数据在、FTS 不重复回填', () => {
    const { sourceId } = seedSource({});
    const before = countKbChunks(requireSqlite(), sourceId);
    const ftsBefore = requireSqlite().prepare('SELECT COUNT(*) AS count FROM kb_chunks_fts').get() as { count: number };

    closeDatabase();
    initDatabase(workspace); // 老库补表 + FTS 回填这条路径

    expect(countKbChunks(requireSqlite(), sourceId)).toBe(before);
    const ftsAfter = requireSqlite().prepare('SELECT COUNT(*) AS count FROM kb_chunks_fts').get() as { count: number };
    expect(ftsAfter.count).toBe(ftsBefore.count);
    expect(searchKbChunks(requireSqlite(), '收入').length).toBeGreaterThan(0);
  });
});

describe('关键词检索：没有向量也必须能用（降级路径）', () => {
  it('新索引的切片全是 pending、一个向量都没有，FTS 照样命中', () => {
    const { sourceId } = seedSource({});

    const chunks = listKbChunks(requireSqlite(), sourceId);
    expect(chunks.every((chunk) => chunk.vector === null && chunk.state === 'pending_embedding')).toBe(true);

    const hits = searchKbChunks(requireSqlite(), '收入');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.vector === null && hit.state === 'pending_embedding')).toBe(true);
    expect(hits[0]).toMatchObject({ sourceId, sourceKind: 'note', sourceTitle: '预算说明' });
    expect(hits[0].snippet).toContain('<<收入>>');
    expect(hits[0].keywordScore).toBeGreaterThan(0);
  });

  it('标题路径前缀也进了索引（搜标题名能命中该标题下的每一块）', () => {
    const { sourceId } = seedSource({});
    const chunks = listKbChunks(requireSqlite(), sourceId);

    const hits = searchKbChunks(requireSqlite(), '预算说明');

    expect(chunks.length).toBeGreaterThan(1);
    expect(hits).toHaveLength(chunks.length);
    expect(hits.every((hit) => hit.text.startsWith('【所属：预算说明'))).toBe(true);
  });

  it('已知边界：unicode61 不切中文词，只有"词首前缀"命中（喂给 T6c 的调优点）', () => {
    // 实测（SQLite 3.53，unicode61）：'收入主要来自软件订阅' 是**一整个 token**，
    // 所以 `收入*` 命中、`订阅` 命中不了。这与仓库既有 messages_fts/tasks_fts 的行为
    // 完全一致（它们也用 unicode61），不是资料库独有的毛病。
    // ⇒ T6c 若发现中文命中率不达标，这里就是第一处要动的地方（两个候选：给 FTS 存
    //    一份"中文字间插空格"的文本，或改用 trigram —— 后者实测对 2 字词无效）。
    seedSource({});

    expect(searchKbChunks(requireSqlite(), '收入').length).toBeGreaterThan(0);
    expect(searchKbChunks(requireSqlite(), '订阅')).toHaveLength(0);
  });

  it('触发器让增/改/删都同步到 FTS（不是只在建表时灌一次）', () => {
    const sqlite = requireSqlite();
    const { sourceId } = seedSource({});
    expect(searchKbChunks(sqlite, '收入').length).toBeGreaterThan(0);

    replaceKbChunks(sqlite, sourceId, buildChunkDrafts('完全换掉的内容：季度复盘。', { chunkSize: 100 }));
    expect(searchKbChunks(sqlite, '收入')).toHaveLength(0);
    expect(searchKbChunks(sqlite, '季度复盘').length).toBe(1);

    deleteKbSource(sqlite, sourceId);
    expect(searchKbChunks(sqlite, '季度复盘')).toHaveLength(0);
    const remaining = sqlite.prepare('SELECT COUNT(*) AS count FROM kb_chunks_fts').get() as { count: number };
    expect(remaining.count).toBe(0);
  });

  it('删 source ⇒ 切片级联删掉', () => {
    const sqlite = requireSqlite();
    const { sourceId } = seedSource({});
    expect(countKbChunks(sqlite, sourceId)).toBeGreaterThan(0);

    expect(deleteKbSource(sqlite, sourceId)).toBe(true);

    expect(countKbChunks(sqlite, sourceId)).toBe(0);
    expect(listKbChunks(sqlite, sourceId)).toEqual([]);
  });

  it('查询太短/纯符号/空串 ⇒ 空结果，不抛错', () => {
    seedSource({});

    for (const query of ['', '   ', 'a', '！？。', '  预算  ']) {
      const hits = searchKbChunks(requireSqlite(), query);
      expect(Array.isArray(hits)).toBe(true);
    }
    expect(searchKbChunks(requireSqlite(), '')).toEqual([]);
    expect(searchKbChunks(requireSqlite(), '  预算  ').length).toBeGreaterThan(0); // 归一化后照样能搜
  });
});

describe('状态机与落库（真库）', () => {
  it('写入向量后能原样读回（BLOB ↔ float32），状态变 embedded', () => {
    const sqlite = requireSqlite();
    const { sourceId } = seedSource({});
    const [first, second] = listKbChunks(sqlite, sourceId);

    const changed = saveKbChunkEmbeddings(sqlite, [
      { id: first.id, vector: new Float32Array([1.5, -2.25, 0.5]), embeddingModel: 'fake-v1' },
      { id: second.id, vector: new Float32Array([0, 0, 1]), embeddingModel: 'fake-v1' },
    ]);

    expect(changed).toBe(2);
    const reloaded = listKbChunks(sqlite, sourceId);
    expect(Array.from(reloaded[0].vector ?? [])).toEqual([1.5, -2.25, 0.5]);
    expect(reloaded.every((chunk) => chunk.state === 'embedded' && chunk.embeddingModel === 'fake-v1')).toBe(true);
    expect(kbChunkStateCounts(sqlite, sourceId)).toEqual({ pending_embedding: 0, embedded: 2, stale: 0 });
  });

  it('listEmbeddableKbChunks 只挑真的需要（重）嵌入的块', () => {
    const sqlite = requireSqlite();
    const { sourceId } = seedSource({});
    const chunks = listKbChunks(sqlite, sourceId);
    saveKbChunkEmbeddings(sqlite, [{ id: chunks[0].id, vector: new Float32Array([1]), embeddingModel: 'fake-v1' }]);

    const forV1 = listEmbeddableKbChunks(sqlite, { model: 'fake-v1' });
    const forV2 = listEmbeddableKbChunks(sqlite, { model: 'fake-v2' });

    expect(forV1.map((chunk) => chunk.id)).toEqual(chunks.slice(1).map((chunk) => chunk.id));
    expect(forV2).toHaveLength(chunks.length); // 换模型 ⇒ 全都要重嵌
    expect(listEmbeddableKbChunks(sqlite, { model: 'fake-v1', sourceId: 'nope' })).toEqual([]);
  });

  it('markKbChunksStale：只把"别的模型嵌过"的块标 stale，向量保留', () => {
    const sqlite = requireSqlite();
    const { sourceId } = seedSource({});
    const chunks = listKbChunks(sqlite, sourceId);
    saveKbChunkEmbeddings(sqlite, [
      { id: chunks[0].id, vector: new Float32Array([1, 2]), embeddingModel: 'fake-v1' },
      { id: chunks[1].id, vector: new Float32Array([3, 4]), embeddingModel: 'fake-v2' },
    ]);

    expect(markKbChunksStale(sqlite, 'fake-v2')).toBe(1);

    const after = listKbChunks(sqlite, sourceId);
    expect(after[0].state).toBe('stale');
    expect(Array.from(after[0].vector ?? [])).toEqual([1, 2]); // 向量没被删
    expect(after[1].state).toBe('embedded');
    expect(markKbChunksStale(sqlite, 'fake-v2')).toBe(0); // 幂等
  });

  it('replaceKbChunks 是事务：中途失败不留半份索引（旧切片原样还在）', () => {
    const sqlite = requireSqlite();
    const { sourceId, drafts } = seedSource({});
    const before = listKbChunks(sqlite, sourceId);

    expect(() =>
      replaceKbChunks(sqlite, sourceId, [
        { ordinal: 0, text: '新文本', tokenEstimate: 1 },
        { ordinal: 0, text: '撞 ordinal 的第二条', tokenEstimate: 1 },
      ]),
    ).toThrow(/UNIQUE constraint failed/i);

    expect(listKbChunks(sqlite, sourceId).map((chunk) => chunk.text)).toEqual(before.map((chunk) => chunk.text));
    expect(listKbChunks(sqlite, sourceId)).toHaveLength(drafts.length);
  });

  it('删掉 chunks 再重建 ⇒ 逐行一致（id/序号/文本/token/状态），FTS 同步重建', () => {
    const sqlite = requireSqlite();
    const { sourceId } = seedSource({});
    const snapshot = (): unknown[] =>
      listKbChunks(sqlite, sourceId).map(({ id, ordinal, text, tokenEstimate, state, vector, embeddingModel }) => ({
        id,
        ordinal,
        text,
        tokenEstimate,
        state,
        vector: vector ? Array.from(vector) : null,
        embeddingModel,
      }));
    const before = snapshot();

    sqlite.prepare('DELETE FROM kb_chunks WHERE source_id = ?').run(sourceId);
    expect(countKbChunks(sqlite, sourceId)).toBe(0);

    const source = getKbSource(sqlite, sourceId);
    replaceKbChunks(sqlite, sourceId, buildChunkDrafts(source?.contentText ?? '', { chunkSize: 40, chunkOverlap: 10 }));

    expect(snapshot()).toEqual(before);
    expect(searchKbChunks(sqlite, '收入').length).toBeGreaterThan(0);
  });

  it('kb_meta：未配置嵌入时模型为 null（默认走 FTS），写读一致', () => {
    const sqlite = requireSqlite();

    expect(readKbMeta(sqlite)).toEqual({ embeddingModel: null, dim: null, updatedAt: '' });

    writeKbMeta(sqlite, { embeddingModel: 'fake-v1', dim: 768 }, '2026-09-18T01:00:00.000Z');

    expect(readKbMeta(sqlite)).toEqual({
      embeddingModel: 'fake-v1',
      dim: 768,
      updatedAt: '2026-09-18T01:00:00.000Z',
    });

    writeKbMeta(sqlite, { embeddingModel: null, dim: null }, '2026-09-18T02:00:00.000Z');
    expect(readKbMeta(sqlite).embeddingModel).toBeNull();
  });
});
