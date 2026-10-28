import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';
import { buildLocalExport, measureLocalBodies, MESSAGE_CHUNK_SIZE } from '../src/main/privacy/export-local.js';

/**
 * F1 的另一半证据：**预检那条聚合 SQL 与分块读，要真的跑在 SQLite 上**。
 *
 * ⚠️ 为什么要单开一个文件：`privacy-export-local.test.ts` 里的库是**手写的假库**
 *    （按表名回行）。它能钉住"读了几次、什么顺序"，但**一条 SQL 都不会真的执行** ——
 *    `count(*)` 聚合写得对不对、SQLite 的 `length()` 到底数什么、`order by 时间戳, id`
 *    在块边界上会不会漏行/重影，假库统统看不见（这与审阅里那条"拿被测函数当自己的
 *    尺子"的空洞是同一类）。所以这里换成**真引擎 + 真 DDL**：直接走 `initDatabase()`
 *    建表、真 drizzle 出 SQL、真 SQLite 执行。
 *
 * ⚠️ 为什么不用真的 `better-sqlite3`：它是按 **Electron ABI** 编译的，在 vitest
 *    （纯 node）里加载即 `ERR_DLOPEN_FAILED`。`node:sqlite` 是 Node 自带的
 *    SQLite（同样带 FTS5），把 `better-sqlite3` 换成一个**薄壳**接过去就行。
 *    ⚠️ 壳子要按 drizzle 实际调用的接口实现：投影查询走 `stmt.raw()`（要**数组**行）。
 */
const hoisted = vi.hoisted(() => ({
  /** 每次 `prepare(sql)` 的台账，按发生顺序 —— 用来钉"超限时一行正文都不读"。 */
  ledger: [] as string[],
}));

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() }),
}));

// 本地设置走白名单挑选，这里不需要真配置（`readConfig() === null` 会如实写进 notes）
vi.mock('../src/main/workspace/config.js', () => ({ readConfig: () => null }));

interface NodeStatement {
  all: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
  columns?: () => Array<{ name?: string }>;
  setReturnArrays?: (flag: boolean) => void;
}

interface NodeDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => NodeStatement;
  close: () => void;
}

vi.mock('better-sqlite3', async () => {
  const nodeSqlite = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (path: string) => NodeDatabase;
  };

  class Statement {
    constructor(private readonly stmt: NodeStatement) {}

    all(...params: unknown[]): unknown {
      return this.stmt.all(...params);
    }

    get(...params: unknown[]): unknown {
      return this.stmt.get(...params);
    }

    run(...params: unknown[]): unknown {
      return this.stmt.run(...params);
    }

    columns(): Array<{ name?: string }> {
      return this.stmt.columns?.() ?? [];
    }

    /** drizzle 的投影查询用 `raw()` 取**数组**行（`initFTS` 不用它，但得上）。 */
    raw(): { all: (...params: unknown[]) => unknown; get: (...params: unknown[]) => unknown } {
      const asArrays = <T>(run: () => T): T => {
        this.stmt.setReturnArrays?.(true);
        try {
          return run();
        } finally {
          this.stmt.setReturnArrays?.(false);
        }
      };
      return {
        all: (...params: unknown[]) => asArrays(() => this.stmt.all(...params)),
        get: (...params: unknown[]) => asArrays(() => this.stmt.get(...params)),
      };
    }
  }

  class Database {
    private readonly inner: NodeDatabase;

    constructor(_path: string) {
      // 用例之间靠 `closeDatabase()` 隔离，所以每个实例用一个独立的内存库
      this.inner = new nodeSqlite.DatabaseSync(':memory:');
    }

    pragma(text: string): void {
      this.inner.exec(`PRAGMA ${text}`);
    }

    exec(sql: string): void {
      this.inner.exec(sql);
    }

    prepare(sql: string): Statement {
      hoisted.ledger.push(sql);
      return new Statement(this.inner.prepare(sql));
    }

    close(): void {
      this.inner.close();
    }
  }

  return { default: Database };
});

/** 台账里"读了消息正文"的语句：碰到 messages 表、又不是那条聚合预检。 */
function bodyReads(): string[] {
  return hoisted.ledger.filter((sql) => /"messages"/.test(sql) && !/count\(\*\)/.test(sql));
}

/** 台账里的**聚合预检**语句（断言它真的跑过 —— 否则"没读正文"就是句空话）。 */
function preChecks(): string[] {
  return hoisted.ledger.filter((sql) => /count\(\*\)/.test(sql) && /"messages"/.test(sql));
}

function requireSqlite() {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('本地库未初始化');
  return sqlite;
}

function seedTasks(count: number): void {
  const now = '2026-09-18T00:00:00.000Z';
  const insert = requireSqlite().prepare(
    `INSERT INTO tasks (id, session_key, session_id, title, status, created_at, updated_at, tags, artifact_dir, gateway_id)
     VALUES (?, ?, '', ?, 'active', ?, ?, '[]', '', '')`,
  );
  for (let i = 0; i < count; i += 1) insert.run(`task-${i}`, `session-${i}`, `任务 ${i}`, now, now);
}

