import type Database from 'better-sqlite3';

interface SearchResult {
  type: 'task' | 'message' | 'artifact';
  id: string;
  title: string;
  snippet: string;
  taskId?: string;
}

const SEARCH_SQL = `
SELECT * FROM (
  SELECT 'task' AS type, t.id, t.title, snippet(tasks_fts, 0, '<<', '>>', '…', 32) AS snippet,
    NULL AS task_id, tasks_fts.rank
  FROM tasks_fts
  JOIN tasks t ON t.rowid = tasks_fts.rowid
  WHERE tasks_fts MATCH ?
  UNION ALL
  SELECT 'message' AS type, m.id, substr(m.content, 1, 60) AS title,
    snippet(messages_fts, 0, '<<', '>>', '…', 32) AS snippet,
    m.task_id, messages_fts.rank
  FROM messages_fts
  JOIN messages m ON m.rowid = messages_fts.rowid
  WHERE messages_fts MATCH ?
  UNION ALL
  SELECT 'artifact' AS type, a.id, a.type AS title,
    snippet(artifacts_fts, 1, '<<', '>>', '…', 32) AS snippet,
    a.task_id, artifacts_fts.rank
  FROM artifacts_fts
  JOIN artifacts a ON a.rowid = artifacts_fts.rowid
  WHERE artifacts_fts MATCH ?
) ORDER BY rank LIMIT 20;
`;

/**
 * Minimum number of normalized (punctuation-stripped) characters a query must
 * have before we run an FTS5 prefix match. A single-character prefix such as
 * `a*` matches almost every indexed token, degrading into a full-table scan
 * that blocks the main process for hundreds of milliseconds (#391).
 */
const MIN_FTS_QUERY_LENGTH = 2;

/**
 * FTS5 \u7684\u5e03\u5c14\u64cd\u4f5c\u7b26\uff1a**\u88f8\u9732\u5730\u62fc\u8fdb `MATCH` \u662f\u8bed\u6cd5\u9519\u8bef**\uff08`OR` \u21d2
 * `fts5: syntax error near "OR"`\uff09\uff0c\u6240\u4ee5\u5b83\u4eec\u5fc5\u987b\u88ab\u5f15\u53f7\u5305\u8d77\u6765\u3001\u5f53\u5b57\u9762\u8bcd\u7528
 * \uff08\u5b9e\u6d4b `"OR"*` \u4e0d\u629b\u9519\uff0c\u800c\u4e14**\u8fd8\u80fd\u641c\u5230\u6b63\u6587\u91cc\u771f\u7684\u5199\u7740 OR \u7684\u90a3\u4e9b\u884c**\uff09\u3002
 *
 * \u26a0\ufe0f FTS5 \u53ea\u8ba4**\u5927\u5199**\u5f62\u5f0f\uff08\u5c0f\u5199\u7684 `and`/`or` \u5c31\u662f\u666e\u901a\u8bcd\uff09\uff0c\u6240\u4ee5\u8fd9\u91cc\u5927\u5c0f\u5199\u654f\u611f\u3002
 */
const FTS_OPERATOR_TOKENS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * Normalize a raw user query into an FTS5 prefix expression, or return `null`
 * when it is empty or shorter than {@link MIN_FTS_QUERY_LENGTH}. Letters and
 * digits of any script (Latin incl. accents, CJK, kana, Hangul, Cyrillic, \u2026)
 * are preserved; everything else is treated as a separator.
 *
 * \u8d44\u6599\u5e93\u7684\u5173\u952e\u8bcd\u68c0\u7d22\uff08`db/kb.ts`\uff09\u590d\u7528\u540c\u4e00\u4e2a\u51fd\u6570 \u2014\u2014 \u4e24\u8fb9\u7684"\u4ec0\u4e48\u7b97\u5408\u6cd5\u67e5\u8be2"\u5fc5\u987b\u4e00\u81f4\uff0c
 * \u5426\u5219\u540c\u4e00\u53e5\u8bdd\u5728\u5168\u5c40\u641c\u7d22\u80fd\u641c\u5230\u3001\u5728\u8d44\u6599\u5e93\u91cc\u8fd4\u56de\u7a7a\u3002
 *
 * \u4e3a\u4ec0\u4e48\u53ea\u7ed9\u64cd\u4f5c\u7b26\u52a0\u5f15\u53f7\uff08\u800c\u4e0d\u662f\u9010 token \u5168\u52a0\uff09\uff1a\u5f52\u4e00\u5316\u540e\u7684 token \u53ea\u80fd\u7531\u5b57\u6bcd/\u6570\u5b57/\u4e0b\u5212\u7ebf\u7ec4\u6210\uff0c
 * FTS5 \u5bf9\u5b83\u4eec\u6ca1\u6709\u4efb\u4f55\u7279\u6b8a\u89e3\u91ca \u2014\u2014 \u52a0\u4e0d\u52a0\u5f15\u53f7\u8bed\u4e49\u5b8c\u5168\u7b49\u4ef7\uff08`render*` \u2261 `"render"*`\uff09\uff0c
 * \u800c\u4fdd\u6301\u539f\u6837\u80fd\u8ba9**\u5df2\u6709**\u7684\u5168\u5c40\u641c\u7d22\u884c\u4e3a\u4e00\u5b57\u4e0d\u53d8\u3002\u9010 token \u5404\u81ea\u5e26 `*`\uff08\u800c\u4e0d\u662f\u6574\u4e32\u5c3e\u90e8\u4e00\u4e2a `*`\uff09
 * \u662f\u987a\u624b\u4fee\u7684\u4e00\u4e2a\u6f0f\u6d1e\uff1a\u539f\u6765 `\u9884\u7b97 \u6536\u5165` \u53ea\u6709\u6700\u540e\u4e00\u4e2a\u8bcd\u662f\u524d\u7f00\u5339\u914d\u3002
 */
