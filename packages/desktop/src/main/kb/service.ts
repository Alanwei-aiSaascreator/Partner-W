import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';
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
  ingestKbSource,
  kbChunkStateCounts,
  listEmbeddableKbChunks,
  listKbSources,
  readKbMeta,
  replaceKbChunks,
  saveKbChunkEmbeddings,
  searchKbChunks,
  syncKbChunkStates,
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
 *    状态同步是**双向**的：切回原模型时向量会被直接救回 `embedded`（不重嵌、不重复扣费）。
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
  /** `no-engine` = 没有可用引擎，**什么都没动**（见 `rebuild` 的注释）。 */
  skipped?: 'no-engine';
}

export interface KbSearchOutcome {
  hits: KbSearchHit[];
  mode: 'keyword' | 'hybrid';
  /** 向量没能参与排序（没引擎 / 嵌不了 / 候选都没向量）—— 界面据此标"离线检索"。 */
  degraded: boolean;
  degradedReason?: KbDegradedReason;
  candidateCount: number;
}

/** 资料列表里的一条（**不含正文**）。 */
export interface KbSourceSummary {
  id: string;
  kind: KbSourceKind;
  path: string;
  title: string;
  bytes: number;
  addedAt: string;
  chunks: number;
  /** 这份资料还差多少切片没向量。 */
  pending: number;
}

export interface KbStats {
  sources: number;
  chunks: number;
  byState: Record<string, number>;
  meta: KbMetaRecord;
}

