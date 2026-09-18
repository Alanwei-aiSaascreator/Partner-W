import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChunkDrafts, chunkNeedsEmbedding } from '@clawwork/core';
import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';
import {
  countKbChunks,
  deleteKbSource,
  findKbSourceByPath,
  getKbSource,
  ingestKbSource,
  kbChunkId,
  kbChunkStateCounts,
  listEmbeddableKbChunks,
  listKbChunks,
  readKbMeta,
  replaceKbChunks,
  saveKbChunkEmbeddings,
  searchKbChunks,
  syncKbChunkStates,
  upsertKbSource,
  writeKbMeta,
} from '../src/main/db/kb.js';
import { KB_TABLES, initKbSchema } from '../src/main/db/kb-schema.js';

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
  const contentHash = `hash-${text.length}`;
  const upserted = upsertKbSource(sqlite, {
    id: input.id ?? 'kb-note-1',
    kind: input.kind ?? 'note',
    path: input.path ?? '',
    title: '预算说明',
    contentHash,
    contentText: text,
    bytes: Buffer.byteLength(text, 'utf8'),
    addedAt: '2026-09-18T00:00:00.000Z',
  });
  const drafts = buildChunkDrafts(text, { chunkSize: 40, chunkOverlap: 10 });
  replaceKbChunks(sqlite, upserted.source.id, drafts);
  return { sourceId: upserted.source.id, drafts, contentHash };
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

  it('启动时对账 FTS 里的孤儿 rowid：不然下一个切片会撞上它、之后**每一次**入库都失败', () => {
    const sqlite = requireSqlite();
    seedSource({ id: 'kb-note-1' });
    const nextRowid = (sqlite.prepare('SELECT MAX(rowid) + 1 AS n FROM kb_chunks').get() as { n: number }).n;
    // 模拟"外部工具动过库"：往 FTS 里塞一个 kb_chunks 里并不存在的 rowid（正好是下一个行号）
    sqlite.prepare('INSERT INTO kb_chunks_fts(rowid, text) VALUES (?, ?)').run(nextRowid, '孤儿行');

    initKbSchema(sqlite); // app 每次启动都会跑这一遍（幂等）

    // 修复前：新切片复用那个 rowid ⇒ 触发器里那句 INSERT 撞 UNIQUE constraint failed，
    // 而且**不是只坏这一条**：库里从此再也存不进任何资料（用户看到"资料存不进去"）
    expect(() => seedSource({ id: 'kb-note-2' })).not.toThrow();
    expect(searchKbChunks(sqlite, '收入').length).toBeGreaterThan(0);
    const counts = sqlite
      .prepare('SELECT (SELECT COUNT(*) FROM kb_chunks) AS chunks, (SELECT COUNT(*) FROM kb_chunks_fts) AS fts')
      .get() as { chunks: number; fts: number };
    expect(counts.fts).toBe(counts.chunks); // 对账之后两边行数一致
  });

  it('kb_chunks_au 只认 text 列：写向量不再把整行 FTS 删了重插（写放大）', () => {
    const sqlite = requireSqlite();
    const { sourceId, contentHash } = seedSource({});
    const [first] = listKbChunks(sqlite, sourceId);
    const changes = (): number => Number((sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n);

    const beforeVector = changes();
    saveKbChunkEmbeddings(sqlite, [
      { id: first.id, vector: new Float32Array([1, 2]), embeddingModel: 'fake-v1', expectedContentHash: contentHash },
    ]);
    const vectorCost = changes() - beforeVector;

    const beforeText = changes();
    sqlite.prepare('UPDATE kb_chunks SET text = ? WHERE id = ?').run(`${first.text}（改过）`, first.id);
    const textCost = changes() - beforeText;

    expect(vectorCost).toBeGreaterThan(0);
    expect(listKbChunks(sqlite, sourceId)[0].vector?.length).toBe(2);
    // 旧形状（`AFTER UPDATE`，不带列限定）：一条向量更新 ≈ 11 条底层变更（DELETE + INSERT
    // 进 FTS，再算上 FTS 的影子表），跟重写一遍正文（≈12）几乎一样贵 —— 这里就会红。
    expect(vectorCost * 3).toBeLessThan(textCost);
  });

  it('老库上的 `AFTER UPDATE` 触发器会在启动时被升级成 `UPDATE OF text`', () => {
    const sqlite = requireSqlite();
    seedSource({});
    const triggerSql = (): string =>
      (
        sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'kb_chunks_au'").get() as {
          sql: string;
        }
      ).sql;

    // 把库退回老定义（触发器改定义只能先删再建，`CREATE TRIGGER IF NOT EXISTS` 不替换）
    sqlite.exec(`
      DROP TRIGGER kb_chunks_au;
      CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
        DELETE FROM kb_chunks_fts WHERE rowid = old.rowid;
        INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
    expect(triggerSql()).toMatch(/AFTER UPDATE ON kb_chunks/i);

    initKbSchema(sqlite);

    expect(triggerSql()).toMatch(/AFTER UPDATE OF text ON kb_chunks/i);
    // 升级之后 FTS 照样跟着正文走（不是"改了定义就不维护了"）
    replaceKbChunks(sqlite, 'kb-note-1', buildChunkDrafts('完全换掉的内容：季度复盘。', { chunkSize: 100 }));
    expect(searchKbChunks(sqlite, '季度复盘').length).toBe(1);
    expect(searchKbChunks(sqlite, '收入')).toHaveLength(0);
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

  it('查询太短/纯符号/裸操作符 ⇒ 空结果，不抛错', () => {
    seedSource({});

    // `'OR'` 这类以前会直接抛 `fts5: syntax error near "OR"`（这里断言的是**结果**，
    // 抛错会让整条用例红 —— 不是断言"返回值是个数组"那种糊弄）
    for (const query of ['', '   ', 'a', '！？。', 'OR', 'AND', 'NOT', 'NEAR']) {
      expect(searchKbChunks(requireSqlite(), query), `查询 ${JSON.stringify(query)}`).toEqual([]);
    }
    expect(searchKbChunks(requireSqlite(), '  预算  ').length).toBeGreaterThan(0); // 归一化后照样能搜
  });

  it('FTS 召回同分时按 ordinal 排：序号 ≥ 10000 不会因 id 的字典序插到 9999 前面', () => {
    const sqlite = requireSqlite();
    const { sourceId } = seedSource({ id: 'kb-note-1' });
    const text = '预算收入速查表';
    replaceKbChunks(sqlite, sourceId, [
      { ordinal: 10000, text, tokenEstimate: 8 },
      { ordinal: 9999, text, tokenEstimate: 8 },
    ]);

    const hits = searchKbChunks(sqlite, '预算收入');

    // 两块的正文一模一样 ⇒ bm25 同分，顺序只能由 ordinal 决定。
    // 修复前按 `c.id` 排：`kb-note-1#10000` 字典序在前 ⇒ 结果是 [10000, 9999]。
    expect(hits.map((hit) => hit.ordinal)).toEqual([9999, 10000]);
  });
});

