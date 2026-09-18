import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type Database from 'better-sqlite3';
import {
  DEFAULT_KB_LIMIT,
  buildChunkDrafts,
  embedPendingChunks,
  hashText,
  isEmbeddingEngineReady,
  rankKbCandidates,
  type EmbeddingEngine,
  type KbChunkingOptions,
  type KbSearchCandidate,
  type KbSearchHit,
  type KbSourceKind,
} from '@clawwork/core';
import { classifyTier } from '../context/file-types.js';
import {
  countKbChunks,
  deleteKbSource,
  getKbSource,
  kbChunkStateCounts,
  listEmbeddableKbChunks,
  listKbSources,
  markKbChunksStale,
  readKbMeta,
  replaceKbChunks,
  saveKbChunkEmbeddings,
  searchKbChunks,
  upsertKbSource,
  writeKbMeta,
  type KbMetaRecord,
} from '../db/kb.js';

/**
 * 资料库服务（T6a）：把"取本地文本 → 切片 → 嵌入 → 落库"串起来，并对外留出
 * **可注入的嵌入引擎**与**降级出口**。
 *
 * 边界（T6a 刻意不做的事，别顺手补）：
 * - **不接真实嵌入**：`engine` 缺省为 `null` ⇒ 一切照旧，检索走 FTS5 关键词。
 *   真引擎（本地 ONNX / relay `/v1/embeddings`）在 T6b 实现同一个接口传进来即可。
 * - **不联网、不 IPC、不碰界面**：文件读的是本机磁盘，产物读的是工作区库里的
 *   `artifacts.content_text`；没有任何一条路径会把原文传出去（设计 §一）。
 * - **不做"自动全量索引"**：谁进资料库由调用方决定（T6d 的沉淀入口/用户手动加入）。
 *
 * ⚠️ 换引擎会**标记**（不是删除）旧向量为 `stale`，所以"切回原模型"不用重新花积分；
 *    而 `stale` 的块在检索时只跳过它的向量、文本照样能关键词命中（见 core/retrieval.ts）。
 */

/** 单个文件的读取上限（超出部分不索引，但不报错 —— 结果里带 `truncated`）。 */
export const MAX_KB_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_KB_CANDIDATE_LIMIT = 30;
export const DEFAULT_KB_EMBED_BATCH_SIZE = 16;

export type KbIngestSkipReason = 'empty' | 'unsupported' | 'unreadable' | 'missing';
export type KbDegradedReason = 'no-engine' | 'engine-error' | 'no-vectors';

export interface KbIngestOutcome {
  status: 'indexed' | 'unchanged' | 'skipped';
  /** `status === 'skipped'` 时说明原因。 */
  reason?: KbIngestSkipReason;
  sourceId?: string;
  chunkCount: number;
  /** 本次真正新增的向量数（已嵌过的不重算，也就是不重复花积分）。 */
  embeddedCount: number;
  /** 仍然没有可用向量的切片数（`pending_embedding` + `stale`）。 */
  pendingCount: number;
  /** 文件超过上限、只索引了前 {@link MAX_KB_FILE_BYTES} 字节。 */
  truncated?: boolean;
  engineError?: string | null;
}

export interface KbIndexReport {
  attempted: number;
  embedded: number;
  failed: number;
  engineError: string | null;
}

export interface KbRebuildReport extends KbIndexReport {
  sources: number;
  chunks: number;
}

export interface KbSearchOutcome {
  hits: KbSearchHit[];
  mode: 'keyword' | 'hybrid';
  /** 向量没能参与排序（没引擎 / 嵌不了 / 候选都没向量）—— 界面据此标"离线检索"。 */
  degraded: boolean;
  degradedReason?: KbDegradedReason;
  candidateCount: number;
}

export interface KbStats {
  sources: number;
  chunks: number;
  byState: Record<string, number>;
  meta: KbMetaRecord;
}

export interface KbFileText {
  ok: boolean;
  reason?: 'unsupported' | 'unreadable';
  text?: string;
  bytes?: number;
  truncated?: boolean;
}

export type KbFileTextReader = (absolutePath: string) => KbFileText;

export interface KbServiceDeps {
  sqlite: Database.Database;
  /** 缺省 `null` = 未配置嵌入 ⇒ 纯 FTS（合法默认，不是降级错误）。 */
  engine?: EmbeddingEngine | null;
  now?: () => string;
  readFileText?: KbFileTextReader;
  chunking?: KbChunkingOptions;
  batchSize?: number;
}

/**
 * 本机文本文件读取（**只读文本类扩展名**）。
 *
 * ⚠️ 为什么不用 `context/file-reader.ts`：那个读取器是给"把文件发给模型"用的，
 *    正文在 100KB 处**静默截断**——拿它建索引会让用户以为后半本书也搜得到。
 *    这里自己按 `MAX_KB_FILE_BYTES` 截断，并把 `truncated` 明确回给调用方。
 *    不改文件、不落盘、不出网。
 */
