/**
 * 「当前账号」的判定（记忆归属键）。
 *
 * ⚠️ **不另起一套**：与 `artifact/delivery-activity.ts` 的归属捕获是**同一把尺** ——
 * 同样要求 `commercial.licenseKey` 与 `licenseBinding` 的 userId/orgId/licenseId 都非空。
 * 两处各判一套的话，"交付归属"与"记忆归属"会在同一台机器上给出不同的账号。
 *
 * ⚠️ 读不到 ⇒ `''`（**匿名**），**不**降级成"看到所有人的记忆"。
 *    原记忆规格的验收里有一条是"越权（别的账号 / 别的盘）读不到"：
 *    拿不准身份时把范围**收窄**到最窄，而不是放宽到最大。
 */

import { readConfig } from '../workspace/config.js';

/** 当前绑定账号的 userId；没有有效绑定 ⇒ `''`（匿名）。 */
export function currentMemoryOwnerId(): string {
  try {
    const commercial = readConfig()?.commercial;
    const binding = commercial?.licenseBinding;
    if (commercial?.licenseKey && binding?.userId && binding.orgId && binding.licenseId) return binding.userId;
  } catch {
    // 读配置失败 = 拿不到账号 ⇒ 匿名作用域。
  }
  return '';
}
