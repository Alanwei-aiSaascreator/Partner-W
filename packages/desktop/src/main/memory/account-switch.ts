/**
 * **账户边界**上的 `MEMORY.md` 重投影（BUG-133，2026-10-17）。
 *
 * ## 为什么需要单独一跳
 *
 * `MEMORY.md` 是**随盘共享文件、运行时每轮全文注入**。平时的重投影只在
 * 「启动 / 运行时重试 / 设置页改动 / 每轮（>20 条时）」发生 ——
 * **纯 sign-in / sign-out 不触发**。于是 A 账号投过影之后，应用内登出 / 换到 B、
 * 且 B 的已确认条目 ≤20（常态）时，助手下一轮**仍读到 A 的已确认记忆** ——
 * 与 §7「越权读不到」直接矛盾。
 *
 * 这一跳补的就是那个缺口：**在"当前账号"发生变化的那一刻**，把受管区块重投一次。
 * 归属从库里现取（`currentMemoryOwnerId()`），没有第二套真源：
 *   · 登出 / 未绑定 ⇒ 归属 = `''`（匿名）⇒ 受管区块被**清空**；
 *   · 登录后激活 / 恢复授权 ⇒ 归属 = 新账号 ⇒ 投影**新账号那批**。
 *
 * ## 与 `sync.ts` 的分工
 *
 * `sync.ts` 是"**把某个账号的已确认集合投影出去**"这件事本身；本文件只回答
 * "**什么时候该投**"—— 由登录 / 登出 / 激活 / 清卡这几条真实账户边界调用。
 *
 * ## 纪律（与 `kickMemoryInjection` 同源）
 *
 * · **永不抛**：账户切换绝不能因为记忆没投影上而失败（记忆是增强，不是前置条件）；
 * · 网关没起 / 没连上 ⇒ **静默跳过**：下一次启动或下一次边界会补上，
 *   绝不能拿"网关不可用"去挡登录登出；
 * · 只写受管区块，用户正文原样保留（那是 `materialize.ts` 的事）。
 */

import { getGatewayClient } from '../ws/index.js';
import { LOCAL_GATEWAY_ID } from '../runtime/state-config.js';
import { getDebugLogger } from '../debug/index.js';
import { syncMemoryToAgents } from './sync.js';
import { currentMemoryOwnerId } from './owner.js';

/**
 * 账户边界之后，把盘上每个助手的 `MEMORY.md` 重投影成**当前账号现算**。
 *
 * 调用方（`ipc/commercial-handlers.ts`）在登录 / 登出 / 激活 / 清卡成功后各调一次；
 * 这里**不抛**，失败只记一条日志（与启动注入同样的姿态）。
 */
export async function resyncMemoryOnAccountBoundary(): Promise<void> {
  // ⚠️ 整段都在 try 里：调用方是**登录 / 登出 / 激活**这几条 IPC —— 它们**绝不能**
  //    因为记忆投影（网关取用、文件读写）的任何一步出错而失败。账户边界已经成立，
  //    记忆只是增强。
  try {
    const gateway = getGatewayClient(LOCAL_GATEWAY_ID);
    // 网关没起来（首跑 / 刚重启）或**连着但不应答**（socket 没 OPEN / 未认证）⇒ 没有可写的
    // 通道，静默跳过。下次启动 / 下次边界会补上。
    // ⚠️ `isConnected` 判据（2026-10-17 统一审核 §T33③）：只判 `!gateway` 时，"对象在、
    //    通道不在"会让这次 IPC 白等一次 `REQ_TIMEOUT_MS`（15s）才有结果 —— 判据便宜
    //    （一个 getter），故加上。
    if (!gateway || !gateway.isConnected) return;
    const outcome = await syncMemoryToAgents({ gateway });
    if (outcome.ok) {
      getDebugLogger().info({
        domain: 'memory',
        event: 'memory.account-boundary-sync',
        data: {
          agents: outcome.agentIds.length,
          entries: outcome.entries.length,
          written: outcome.result.written.length,
          unchanged: outcome.result.unchanged.length,
          failed: outcome.result.failed.length,
        },
      });
      return;
    }
    // ⚠️ 失败**不留白**（2026-10-17 统一审核 §T33②）：`ok:false`（持续 db-unavailable /
    //    名单读不到）时受管区块**保住的是旧记忆、无信号** —— 必须让人看得见（warn，不是
    //    info），并带够定位字段（归属 id + 失败原因）。
    getDebugLogger().warn({
      domain: 'memory',
      event: 'memory.account-boundary-sync.failed',
      data: { reason: outcome.reason, ownerUserId: currentMemoryOwnerId() },
    });
  } catch (error) {
    getDebugLogger().warn({
      domain: 'memory',
      event: 'memory.account-boundary-sync.failed',
      data: {
        reason: error instanceof Error ? error.message : 'unknown',
        ownerUserId: currentMemoryOwnerId(),
      },
    });
  }
}