export function readLocalTextFile(absolutePath: string, maxBytes: number = MAX_KB_FILE_BYTES): KbFileText {
  if (classifyTier(extname(absolutePath).toLowerCase()) !== 'text') return { ok: false, reason: 'unsupported' };

  let size: number;
  try {
    size = statSync(absolutePath).size;
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  let handle: number | null = null;
  try {
    handle = openSync(absolutePath, 'r');
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    if (buffer.length > 0) readSync(handle, buffer, 0, buffer.length, 0);
    return { ok: true, text: buffer.toString('utf8'), bytes: size, truncated: size > maxBytes };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

export interface KbService {
  addFile(absolutePath: string, options?: { title?: string }): Promise<KbIngestOutcome>;
  addNote(input: { title: string; text: string }): Promise<KbIngestOutcome>;
  addArtifact(artifactId: string): Promise<KbIngestOutcome>;
  removeSource(sourceId: string): boolean;
  indexPending(sourceId?: string): Promise<KbIndexReport>;
  rebuild(sourceId?: string): Promise<KbRebuildReport>;
  search(query: string, options?: { limit?: number; candidateLimit?: number }): Promise<KbSearchOutcome>;
  setEmbeddingEngine(engine: EmbeddingEngine | null): { model: string | null; dim: number | null; staled: number };
  getStats(): KbStats;
}

export function createKbService(deps: KbServiceDeps): KbService {
  const { sqlite } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const readFileText = deps.readFileText ?? readLocalTextFile;
  const batchSize = deps.batchSize ?? DEFAULT_KB_EMBED_BATCH_SIZE;
  let engine: EmbeddingEngine | null = isEmbeddingEngineReady(deps.engine) ? (deps.engine as EmbeddingEngine) : null;

  function skip(reason: KbIngestSkipReason): KbIngestOutcome {
    return { status: 'skipped', reason, chunkCount: 0, embeddedCount: 0, pendingCount: 0 };
  }

  /**
   * 装上/摘掉引擎的唯一入口（构造时带引擎与运行中换引擎走同一条路，避免两套语义）。
   * 换模型 ⇒ 老向量标 `stale`（**不删**）：检索时被跳过，等重建；切回原模型不用重新花积分。
   */
  function applyEngine(next: EmbeddingEngine | null): { model: string | null; dim: number | null; staled: number } {
    engine = isEmbeddingEngineReady(next) ? next : null;
    const model = engine?.model ?? null;
    writeKbMeta(sqlite, { embeddingModel: model, dim: engine?.dim ?? null }, now());
    return { model, dim: engine?.dim ?? null, staled: model ? markKbChunksStale(sqlite, model) : 0 };
  }

  // 构造时就带引擎（T6b 从配置里读出来传进来）也必须落 meta 并把别的模型嵌过的块标 stale ——
  // 否则重启后 meta 说"没模型"、库里却躺着一堆向量，两边对不上。
  if (engine) applyEngine(engine);

  function pendingCount(sourceId: string): number {
    const counts = kbChunkStateCounts(sqlite, sourceId);
    return counts.pending_embedding + counts.stale;
  }

  /** 把还需要向量的切片嵌上（有引擎才做；没有就原地不动，等联网）。 */
  async function runIndex(sourceId?: string): Promise<KbIndexReport> {
    if (!isEmbeddingEngineReady(engine)) return { attempted: 0, embedded: 0, failed: 0, engineError: null };

    const pending = listEmbeddableKbChunks(sqlite, { model: engine.model, sourceId });
    const result = await embedPendingChunks(pending, engine, { batchSize });
    const updates = result.chunks.flatMap((chunk) =>
      chunk.state === 'embedded' && chunk.vector && chunk.embeddingModel
        ? [{ id: chunk.id, vector: chunk.vector, embeddingModel: chunk.embeddingModel }]
        : [],
    );
    saveKbChunkEmbeddings(sqlite, updates);
    return {
      attempted: result.attempted,
      embedded: updates.length,
      failed: result.failed,
      engineError: result.error?.message ?? null,
    };
  }

  async function ingest(input: {
    kind: KbSourceKind;
    path: string;
    title: string;
    text: string;
    bytes: number;
    truncated?: boolean;
  }): Promise<KbIngestOutcome> {
    if (input.text.trim().length === 0) return skip('empty');

    // 同一份文件/产物重复入库 ⇒ 同一个 source id（外加 (kind, path) 唯一索引兜底）。
    const sourceId =
      input.kind === 'note'
        ? `kb-note-${randomUUID()}`
        : `kb-${input.kind}-${hashText(`${input.kind} ${input.path}`).slice(0, 16)}`;

    const upserted = upsertKbSource(sqlite, {
      id: sourceId,
      kind: input.kind,
      path: input.path,
      title: input.title,
      contentHash: hashText(input.text),
      contentText: input.text,
      bytes: input.bytes,
      addedAt: now(),
    });
    const { source } = upserted;

    // 内容没变、切片也在 ⇒ 不重切、更不重嵌（重复加入不该再花一次积分）。
    if (!upserted.contentChanged && countKbChunks(sqlite, source.id) > 0) {
      return {
        status: 'unchanged',
        sourceId: source.id,
        chunkCount: countKbChunks(sqlite, source.id),
        embeddedCount: 0,
        pendingCount: pendingCount(source.id),
        truncated: input.truncated,
      };
    }

    const drafts = buildChunkDrafts(input.text, deps.chunking);
    replaceKbChunks(sqlite, source.id, drafts);
    const report = await runIndex(source.id);

    return {
      status: 'indexed',
      sourceId: source.id,
      chunkCount: drafts.length,
      embeddedCount: report.embedded,
      pendingCount: pendingCount(source.id),
      truncated: input.truncated,
      engineError: report.engineError,
    };
  }

  return {
    async addFile(absolutePath, options) {
      const read = readFileText(absolutePath);
      if (!read.ok || read.text === undefined) return skip(read.reason ?? 'unreadable');
      return ingest({
        kind: 'file',
        path: absolutePath,
        title: options?.title ?? basename(absolutePath),
        text: read.text,
        bytes: read.bytes ?? Buffer.byteLength(read.text, 'utf8'),
        truncated: read.truncated,
      });
    },

    async addNote(input) {
      return ingest({
        kind: 'note',
        path: '',
        title: input.title,
        text: input.text,
        bytes: Buffer.byteLength(input.text, 'utf8'),
      });
    },

    async addArtifact(artifactId) {
      const row = sqlite
        .prepare('SELECT id, name, local_path, content_text, size FROM artifacts WHERE id = ?')
        .get(artifactId) as
        | { id: string; name: string; local_path: string; content_text: string; size: number }
        | undefined;
      if (!row) return skip('missing');
      if (row.content_text.trim().length === 0) return skip('empty');
      return ingest({
        kind: 'artifact',
        path: row.local_path,
        title: row.name,
        text: row.content_text,
        bytes: row.size,
      });
    },

    removeSource(sourceId) {
      // 切片靠外键级联一起删（kb_chunks.source_id ON DELETE CASCADE）。
      return deleteKbSource(sqlite, sourceId);
    },

    async indexPending(sourceId) {
      return runIndex(sourceId);
    },

    async rebuild(sourceId) {
      const sources = (sourceId ? [getKbSource(sqlite, sourceId)] : listKbSources(sqlite)).filter(
        (source): source is NonNullable<typeof source> => source !== null,
      );
      let chunks = 0;
      for (const source of sources) {
        // 真相是 kb_sources.content_text（不再回读磁盘：U 盘拔了、文件删了也重建得出来）。
        const drafts = buildChunkDrafts(source.contentText, deps.chunking);
        replaceKbChunks(sqlite, source.id, drafts);
        chunks += drafts.length;
      }
      const report = await runIndex(sourceId);
      return { sources: sources.length, chunks, ...report };
    },

    async search(query, options = {}) {
      const limit = options.limit ?? DEFAULT_KB_LIMIT;
      const candidateLimit = options.candidateLimit ?? Math.max(limit * 3, DEFAULT_KB_CANDIDATE_LIMIT);
      const candidates: KbSearchCandidate[] = searchKbChunks(sqlite, query, { limit: candidateLimit });

      let queryVector: Float32Array | null = null;
      let engineFailed = false;
      if (isEmbeddingEngineReady(engine)) {
        try {
          const [vector] = await engine.embed([query]);
          queryVector = vector ? new Float32Array(vector) : null;
          engineFailed = !vector;
        } catch {
          // 断网 / relay 不可达：**不抛**，直接退化成关键词检索（设计 §五）
          engineFailed = true;
        }
      }

      const ranked = rankKbCandidates(candidates, {
        queryVector,
        activeModel: engine?.model ?? null,
        limit,
      });

      const degraded = ranked.mode === 'keyword';
      const degradedReason: KbDegradedReason | undefined = !degraded
        ? undefined
        : !isEmbeddingEngineReady(engine)
          ? 'no-engine'
          : engineFailed || !queryVector
            ? 'engine-error'
            : 'no-vectors';

      return { hits: ranked.hits, mode: ranked.mode, degraded, degradedReason, candidateCount: candidates.length };
    },

    setEmbeddingEngine(next) {
      return applyEngine(next);
    },

    getStats() {
      return {
        sources: listKbSources(sqlite).length,
        chunks: countKbChunks(sqlite),
        byState: kbChunkStateCounts(sqlite),
        meta: readKbMeta(sqlite),
      };
    },
  };
}
