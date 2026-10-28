/**
 * PPTX 模板目录在**两种形态**下的位置。
 *
 * 形状刻意与 `docs/../skills/locate.ts` 的 `resolveOurSkillsRoot`、
 * `runtime/locate.ts` 的 `resolveBundledRuntimeRoot`、`kb/embedding/locate.ts` 保持一致：
 * 打包态从 `<resources>` 找、开发态从项目目录找，**都是纯函数**
 * （`isPackaged` / 路径由调用方注入，本模块不 import electron）——
 * 这样"开发态好好的、装出来就找不到"这类问题能在单测里直接覆盖，不用真打一次包。
 *
 * ⚠️ `PPTX_TEMPLATES_DIR_NAME` 必须与 `packages/desktop/electron-builder.yml` 里
 *    `extraResources` 的 `to:` **一字不差**。两边漂移的表现：
 *    模板填充**永远失败**（找不到模板文件），而开发态一切正常 ——
 *    靠 `test/pptx-template-packaging-gate.test.ts` 断言两者相等钉住。
 *
 * ⚠️ 只读。**不许往这个目录写**：打包态的模板在 `<resources>` 下，
 *    安装目录通常无写权限，而且那是随包资源、不是用户数据。
 *    产出写到调用方给的任务目录，由现成的产物通道负责。
 */

import path from 'node:path';

/** 随包模板根目录名（`<resources>/pptx-templates` 与 `<packages/desktop>/resources/pptx-templates` 同一名字）。 */
export const PPTX_TEMPLATES_DIR_NAME = 'pptx-templates';

export interface ResolvePptxTemplatesRootOptions {
  isPackaged: boolean;
  /** 打包态的 `<resources>`（真机上是 `process.resourcesPath`）。 */
  resourcesPath?: string;
  /**
   * 开发态的项目目录（真机上是 `app.getAppPath()`，dev 下即 `packages/desktop`）。
   * ⚠️ 刻意**不是**仓库根：模板就在 `packages/desktop/resources/pptx-templates`，
   *    与 `extraResources` 的 `from` 同一个位置，少一层推导少一处能错。
   */
  appPath?: string;
}

export function resolvePptxTemplatesRoot(opts: ResolvePptxTemplatesRootOptions): string | undefined {
  if (opts.isPackaged) {
    return opts.resourcesPath ? path.join(opts.resourcesPath, PPTX_TEMPLATES_DIR_NAME) : undefined;
  }
  return opts.appPath ? path.join(opts.appPath, 'resources', PPTX_TEMPLATES_DIR_NAME) : undefined;
}
