/**
 * `relay-bootstrap` 的**接线层** —— 把真实世界的 Supabase / 网关 / 日志接上去。
 *
 * 分层刻意如此：`relay-bootstrap.ts` 只认接口（可以裸跑单测），
 * 这里才 import electron 那一侧的东西。
 *
 * ⚠️ 本文件里出现的所有 key **都不许进日志**（relay key 是能花钱的凭证）。
 */

import { getCommercialClient } from './client.js';
import { probeAuth } from './auth.js';
import { deviceFingerprint, readLicenseStatus } from './license.js';
import { fetchFirstRelayModel } from './relay-config.js';
import { createRelayBootstrapScheduler } from './relay-bootstrap.js';
import type {
  RelayBootstrapDeps,
  RelayBootstrapReason,
  RelayBootstrapResult,
  RelayBootstrapScheduler,
  RelayGatewayHandle,
} from './relay-bootstrap.js';
import { getAllGatewayClients } from '../ws/index.js';
import { getDebugLogger } from '../debug/index.js';
import { LOCAL_GATEWAY_ID } from '../runtime/state-config.js';
import { buildCommercialAccessCleanupDeps, drainPendingCommercialAccessCleanup } from './relay-cleanup.js';

/**
 * 找一个**连上的**网关。
 *
 * 优先本机的 `local-runtime`（阶段 1 起的那个），否则退回"任意一个连上的" ——
 * 与用量上报、以及激活时的 `configureRelay` 口径一致。
 */
export function findConnectedGateway(): RelayGatewayHandle | null {
  const clients = getAllGatewayClients();
  const preferred = clients.get(LOCAL_GATEWAY_ID);
  const picked = preferred?.isConnected ? preferred : Array.from(clients.values()).find((gw) => gw.isConnected);
  if (!picked) return null;
  return {
    getConfig: () => picked.getConfig(),
    patchConfig: (params) => picked.patchConfig(params),
  };
}

/**
 * 取这张卡的中转 key。
 *
 * ⚠️ 用的是 `activate_license` —— 它对**已知设备是幂等的**（迁移 20260912000011）：
 * 同一 device_fingerprint 再来一次只会刷新 `last_seen_at`，**不占激活名额**，
 * 而且「relay key 生成一次后固定不变」⇒ 拿到的永远是同一把。
 *
 * 这是**唯一**的取 key 途径：key 只在 RPC 返回里出现（设计上不落客户端磁盘）。
 */
export async function fetchRelayKeyForLicense(licenseKey: string): Promise<string | null> {
  const supabase = getCommercialClient();
  if (!supabase) return null;

  const { data, error } = await supabase.rpc('activate_license', {
    p_license_key: licenseKey,
    p_device_fingerprint: deviceFingerprint(),
  });
  if (error) {
    // 只记错误码与文案，**不记 key**
    log('relay.bootstrap.activate-rpc-failed', { code: error.code, message: error.message });
    return null;
  }
  return (data as { relayKey?: string | null } | null)?.relayKey ?? null;
}

function log(event: string, data: Record<string, unknown> = {}): void {
  const logger = getDebugLogger();
  if (event.endsWith('failed') || event.includes('no-')) logger.warn({ domain: 'commercial', event, data });
  else logger.info({ domain: 'commercial', event, data });
}

export function buildRelayBootstrapDeps(): RelayBootstrapDeps {
  return {
    hasCommercialClient: () => getCommercialClient() !== null,
    // 三态，不是布尔 —— 「没登录」和「暂时问不出来」必须分开（见 auth-classify.ts）。
    checkAuth: () => probeAuth(),
    prepareGatewayAccess: async () => {
      const cleanup = await drainPendingCommercialAccessCleanup(buildCommercialAccessCleanupDeps());
      if (!cleanup.pending) return { ok: true };
      return { ok: false, ...(cleanup.errorCode ? { errorCode: cleanup.errorCode } : {}) };
    },
    readLicenseKey: async () => {
      const res = await readLicenseStatus();
      return res.ok && res.result?.licenseKey ? res.result.licenseKey : null;
    },
    fetchRelayKey: fetchRelayKeyForLicense,
    getGateway: findConnectedGateway,
    resolveDefaultModel: fetchFirstRelayModel,
    deviceFingerprint,
    log,
  };
}

/**
 * 商业 bootstrap 的**单飞调度器**（实现在 `relay-bootstrap.ts`，不依赖 electron）。
 *
 * 惰性建、建一次：单飞的语义就是"同一时刻只有一条链"，所以它必须是**模块级单例**，
 * 而不是每次调用新建一个。
 *
 * ⚠️ `bootstrapCommercialRelay(opts)` 的 opts 只在**第一次**调用时生效 —— 调度器
 * 一旦建好，运行参数就固定了。这正是单飞的应有之义（一次只允许一组参数在跑）。
 * 目前唯一的生产调用点（`main/index.ts`）传的是空参数。
 */