describe('状态机与落库（真库）', () => {
  it('写入向量后能原样读回（BLOB ↔ float32），状态变 embedded', () => {
    const sqlite = requireSqlite();
    const { sourceId, contentHash } = seedSource({});
    const [first, second] = listKbChunks(sqlite, sourceId);

    const changed = saveKbChunkEmbeddings(sqlite, [
      {
        id: first.id,
        vector: new Float32Array([1.5, -2.25, 0.5]),
        embeddingModel: 'fake-v1',
        expectedContentHash: contentHash,
      },
      {
        id: second.id,
        vector: new Float32Array([0, 0, 1]),
        embeddingModel: 'fake-v1',
        expectedContentHash: contentHash,
      },
    ]);

    expect(changed).toBe(2);
    const reloaded = listKbChunks(sqlite, sourceId);
    expect(Array.from(reloaded[0].vector ?? [])).toEqual([1.5, -2.25, 0.5]);
    expect(reloaded.every((chunk) => chunk.state === 'embedded' && chunk.embeddingModel === 'fake-v1')).toBe(true);
    expect(kbChunkStateCounts(sqlite, sourceId)).toEqual({ pending_embedding: 0, embedded: 2, stale: 0 });
  });

  it('listEmbeddableKbChunks 只挑真的需要（重）嵌入的块', () => {
    const sqlite = requireSqlite();
    const { sourceId, contentHash } = seedSource({});
    const chunks = listKbChunks(sqlite, sourceId);
    saveKbChunkEmbeddings(sqlite, [
      { id: chunks[0].id, vector: new Float32Array([1]), embeddingModel: 'fake-v1', expectedContentHash: contentHash },
    ]);

    const forV1 = listEmbeddableKbChunks(sqlite, { model: 'fake-v1' });
    const forV2 = listEmbeddableKbChunks(sqlite, { model: 'fake-v2' });

    expect(forV1.map((chunk) => chunk.id)).toEqual(chunks.slice(1).map((chunk) => chunk.id));
    expect(forV2).toHaveLength(chunks.length); // 换模型 ⇒ 全都要重嵌
    expect(listEmbeddableKbChunks(sqlite, { model: 'fake-v1', sourceId: 'nope' })).toEqual([]);
  });

  it('syncKbChunkStates：只把"别的模型嵌过"的块标 stale，向量保留', () => {
    const sqlite = requireSqlite();
    const { sourceId, contentHash } = seedSource({});
    const chunks = listKbChunks(sqlite, sourceId);
    saveKbChunkEmbeddings(sqlite, [
      {
        id: chunks[0].id,
        vector: new Float32Array([1, 2]),
        embeddingModel: 'fake-v1',
        expectedContentHash: contentHash,
      },
      {
        id: chunks[1].id,
        vector: new Float32Array([3, 4]),
        embeddingModel: 'fake-v2',
        expectedContentHash: contentHash,
      },
    ]);

    expect(syncKbChunkStates(sqlite, 'fake-v2')).toEqual({ staled: 1, restored: 0 });

    const after = listKbChunks(sqlite, sourceId);
    expect(after[0].state).toBe('stale');
    expect(Array.from(after[0].vector ?? [])).toEqual([1, 2]); // 向量没被删
    expect(after[1].state).toBe('embedded');
    expect(syncKbChunkStates(sqlite, 'fake-v2')).toEqual({ staled: 0, restored: 0 }); // 幂等
  });

  it('syncKbChunkStates 是双向的：A→B→A 时把向量直接救回 embedded，不产生待嵌任务（不白花钱）', () => {
    const sqlite = requireSqlite();
    const { sourceId, contentHash } = seedSource({});
    const chunkIds = listKbChunks(sqlite, sourceId).map((chunk) => chunk.id);
    saveKbChunkEmbeddings(
      sqlite,
      chunkIds.map((id) => ({
        id,
        vector: new Float32Array([1, 0]),
        embeddingModel: 'A',
        expectedContentHash: contentHash,
      })),
    );

    // 换成 B：旧向量标 stale，B 确实要重嵌（这是真的换了模型）
    expect(syncKbChunkStates(sqlite, 'B')).toEqual({ staled: chunkIds.length, restored: 0 });
    expect(listEmbeddableKbChunks(sqlite, { model: 'B' })).toHaveLength(chunkIds.length);

    // 切回 A：向量**一直躺在库里**（就是 A 嵌的）⇒ 直接升回 embedded，一条重嵌都不该有。
    // 单向标记的实现会在这里留下 N 条待嵌 ⇒ 用户白等一遍 U 盘索引、还白花一遍积分。
    expect(syncKbChunkStates(sqlite, 'A')).toEqual({ staled: 0, restored: chunkIds.length });
    expect(listEmbeddableKbChunks(sqlite, { model: 'A' })).toEqual([]);
    expect(kbChunkStateCounts(sqlite, sourceId)).toEqual({
      pending_embedding: 0,
      embedded: chunkIds.length,
      stale: 0,
    });
    // 向量还是原来那批（没有被重算、也没有被删）
    expect(listKbChunks(sqlite, sourceId).every((chunk) => chunk.vector?.[0] === 1)).toBe(true);
  });

  it('saveKbChunkEmbeddings 按 content_hash 对账：正文换代之后，上一代的向量写不进去', () => {
    const sqlite = requireSqlite();
    const { sourceId, contentHash } = seedSource({});
    const chunkIds = listKbChunks(sqlite, sourceId).map((chunk) => chunk.id);

    // 同一份资料换了正文（切片 id 是确定性的 ⇒ 新切片占用的还是这批 id）
    upsertKbSource(sqlite, {
      id: sourceId,
      kind: 'note',
      path: '',
      title: '预算说明',
      contentHash: 'hash-新一代',
      contentText: '完全换掉的正文。',
      bytes: 18,
      addedAt: '2026-09-18T00:00:00.000Z',
    });

    const written = saveKbChunkEmbeddings(
      sqlite,
      chunkIds.map((id) => ({
        id,
        vector: new Float32Array([9, 9]),
        embeddingModel: 'slow',
        expectedContentHash: contentHash,
      })),
    );

    expect(written).toBe(0); // 一条都没写：它们已经不是"那一代正文"的切片了
    expect(
      listKbChunks(sqlite, sourceId).every((chunk) => chunk.vector === null && chunk.state === 'pending_embedding'),
    ).toBe(true);
    // 正文没换代的块照常写得进去（对照组：不是"这个函数坏了"）
    expect(
      saveKbChunkEmbeddings(sqlite, [
        {
          id: chunkIds[0],
          vector: new Float32Array([9, 9]),
          embeddingModel: 'slow',
          expectedContentHash: 'hash-新一代',
        },
      ]),
    ).toBe(1);
  });

  it('ingestKbSource：更新资料与替换切片同一个事务 —— 第二步炸了连 hash 都不许变', () => {
    const sqlite = requireSqlite();
    const { sourceId, contentHash, drafts } = seedSource({});
    const before = listKbChunks(sqlite, sourceId).map((chunk) => chunk.text);

    expect(() =>
      ingestKbSource(
        sqlite,
        {
          id: sourceId,
          kind: 'note',
          path: '',
          title: '预算说明',
          contentHash: 'hash-新正文',
          contentText: '新正文。',
          bytes: 12,
          addedAt: '2026-09-18T00:00:00.000Z',
        },
        // 重切这一步故意崩（模拟"两步之间"出问题：U 盘被拔、进程被杀）
        () => {
          throw new Error('重切崩了');
        },
      ),
    ).toThrow('重切崩了');

    // 关键：content_hash **没有**变成新的 —— 否则之后每次 addFile 都会因为
    // "hash 没变"直接返回 unchanged，用户以为存进去了，检索到的还是上一代正文
    expect(getKbSource(sqlite, sourceId)?.contentHash).toBe(contentHash);
    expect(getKbSource(sqlite, sourceId)?.contentText).toBe(NOTE_TEXT);
    expect(listKbChunks(sqlite, sourceId).map((chunk) => chunk.text)).toEqual(before);
    expect(drafts.length).toBeGreaterThan(0);
  });

  it('"该不该重嵌"只有一份口径：SQL 粗筛与 core 的 chunkNeedsEmbedding 逐行一致', () => {
    // 两处实现（store 的 SQL WHERE / core 的纯函数）以后各改各的就会漂移 ——
    // 一旦漂移，要么漏嵌（检索悄悄变差）、要么重嵌（白花积分）。这里拿同一批
    // 真实行、两条路径逐个模型对照。
    const sqlite = requireSqlite();
    // 三个小节 ⇒ 恰好三块（chunkSize 40）：一块 A、一块 B、一块留在 pending
    const { sourceId, contentHash } = seedSource({
      text: [
        '# 预算说明',
        '',
        '第三章讲的是收入与支出，这一节先讲口径。',
        '',
        '## 收入',
        '',
        '收入主要来自软件订阅与授权，其次是服务。',
        '',
        '## 支出',
        '',
        '支出主要是算力与人力成本。',
      ].join('\n'),
    });
    const chunks = listKbChunks(sqlite, sourceId);
    expect(chunks).toHaveLength(3);
    saveKbChunkEmbeddings(sqlite, [
      { id: chunks[0].id, vector: new Float32Array([1]), embeddingModel: 'A', expectedContentHash: contentHash },
      { id: chunks[1].id, vector: new Float32Array([1]), embeddingModel: 'B', expectedContentHash: contentHash },
    ]); // chunks[2] 故意留在 pending_embedding

    for (const model of ['A', 'B']) {
      const bySql = listEmbeddableKbChunks(sqlite, { model }).map((chunk) => chunk.id);
      const byCore = listKbChunks(sqlite, sourceId)
        .filter((chunk) => chunkNeedsEmbedding(chunk, model))
        .map((chunk) => chunk.id);
      expect(bySql, `模型 ${model}`).toEqual(byCore);
    }
    expect(listKbChunks(sqlite, sourceId)).toHaveLength(3); // 三种状态都真的存在（不是空集对空集）
    expect(listEmbeddableKbChunks(sqlite, { model: 'A' })).toHaveLength(2);
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
