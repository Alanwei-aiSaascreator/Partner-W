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
 * 用法：抄任意一个用例文件顶部的 `vi.mock('better-sqlite3', …)` 即可
 * （`kb-bootstrap` / `kb-fts-query` / `kb-recall-boundary` / `kb-service` /
 * `kb-store` / `workspace-db-rebuild`）。全都一字不差，所以不再在这里抄一遍。
 *
 * ⚠️ **刻意不在 docblock 里写那段代码块**：knip 会把 docblock 代码块里的
 * `import('<相对路径>')` 当成真的导入去解析，而那条路径是相对**用例文件**
 * （`test/*.test.ts`）写的，从本文件所在的 `helpers/` 自然解析不到
 * ⇒ 白报一条「未解析导入」。换个位置写只是让它换个行号继续报（试过），
 * 所以这里改成指路。（触发条件没能完全收敛：静态 `import … from '…'` 写在
 * 注释里、以及动态 `import()` 写在**自由注释**里，实测都**不**会触发。）
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

/**
 * `better-sqlite3` 的替身。接法见本文件顶部的说明（那里列了 6 个现成用例）。
 *
 * ⚠️ 装法本身值得记一句：`vi.mock` 的工厂会被 vitest **提升**到 import 之前，
 * 所以工厂里**不能**用静态 import（那时模块还没求值），只能用 `await import(...)`。
 */
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

  /**
   * `better-sqlite3` 的 `db.transaction(fn)`：返回带 `.deferred/.immediate/.exclusive`
   * 三个变体的包装函数（F4 起 `delivery-settlement` 用 drizzle 事务 —— 少了这个，
   * drizzle 的 `nativeTx[config.behavior ?? 'deferred']` 直接抛 "not a function"，
   * 标记静默写不进去）。语义对齐：包装调用 = BEGIN（按变体）→ fn → COMMIT，
   * fn 抛错则 ROLLBACK 后原样重抛；参数透传（better-sqlite3 同款）。
   */
  transaction(fn: (...args: unknown[]) => unknown): {
    (...args: unknown[]): unknown;
    deferred: (...args: unknown[]) => unknown;
    immediate: (...args: unknown[]) => unknown;
    exclusive: (...args: unknown[]) => unknown;
  } {
    const run = (mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE') => {
      return (...args: unknown[]): unknown => {
        this.inner.exec(`BEGIN ${mode}`);
        try {
          const result = fn(...args);
          this.inner.exec('COMMIT');
          return result;
        } catch (err) {
          this.inner.exec('ROLLBACK');
          throw err;
        }
      };
    };
    const wrapper = run('DEFERRED') as ReturnType<NodeSqliteShim['transaction']>;
    wrapper.deferred = run('DEFERRED');
    wrapper.immediate = run('IMMEDIATE');
    wrapper.exclusive = run('EXCLUSIVE');
    return wrapper;
  }

  close(): void {
    this.inner.close();
  }
}