export function toFtsPrefixQuery(query: string): string | null {
  const normalized = query.replace(/[^\p{L}\p{N}_]/gu, ' ').trim();
  if (normalized.length < MIN_FTS_QUERY_LENGTH) return null;
  return normalized
    .split(/\s+/)
    .map((token) => (FTS_OPERATOR_TOKENS.has(token) ? `"${token}"*` : `${token}*`))
    .join(' ');
}

export function globalSearch(db: Database.Database, query: string): SearchResult[] {
  const ftsQuery = toFtsPrefixQuery(query);
  if (!ftsQuery) return [];

  const stmt = db.prepare(SEARCH_SQL);
  const rows = stmt.all(ftsQuery, ftsQuery, ftsQuery) as Array<{
    type: 'task' | 'message' | 'artifact';
    id: string;
    title: string;
    snippet: string;
    task_id: string | null;
  }>;

  return rows.map((r) => ({
    type: r.type,
    id: r.id,
    title: r.title,
    snippet: r.snippet,
    taskId: r.task_id ?? undefined,
  }));
}

const ARTIFACT_SEARCH_SQL = `
SELECT a.id, a.task_id, a.name, a.type, a.local_path, a.mime_type, a.size, a.created_at, a.file_path, a.message_id,
  snippet(artifacts_fts, 1, '<mark>', '</mark>', '…', 32) AS content_snippet
FROM artifacts_fts
JOIN artifacts a ON a.rowid = artifacts_fts.rowid
WHERE __WHERE__
ORDER BY artifacts_fts.rank
LIMIT 50;
`;

interface ArtifactSearchResult {
  id: string;
  taskId: string;
  name: string;
  type: string;
  localPath: string;
  mimeType: string;
  size: number;
  createdAt: string;
  filePath: string;
  messageId: string;
  contentSnippet?: string;
}

type ArtifactSearchKind = 'all' | 'image' | 'code' | 'file' | 'other';

interface ArtifactSearchOptions {
  kind?: ArtifactSearchKind;
}

function artifactKindClause(kind: ArtifactSearchKind | undefined): string | null {
  if (!kind || kind === 'all') return null;
  if (kind === 'image') return "(a.type = 'image' OR a.mime_type LIKE 'image/%')";
  if (kind === 'code') return "a.type = 'code'";
  if (kind === 'file') return "a.type = 'file'";
  return "(a.type NOT IN ('image', 'code', 'file') AND a.mime_type NOT LIKE 'image/%')";
}

export function searchArtifacts(
  db: Database.Database,
  query: string,
  options: ArtifactSearchOptions = {},
): ArtifactSearchResult[] {
  const ftsQuery = toFtsPrefixQuery(query);
  if (!ftsQuery) return [];
  const clauses = ['artifacts_fts MATCH ?'];
  const params: string[] = [ftsQuery];
  const kindClause = artifactKindClause(options.kind);
  if (kindClause) clauses.push(kindClause);
  const stmt = db.prepare(ARTIFACT_SEARCH_SQL.replace('__WHERE__', clauses.join(' AND ')));
  const rows = stmt.all(...params) as Array<{
    id: string;
    task_id: string;
    name: string;
    type: string;
    local_path: string;
    mime_type: string;
    size: number;
    created_at: string;
    file_path: string;
    message_id: string;
    content_snippet: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    name: r.name,
    type: r.type,
    localPath: r.local_path,
    mimeType: r.mime_type,
    size: r.size,
    createdAt: r.created_at,
    filePath: r.file_path,
    messageId: r.message_id,
    contentSnippet: r.content_snippet || undefined,
  }));
}
