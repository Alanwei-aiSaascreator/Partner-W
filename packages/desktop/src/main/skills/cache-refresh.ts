/**
 * 装/卸随包技能之后，通知网关**把那一侧的技能缓存作废**（T-a2·A2-6）。
 *
 * ## 为什么需要这一下（机制与实测）
 *
 * 网关对**每个 agent** 缓存一份技能表：`skills.status` 的结果进 `skillEntryCache`，
 * 缓存键里含 `getSkillsSnapshotVersion(workspaceDir)`（随包运行时
 * `workspace-skill-loader-*.mjs`）。我们装/卸只动磁盘（cp/rm `managedSkillsDir`），
 * 那个版本号不会前进 ⇒ **装/卸对已经问过的 agent 不可见**。
 * 实测 2026-09-20（`%TEMP%/ta7mut/skills-cache-probe.mjs`，随包运行时 2026.9.3）：
 * 同一个网关进程、同一时刻，盘上删掉一个 managed 技能之后，
 * 问已经问过的 agent 技能数不变（照旧报着它），问没问过的 agent 立刻是磁盘真值；
 * 加技能同样看不见。两个方向都量了。
 *
 * 能让版本号前进的路子里，只有一条能从 RPC 够到（`bumpSkillsSnapshotVersion` 的
 * 调用点全扫过一遍）：
 *   - fs watcher（`refresh-C1N_6Xgp.mjs`）—— 只在**构建过一次 session snapshot**
 *     之后才装（`session-snapshot-DsNGsPvO.mjs:37`），而且 chokidar `ignoreInitial: true`，
 *     装它**之前**发生的增删永远看不见；
 *   - 远端节点、技能工坊 —— 与本场景无关；
 *   - **写一处 `skills.*` 配置**（`server-reload-managed-BZLndg46.mjs:508`：changedPaths 里
 *     有 `skills` 或 `skills.*` ⇒ 全局 bump）。
 *
 * 而且那条配置**值必须真的变**：原样重写同一条不算变更（`changedPaths.length === 0`
 * 直接 return），这一条也实测过（同一条 `skills.update` 连发两次，第二次不刷新）。
 *
 * ⇒ 装写 `{enabled: true}`、卸写 `{enabled: false}`（走 `skills.update`，写的是
 * `skills.entries.<skillKey>`）。装上 → 卸下 → 再装，值每次都真变，所以这三种
 * 常见动作都能立刻生效。
 *
 * ⚠️ 上面那个「内容升级值没变 ⇒ 不 bump」的缺口**已经补上了**（2026-09-29）：
 *    `force: true` 在同一笔 `skills.update` 中保持目标 enabled 不变，同时更新一个
 *    内部 nonce。这样既能让 `skills.*` 版本号前进，也没有「先禁用、再恢复」的竞态窗口。
 *
 * ## 纪律
 *
 * - **尽力而为**：装/卸本身成功与否不受这里影响，失败只记一条 warn。
 * - 网关没连上（或连接已断）就**不发**：`GatewayClient` 的请求超时是 15 秒，
 *   发出去而对面不回，只会把一条没人在等的请求挂在超时上。
 * - 这个模块**不 import 任何东西**（连日志都由调用方注入），所以它能在普通
 *   node 环境里被单测，不需要 electron 桩。
 */

/** 只需要 `updateSkill` 这一个方法 —— 传 `GatewayClient` 进来即可（结构匹配）。 */
export interface SkillCacheClient {
  updateSkill(params: { skillKey: string; enabled: boolean; env?: Record<string, string> }): Promise<unknown>;
}

export type SkillCacheNotifyOutcome = 'ok' | 'skipped' | 'failed';

export interface NotifySkillCacheChangeOptions {
  /** 网关客户端；没连上时调用方应传 `null`。 */
  client: SkillCacheClient | null | undefined;
  slug: string;
  enabled: boolean;
  /**
   * **强制 bump**：保持 `enabled` 为最终值，同一笔写入里更新内部 nonce。
   *
   * 为什么需要它：上面那段注释里记的**已知缺口** —— 「重复装同一个技能（内容升级）
   * 写进去的值没变 ⇒ 不 bump」。真机形状（2026-09-26，盘 E: 0.0.35）：
   * 技能内容升级后助手照旧按旧契约说"PDF 做不到"。
   *
   * 用的还是同一条**已实测过**的机制（“值必须真的变”）：
   * `skills.entries.<skillKey>.env.CLAWWORK_CACHE_REFRESH_NONCE` 每次都是新值。网关对
   * `env` 是逐键 merge，不会清掉技能原有的 Key。
   *
   * 一笔原子更新还消掉了超时歧义：就算客户端先收到超时、服务端稍后才
   * 提交，迟到的也是“正确 enabled + 新 nonce”，不可能再把目标技能关掉。
   * ⚠️ 只给**内容升级**用。普通装/卸的值本来就会变，多打一次是白打。
   */
  force?: boolean;
  onWarn?: (info: { slug: string; error: unknown }) => void;
}

let refreshNonceSequence = 0;

function nextRefreshNonce(): string {
  refreshNonceSequence += 1;
  return `${Date.now().toString(36)}-${refreshNonceSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function notifySkillCacheChange(opts: NotifySkillCacheChangeOptions): Promise<SkillCacheNotifyOutcome> {
  if (!opts.client) return 'skipped';
  try {
    await opts.client.updateSkill({
      skillKey: opts.slug,
      enabled: opts.enabled,
      ...(opts.force ? { env: { CLAWWORK_CACHE_REFRESH_NONCE: nextRefreshNonce() } } : {}),
    });
    return 'ok';
  } catch (error) {
    opts.onWarn?.({ slug: opts.slug, error });
    return 'failed';
  }
}
