import type Database from 'better-sqlite3';
import type {
  ClawDashboardData,
  DashboardBreakdownEntry,
  DashboardBreakdowns,
  DashboardLast30d,
} from '@clawwork/shared';
import { parseAgentIdFromSessionKey } from '@clawwork/shared';
import { getAllGatewayClients } from '../ws/index.js';
import { readServerUsage } from './usage-from-server.js';

/**
 * 统计页数据。
 *
 * ⚠️ 这里有**两个口径**，别混：
 *
 *   · 任务数 / 活跃天数 / 消息数 / 文件数 / 网关排行 / Agent 排行 —— **本机**
 *     SQLite，反映这台机器上的活动。
 *   · `modelUsage` 与 `last30d` —— **账号级**，来自服务端计费表，反映
 *     「钱花在哪了」。它与账户页的余额同源，能对账。
 *
 * 两者数量级和含义都不同，界面上必须标出来（否则用户会以为数字对不上）。
 */
export async function collectDashboardData(db: Database.Database): Promise<ClawDashboardData> {
  const totalTasks = (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;

  const activeDays = (
    db.prepare('SELECT COUNT(DISTINCT substr(created_at, 1, 10)) as c FROM tasks').get() as { c: number }
  ).c;

  const totalMessages = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
  const totalArtifacts = (db.prepare('SELECT COUNT(*) as c FROM artifacts').get() as { c: number }).c;

  const breakdowns = collectBreakdowns(db, totalTasks, buildGatewayNameMap());

  // 账号级的真实消耗。拿不到就是 null（未登录 / 无商业配置 / 请求失败），
  // 界面降级成「暂无数据」—— 注意 null 与「空数组」含义不同，别合并。
  const server = await readServerUsage();

  const last30d: DashboardLast30d | null = server
    ? {
        input: server.totals.input,
        output: server.totals.output,
        costMicros: server.totals.costMicros,
        daily: server.daily,
      }
    : null;

  return {
    totalTasks,
    activeDays,
    totalMessages,
    totalArtifacts,
    breakdowns,
    last30d,
    modelUsage: server ? server.models : null,
  };
}

function toEntries(
  rows: Array<{ name: string; count: number }>,
  total: number,
  limit: number,
): DashboardBreakdownEntry[] {
  return rows
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((row) => ({
      name: row.name,
      count: row.count,
      percent: total > 0 ? Math.round((row.count / total) * 100) : 0,
    }));
}

function buildGatewayNameMap(): Map<string, string> {
  const clients = getAllGatewayClients();
  const nameMap = new Map<string, string>();
  for (const [id, client] of clients) {
    nameMap.set(id, client.name || id);
  }
  return nameMap;
}

function collectBreakdowns(
  db: Database.Database,
  totalTasks: number,
  gatewayNames: Map<string, string>,
): DashboardBreakdowns {
  // ⚠️ 这里原来有一条 `SELECT model, COUNT(*) FROM tasks GROUP BY model`，2026-09-12 删掉了。
  //
  // 它数的是**任务行**，而 `tasks.model` 是**会话选中的模型**（一个会话一行）——
  // 既看不出用户中途切模型，也看不出网关的自动回退（fallback 事件只弹一条
  // persist:false 的提示，从不落库）。用户拿它跟账单对，永远对不上。
  //
  // 模型维度改由 `modelUsage` 承担：数据来自服务端**计费表**，
  // 每次调用一行、记的是实际发到上游的模型名。见 usage-from-server.ts。
  //
  // 保留这个空数组而不是删字段：`DashboardBreakdowns` 的形状被 IPC 契约与
  // preload 类型引用，删字段会波及一串无关文件；空数组在界面上就是不展示。

  const gatewayRawRows = db
    .prepare(
      `SELECT gateway_id as id, COUNT(*) as count
       FROM tasks
       WHERE gateway_id IS NOT NULL AND gateway_id != ''
       GROUP BY gateway_id`,
    )
    .all() as Array<{ id: string; count: number }>;
  const gatewayRows = gatewayRawRows.map((row) => ({
    name: gatewayNames.get(row.id) ?? row.id,
    count: row.count,
  }));

  const sessionKeyRows = db.prepare('SELECT session_key as sessionKey FROM tasks').all() as Array<{
    sessionKey: string;
  }>;
  const agentCounts = new Map<string, number>();
  for (const { sessionKey } of sessionKeyRows) {
    const agentId = parseAgentIdFromSessionKey(sessionKey);
    if (!agentId) continue;
    agentCounts.set(agentId, (agentCounts.get(agentId) ?? 0) + 1);
  }
  const agentRows = Array.from(agentCounts.entries()).map(([name, count]) => ({ name, count }));

  return {
    models: [],
    gateways: toEntries(gatewayRows, totalTasks, 5),
    agents: toEntries(agentRows, totalTasks, 5),
  };
}
