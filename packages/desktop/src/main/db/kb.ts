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
 * - **两代正文不会串味（写向量时按 content_hash 对账）**：切片 id 是确定性的
 *   （`sourceId#ordinal`），所以"同一份资料重新入库"会在**同一批 id** 上换一具身体。
 *   嵌入是异步的（U 盘上还很慢），如果第一代的嵌入结果回来时第二代已经落库，按 id
 *   UPDATE 就会把**上一代的向量写到这一代的正文上**，而状态还显示 embedded（毫无标记）。
 *   所以 `saveKbChunkEmbeddings` 要求每个块带上"它是哪一代正文"的 content_hash，
 *   对不上就整行跳过（宁可让它留在 pending 等下一轮，也不写脏向量）。
 * - **已知边界（不打算在 T6a 解）**：两台机器同时挂同一个 U 盘/工作区，是"同一份库
 *   两个写者"。SQLite 能保证**不写坏**（页级原子 + 回滚），但保证不了"逻辑上谁赢" ——
 *   两个进程同时给同一份资料重建索引时，后提交的那份生效（上一条的 hash 对账让
 *   "向量与正文错配"这件事在跨进程下也不成立；但"谁赢"仍不保证）。
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

/**
 * 切片 id：确定性命名（`sourceId#序号`），所以重建出来的 id 与重建前一模一样。
 *
 * ⚠️ `padStart(4)` 只够四位数：序号 ≥ 10000 时 `#10000` 的**字典序排到 `#9999` 前面**
 * （`addNote` 没有长度上限，长文档确实到得了）。所以**任何排序都用 `ordinal` 列，
 * 不要用 id 的字典序** —— 这个函数只负责当主键，排序语义在 `ORDER BY`/rank 里显式写。
 */
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

/**
 * 切片替换的**执行体**：不自开事务 —— 调用方要么自己包（`replaceKbChunks`），
 * 要么已经在事务里（`ingestKbSource`）。SQLite 不支持嵌套 `BEGIN`，所以这一层必须能"搭车"。
 */
function replaceKbChunksInner(sqlite: Database.Database, sourceId: string, drafts: readonly KbChunkDraft[]): number {
  sqlite.prepare('DELETE FROM kb_chunks WHERE source_id = ?').run(sourceId);
  const insert = sqlite.prepare(
    `INSERT INTO kb_chunks (id, source_id, ordinal, text, token_estimate, vector, embedding_model, state)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pending_embedding')`,
  );
  for (const draft of drafts) {
    insert.run(kbChunkId(sourceId, draft.ordinal), sourceId, draft.ordinal, draft.text, draft.tokenEstimate);
  }
  return drafts.length;
}

/** 整份资料的切片替换（重建的最小单位）：删旧 + 写新，**一个事务**。 */
export function replaceKbChunks(sqlite: Database.Database, sourceId: string, drafts: readonly KbChunkDraft[]): number {
  return withTransaction(sqlite, () => replaceKbChunksInner(sqlite, sourceId, drafts));
}

export interface IngestKbSourceResult extends UpsertKbSourceResult {
  /** 这次真的重切了吗（`false` = 内容没变且切片还在 ⇒ 调用方可以跳过重嵌）。 */
  rechunked: boolean;
  /** 事务提交后库里这份资料的切片数。 */
  chunkCount: number;
}

/**
 * **入库的原子单位**：更新/新建 `kb_sources` 与（需要时）替换切片，**同一个事务**。
 *
 * 为什么不能分两步做（`upsertKbSource` 然后 `replaceKbChunks`）：两步之间崩一下
 * （U 盘被拔、进程被杀）就会留下"content_hash 已经是新的、切片刻还是旧的"这种状态 ——
 * 而 `ingest` 的判据是"hash 没变就跳过"，于是之后每次 addFile 都返回 `unchanged`，
 * 用户以为存进去了，其实检索到的还是上一代正文（静默陈旧，比报错难查得多）。
 * 包进一个事务后，这种中间态在结构上就不可能存在（要么新 hash + 新切片，要么全旧）。
 *
 * `buildDrafts` 只在真的需要重切时调用（内容变了、或切片被删光了）。
 */
export function ingestKbSource(
  sqlite: Database.Database,
  input: UpsertKbSourceInput,
  buildDrafts: () => readonly KbChunkDraft[],
): IngestKbSourceResult {
  return withTransaction(sqlite, () => {
    const upserted = upsertKbSource(sqlite, input);
    const existingChunks = countKbChunks(sqlite, upserted.source.id);
    if (!upserted.contentChanged && existingChunks > 0) {
      return { ...upserted, rechunked: false, chunkCount: existingChunks };
    }
    const drafts = buildDrafts();
    replaceKbChunksInner(sqlite, upserted.source.id, drafts);
    return { ...upserted, rechunked: true, chunkCount: drafts.length };
  });
}

export interface KbChunkEmbeddingUpdate {
  id: string;
  vector: Float32Array;
  embeddingModel: string;
  /**
   * 这个向量是**哪一代正文**算出来的（该资料当时的 `content_hash`）。
   *
   * 嵌入是异步的，而切片 id 是确定性的（`sourceId#ordinal`）—— 同一份资料被重新入库时，
   * 新切片会占用**同一批 id**。只按 id UPDATE 的话，慢吞吞的第一代结果回来时就会把
   * "上一代正文的向量"写到"这一代正文"上，状态还照样是 `embedded`（查都没法查）。
   * 落库前拿这个指纹对一下：对不上 ⇒ 这一行跳过（它留在 pending，等下一轮按新正文重嵌）。
   */
  expectedContentHash: string;
}

