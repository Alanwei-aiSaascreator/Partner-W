/**
 * 资料库服务的**引导**：把"引擎"和"服务"按正确的降级口径接起来。
 *
 * ## 为什么单独一层
 *
 * T6a 把服务与流水线都造好了（`createKbService` / `indexPending` / `search`），
 * T6b 造好了引擎（`loadEmbeddingEngine`）。两者之间要有人回答一个问题：
 * **引擎起不来时怎么办。**
 *
 * 答案写在 `loadEmbeddingEngine` 的契约里：返回 `null`。这一层把它翻成
 * 「**服务照建，engine 传 null**」—— 也就是纯关键词检索，T6a 的 `KbDegradedReason`
 * 里那个 `'no-engine'`，是**合法状态不是错误**。
 *
 * ⚠️ 存在的意义是"别让引擎的可用性决定资料库的可用性"：
 *    模型没打进包 / 原生模块被杀软拦 / 磁盘不够 —— 这些都只该让**向量检索**少一块，
 *    不该让用户连"搜我的资料"都做不到。
 *
 * ⚠️ 引擎只在这里加载**一次**并复用：加载要读 90MB 模型、几百毫秒，
 *    每次索引都重来一遍是不可接受的。
 */

import type Database from 'better-sqlite3';
import type { EmbeddingEngine } from '@clawwork/core';
import { createKbService, type KbService } from './service.js';
import { loadEmbeddingEngine } from './embedding/engine.js';
import { resolveKbModelRoot, type ResolveKbModelRootOptions } from './embedding/locate.js';

interface KbRuntime {
  service: KbService;
  /** `null` = 没有可用引擎，服务走纯关键词检索（合法降级，不是错误）。 */
  engine: EmbeddingEngine | null;
  /** 模型根目录；`undefined` = 打包态/开发态都没找到（日志里用来区分"没打进去"和"加载失败"）。 */
  modelRoot: string | undefined;
}

interface CreateKbRuntimeOptions {
  sqlite: Database.Database;
  /** 直接给模型根目录（测试/特殊部署用）；不给就从 `locate` 推。 */
  modelRoot?: string;
  /** 推模型根目录用的环境（打包态 vs 开发态）。 */
  locate?: ResolveKbModelRootOptions;
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** 注入点：测试用假引擎。 */
  loadEngine?: typeof loadEmbeddingEngine;
}

export async function createKbRuntime(options: CreateKbRuntimeOptions): Promise<KbRuntime> {
  const log = options.log ?? ((): void => {});
  const modelRoot = options.modelRoot ?? (options.locate ? resolveKbModelRoot(options.locate) : undefined);

  // 连模型目录都没找到（打包漏了 / 目录被删）⇒ **不去调加载器**，直接当"没有引擎"。
  // 这不是省一步，是避免把 `undefined` 传进去让加载器去猜一个路径 —— 猜出来的
  // 目录要么不存在、要么是别人的。日志里也要能区分这两种情况：模型没找到 vs 加载失败。
  if (!modelRoot) {
    log('kb.runtime.no_model_root', {});
    return { service: createKbService({ sqlite: options.sqlite, engine: null }), engine: null, modelRoot: undefined };
  }

  const engine = await (options.loadEngine ?? loadEmbeddingEngine)({ modelRoot, log });
  log('kb.runtime.ready', { engine: engine !== null, model: engine?.model ?? null, modelRoot });

  // ⚠️ 引擎是 null 也**照建服务** —— 见文件头注释。
  return { service: createKbService({ sqlite: options.sqlite, engine }), engine, modelRoot };
}
