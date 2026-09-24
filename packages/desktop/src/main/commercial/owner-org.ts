import type { CommercialOrg } from './auth.js';

/**
 * 「这个账号的计费组织是哪个」——**全客户端唯一的定义处**。
 *
 * 规则：`role = 'owner'` 里 `joined_at` 最早的那个；同时刻按 `org_id` 升序。
 * 一个 owner 组织都没有 ⇒ `null`（**不是**"随便挑一个组织"）。
 *
 * 为什么必须是这个规则（三处口径逐字对齐）：
 *   · 服务端 `activate_license`（迁移 56）在卡未绑时绑到
 *     `order by om.joined_at asc, om.org_id asc` 的**最早 owner 组织**；
 *   · `license.ts` 的 `firstOwnerOrg()` 查的是同一条 ORDER BY；
 *   · 这里必须一致 —— 否则「界面显示的卡」和「服务端认的卡」可能不是同一张。
 *
 * 为什么 owner-only（而不是 member 也算）：
 *   所有计费 RPC 都要求 `role = 'owner'`，member 连中转 key 都读不到；
 *   团队共享额度是 P1 明文推迟的事项（见 docs 的 p1/specs）。
 *   把 member 的组织算进来，等于把**别人组织的卡**显示成"当前账户已绑定"。
 *
 * 为什么要显式排序而不是用 `orgs[0]`：
 *   2026-09-24 的缺陷就是这个 —— `readSessionState` 查 `org_members` 时
 *   **既没有 order 也没有 role 过滤**，`orgs[0]` 是数据库给的任意一行。
 *
 * 纯函数：不改入参、不碰网络，所以它可以被穷举测试，
 * 而调用方（auth.ts / usage-from-server.ts）只剩"把结果传进去"这一件事。
 */
export function selectOwnerOrg(orgs: readonly CommercialOrg[]): CommercialOrg | null {
  let best: CommercialOrg | null = null;

  for (const org of orgs) {
    if (org.role !== 'owner') continue;
    if (best === null || compareOrgs(org, best) < 0) best = org;
  }

  return best;
}

/**
 * 早的排前面；`joined_at` 缺失/不可解析的排**最后**
 * （未知不等于最早 —— 与 `firstOwnerOrg()` 的 `asc` 在 NULL 上的行为一致，
 *  Postgres 默认 `NULLS LAST` 用于 asc）。
 */
function compareOrgs(left: CommercialOrg, right: CommercialOrg): number {
  const byJoined = joinedAtMs(left) - joinedAtMs(right);
  if (byJoined !== 0) return byJoined;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function joinedAtMs(org: CommercialOrg): number {
  const parsed = org.joinedAt ? Date.parse(org.joinedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