/** 批量写向量（U 盘上避免"一块一事务"的高频小写）。跳过的行见 `expectedContentHash`。 */
export function saveKbChunkEmbeddings(sqlite: Database.Database, updates: readonly KbChunkEmbeddingUpdate[]): number {
  if (updates.length === 0) return 0;
  return withTransaction(sqlite, () => {
    const statement = sqlite.prepare(
      `UPDATE kb_chunks SET vector = ?, embedding_model = ?, state = 'embedded'
       WHERE id = ?
         AND EXISTS (SELECT 1 FROM kb_sources s WHERE s.id = kb_chunks.source_id AND s.content_hash = ?)`,
    );
    let changed = 0;
    for (const update of updates) {
      changed += statement.run(
        encodeVector(update.vector),
        update.embeddingModel,
        update.id,
        update.expectedContentHash,
      ).changes;
    }
    return changed;
  });
}

export interface KbChunkStateSync {
  /** 这次被标成 `stale` 的块数（模型换了、旧向量被跳过）。 */
  staled: number;
  /** 这次被**升回** `embedded` 的块数（换回了原来的模型、向量还在）。 */
  restored: number;
}

/**
 * 按当前模型**双向**同步切片状态，只动**有向量**的行：
 * 有向量且就是当前模型 ⇒ `embedded`；有向量但是别的模型 ⇒ `stale`（向量保留、检索时跳过）。
 *
 * 为什么必须双向（单向标记的代价）：A 模型 → B 模型 → 切回 A 时，向量其实一直躺在库里
 * （`vector` 没删、`embedding_model` 还是 `'A'`），但 state 单向地卡在 `'stale'`，
 * 于是 `listEmbeddableKbChunks` 把它们全当"要重嵌" ⇒ U 盘上白重嵌一遍、还白花一遍积分。
 *
 * 没向量的行不动：它们该在 `pending_embedding` 等着，跟换没换模型无关。
 * `model` 为 `null`（引擎被摘掉）时调用方**不该调它** —— 那不是"换了模型"。
 */
export function syncKbChunkStates(sqlite: Database.Database, model: string): KbChunkStateSync {
  return withTransaction(sqlite, () => {
    const staled = sqlite
      .prepare(
        `UPDATE kb_chunks SET state = 'stale'
         WHERE vector IS NOT NULL AND state <> 'stale'
           AND (embedding_model IS NULL OR embedding_model <> ?)`,
      )
      .run(model).changes;
    const restored = sqlite
      .prepare(
        `UPDATE kb_chunks SET state = 'embedded'
         WHERE vector IS NOT NULL AND state <> 'embedded' AND embedding_model = ?`,
      )
      .run(model).changes;
    return { staled, restored };
  });
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
 * 向量**补召回**：把这个模型已嵌好的块捞出来，交给上层按余弦排。
 *
 * ⚠️ 为什么必须有这一步：关键词召回（`searchKbChunks`）是**纯 FTS**，
 * 而向量原本**只在重排时进场** —— `rankKbCandidates` 只能给**已经被召回的**候选打分
 * ⇒ **FTS 没召回的，向量永远没机会看到**。
 * 而 `unicode61` 不切中文词，`收入主要来自软件订阅` 是**一整个 token**，
 * 于是"正文里明明有'软件订阅'，查 `订阅` ⇒ 0 命中"。
 *
 * ⚠️ 这里**只捞、不算相似度、不排序**：余弦与维度/模型一致性那套判据都在 core 的
 * `rankKbCandidates` 里（它已经会算）。两边各算一次的话，那套判据迟早漂。
 *
 * ⚠️ **必须有上限**：这是**全表扫**。上层只在"FTS 没填满结果页"时才调它，
 * 所以常见查询（关键词能命中的）根本不付这个代价。
 */
export function listKbChunksForVectorRecall(
  sqlite: Database.Database,
  options: { model: string; scanLimit: number },
): KbChunkHit[] {
  const scanLimit = Math.max(1, Math.floor(options.scanLimit));

  const rows = sqlite
    .prepare(
      `SELECT c.id AS chunk_id, c.source_id, c.ordinal, c.text, c.vector, c.embedding_model, c.state,
              s.kind AS source_kind, s.title AS source_title, s.path AS source_path
       FROM kb_chunks c
       JOIN kb_sources s ON s.id = c.source_id
       WHERE c.state = 'embedded' AND c.embedding_model = ? AND c.vector IS NOT NULL
       ORDER BY c.source_id, c.ordinal, c.id
       LIMIT ?`,
    )
    .all(options.model, scanLimit) as Array<{
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
      // 没有 FTS 命中就没有高亮片段 ⇒ 给个朴素头一段。
      // 刻意**不带** `<<`/`>>` 标记：那两个符号的含义是"这里匹配上了"，这里并没有。
      snippet: row.text.slice(0, VECTOR_RECALL_SNIPPET_CHARS),
      // 没有关键词分 ⇒ 0。权重是"关键词 0.4 / 向量 0.6"，所以它只能靠向量往上走，
      // 这正是"FTS 优先"的表达方式：关键词命中的候选天然多一份关键词分。
      keywordScore: 0,
      vector: row.vector ? decodeVector(row.vector) : null,
      embeddingModel: row.embedding_model,
      state,
      sourceKind: kind,
      sourceTitle: row.source_title,
      sourcePath: row.source_path,
    };
  });
}

/** 补召回的朴素片段长度（够卡片显示一行多一点）。 */
const VECTOR_RECALL_SNIPPET_CHARS = 120;

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
       -- 同分时按 (source_id, ordinal) 排：**不能按 c.id 的字典序**（序号 ≥ 10000 会排错，
       -- 见 kbChunkId 的注释），id 只当最后一道确定性兜底。
       ORDER BY keyword_score DESC, c.source_id, c.ordinal, c.id
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
