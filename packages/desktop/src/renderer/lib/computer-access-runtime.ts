import { DEFAULT_COMPUTER_ACCESS_TIER } from '@clawwork/core';
import type { AppliedPermissionMode, ChatComposerDeps, ComputerAccessTier } from '@clawwork/core';

/**
 * 桌面端那一层：把「设置里那一个字符串」翻译成 composer 认识的档位。
 *
 * 三件事，各占一个小函数（都好单测）：
 *   1. `normalizeComputerAccessTier` —— 字符串 → 档位，**认不出的一律安全档**；
 *   2. `permissionModeForTier`     —— 档位 → 该写下去的会话模式；
 *   3. `createComputerAccessDep`   —— 组装 composer 要的那个可选 dep。
 *
 * 真正的决策规则在 `@clawwork/core` 的 `decidePermissionPatch`（纯函数）里，
 * 本文件**不重复**那条规则。
 */

/**
 * 只认识 `'full'` 一个字面量，**其它一切**（`undefined` / `null` / `'FULL'` /
 * `'safe'` / 数字 / 对象 / 设置还没加载完）都是**安全档**。
 *
 * ⚠️ 方向不许反过来。这里是本项目的老坑（"读取期兜底"）：
 *    配置坏掉、字段缺失、IPC 还没回来 —— 这些都必须落到**更窄**的那一档。
 *    兜到 `full` 就成了"配置一坏反而放开整台电脑"。
 */
export function normalizeComputerAccessTier(value: unknown): ComputerAccessTier {
  return value === 'full' ? 'full' : DEFAULT_COMPUTER_ACCESS_TIER;
}

/**
 * 档位 → 要写下去的会话模式。
 *
 * ⚠️ **安全档写的是显式的 `'guarded'`，不是"什么都不写"**。
 *    发送链上（`decidePermissionPatch`）才有"没记过账就别动"那条优化；
 *    而**用户主动关开关**这个动作必须**无条件收回** ——
 *    进程重启后记账是空的，而会话可能还是 full（上一次开的），
 *    靠记账去判断就永远收不回来了。
 */
export function permissionModeForTier(tier: ComputerAccessTier): AppliedPermissionMode {
  return tier === 'full' ? 'full' : 'guarded';
}

/**
 * 本进程**亲手设过**的会话模式记账（会话键 → 设成了什么）。
 *
 * ⚠️ 它只用来给发送链省掉重复补刀，**不是"当前档位的真相"**。
 *    真相以 `sessions.list` 读回来的 `permissionMode` 为准（界面上的徽章读的就是它）。
 */
export const computerAccessApplied = new Map<string, AppliedPermissionMode>();

/** composer 要的那个可选 dep。宿主按 `readTier` 现读设置（不缓存快照）。 */
export function createComputerAccessDep(deps: {
  /** 读设置里那个原始值（**故意是 `unknown`**：脏值要在这里被挡掉，不是在上游假定干净）。 */
  readTier: () => unknown;
  applied: Map<string, AppliedPermissionMode>;
}): NonNullable<ChatComposerDeps['computerAccess']> {
  return {
    tier: () => normalizeComputerAccessTier(deps.readTier()),
    applied: () => deps.applied,
    remember: (sessionKey, mode) => {
      deps.applied.set(sessionKey, mode);
    },
  };
}
