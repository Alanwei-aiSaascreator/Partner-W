import type Database from 'better-sqlite3';
import {
  decodeVector,
  encodeVector,
  isKbChunkState,
  type KbChunkDraft,
  type KbChunkState,
  type KbEmbeddableChunk,
  type KbSearchCandidate,
  type KbSourceKind,
} from '@clawwork/core';
import { toFtsPrefixQuery } from './search.js';

/**
 * 资料库的落库层（工作区库里的 kb_* 三张表 + FTS5）。
 *
 * 并发 / U 盘安全策略（设计 §八，能写清楚边界比"加了锁"更重要）：
 * - **一次写入一个事务**：切片替换、批量写向量都包在 `BEGIN IMMEDIATE ... COMMIT` 里。
 *   半途崩（U 盘被拔出、进程被杀）由 SQLite 的 WAL 回滚保证"要么全有、要么全无"，
 *   不会留下半份索引；`kb_sources` 是真相，chunks 随时可重建。
 * - `BEGIN IMMEDIATE` 而不是 `BEGIN`：写事务一上来就拿写锁，避免两个进程同时从读
 *   升级成写时的死锁（SQLITE_BUSY 升级失败）；配合 `busy_timeout`（见 db/index.ts）
 *   等一会儿重试，而不是立刻报错。
 * - **已知边界（不打算在 T6a 解）**：两台机器同时挂同一个 U 盘/工作区，是"同一份库
 *   两个写者"。SQLite 能保证**不写坏**（页级原子 + 回滚），但保证不了"逻辑上谁赢" ——
 *   两个进程同时给同一份资料重建索引时，后提交的那份生效（切片 id 是
 *   `sourceId#ordinal` 的确定性命名，所以结果等价，不会新旧掺半）。
 *   "同一工作区只允许一个实例"仍由既有的单实例锁负责。
 */

export interface KbMetaRecord {
  embeddingModel: string | null;
  dim: number | null;
  updatedAt: string;
}

export interface KbSourceRecord {
  id: string;
  kind: KbSourceKind;
  path: string;
  title: string;
  contentHash: string;
  contentText: string;
  addedAt: string;
  bytes: number;
}

export interface UpsertKbSourceInput {
  id: string;
  kind: KbSourceKind;
  path: string;
  title: string;
  contentHash: string;
  contentText: string;
  bytes: number;
  addedAt?: string;
}

export interface UpsertKbSourceResult {
  /** 实际落库的那一行（可能命中已有的同 kind+path 行，id 与传入的不同）。 */
  source: KbSourceRecord;
  created: boolean;
  /** 正文指纹变了（`false` = 内容没动，调用方可以跳过重切/重嵌）。 */
  contentChanged: boolean;
}

export interface KbChunkRow extends KbEmbeddableChunk {
  sourceId: string;
  tokenEstimate: number;
}

/** 关键词召回的一行：切片 + 出处（`KbSearchCandidate` 就是 `rankKbCandidates` 的入参）。 */
export type KbChunkHit = KbSearchCandidate;

interface KbSourceSqlRow {
  id: string;
  kind: string;
  path: string;
  title: string;
  content_hash: string;
  content_text: string;
  added_at: string;
  bytes: number;
}

interface KbChunkSqlRow {
  id: string;
  source_id: string;
  ordinal: number;
  text: string;
  token_estimate: number;
  vector: Uint8Array | null;
  embedding_model: string | null;
  state: string;
}

const SOURCE_COLUMNS = 'id, kind, path, title, content_hash, content_text, added_at, bytes';
const CHUNK_COLUMNS = 'id, source_id, ordinal, text, token_estimate, vector, embedding_model, state';

function isSourceKind(value: string): value is KbSourceKind {
  return value === 'file' || value === 'artifact' || value === 'note';
}

function mapSourceRow(row: KbSourceSqlRow): KbSourceRecord {
  if (!isSourceKind(row.kind)) throw new Error(`kb_sources.kind 非法：${row.kind}`);
  return {
    id: row.id,
    kind: row.kind,
    path: row.path,
    title: row.title,
    contentHash: row.content_hash,
    contentText: row.content_text,
    addedAt: row.added_at,
    bytes: row.bytes,
  };
}

