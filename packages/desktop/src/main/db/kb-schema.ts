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

/** 表名清单（隐私导出/体检脚本可以拿它对照，确认没有多出别的表）。 */
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
CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
  DELETE FROM kb_chunks_fts WHERE rowid = old.rowid;
  INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  DELETE FROM kb_chunks_fts WHERE rowid = old.rowid;
END;
`;

/** FTS 表由触发器维护；这条只兜底"库是上一版建的、FTS 表还没回填过"的情况。 */
const KB_FTS_BACKFILL = `
INSERT OR IGNORE INTO kb_chunks_fts(rowid, text) SELECT rowid, text FROM kb_chunks;
`;

export function initKbSchema(db: Database.Database): void {
  db.exec(KB_TABLES_DDL);
  db.exec(KB_FTS_DDL);

  // 与 fts.ts 里 artifacts_fts 同款的列漂移守卫：以后给切片加可检索列时，
  // 老库要能自愈（否则新列永远搜不到，而且不会报错）。
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
    db.exec(KB_FTS_DDL);
  }

  db.exec(KB_FTS_BACKFILL);
  console.log('[kb] knowledge base tables initialized');
}
