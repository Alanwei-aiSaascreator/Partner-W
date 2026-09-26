/**
 * 「电脑操控权限」两档 —— 纯决策，不带 IO。
 *
 * 用户拍板的是**两档**（2026-09-26）：
 *   · `safe`（默认）= **一个字都不改动**：不下发任何 `permissionMode`，
 *     助手仍被关在自己工作区里、跑命令仍要问（= 0.0.35 的行为）；
 *   · `full`        = 下发 `permissionMode:'full'`：助手能读写整台电脑上的文件、
 *     跑命令不再逐条询问（运行时里该模式同时置 `workspaceOnly:false` 与
 *     `bypassHostApprovalFloors:true`，见 spec §1.2）。
 *
 * ⚠️ **为什么不改配置**：`state-config.ts` 的红线（`workspaceOnly:true` / `exec.mode:'ask'` /
 *    deny 掉 memory 工具）是**产品底线**，不在本设计的授权范围内。这里动的是**会话权限模式**
 *    ——运行时里它按设计**压过**配置（`agent-tools-*.mjs:375` 的 `??` 合成），
 *    且网关自己给 `full` 加了 `operator.admin` 门（spec §1.3）。
 *    ⇒ 「全权」是一个**显式的、要过同意门的、可随时收回的会话级授权**，
 *    不是把产品的安全底线拆掉。
 *
 * ⚠️ 本文件的规则（spec §2.5）只有三句话，改动前先回读 spec：
 *    ① 开着的档位必须在你说得上话的每个会话里都成立；
 *    ② 关着的档位**不去动**历史状态；
 *    ③ 补刀只补一次（进程内记账，见 `AppliedPermissionMode`）。
 */

/** 两档。默认 `safe`。 */
export type ComputerAccessTier = 'safe' | 'full';

/** ⚠️ 默认必须是安全档 —— 有测试按名钉住（判据 1）。 */
export const DEFAULT_COMPUTER_ACCESS_TIER: ComputerAccessTier = 'safe';

/**
 * 我们**主动写下去**的会话权限模式。
 *
 * 只收窄到这两档：`read-only`/`workspace` 是运行时的事，本功能不下发它们
 * （下发了自己都不认识，收回时就不知道该收成什么）。
 */
export type AppliedPermissionMode = 'full' | 'guarded';

/**
 * 一条记账：我们把某个会话设成了什么模式、**在哪个网关上**。
 *
 * ⚠️ 网关必须一起记：关掉全权时要把之前设过的会话一并收回，而那时**手上不一定有
 *    当前任务**（用户可能已经切走或删了任务）。靠任务列表反查网关是条会断的路。
 */
export interface AppliedPermissionRecord {
  mode: AppliedPermissionMode;
  gatewayId: string;
}

/**
 * 本进程**亲手设过**的会话模式记账（会话键 → 设成了什么 + 在哪个网关）。
 *
 * ⚠️ 它存在的唯一理由是**省掉重复补刀**，不是"当前档位的真相"。
 *    真相永远以 `sessions.list` 读回来的 `permissionMode` 为准（spec §2.4）——
 *    拿这张表当真相就会在"用户在别处改过/换了台机器"时骗人。
 */
export type AppliedPermissionMap = ReadonlyMap<string, AppliedPermissionRecord>;

/**
 * 这次发送前该不该补一刀权限？回 `null` = **什么都不发**。
 *
 * 调用方负责：拿到非 `null` 就 `sessions.patch {permissionMode}`，
 * **成功了才**记进 `applied`（失败不记账 ⇒ 下次还会补，不会永久哑掉）。
 */
export function decidePermissionPatch(params: {
  tier: ComputerAccessTier;
  sessionKey: string;
  applied: AppliedPermissionMap;
}): AppliedPermissionMode | null {
  const { tier, sessionKey, applied } = params;
  const previous = applied.get(sessionKey)?.mode;

  if (tier === 'full') {
    // 已经记过 full ⇒ 安静（补刀只补一次）。
    return previous === 'full' ? null : 'full';
  }

  // 安全档：只收回**我们自己开过**的那些；没记过账 / 已经收回过的，一个字都不动。
  return previous === 'full' ? 'guarded' : null;
}