function mapChunkRow(row: KbChunkSqlRow): KbChunkRow {
  if (!isKbChunkState(row.state)) throw new Error(`kb_chunks.state 非法：${row.state}`);
  return {
    id: row.id,
    sourceId: row.source_id,
    ordinal: row.ordinal,
    text: row.text,
    tokenEstimate: row.token_estimate,
    vector: row.vector ? decodeVector(row.vector) : null,
    embeddingModel: row.embedding_model,
    state: row.state,
  };
}

/**
 * 写事务。`BEGIN IMMEDIATE` 的取舍见文件头注释。
 * 回滚失败（例如连接已经断了）**不再掩盖原始错误** —— 抛出的一定是业务错误本身。
 */
function withTransaction<T>(sqlite: Database.Database, work: () => T): T {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      // 事务已经因为连接问题结束了；原始错误更重要
    }
    throw error;
  }
}

/** 切片 id：确定性命名（`sourceId#序号`），所以重建出来的 id 与重建前一模一样。 */
export function kbChunkId(sourceId: string, ordinal: number): string {
  return `${sourceId}#${String(ordinal).padStart(4, '0')}`;
}

export function readKbMeta(sqlite: Database.Database): KbMetaRecord {
  const row = sqlite.prepare('SELECT embedding_model, dim, updated_at FROM kb_meta WHERE id = 1').get() as
    | { embedding_model: string | null; dim: number | null; updated_at: string }
    | undefined;
  if (!row) return { embeddingModel: null, dim: null, updatedAt: '' };
  return { embeddingModel: row.embedding_model, dim: row.dim, updatedAt: row.updated_at };
}

export function writeKbMeta(
  sqlite: Database.Database,
  input: { embeddingModel: string | null; dim: number | null },
  now: string = new Date().toISOString(),
): void {
  sqlite
    .prepare(
      `INSERT INTO kb_meta (id, embedding_model, dim, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         embedding_model = excluded.embedding_model,
         dim = excluded.dim,
         updated_at = excluded.updated_at`,
    )
    .run(input.embeddingModel, input.dim, now);
}

export function getKbSource(sqlite: Database.Database, id: string): KbSourceRecord | null {
  const row = sqlite.prepare(`SELECT ${SOURCE_COLUMNS} FROM kb_sources WHERE id = ?`).get(id) as
    | KbSourceSqlRow
    | undefined;
  return row ? mapSourceRow(row) : null;
}

export function findKbSourceByPath(sqlite: Database.Database, kind: KbSourceKind, path: string): KbSourceRecord | null {
  if (!path) return null;
  const row = sqlite.prepare(`SELECT ${SOURCE_COLUMNS} FROM kb_sources WHERE kind = ? AND path = ?`).get(kind, path) as
    | KbSourceSqlRow
    | undefined;
  return row ? mapSourceRow(row) : null;
}

export function listKbSources(sqlite: Database.Database): KbSourceRecord[] {
  const rows = sqlite
    .prepare(`SELECT ${SOURCE_COLUMNS} FROM kb_sources ORDER BY added_at, id`)
    .all() as KbSourceSqlRow[];
  return rows.map(mapSourceRow);
}

