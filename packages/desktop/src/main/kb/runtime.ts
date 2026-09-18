/**
 * 资料库运行时的**进程单例**。
 *
 * 为什么要有它：`createKbRuntime` 是纯函数（可测、无副作用），但真实应用里
 * 那个服务必须**活得比一次调用长** —— 引擎加载要读 90MB 模型（几百毫秒），
 * 每次搜索都重建一遍是不可接受的；而且 `KbService` 自己带**单飞队列**
 *（`requestIndex` 的并发守卫），必须让所有调用者拿到**同一个实例**，
 * 否则那道守卫等于没有。
 *
 * ## 生命周期
 *
 * - **建**：工作区就绪之后（`initDatabase` 跑过）。⚠️ **不要挡在开窗之前** ——
 *   加载模型要几百毫秒，用户看到的是"窗口半天不出来"。
 * - **拆**：工作区换了（`reinitDatabase`）⇒ 旧服务绑的是**旧库**，
 *   继续用它就是往一个已经关掉的连接上写。所以换库时必须先 `resetKbRuntime()`。
 * - 引擎加载失败**不抛也不重试**：`createKbRuntime` 会返回一个 engine=null 的服务
 *   （纯关键词检索，合法降级）。重试留给下次建运行时。
 */

import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { createKbRuntime } from './bootstrap.js';

type KbRuntime = Awaited<ReturnType<typeof createKbRuntime>>;

export interface BuildKbRuntimeOptions {
  sqlite: Database.Database;
  /** `app.isPackaged`。 */
  isPackaged: boolean;
  /** `process.resourcesPath`。 */
  resourcesPath?: string;
  /** `app.getAppPath()`（**开发态**用它推仓库根，打包态用不到）。 */
  appPath: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * 应用侧的构造：把 electron 那三样东西翻成 `createKbRuntime` 的入参。
 *
 * 单独抽出来是因为它**有两个调用点**（启动时建一次；换工作区后重来一次），
 * 而 `locate` 那三行的写法一旦两边不一致，就会出现"启动时找得到模型、换完盘找不到了"
 * 这种只在特定路径上复现的问题。
 */
export function buildKbRuntime(options: BuildKbRuntimeOptions): Promise<KbRuntime> {
  return createKbRuntime({
    sqlite: options.sqlite,
    locate: {
      isPackaged: options.isPackaged,
      resourcesPath: options.resourcesPath,
      // 开发态：本包在 `packages/desktop` ⇒ 仓库根是上两级（模型在 `<repo>/runtime-out/kb-model`）。
      repoRoot: options.isPackaged ? undefined : resolve(options.appPath, '..', '..'),
    },
    log: options.log,
  });
}

let current: KbRuntime | null = null;
/** 正在建的那一次：并发调用复用，避免同时加载两遍模型。 */
let inFlight: Promise<KbRuntime> | null = null;

export interface EnsureKbRuntimeOptions {
  loadEngine?: Parameters<typeof createKbRuntime>[0]['loadEngine'];
}

/** 取当前运行时；没建好就是 `null`（调用方据此回"还没就绪"，**不要**顺手建一个）。 */
export function getKbRuntime(): KbRuntime | null {
  return current;
}

/** 已经在跑或者跑完了 ⇒ 复用；否则建一次。并发调用共用一个 promise。 */
export function ensureKbRuntime(build: () => Promise<KbRuntime>): Promise<KbRuntime> {
  if (current) return Promise.resolve(current);
  if (inFlight) return inFlight;

  // ⚠️ 用 `Promise.resolve().then(build)` 而不是直接 `build()`：
  //    `build` 里可能**同步抛**（例如 `getSqlite()` 返回 null 时那句 throw），
  //    直接调用的话异常会同步穿出 `ensureKbRuntime`，下面的 `.catch` 根本接不到 ——
  //    调用方（IPC handler）就会在"工作区库还没就绪"这种正常时序下直接报错。
  const promise = Promise.resolve()
    .then(build)
    .then(
      (runtime) => {
        current = runtime;
        if (inFlight === promise) inFlight = null;
        return runtime;
      },
      (error: unknown) => {
        // 建失败**不留残骸**：下次调用可以重来（工作区可能刚被修好）。
        if (inFlight === promise) inFlight = null;
        throw error;
      },
    );
  inFlight = promise;
  return promise;
}

/** 换工作区 / 退出前调。不 await 引擎的释放（它没有可释放的原生句柄）。 */
export function resetKbRuntime(): void {
  current = null;
  inFlight = null;
}

export type { KbRuntime };
