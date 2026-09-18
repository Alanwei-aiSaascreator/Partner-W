import { DatabaseSync } from 'node:sqlite';

/**
 * 把 `better-sqlite3` 的接口接到 Node 自带的 `node:sqlite` 上。
 *
 * 为什么需要：`better-sqlite3` 在本仓库是按 **Electron ABI** 编译的，vitest 跑在纯 node
 * 里，`require` 到它就 `ERR_DLOPEN_FAILED`。而资料库要验的东西（DDL、FTS5 触发器、
 * bm25 排序、外键级联、事务回滚）**全在 SQL 里** —— 拿假库断言"SQL 字符串长什么样"
 * 等于什么都没验。`node:sqlite` 同样是完整 SQLite（带 FTS5），换掉驱动即可真跑。
 *
 * ⚠️ 与 `privacy-export-local-sqlite.test.ts` 那份壳的**唯一区别**：这里把传入的路径
 *    原样交给 `node:sqlite`（真文件），而不是一律换 `:memory:` —— 资料库要测
 *    "关掉再打开同一个工作区库"（老库补表 + FTS 回填不能重复/丢数据）。
 *
 * 用法：
 * ```ts
 * vi.mock('better-sqlite3', async () => ({
 *   default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
 * }));
 * ```
 */
interface NodeSqliteStatement {
  all: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
  columns?: () => Array<{ name?: string }>;
  setReturnArrays?: (flag: boolean) => void;
}

class ShimStatement {
  constructor(private readonly statement: NodeSqliteStatement) {}

  all(...params: unknown[]): unknown {
    return this.statement.all(...params);
  }

  get(...params: unknown[]): unknown {
    return this.statement.get(...params);
  }

  run(...params: unknown[]): unknown {
    return this.statement.run(...params);
  }

  columns(): Array<{ name?: string }> {
    return this.statement.columns?.() ?? [];
  }

  /** drizzle 的投影查询走 `raw()`（要**数组**行）。资料库的 store 不用它，但得在。 */
  raw(): { all: (...params: unknown[]) => unknown; get: (...params: unknown[]) => unknown } {
    const asArrays = <T>(run: () => T): T => {
      this.statement.setReturnArrays?.(true);
      try {
        return run();
      } finally {
        this.statement.setReturnArrays?.(false);
      }
    };
    return {
      all: (...params: unknown[]) => asArrays(() => this.statement.all(...params)),
      get: (...params: unknown[]) => asArrays(() => this.statement.get(...params)),
    };
  }
}

export class NodeSqliteShim {
  private readonly inner: DatabaseSync;

  constructor(path: string) {
    this.inner = new DatabaseSync(path);
  }

  pragma(text: string): void {
    this.inner.exec(`PRAGMA ${text}`);
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.inner.prepare(sql) as unknown as NodeSqliteStatement);
  }

  close(): void {
    this.inner.close();
  }
}