export function upsertKbSource(sqlite: Database.Database, input: UpsertKbSourceInput): UpsertKbSourceResult {
  const existing = getKbSource(sqlite, input.id) ?? findKbSourceByPath(sqlite, input.kind, input.path);
  const now = input.addedAt ?? new Date().toISOString();

  if (!existing) {
    sqlite
      .prepare(
        `INSERT INTO kb_sources (id, kind, path, title, content_hash, content_text, added_at, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.kind, input.path, input.title, input.contentHash, input.contentText, now, input.bytes);
    const created = getKbSource(sqlite, input.id);
    if (!created) throw new Error('kb_sources 写入后读不回（不该发生）');
    return { source: created, created: true, contentChanged: true };
  }

  const contentChanged = existing.contentHash !== input.contentHash;
  sqlite
    .prepare(
      `UPDATE kb_sources SET kind = ?, path = ?, title = ?, content_hash = ?, content_text = ?, bytes = ? WHERE id = ?`,
    )
    .run(input.kind, input.path, input.title, input.contentHash, input.contentText, input.bytes, existing.id);
  // ⚠️ 用 `existing.id` 而不是 `input.id`：命中"同 kind+path 的老行"时两者不同，
  //    真正在库里的 id 才是那个老行的。
  return {
    source: {
      id: existing.id,
      kind: input.kind,
      path: input.path,
      title: input.title,
      contentHash: input.contentHash,
      contentText: input.contentText,
      addedAt: existing.addedAt,
      bytes: input.bytes,
    },
    created: false,
    contentChanged,
  };
}

export function deleteKbSource(sqlite: Database.Database, id: string): boolean {
  // 切片靠外键 ON DELETE CASCADE 一起走（前提是 db/index.ts 里开了 foreign_keys）。
  return sqlite.prepare('DELETE FROM kb_sources WHERE id = ?').run(id).changes > 0;
}

export function countKbChunks(sqlite: Database.Database, sourceId?: string): number {
  const row = (
    sourceId
      ? sqlite.prepare('SELECT COUNT(*) AS count FROM kb_chunks WHERE source_id = ?').get(sourceId)
      : sqlite.prepare('SELECT COUNT(*) AS count FROM kb_chunks').get()
  ) as { count: number };
  return row.count;
}

export function listKbChunks(sqlite: Database.Database, sourceId: string): KbChunkRow[] {
  const rows = sqlite
    .prepare(`SELECT ${CHUNK_COLUMNS} FROM kb_chunks WHERE source_id = ? ORDER BY ordinal`)
    .all(sourceId) as KbChunkSqlRow[];
  return rows.map(mapChunkRow);
}

/**
 * 需要（重新）嵌入的切片：没嵌过的、换了模型的、以及被标成 stale 的。
 * 只传 `model` 一个条件，是为了让 SQL 与 core 的 `chunkNeedsEmbedding` 判定一致。
 */
export function listEmbeddableKbChunks(
  sqlite: Database.Database,
  input: { model: string; sourceId?: string; limit?: number },
): KbChunkRow[] {
  const conditions = ["(state <> 'embedded' OR embedding_model IS NULL OR embedding_model <> ?)"];
  const params: unknown[] = [input.model];
  if (input.sourceId) {
    conditions.push('source_id = ?');
    params.push(input.sourceId);
  }
  const limit = input.limit === undefined ? '' : ' LIMIT ?';
  if (input.limit !== undefined) params.push(Math.max(0, Math.floor(input.limit)));
  const rows = sqlite
    .prepare(
      `SELECT ${CHUNK_COLUMNS} FROM kb_chunks WHERE ${conditions.join(' AND ')} ORDER BY source_id, ordinal${limit}`,
    )
    .all(...params) as KbChunkSqlRow[];
  return rows.map(mapChunkRow);
}

/** 整份资料的切片替换（重建的最小单位）：删旧 + 写新，**一个事务**。 */
export function replaceKbChunks(sqlite: Database.Database, sourceId: string, drafts: readonly KbChunkDraft[]): number {
  return withTransaction(sqlite, () => {
    sqlite.prepare('DELETE FROM kb_chunks WHERE source_id = ?').run(sourceId);
    const insert = sqlite.prepare(
      `INSERT INTO kb_chunks (id, source_id, ordinal, text, token_estimate, vector, embedding_model, state)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pending_embedding')`,
    );
    for (const draft of drafts) {
      insert.run(kbChunkId(sourceId, draft.ordinal), sourceId, draft.ordinal, draft.text, draft.tokenEstimate);
    }
    return drafts.length;
  });
}