let scheduler: RelayBootstrapScheduler | null = null;

function getScheduler(opts: { waitForGatewayMs?: number } = {}): RelayBootstrapScheduler {
  scheduler ??= createRelayBootstrapScheduler(buildRelayBootstrapDeps(), opts);
  return scheduler;
}

/**
 * 启动时把商业配置落到网关上。**永不抛**。
 *
 * 重试策略在 `relay-bootstrap.ts` 的 `bootstrapRelayWithRetry` 里（那边没有 electron
 * 依赖，可以被单测钉死）；单飞在 `createRelayBootstrapScheduler` 里；
 * 这里只负责**接线**与"启动路径绝不抛"。
 */
export async function bootstrapCommercialRelay(
  opts: { waitForGatewayMs?: number } = {},
): Promise<RelayBootstrapResult> {
  try {
    return await getScheduler(opts).trigger('startup');
  } catch (error) {
    // 这一层永不抛：启动路径上抛出去就是白屏。
    console.error('[commercial] relay bootstrap 失败（忽略，界面照常）:', error);
    return { status: 'failed', relayReady: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 「用户**刚刚完成一次交互式登录**」—— 让商业 bootstrap 再跑一次。
 *
 * ## 为什么需要它（Stage 2C）
 *
 * 启动路径只在 `main/index.ts` 里 bootstrap **一次**。启动时没登录 ⇒ 结论是
 * `unauthenticated`，而按设计**明确没登录不重试**（等多久都一样）。可用户随后
 * 就在登录页完成了 OTP —— 那一刻如果没有东西主动重新调度，中转配置永远不会落到
 * 网关上、模型列表一直是空的，用户**必须重启客户端**。
 *
 * ## 为什么触发点在这里，而不是订阅 auth 事件
 *
 * - auth-js 的 `SIGNED_IN` 在**启动恢复会话**时也会发（`_recoverAndRefresh`），
 *   拿它当触发条件会在启动时和既有那一次撞车；
 * - `TOKEN_REFRESHED` 每 ~30 秒就可能来一次（auto-refresh 定时器），拿它当触发条件
 *   会变成"每半分钟重写一次网关配置"。
 * ⇒ 只认**这一个语义**：用户刚完成一次交互式登录。主进程知道这件事的唯一地方，
 * 就是两个登录 handler 的成功返回（见 `ipc/commercial-handlers.ts`）。
 *
 * ⚠️ **刻意不 await**：bootstrap 最长要跑 240 秒（等网关 + 有界退避），
 * 让登录 IPC 等它会把界面卡住。重复触发由调度器的单飞吸收。
 */
export function notifyCommercialSignedIn(): void {
  notifyRelayBootstrapNeeded('signed-in', '登录后补跑 relay bootstrap');
}

/**
 * 「用户**刚刚激活了一张卡**」—— 让商业 bootstrap 再跑一次。
 *
 * ## 为什么激活也需要它（2026-09-17 实机 `relay.config-no-gateway`）
 *
 * `activateLicense` 内部确实会顺手把中转配置写进网关，但那条路**遇到网关没连上就
 * 放弃了** —— 只记一条 `relay.config-no-gateway` 日志、返回 false，**没有任何重试**
 * （`license.ts` 的 `configureRelay`）。而激活那一刻恰恰是网关最可能还没起好的时候：
 * 全新环境、刚装完、刚输完卡密。
 *
 * 结果是：卡激活了、额度到账了，模型列表却是空的 —— 用户会以为激活失败。
 * 与登录（Stage 2C）是同一个道理、同一个调度器，所以这里补上第二道保险：
 * 调度器会等网关连上（最长 240 秒）并把配置落下去，用户不必重启客户端。
 *
 * ⚠️ 与登录不同：激活**不做**账户清理（`requestCommercialAccessCleanup`）——
 *    那会把刚拿到的 license 清掉。
 */
export function notifyCommercialActivated(): void {
  notifyRelayBootstrapNeeded('activated', '激活后补跑 relay bootstrap');
}

function notifyRelayBootstrapNeeded(reason: Exclude<RelayBootstrapReason, 'startup'>, label: string): void {
  try {
    void getScheduler()
      .trigger(reason)
      .then((res) => log('commercial.relay.bootstrap', { ...res, trigger: reason }))
      .catch((error: unknown) => {
        // 调度器内部已经不抛（`bootstrapRelayWithRetry` 永不抛），这里只是兜底。
        console.error(`[commercial] ${label} 失败（忽略，界面照常）:`, error);
      });
  } catch (error) {
    console.error(`[commercial] ${label} 失败（忽略，界面照常）:`, error);
  }
}
