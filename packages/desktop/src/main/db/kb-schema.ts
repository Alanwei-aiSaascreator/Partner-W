import type Database from 'better-sqlite3';

/**
 * 资料库（T6a）在工作区库 `<workspace>/.clawwork.db` 里的建表 + FTS5 索引。
 *
 * ⚠️ 三条铁律（写在这里，因为它们决定了整个 T6 的形状）：
 * 1. **只在工作区库建表**。生产库（`supabase/migrations/`）里**不许**出现任何
 *    kb_* 表 —— 隐私政策 §12.2 已承诺"对话记录/生成产物/记忆数据/文件索引保存在
 *    本机，我们不予收集、不予上传"（设计 §一）。
 * 2. `kb_chunks_fts` 是**降级路径的命脉**：没有向量、没有网也必须能检索（设计 §五）。
 *    所以它跟 `artifacts_fts` 一样用触发器维护，而不是等到嵌入成功才建索引。
 * 3. `kb_sources` 是真相、`kb_chunks` 可整体重建（设计 §八）：`content_text` 存的是
 *    建索引那一刻的正文快照，所以重建**不需要**回头读文件（U 盘拔了/文件被删也重建得出来）。
 */

/**
 * 表名清单（体检脚本可以拿它对照，确认没有多出别的表）。
 *
 * ⚠️ **待 T6b 接线：`kb_*` 目前还没有纳入本地隐私导出**
 *    （`src/main/privacy/export-local.ts` 里没有它们），而 `kb_sources.content_text`
 *    存的是用户全文（设计 §一承诺"文件索引保存在本机、不予收集"）——
 *    T6b 必须把这几张表接进导出，接完这句话才可以改成"导出可以拿它对照"。
 */
export const KB_TABLES = ['kb_meta', 'kb_sources', 'kb_chunks'] as const;

const KB_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS kb_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  embedding_model TEXT,
  dim INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'artifact', 'note')),
  path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  content_text TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0
);

-- 同一份资料重复入库要落到同一行（kind + path 唯一）。手工条目（note，path = ''）
-- 不参与去重：它们没有路径，每条都是新的。
CREATE UNIQUE INDEX IF NOT EXISTS kb_sources_kind_path ON kb_sources(kind, path) WHERE path <> '';

CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  vector BLOB,
  embedding_model TEXT,
  state TEXT NOT NULL DEFAULT 'pending_embedding'
    CHECK (state IN ('pending_embedding', 'embedded', 'stale')),
  UNIQUE (source_id, ordinal)
);

CREATE INDEX IF NOT EXISTS kb_chunks_state ON kb_chunks(state);
`;

/**
 * ⚠️ `unicode61` 与仓库里另外三张 FTS 表保持一致，代价是**中文不切词**：`收入主要来自
 *    软件订阅` 是一整个 token，所以 `收入*` 能命中、`订阅` 命中不了（实测见
 *    `test/kb-store.test.ts` 里那条"已知边界"用例）。断网降级的召回率就卡在这里，
 *    T6c 做命中率抽查时若发现不够，第一处要动的就是它（候选项与实测结论都在那条用例里）。
 */
const KB_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(text, tokenize='unicode61');

CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
-- ⚠️ 必须是 UPDATE OF text：写向量（vector/state/embedding_model）不碰 text，
--    没这条限定的话每写一次向量都要把整行 FTS 删了重插一遍（纯写放大，检索结果不变）。
CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE OF text ON kb_chunks BEGIN
  DELETE FROM kb_chunks_fts WHERE rowid = old.rowid;
  INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  DELETE FROM kb_chunks_fts WHERE rowid = old.rowid;
END;
`;

/**
 * FTS 回填 + **孤儿行对账**：每次启动都跑，幂等。
 *
 * 为什么必须先删孤儿：`kb_chunks_fts` 的 rowid 是与 `kb_chunks` 对齐的（触发器用
 * `new.rowid` 写进去的），一旦有人**绕开触发器**动过库（外部工具；或删除正好落在
 * "触发器不在"的窗口里），FTS 里就会留下一个 `kb_chunks` 里并不存在的 rowid。
 * SQLite 的 rowid 是**会复用**的：等新切片撞上那个号，`kb_chunks_ai` 里那句朴素的
 * `INSERT` 立刻 `UNIQUE constraint failed` —— 从那往后**每一次**入库都失败，用户看到的
 * 是"资料存不进去"，日志里只有一句约束冲突、指不到真凶。
 * 只做 `INSERT OR IGNORE` 回填救不了这一类：它只保证"不重复"，不负责"不留孤儿"。
 */