/** 换引擎的结果：`staled` = 被跳过向量的块数，`restored` = 换回原模型后被救回来的块数。 */
export interface KbEngineSwitch {
  model: string | null;
  dim: number | null;
  staled: number;
  restored: number;
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

/**
 * 路径规范化：让"同一个文件的两种写法"收敛成同一个串（`kb_sources` 的 (kind, path) 唯一）。
 *
 * - `realpathSync.native` 拿的是**磁盘上的真实大小写** —— Windows / macOS 默认大小写不敏感，
 *   不规范化的话 `C:\Docs\预算.md` 与 `c:\docs\预算.md` 会建出两条资料：重复切片、重复嵌入
 *   （白花积分），检索里同一段正文还能被引用两次。
 * - 只对**绝对路径**做：产物的 `local_path` 可能是相对任务目录的，`realpath` 会拿当前工作
 *   目录去解析，可能指到别的文件上 —— 宁可不合并，也不能合错。
 * - 拿不到真实路径（文件已经不在了：U 盘拔了、产物被清理）就**原样返回**：不猜写法。
 */
export function normalizeSourcePath(path: string): string {
  if (!path || !isAbsolute(path)) return path;
  try {
    return realpathSync.native(path);
  } catch {
    return path;
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
  setEmbeddingEngine(engine: EmbeddingEngine | null): KbEngineSwitch;
  getStats(): KbStats;
  /**
   * 已加入的资料（**不带正文**）。
   *
   * ⚠️ 单独开一条而不是塞进 `getStats()`：统计是每次都能算的轻量数字，而这条会
   * 把每份资料的元数据（标题/路径/字节数）都读出来 —— 界面上是"资料列表"那个页签
   * 才需要它。混在一起会让每次刷统计都拖一份全表。
   * ⚠️ 只回**元数据**：正文（最长 2MB/份）由 `search` 按命中片段给，别顺手带上。
   */
  listSources(): KbSourceSummary[];
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
   * 换模型 ⇒ 老向量标 `stale`（**不删**）：检索时被跳过，等重建；切回原模型**自动救回来**
   * （`syncKbChunkStates` 是双向的：向量还在、模型又对上了 ⇒ 直接回 `embedded`，不重嵌）。
   * 摘掉引擎（`null`）不是"换了模型"：什么都不动，只是暂时没有引擎。
   */
  function applyEngine(next: EmbeddingEngine | null): KbEngineSwitch {
    engine = isEmbeddingEngineReady(next) ? next : null;
    const model = engine?.model ?? null;
    writeKbMeta(sqlite, { embeddingModel: model, dim: engine?.dim ?? null }, now());
    const synced = model ? syncKbChunkStates(sqlite, model) : { staled: 0, restored: 0 };
    return { model, dim: engine?.dim ?? null, staled: synced.staled, restored: synced.restored };
  }

  // 构造时就带引擎（T6b 从配置里读出来传进来）也必须落 meta 并把别的模型嵌过的块标 stale ——
  // 否则重启后 meta 说"没模型"、库里却躺着一堆向量，两边对不上。
  if (engine) applyEngine(engine);

  function pendingCount(sourceId: string): number {
    const counts = kbChunkStateCounts(sqlite, sourceId);
    return counts.pending_embedding + counts.stale;
  }

  const EMPTY_INDEX_REPORT: KbIndexReport = { attempted: 0, embedded: 0, failed: 0, engineError: null };

  /** 把还需要向量的切片嵌上（有引擎才做；没有就原地不动，等联网）。**必须走 `requestIndex`**。 */
  async function runIndex(sourceId?: string): Promise<KbIndexReport> {
    if (!isEmbeddingEngineReady(engine)) return { ...EMPTY_INDEX_REPORT };

    const pending = listEmbeddableKbChunks(sqlite, { model: engine.model, sourceId });
    // 先记下"这批切片是**哪一代正文**"（嵌入是异步的，回来时这份资料可能已经被
    // 重新入库成下一代 —— 切片 id 是确定性的，同一个 id 会换一具身体）。
    const expectedHashes = new Map<string, string>();
    const hashOfSource = new Map<string, string>();
    for (const chunk of pending) {
      let hash = hashOfSource.get(chunk.sourceId);
      if (hash === undefined) {
        hash = getKbSource(sqlite, chunk.sourceId)?.contentHash ?? '';
        hashOfSource.set(chunk.sourceId, hash);
      }
      expectedHashes.set(chunk.id, hash);
    }

    const result = await embedPendingChunks(pending, engine, { batchSize });
    const updates = result.chunks.flatMap((chunk) =>
      chunk.state === 'embedded' && chunk.vector && chunk.embeddingModel
        ? [
            {
              id: chunk.id,
              vector: chunk.vector,
              embeddingModel: chunk.embeddingModel,
              expectedContentHash: expectedHashes.get(chunk.id) ?? '',
            },
          ]
        : [],
    );
    const written = saveKbChunkEmbeddings(sqlite, updates);
    return {
      attempted: result.attempted,
      embedded: written, // 实际写进去的条数：赶上"重新入库"的块会被跳过（不写脏向量）
      failed: result.failed,
      engineError: result.error?.message ?? null,
    };
  }

  /**
   * 索引请求的**单飞**（in-flight 复用 + 跑完补一轮）：
   *
   * - 并发调用者**复用同一个在跑的 promise**：不加这一条，两次 `indexPending` 会把
   *   **同一批文本**送进引擎两遍 —— 付费嵌入里那就是实打实的重复扣费，而且状态机挡不住
   *   （两次读到的都是"还没嵌"）。
   * - 但请求本身不能被吞掉（第二次可能带着刚写进来的新切片）：跑完**补一轮全库**。
   *   补的那轮没有待嵌的块时只是一次 SQL 扫描，不会白调引擎。
   */
  let inFlight: Promise<KbIndexReport> | null = null;
  let rerunRequested = false;

  function requestIndex(sourceId?: string): Promise<KbIndexReport> {
    if (!inFlight) return startRun(sourceId);
    rerunRequested = true;
    // 等这一轮跑完（它的结果也算在"我这次请求"的账上），再按需要补一轮
    return inFlight.then((report) => afterRun(report));
  }

  function startRun(sourceId?: string): Promise<KbIndexReport> {
    const promise = runIndex(sourceId);
    inFlight = promise;
    return promise.then(
      (report) => {
        if (inFlight === promise) inFlight = null;
        return afterRun(report);
      },
      (error: unknown) => {
        if (inFlight === promise) inFlight = null;
        // 这一轮已经失败了，排队的那轮也一并作废：待嵌的块都还在库里，
        // 下一次调用会重新读状态、接着做（不会丢活，也不用去追一个没人看的 promise）。
        rerunRequested = false;
        throw error;
      },
    );
  }

  /** 把"我等的那几轮"合成一份报告：`attempted/embedded/failed` 相加，错误取第一个非空。 */
  function mergeReports(base: KbIndexReport, next: KbIndexReport): KbIndexReport {
    return {
      attempted: base.attempted + next.attempted,
      embedded: base.embedded + next.embedded,
      failed: base.failed + next.failed,
      engineError: base.engineError ?? next.engineError,
    };
  }

  /**
   * 一轮跑完之后：有人排队就补一轮（全库，并发请求可能来自别的资料）；
   * 没排队但**别人已经补上了**（同一个 flag 只会被消费一次）就等那一轮 ——
   * 否则第二个调用者会拿着"其实什么都没干"的报告提前返回，调用方读到的
   * pendingCount 就是过期的。
   */
  function afterRun(report: KbIndexReport = { ...EMPTY_INDEX_REPORT }): Promise<KbIndexReport> {
    if (rerunRequested) {
      rerunRequested = false;
      return startRun().then((next) => mergeReports(report, next));
    }
    if (inFlight) return inFlight.then((next) => afterRun(mergeReports(report, next)));
    return Promise.resolve(report);
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

    const path = normalizeSourcePath(input.path);
    // 同一份文件/产物重复入库 ⇒ 同一个 source id（外加 (kind, path) 唯一索引兜底）。
    // 分隔符用 `::`（**不能是路径里可能出现的字符，也不能是不可打印字符**：NUL 会让
    // 整个源文件被 grep/diff 当成二进制，全库审计静默降级）。kind 只可能是
    // file/artifact/note 三者之一、都不含 `:`，所以 "kind::path" 不会有二义性。
    const sourceId =
      input.kind === 'note'
        ? `kb-note-${randomUUID()}`
        : `kb-${input.kind}-${hashText(`${input.kind}::${path}`).slice(0, 16)}`;

    // 更新 kb_sources 与替换切片**同一个事务**（见 db/kb.ts 的 ingestKbSource），
    // 所以"hash 已是新的、切片还是旧的"这种静默陈旧态在结构上不存在。
    const ingested = ingestKbSource(
      sqlite,
      {
        id: sourceId,
        kind: input.kind,
        path,
        title: input.title,
        contentHash: hashText(input.text),
        contentText: input.text,
        bytes: input.bytes,
        addedAt: now(),
      },
      () => buildChunkDrafts(input.text, deps.chunking),
    );
    const sourceId_ = ingested.source.id;

    // 内容没变、切片也在 ⇒ 不重切、更不重嵌（重复加入不该再花一次积分）。
    if (!ingested.rechunked) {
      return {
        status: 'unchanged',
        sourceId: sourceId_,
        chunkCount: ingested.chunkCount,
        embeddedCount: 0,
        pendingCount: pendingCount(sourceId_),
        truncated: input.truncated,
      };
    }

    const report = await requestIndex(sourceId_);

    return {
      status: 'indexed',
      sourceId: sourceId_,
      chunkCount: ingested.chunkCount,
      embeddedCount: report.embedded,
      pendingCount: pendingCount(sourceId_),
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
      return requestIndex(sourceId);
    },

    /**
     * 整库（或单份资料）重切 + 重嵌。
     *
     * ## 🔴 没有引擎时**必须什么都不做**
     *
     * `replaceKbChunks` 是"先删后插"（旧切片连同向量一起没），而 `runIndex` 在没有引擎时
     * **第一行就空手返回**。两者凑一起就是：把库里所有向量删干净、再补不回来 ——
     * 检索永久退化成关键词，界面还显示"重建完成"。实测过：删之前每行都有向量，
     * 删之后 `vector`/`embedding_model` 全变 NULL、`state` 回 `pending_embedding`。
     *
     * 触发路径一点都不刁钻：模型没打进包 / 被杀软拦 / U 盘换台机器 ⇒ 引擎起不来
     *（界面这时**正好**在提示"只能关键词检索"，用户很容易想"重建一下试试"）。
     *
     * 所以这里**提前返回**并带上 `skipped: 'no-engine'`，而不是"尽力而为" ——
     * 重建是**可重入**的（源文本才是真相），等引擎回来了再做完全来得及，没有任何损失。
     */
    async rebuild(sourceId) {
      if (!isEmbeddingEngineReady(engine)) {
        return { sources: 0, chunks: 0, ...EMPTY_INDEX_REPORT, skipped: 'no-engine' as const };
      }

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
      const report = await requestIndex(sourceId);
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

    listSources() {
      return listKbSources(sqlite).map((source) => ({
        id: source.id,
        kind: source.kind,
        path: source.path,
        title: source.title,
        bytes: source.bytes,
        addedAt: source.addedAt,
        chunks: countKbChunks(sqlite, source.id),
        // 这份资料还差多少切片没向量（界面显示"待建索引"）
        pending: kbChunkStateCounts(sqlite, source.id).pending_embedding,
      }));
    },
  };
}
