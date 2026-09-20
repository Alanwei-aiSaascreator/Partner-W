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
 * ⚠️ **已知缺口（照实记）**：重复装同一个技能（内容升级）写进去的值没变 ⇒ 不 bump，
 * 那种情况下 agent 可能还拿着旧内容，直到别的事件 bump 或重启应用。
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
  updateSkill(params: { skillKey: string; enabled: boolean }): Promise<unknown>;
}

export type SkillCacheNotifyOutcome = 'ok' | 'skipped' | 'failed';

export interface NotifySkillCacheChangeOptions {
  /** 网关客户端；没连上时调用方应传 `null`。 */
  client: SkillCacheClient | null | undefined;
  slug: string;
  enabled: boolean;
  onWarn?: (info: { slug: string; error: unknown }) => void;
}

export async function notifySkillCacheChange(opts: NotifySkillCacheChangeOptions): Promise<SkillCacheNotifyOutcome> {
  if (!opts.client) return 'skipped';
  try {
    await opts.client.updateSkill({ skillKey: opts.slug, enabled: opts.enabled });
    return 'ok';
  } catch (error) {
    opts.onWarn?.({ slug: opts.slug, error });
    return 'failed';
  }
}
