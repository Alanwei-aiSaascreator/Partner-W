/**
 * 嵌入模型根目录在**两种形态**下的位置。
 *
 * 形状刻意与 `runtime/locate.ts` 的 `resolveBundledRuntimeRoot` 保持一致：
 * 都是「打包态从 `process.resourcesPath` 找、开发态从仓库根找」，
 * 也**都是纯函数**（`isPackaged` / 路径由调用方注入，本模块不 import electron）——
 * 这样"开发态好好的、装出来就不对"这类问题能在单测里直接覆盖，不用真打一次包。
 *
 * ⚠️ `KB_MODEL_DIR_NAME` 必须与 `packages/desktop/electron-builder.yml` 里
 *    `extraResources` 的 `to:` **一字不差**（现在都是 `kb-model`）。
 *    两边漂移的表现：装出来的包里模型躺在 A 目录、代码去 B 目录找 ⇒ 引擎返回 null ⇒
 *    **资料库静默退化成纯关键词检索**，没有任何报错。靠
 *    `test/kb-model-packaging-gate.test.ts` 断言两者相等钉住。
 */

import path from 'node:path';

/** 模型根目录名（`<resources>/kb-model` 与 `<repo>/runtime-out/kb-model` 同一名字）。 */
export const KB_MODEL_DIR_NAME = 'kb-model';

// ⚠️ 用 `path.join` 而不是手拼 `/`：手拼在 Windows 上得到 `C:/a/b`，功能上能跑，
// 但跟别处 `path.join` 出来的 `C:\a\b` **字符串不相等** —— 拿它做缓存键、去重、
// 或跟配置里的路径比对时会静默不命中。本文件第一版就是这么写的，被单测抓了出来。

export interface ResolveKbModelRootOptions {
  isPackaged: boolean;
  /** 打包态的 `<resources>`（真机上是 `process.resourcesPath`）。 */
  resourcesPath?: string;
  /** 开发态的仓库根（真机上是 `<repo>`；本模块不自己去猜 `__dirname` 的层数）。 */
  repoRoot?: string;
}

export function resolveKbModelRoot(opts: ResolveKbModelRootOptions): string | undefined {
  if (opts.isPackaged) {
    return opts.resourcesPath ? path.join(opts.resourcesPath, KB_MODEL_DIR_NAME) : undefined;
  }
  // 开发态：抓取脚本 `scripts/fetch-kb-model.mjs` 就是往 `runtime-out/kb-model` 落的。
  return opts.repoRoot ? path.join(opts.repoRoot, 'runtime-out', KB_MODEL_DIR_NAME) : undefined;
}