const KB_FTS_BACKFILL = `
DELETE FROM kb_chunks_fts WHERE rowid NOT IN (SELECT rowid FROM kb_chunks);
INSERT OR IGNORE INTO kb_chunks_fts(rowid, text) SELECT rowid, text FROM kb_chunks;
`;

/**
 * 触发器改定义只能"先删再建"（`CREATE TRIGGER IF NOT EXISTS` 不会替换已有的同名触发器）。
 * 早期版本建的是 `AFTER UPDATE`（不带列限定）⇒ 每次写向量都白重写一遍 FTS 行。
 * **只在这种老形状上删一次**：健康的库不碰，免得凭空造出"触发器缺失窗口"。
 *
 * ⚠️ 读 `sqlite_master` 要 `prepare`。**这条是尽力而为的巡检，不是建表的必经之路**：
 *    调用方给的句柄万一不支持查询（测试里的假库就只实现 `exec`），跳过即可 ——
 *    为了"检查优化"把建表整个搞挂，是捡了芝麻。
 */
function upgradeKbFtsTriggers(db: Database.Database): void {
  let row: { sql: string } | undefined;
  try {
    row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'kb_chunks_au'").get() as
      | { sql: string }
      | undefined;
  } catch {
    return;
  }
  if (row && !/UPDATE\s+OF\s+text/i.test(row.sql)) db.exec('DROP TRIGGER IF EXISTS kb_chunks_au');
}

/**
 * 回填后的自查：FTS 行数必须与切片行数一致。
 * **只报警不抛**：一次体检失败不该让应用起不来（库已经能用了，最坏只是召回率下降）。
 * 句柄不支持查询时同 `upgradeKbFtsTriggers`：跳过，不报错。
 */
function warnIfKbFtsOutOfSync(db: Database.Database): void {
  let row: { chunks: number; fts: number } | undefined;
  try {
    row = db
      .prepare(`SELECT (SELECT COUNT(*) FROM kb_chunks) AS chunks, (SELECT COUNT(*) FROM kb_chunks_fts) AS fts`)
      .get() as { chunks: number; fts: number } | undefined;
  } catch {
    return;
  }
  if (row && row.chunks !== row.fts) {
    console.warn(
      `[kb] FTS 与切片行数不一致（chunks=${row.chunks} / fts=${row.fts}）` +
        '：库可能被外部工具改过。已尝试回填；若重建索引后仍不一致请检查 kb_chunks_fts 的触发器。',
    );
  }
}

export function initKbSchema(db: Database.Database): void {
  db.exec(KB_TABLES_DDL);
  upgradeKbFtsTriggers(db);
  db.exec(KB_FTS_DDL);

  // 与 fts.ts 里 artifacts_fts 同款的漂移守卫。⚠️ 它查的**只是**"`text` 这一列在不在"
  // （用来兜底"上一版建的 FTS 表列不对"），并**不**比对完整列集、也不比对 tokenizer ——
  // 改 tokenizer 或加可检索列时都得自己在这里加判据，否则老库不会自愈。
  try {
    const columns = db.prepare('SELECT * FROM kb_chunks_fts LIMIT 0').columns();
    if (!columns.some((column) => column.name === 'text')) throw new Error('schema mismatch');
  } catch {
    db.exec(`
      DROP TABLE IF EXISTS kb_chunks_fts;
      DROP TRIGGER IF EXISTS kb_chunks_ai;
      DROP TRIGGER IF EXISTS kb_chunks_au;
      DROP TRIGGER IF EXISTS kb_chunks_ad;
    `);
    // 老定义是在这一步之前被删的 ⇒ 这里重建出来的就是新形状。
    db.exec(KB_FTS_DDL);
  }

  db.exec(KB_FTS_BACKFILL);
  warnIfKbFtsOutOfSync(db);
  console.log('[kb] knowledge base tables initialized');
}