/** 批量写向量（U 盘上避免"一块一事务"的高频小写）。 */
export function saveKbChunkEmbeddings(
  sqlite: Database.Database,
  updates: ReadonlyArray<{ id: string; vector: Float32Array; embeddingModel: string }>,
): number {
  if (updates.length === 0) return 0;
  return withTransaction(sqlite, () => {
    const statement = sqlite.prepare(
      `UPDATE kb_chunks SET vector = ?, embedding_model = ?, state = 'embedded' WHERE id = ?`,
    );
    let changed = 0;
    for (const update of updates) {
      changed += statement.run(encodeVector(update.vector), update.embeddingModel, update.id).changes;
    }
    return changed;
  });
}

/** 换嵌入模型：把用别的模型嵌过的块标成 stale（向量保留，检索时被跳过）。 */
export function markKbChunksStale(sqlite: Database.Database, model: string): number {
  return sqlite
    .prepare(
      `UPDATE kb_chunks SET state = 'stale'
       WHERE state = 'embedded' AND embedding_model IS NOT NULL AND embedding_model <> ?`,
    )
    .run(model).changes;
}

/** 按状态数切片；给了 `sourceId` 就只数那一份资料。 */
export function kbChunkStateCounts(sqlite: Database.Database, sourceId?: string): Record<KbChunkState, number> {
  const counts: Record<KbChunkState, number> = { pending_embedding: 0, embedded: 0, stale: 0 };
  const rows = (
    sourceId
      ? sqlite
          .prepare('SELECT state, COUNT(*) AS count FROM kb_chunks WHERE source_id = ? GROUP BY state')
          .all(sourceId)
      : sqlite.prepare('SELECT state, COUNT(*) AS count FROM kb_chunks GROUP BY state').all()
  ) as Array<{ state: string; count: number }>;
  for (const row of rows) {
    if (isKbChunkState(row.state)) counts[row.state] = row.count;
  }
  return counts;
}

/**
 * 关键词召回（FTS5）。**这条路径永远可用**：它不碰向量、不碰网络，所以断网/U 盘换机
 * 时它照样返回结果 —— 设计 §五的降级全靠它。
 */
export function searchKbChunks(
  sqlite: Database.Database,
  query: string,
  options: { limit?: number } = {},
): KbChunkHit[] {
  const ftsQuery = toFtsPrefixQuery(query);
  if (!ftsQuery) return [];
  const limit = Math.max(1, Math.floor(options.limit ?? 30));

  const rows = sqlite
    .prepare(
      `SELECT c.id AS chunk_id, c.source_id, c.ordinal, c.text, c.vector, c.embedding_model, c.state,
              s.kind AS source_kind, s.title AS source_title, s.path AS source_path,
              snippet(kb_chunks_fts, 0, '<<', '>>', '…', 12) AS snippet,
              -bm25(kb_chunks_fts) AS keyword_score
       FROM kb_chunks_fts
       JOIN kb_chunks c ON c.rowid = kb_chunks_fts.rowid
       JOIN kb_sources s ON s.id = c.source_id
       WHERE kb_chunks_fts MATCH ?
       ORDER BY keyword_score DESC, c.id
       LIMIT ?`,
    )
    .all(ftsQuery, limit) as Array<{
    chunk_id: string;
    source_id: string;
    ordinal: number;
    text: string;
    vector: Uint8Array | null;
    embedding_model: string | null;
    state: string;
    source_kind: string;
    source_title: string;
    source_path: string;
    snippet: string;
    keyword_score: number;
  }>;

  return rows.map((row) => {
    const state = row.state;
    const kind = row.source_kind;
    if (!isKbChunkState(state)) throw new Error(`kb_chunks.state 非法：${state}`);
    if (!isSourceKind(kind)) throw new Error(`kb_sources.kind 非法：${kind}`);
    return {
      chunkId: row.chunk_id,
      sourceId: row.source_id,
      ordinal: row.ordinal,
      text: row.text,
      snippet: row.snippet,
      keywordScore: row.keyword_score,
      vector: row.vector ? decodeVector(row.vector) : null,
      embeddingModel: row.embedding_model,
      state,
      sourceKind: kind,
      sourceTitle: row.source_title,
      sourcePath: row.source_path,
    };
  });
}