function seedMessages(list: Array<{ id: string; content: string; timestamp: string }>): void {
  // ⚠️ `messages_dedup` 是 (task_id, session_key, role, timestamp) 上的**唯一索引**：
  //    要让一批消息共用同一个时间戳（用来钉 `order by timestamp, id` 的分页稳定性），
  //    就得让 session_key 逐条不同，否则插入当场撞唯一索引、测的根本不是导出。
  const insert = requireSqlite().prepare(
    `INSERT INTO messages (id, task_id, role, content, timestamp, session_key)
     VALUES (?, 'task-0', 'assistant', ?, ?, ?)`,
  );
  for (const message of list) insert.run(message.id, message.content, message.timestamp, `session-${message.id}`);
}

function idsOf(rows: unknown[]): string[] {
  return rows.map((row) => (row as { id: string }).id);
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'privacy-export-sqlite-'));
  initDatabase(workspace);
});

afterEach(() => {
  closeDatabase();
  rmSync(workspace, { recursive: true, force: true });
});

describe('本地导出跑在真 SQLite 上（F1：预检 + 分块读）', () => {
  it('分块读跨块边界不重不漏，且每块之间是真的分页（真引擎）', async () => {
    const total = MESSAGE_CHUNK_SIZE + 1_000;
    const list = Array.from({ length: total }, (_, index) => ({
      id: `msg-${String(index).padStart(5, '0')}`,
      content: `第 ${index} 条中文正文`,
      // 每条时间戳**完全相同** ⇒ 次序只能靠 `id` 这个主键 tiebreak 撑住
      timestamp: '2026-09-18T00:00:00.000Z',
    }));
    seedTasks(1);
    seedMessages(list);
    hoisted.ledger.length = 0;

    const out = await buildLocalExport();

    expect(out.meta.counts.messages).toBe(total);
    // 一次全等：行数、次序、不重不漏（重影会让数组更长或 id 重复）
    expect(idsOf(out.messages)).toEqual(list.map((message) => message.id));
    expect(new Set(idsOf(out.messages)).size).toBe(total);
    expect(out.meta.truncated).toBe(false);

    // 真引擎上的分页：6000 行 / 每块 5000 ⇒ 恰好两条带 order by 的语句
    const chunks = hoisted.ledger.filter((sql) => /"messages"/.test(sql) && /order by/i.test(sql));
    expect(chunks).toHaveLength(2);
    // 行形状对得上：raw 数组行 → drizzle 映射回 camelCase 字段
    expect(out.messages[0]).toMatchObject({ id: 'msg-00000', taskId: 'task-0', role: 'assistant' });
  });

  it('预检是**下界**：中文正文字符数 < 真实字节数 ⇒ 不会误触体积闸（真引擎）', async () => {
    const list = Array.from({ length: 40 }, (_, index) => ({
      id: `msg-${String(index).padStart(3, '0')}`,
      content: '中文正文『导出』测试'.repeat(20),
      timestamp: `2026-09-18T00:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    seedTasks(1);
    seedMessages(list);

    const full = await buildLocalExport();
    const exact = measureLocalBodies({
      tasks: full.tasks,
      sessions: full.sessions,
      messages: full.messages,
      artifacts: full.artifacts,
    });
    // SQLite 的 `length()` 数的是**字符**：一个中文 3 字节 ⇒ 下界严格小于真值
    const chars = list.reduce((sum, message) => sum + message.content.length, 0);
    expect(chars).toBeLessThan(exact);

    // 上限卡在**下界与真值之间**：预检不该开火（开了就说明它算的不是下界），
    // 精确尺子必须开火 —— 两条说明文案不同，正好区分是谁触发的
    const capped = await buildLocalExport({ maxBytes: exact - 1 });
    expect(capped.meta.truncated).toBe(true);
    expect(capped.messages).toHaveLength(0);
    const notes = capped.notes.join('\n');
    expect(notes).toContain('本地数据体积');
    expect(notes).not.toContain('下界估计');
  });

  it('条数超限：真引擎上只跑聚合预检，一行正文都不读', async () => {
    const total = 3_000;
    seedTasks(1);
    seedMessages(
      Array.from({ length: total }, (_, index) => ({
        id: `msg-${String(index).padStart(5, '0')}`,
        content: `第 ${index} 条`,
        timestamp: '2026-09-18T00:00:00.000Z',
      })),
    );
    hoisted.ledger.length = 0;

    const out = await buildLocalExport({ maxMessages: 2_000 });

    expect(out.meta.counts.messages).toBe(total);
    expect(out.messages).toHaveLength(0);
    expect(out.meta.truncated).toBe(true);
    // 预检真的跑过（否则下面那条"没读正文"是空话）
    expect(preChecks().length).toBeGreaterThan(0);
    expect(bodyReads()).toEqual([]);
  });

  it('体积下界超限：真引擎上**在读正文之前**就退到元数据，一行正文都不读', async () => {
    seedTasks(1);
    seedMessages(
      Array.from({ length: 300 }, (_, index) => ({
        id: `msg-${String(index).padStart(5, '0')}`,
        content: '中'.repeat(4_000), // 每行下界 4000 字节 ⇒ 总量约 1.2 MB
        timestamp: '2026-09-18T00:00:00.000Z',
      })),
    );
    hoisted.ledger.length = 0;

    const out = await buildLocalExport({ maxBytes: 100_000 });

    expect(out.meta.truncated).toBe(true);
    expect(out.tasks).toHaveLength(0); // 正文整体退化成元数据
    expect(out.messages).toHaveLength(0);
    expect(out.notes.join('\n')).toContain('下界估计');
    expect(preChecks().length).toBeGreaterThan(0);
    expect(bodyReads()).toEqual([]);
  });
});
