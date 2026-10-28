import { DEFAULT_COMPUTER_ACCESS_TIER } from '@clawwork/core';
import type {
  AppliedPermissionMap,
  AppliedPermissionMode,
  AppliedPermissionRecord,
  ChatComposerDeps,
  ComputerAccessTier,
} from '@clawwork/core';

/**
 * 桌面端那一层：把「设置里那一个字符串」翻译成 composer 认识的档位。
 *
 * 三件事，各占一个小函数（都好单测）：
 *   1. `normalizeComputerAccessTier` —— 字符串 → 档位（**显式值照办，其余落产品默认档**）；
 *   2. `permissionModeForTier`     —— 档位 → 该写下去的会话模式；
 *   3. `createComputerAccessDep`   —— 组装 composer 要的那个可选 dep。
 *
 * 真正的决策规则在 `@clawwork/core` 的 `decidePermissionPatch`（纯函数）里，
 * 本文件**不重复**那条规则。
 */

/**
 * 设置里那个原始值 → 档位。
 *
 * 规则两句话：
 *   1. **显式写下的 `'full'` / `'safe'` 一律照办** —— 用户关得掉；
 *   2. 其余（`undefined` / `null` / 数字 / 对象 / 拼错的字符串）⇒ **产品默认档**。
 *
 * 🔴 **2026-09-27 反转**：默认档从 `safe` 改成 `full`（理由见
 *    `@clawwork/core` 的 `DEFAULT_COMPUTER_ACCESS_TIER`）。
 *
 * ⚠️ **这里曾经是这样写的**：`value === 'full' ? 'full' : DEFAULT` —— 在默认是
 *    `safe` 时它恰好正确，但默认一改成 `full`，那一行就会**永远返回 `full`**：
 *    用户明确关掉（存下 `'safe'`）下次读又变回开着，**开关根本关不掉**。
 *    ⇒ 所以改成**逐字面量判断**，而不是"不是 full 就是默认"。
 *    有测试按名钉住（用例表里那条 `['safe', 'safe']`）。
 *
 * ⚠️ 认不出的值是**照默认档**处理（不再 fail-closed 到 `safe`）：默认档本身就是
 *    `full`，"坏值落到默认"才是一致的行为。这是用户知情的取舍 —— 原文写在这里的
 *    「配置坏掉必须落到更窄那一档」已被这次反转推翻，别当成 bug 改回去。
 */
export function normalizeComputerAccessTier(value: unknown): ComputerAccessTier {
  if (value === 'full') return 'full';
  if (value === 'safe') return 'safe';
  return DEFAULT_COMPUTER_ACCESS_TIER;
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
export const computerAccessApplied = new Map<string, AppliedPermissionRecord>();

/**
 * 「我们刚改过档位」的修订号 —— 让**徽章**能听见。
 *
 * ⚠️ 为什么需要它（2026-09-26 真机验收抓到的真 bug）：
 *    在任务里打开全权（或发一条消息触发发送链补刀）之后，那个会话**已经**是全权，
 *    而徽章**不出现** —— 因为它的重读只在**会话键变化**时触发，而全权是在它挂载
 *    **之后**才生效的。切走再切回来才看得见。
 *    徽章是「看得见」这条判据的承载者，看不见就等于没做。
 */
let revision = 0;
const revisionListeners = new Set<() => void>();

/** 给 `useSyncExternalStore` 用的快照读法。 */
export function computerAccessRevision(): number {
  return revision;
}

/** 订阅修订号变化；返回退订函数。 */
export function subscribeComputerAccessRevision(listener: () => void): () => void {
  revisionListeners.add(listener);
  return () => {
    revisionListeners.delete(listener);
  };
}

/**
 * 记下"我们把某个会话设成了什么"，并**通知界面重读**。
 *
 * ⚠️ 所有写入方都必须走这里（发送链补刀 + 设置页开关），别再直接 `.set()` ——
 *    直接 set 的后果就是徽章不刷新，也就是这次真机抓到的那条。
 */
export function rememberPermissionMode(
  applied: Map<string, AppliedPermissionRecord>,
  sessionKey: string,
  mode: AppliedPermissionMode,
  gatewayId: string,
): void {
  applied.set(sessionKey, { mode, gatewayId });
  revision += 1;
  for (const listener of revisionListeners) listener();
}

/**
 * 关掉全权时要**收回哪些会话**（纯函数）。
 *
 * ⚠️ 只收回**我们设过的那些**（记账里记着 `'full'` 的）：不认识的会话一律不碰 ——
 *    团队 / 对比 / 定时任务那些路径开的全权不归这个开关管。
 *
 * 为什么不能只收当前任务（补的是一个真缺口）：在任务 A 开了全权、切到 B 关掉，
 * A 仍然是全权。徽章会如实显示它，但**用户的理解是"我把这个功能关了"**。
 */
export function sessionsToRevoke(applied: AppliedPermissionMap, except?: string | null): string[] {
  const out: string[] = [];
  for (const [sessionKey, record] of applied) {
    if (record.mode !== 'full') continue;
    if (except && sessionKey === except) continue;
    out.push(sessionKey);
  }
  return out;
}

/** composer 要的那个可选 dep。宿主按 `readTier` 现读设置（不缓存快照）。 */
export function createComputerAccessDep(deps: {
  /** 读设置里那个原始值（**故意是 `unknown`**：脏值要在这里被挡掉，不是在上游假定干净）。 */
  readTier: () => unknown;
  applied: Map<string, AppliedPermissionRecord>;
}): NonNullable<ChatComposerDeps['computerAccess']> {
  return {
    tier: () => normalizeComputerAccessTier(deps.readTier()),
    applied: () => deps.applied,
    remember: (sessionKey, record) => {
      rememberPermissionMode(deps.applied, sessionKey, record.mode, record.gatewayId);
    },
  };
}
