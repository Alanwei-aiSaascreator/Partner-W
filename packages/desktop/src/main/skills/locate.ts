/**
 * 「我们自己的技能」随包根目录在**两种形态**下的位置（T-a2）。
 *
 * 形状刻意与 `runtime/locate.ts` 的 `resolveBundledRuntimeRoot`、
 * `kb/embedding/locate.ts` 的 `resolveKbModelRoot` 保持一致：
 * 打包态从 `<resources>` 找、开发态从项目目录找，**都是纯函数**
 * （`isPackaged` / 路径由调用方注入，本模块不 import electron）——
 * 这样"开发态好好的、装出来就找不到"这类问题能在单测里直接覆盖，不用真打一次包。
 *
 * ⚠️ `OUR_SKILLS_DIR_NAME` 必须与 `packages/desktop/electron-builder.yml` 里
 *    `extraResources` 的 `to:` **一字不差**。两边漂移的表现：
 *    技能市场**空着**、一键装永远失败，而开发态一切正常 —— 靠
 *    `test/our-skills-packaging-gate.test.ts` 断言两者相等钉住。
 */

import path from 'node:path';

/** 随包技能根目录名（`<resources>/our-skills` 与 `<packages/desktop>/our-skills` 同一名字）。 */
export const OUR_SKILLS_DIR_NAME = 'our-skills';

export interface ResolveOurSkillsRootOptions {
  isPackaged: boolean;
  /** 打包态的 `<resources>`（真机上是 `process.resourcesPath`）。 */
  resourcesPath?: string;
  /**
   * 开发态的项目目录（真机上是 `app.getAppPath()`，dev 下即 `packages/desktop`）。
   * ⚠️ 刻意**不是**仓库根：技能目录就在 `packages/desktop/our-skills`，
   *    与 `extraResources` 的 `from` 同一个位置，少一层推导少一处能错。
   */
  appPath?: string;
}

export function resolveOurSkillsRoot(opts: ResolveOurSkillsRootOptions): string | undefined {
  if (opts.isPackaged) {
    return opts.resourcesPath ? path.join(opts.resourcesPath, OUR_SKILLS_DIR_NAME) : undefined;
  }
  return opts.appPath ? path.join(opts.appPath, OUR_SKILLS_DIR_NAME) : undefined;
}
