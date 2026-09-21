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
import { deviceFingerprint, mapActivationError, readLicenseStatus } from './license.js';
import { fetchFirstRelayModel } from './relay-config.js';
import { createRelayBootstrapScheduler } from './relay-bootstrap.js';
import type {
  RelayBootstrapDeps,
  RelayBootstrapReason,
  RelayBootstrapResult,
  RelayBootstrapScheduler,
  RelayGatewayHandle,
  RelayKeyFetchResult,
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
    runConfigMutation: (work) =>
      picked.runConfigMutation((tx) =>
        work({
          getConfig: tx.getConfig,
          patchConfig: tx.patchConfig,
        }),
      ),
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
 *
 * ## 返回结构化结果，**不再**是 `string | null`
 *
 * 那个形状把三件完全不同的事压成同一个 `null`，上层于是只能说"没卡"：
 *   ① 服务端**确定性**拒绝 —— `P0001`「卡已绑到别的组织」/ `23514` 激活数已达上限…
 *   ② 传输失败（fetch 失败 / 超时 / 502）—— 这一类等一等真的会好（`transport`）
 *   ③ RPC 成功却没有 relay key（旧卡 / 返回形状变了）—— 确定性失败，**不是**成功
 *
 * 分类一律走 `license.ts` 的 `mapActivationError()`：**同一张表**，这里不再写一份。
 *
 * ## 日志纪律（本函数 = **结构化中继路径**）
 *
 * 只记 SQLSTATE 与安全码。**不记**原始 message —— `activate_license` 的入参就是
 * 卡密，服务端文案很可能回显它；异常文案里还可能带 URL / `apikey`。
 * ⚠️ 别把这条写成全局承诺：**手动激活**那条 IPC 路径刻意仍把原文返回给界面
 * （见 `license.ts` 里 `mapActivationError` 的口径说明）—— 那是给用户看的出口，不是日志。
 */
export async function fetchRelayKeyForLicense(licenseKey: string): Promise<RelayKeyFetchResult> {
  const supabase = getCommercialClient();
  if (!supabase) {
    // 商业层没配上（纯净开发环境，或读取期兜底也拿不到凭据）。**这不是用户卡的问题** ——
    // 绝不能编成 `activation_failed`（那会被渲染成"激活失败"，拿用户的开卡说事）。
    // 这一层没有任何码能表达"没配置"（也**不新增**公开错误码）⇒ 归到既有的 `transport`
    // （"这次没问出来"）；真正的 `not-configured` 语义由 `ensureRelayConfigured` 开头那道
    // `hasCommercialClient()` 门表达 —— 两者判据同源（都是 `getCommercialClient()`），
    // 所以生产路径上这个值不会露头。
    return { ok: false, errorCode: 'transport', retryable: true };
  }

  try {
    const { data, error, status } = await supabase.rpc('activate_license', {
      p_license_key: licenseKey,
      p_device_fingerprint: deviceFingerprint(),
    });

    if (error) {
      // ⚠️ 先分清「服务端拒绝了这张卡」与「这次压根没问出来」—— 判据是 **SQLSTATE**。
      //
      // 事实（2026-09-21 在钉住的 `@supabase/supabase-js@2.116.0` / `postgrest-js@2.116.0`
      // 上实测，不是推理）：`PostgrestBuilder.then` 装了 `.catch`，而 `shouldThrowOnError`
      // 默认 false、全仓无人调 `.throwOnError()` ⇒ **fetch 失败 / 超时 / 502 都是 resolve，
      // 不是 throw**，只是 `error` 不同：
      //   · `TypeError: fetch failed`      ⇒ `error.code === ''`、响应 `status === 0`
      //   · 被 `AbortSignal.timeout` 中止    ⇒ `error.code === ''`、响应 `status === 0`
      //     （生产正是这条路：`client.ts` 的 `createTimeoutFetch()`，15 秒）
      //   · 代理返回 502 HTML               ⇒ error 里**没有** `code` 这个键（只有 message）
      //
      // 把它们兜进分类器会落成 `activation_failed` ⇒ 终态 `entitlement-rejected`：用户被告知
      // "这张卡不行"，而其实只是网络抖了一下、**再试一次就会好**。
      //
      // 判据与 `auth-classify.ts` 的 `status === 0`（"fetch 层就失败了"）同一口径：
      // **确定性的服务端拒绝一定带 SQLSTATE**（迁移 56 的 P0001/P0002/23514/28000 都带），
      // 传输类没有码、或 status 为 0；无码的 5xx/HTML 也由 `!error.code` 覆盖。
      //
      // ⚠️ `status` 在**响应**上，不在 `error` 对象里（实测 error 的键只有
      //    `message/details/hint/code`）。
      if (!error.code || status === 0) {
        log('relay.bootstrap.activate-rpc-transport-failed', { errorCode: 'transport' });
        return { ok: false, errorCode: 'transport', retryable: true };
      }

      // 到这里才是**服务端答回来的**确定性拒绝 ⇒ 交给唯一那张分类表。
      // 安全码与 SQLSTATE 进日志；原始 message 不进。
      const errorCode = mapActivationError(error);
      log('relay.bootstrap.activate-rpc-failed', { sqlState: error.code, errorCode });
      return { ok: false, errorCode, retryable: false };
    }

    const relayKey = (data as { relayKey?: string | null } | null)?.relayKey ?? '';
    if (!relayKey) {
      // RPC 成功但没下发 key（旧卡 / 返回形状变了）。**绝不**当成成功：上层会拿
      // 它去写一个空 apiKey 进网关，那比"没配置"更难排查。
      log('relay.bootstrap.activate-rpc-no-key');
      return { ok: false, errorCode: 'activation_failed', retryable: false };
    }

    return { ok: true, relayKey };
  } catch {
    // **硬抛**：真库里 fetch 失败/超时是 resolve 的（见上面的实测说明），但同步异常、
    // 未来换传输层、或 rpc 之外的层抛出来时仍然走这里 ⇒ 同样归可重试的传输类。
    // 只记安全码，不记异常文案（它可能带 URL 与 apikey）。
    log('relay.bootstrap.activate-rpc-transport-failed', { errorCode: 'transport' });
    return { ok: false, errorCode: 'transport', retryable: true };
  }
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
    return {
      status: 'failed',
      relayReady: false,
      retryable: false,
      detail: error instanceof Error ? error.message : String(error),
    };
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
