/**
 * `relay-bootstrap` 的**接线层** —— 把真实世界的 Supabase / 网关 / 日志接上去。
 *
 * 分层刻意如此：`relay-bootstrap.ts` 只认接口（可以裸跑单测），
 * 这里才 import electron 那一侧的东西。
 *
 * ⚠️ 本文件里出现的所有 key **都不许进日志**（relay key 是能花钱的凭证）。
 */

import { relayBootstrapPublicStateStore, type RelayBootstrapPublicPhase } from '@clawwork/shared';
import { getCommercialClient } from './client.js';
import { probeAuth } from './auth.js';
import { deviceFingerprint, mapActivationError, readLicenseStatus } from './license.js';
import { webSearchEnabled, fetchFirstRelayModel, fetchRelayMediaCapabilities } from './relay-config.js';
import { readConfig } from '../workspace/config.js';
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
import { sendToWindow } from '../ws/window-utils.js';
import { getMainWindow } from '../window-manager.js';
import { getDebugLogger } from '../debug/index.js';
import { LOCAL_GATEWAY_ID } from '../runtime/state-config.js';
import { getActiveLocalGatewayDeploymentRoot } from '../runtime/index.js';
import { hasBundledSearchProvider } from '../runtime/bundled-search.js';
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
    bundledWebSearchAvailable: picked === preferred && hasBundledSearchProvider(getActiveLocalGatewayDeploymentRoot()),
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
 * `activate_license` / `check_activation_limit()` **故意**给出的裁决码（= 确定性的服务端判决）。
 *
 * 来源（2026-09-21 从 SQL 源自己数出来的，不是照抄清单）：
 *   · `supabase/migrations/20260921000056_activate_license_bound_org_owner.sql`
 *     —— `28000` not signed in（:72）/ `P0001`（卡失效 :94,:98、绑错组织 :112、设备被撤销 :176）
 *     / `P0002`（卡号查不到 :90、没有组织 :125）
 *   · `20260910000001_init.sql:123` 与 `20260910000003_mvp_closure.sql:427`
 *     —— `check_activation_limit()` 触发器 `raise … using errcode = 'check_violation'`
 *     （SQLSTATE **23514**，就是"激活数已达上限"）
 *   · 同一个函数在 1 / 3 / 11 / 23 号迁移里的历史版本用的是同一组码
 *     ⚠️ 这里原先还写着"全仓计数 `P0001`×21、`P0002`×8、`28000`×4、`check_violation`×2" ——
 *     那组数字**在本仓库里复现不出来**（`supabase/migrations` 属后端仓库，而且同一个
 *     函数被反复重建；换成后端仓库去数也不是同一份代码），已删除。判据只靠上面那些
 *     `文件:行号` 与 SQLSTATE 本身。唯一的 `42501` 属于 `report_usage` 的 service-role
 *     检查，不在取 key 这条路上
 *   ⇒ 闭集 = {28000, P0001, P0002, 23514}。**只有这些**才算"服务端真的拒绝了这张卡"。
 *
 * ⚠️ 取舍（**有意**）：白名单**之外**一切带 code 的失败都归**可重试** ——
 *    `PGRST301`（token 过期）、`57014`（statement_timeout）、`55P03`/`40P01`（拿不到行锁、死锁）、
 *    `08006`/`53300`（连接层失败）、`PGRST002/003/202`（PostgREST 自身的解析/缓存问题）……
 *    理由：迁移 56 的 `activate_license` 在卡行上 `for update` 并 `delete … offset`，
 *    **同一张卡的并发**（多端同时启动）本来就会制造锁等待 ⇒ 那些"再试一次就会好"的失败
 *    不该被说成"这张卡不行"（Task 3/4 会把它渲染成不可重试的 blocked 文案）。
 *    代价：token 过期（`PGRST301`）也会被当成可重试 —— 可接受，因为每一轮重试都先过
 *    `checkAuth()`，而且 supabase-js 自己会刷 token。
 */
const ACTIVATION_VERDICTS = new Set(['28000', 'P0001', 'P0002', '23514']);

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
      // 判据 = **裁决白名单**（`ACTIVATION_VERDICTS`，来源见它的注释）：
      //   · 没有码 / `status === 0` ⇒ 压根没问出来（实测的传输形状）；
      //   · 有码但**不在**白名单里 ⇒ 也不当成"卡的判决" —— `57014`（语句超时）、
      //     `55P03`/`40P01`（拿不到行锁/死锁）、`08006`/`53300`（连接层）、
      //     `PGRST301`（token 过期）……这些恰恰是"再试一次会好"的那一类，
      //     判成终态就是把并发/网络问题说成"这张卡不行"。
      // 与 `auth-classify.ts` 的 `status === 0`（"fetch 层就失败了"）同一口径。
      //
      // ⚠️ `status` 在**响应**上，不在 `error` 对象里（实测 error 的键只有
      //    `message/details/hint/code`）。
      if (!error.code || status === 0 || !ACTIVATION_VERDICTS.has(error.code)) {
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
    // ⭐ 联网开关**在这里读一次**（deps 是每个进程建一次的）：读全局配置的活儿留在
    //    最外层，被调用的那个函数保持可单测。
    webSearchEnabled: () => webSearchEnabled(readConfig()),
    // 三态，不是布尔 —— 「没登录」和「暂时问不出来」必须分开（见 auth-classify.ts）。
    checkAuth: () => probeAuth(),
    prepareGatewayAccess: async () => {
      const cleanup = await drainPendingCommercialAccessCleanup(buildCommercialAccessCleanupDeps());
      if (!cleanup.pending) return { ok: true };
      return { ok: false, ...(cleanup.errorCode ? { errorCode: cleanup.errorCode } : {}) };
    },
    readLicenseKey: async () => {
      const res = await readLicenseStatus();
      return res.ok && res.result?.configured && res.result.activated && res.result.licenseKey
        ? res.result.licenseKey
        : null;
    },
    fetchRelayKey: fetchRelayKeyForLicense,
    getGateway: findConnectedGateway,
    resolveDefaultModel: fetchFirstRelayModel,
    resolveMediaCapabilities: fetchRelayMediaCapabilities,
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

/** 公开状态变化的事件通道（preload 按这个名字订阅，见 `preload/index.ts`）。 */
const RELAY_BOOTSTRAP_STATE_CHANGED_CHANNEL = 'commercial:relay-bootstrap-state-changed';

let rendererBridgeReady = false;

/**
 * 把公开状态的**每次**转变转发给渲染层。
 *
 * ⚠️ store 是进程级单例（`@clawwork/shared`），所以这条桥建**一次**就够。
 * ⚠️ 窗口还没建时 `sendToWindow` 返回 false，事件**直接丢掉** —— 这不是 bug，
 *    正是「初始读」（`commercial:relay-bootstrap-state`）存在的理由：快照一直
 *    留在 store 里，渲染层挂上来之后补读一次就能拿到（启动那一轮往往就发生在
 *    窗口建好之前）。
 */
function ensureRendererBridge(): void {
  if (rendererBridgeReady) return;
  rendererBridgeReady = true;
  relayBootstrapPublicStateStore.subscribe((state) => {
    sendToWindow(getMainWindow(), RELAY_BOOTSTRAP_STATE_CHANGED_CHANNEL, state);
  });
}

/**
 * 一轮 bootstrap 的**结果** → 渲染层能看的状态。
 *
 * ⚠️ 判据一律是 **`status` 与 `errorCode` 的配对**，绝不是"有没有出错"：
 *    只有 `entitlement-rejected` 是终局（服务端**确定**拒绝了这张卡）；会话暂时
 *    问不出来、取 key 的网络抖动、网关没连上、配置写失败这四种都是"再试一次可能
 *    会好"，各自给一个安全码交给渲染层去说人话。把 `auth-transient` 说成
 *    `blocked` = 把一次网络抖动说成"你的卡不行"（那正是本轮要拆掉的塌缩）。
 *
 * `detail` **绝不**上这条线：它可能带原始 message（服务端文案会回显卡密）。
 */
export function mapRelayBootstrapPublicPhase(result: RelayBootstrapResult): RelayBootstrapPublicPhase {
  switch (result.status) {
    case 'applied':
    case 'already-applied':
      return {
        phase: 'ready',
        ...(result.media ? { media: { image: result.media.image, video: result.media.video } } : {}),
      };
    case 'unlicensed':
      // 名下（或本地）没有可用的卡 ⇒ 用户要做的是**去激活**，不是"再试一次"。
      // ⚠️ 与 `entitlement-rejected` 分开：那个是"有卡，但服务端说不行"。
      return { phase: 'blocked', errorCode: 'license_required' };
    case 'entitlement-rejected': {
      const code = result.errorCode;
      // 不该发生（transport 一律走 auth-transient）；真发生了宁可说成"再试一次"，
      // 也不要把一次传输抖动说成"你的卡被拒了"。
      if (code === 'transport') return { phase: 'retryable-error', errorCode: 'transport' };
      // 裁决却没带码 = 违约的实现：仍然按终局处理，给最保守的那个码。
      if (!code) return { phase: 'blocked', errorCode: 'activation_failed' };
      return { phase: 'blocked', errorCode: code };
    }
    case 'auth-transient':
      // 带 transport 码的是"取 key 那一步没问出来"，其余是"会话暂时问不出来"。
      return {
        phase: 'retryable-error',
        errorCode: result.errorCode === 'transport' ? 'transport' : 'auth_unavailable',
      };
    case 'runtime-not-ready':
      return { phase: 'retryable-error', errorCode: 'runtime_not_ready' };
    case 'failed':
      // ⚠️ `failed` **可能是确定性失败**，别把这个码读成"重试就会好"：
      //    `ensureRelayConfigured` 对"上一个账号的清理被网关**确定性**拒绝 / 回读校验
      //    没过"**刻意**返回 `{status:'failed', retryable:false}`（注释写着"确定性失败
      //    不能轮询"—— 轮询只会把网关打到限流）。而 DTO 里**没有**"确定的非-entitlement
      //    失败"这个相位（`errorCode` 是冻结的闭集，不许新增），所以只能落在
      //    `retryable-error: relay_apply_failed` —— 这是**最不坏的标签，不是重试承诺**。
      //    ⚠️ 给 Task 4 的合同：这条码的重试文案**不得承诺成功**（"再试一次"可以，
      //    "马上就好"不行）；真正该做的是把网关那侧的原因送去排查（调试日志里那条
      //    `relay.bootstrap.cleanup-rejected`）。这个不精确由 `MAPPING_CASES` 里点名
      //    "清理被拒"那一行钉住，别让它变成没人知道的偏差。
      return { phase: 'retryable-error', errorCode: 'relay_apply_failed' };
    case 'unauthenticated':
    case 'not-configured':
      // 这两个都**不是错误**：明确没登录 ⇒ 界面本来就在登录页；没接商业层 ⇒
      // 纯开发环境。渲染成错误会在登录页旁边挂一条"模型不可用"。
      return { phase: 'idle' };
  }
}

/**
 * 跑一轮 bootstrap，并把结果翻成公开状态。**永不抛**（调度器自己也不抛）。
 *
 * ⚠️ 先宣布 `running` **再**进单飞：渲染层可能正好在这两条状态之间问上来
 *    （初始读），而"这一轮在跑"本身就是它要渲染的东西。
 */
function runRelayBootstrap(
  reason: RelayBootstrapReason,
  opts: { waitForGatewayMs?: number } = {},
): Promise<RelayBootstrapResult> {
  // 事件桥按需建：模块加载时不建，免得在没有窗口的进程（测试 / 工具）里也去碰窗口管理器。
  ensureRendererBridge();
  // 先宣布"在跑"：初始读可能正好问上来，而这一轮确实已经开始了。
  const running = relayBootstrapPublicStateStore.set({ phase: 'running' });
  const publish = (phase: RelayBootstrapPublicPhase) => {
    if (relayBootstrapPublicStateStore.get().updatedAt === running.updatedAt) relayBootstrapPublicStateStore.set(phase);
  };

  let pending: Promise<RelayBootstrapResult>;
  try {
    pending = getScheduler(opts).trigger(reason);
  } catch (error) {
    // 同步就抛（违约的实现）：状态**绝不能**停在 `running`。
    publish({ phase: 'retryable-error', errorCode: 'relay_apply_failed' });
    return Promise.reject(error);
  }

  return pending.then(
    (result) => {
      publish(mapRelayBootstrapPublicPhase(result));
      return result;
    },
    (error: unknown) => {
      // 同上：调度器内部不抛，这里只是兜底。
      publish({ phase: 'retryable-error', errorCode: 'relay_apply_failed' });
      throw error;
    },
  );
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
    return await runRelayBootstrap('startup', opts);
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

/**
 * 「用户**点了重试**」—— 让商业 bootstrap 再跑一次（`commercial:relay-bootstrap-retry`）。
 *
 * 与上面两个通知是同一个入口、同一个单飞调度器：重试**只是排队**（跑着就记一个补跑），
 * 不会开出第二条链、也不会绕过退避直接猛打服务端。
 *
 * ⚠️ **同步返回**：真正的进度跟公开状态事件走（`commercial:relay-bootstrap-state-changed`），
 *    渲染层的按钮不该被最长 240 秒的重试窗口挂住。
 *    能重试的是"暂时"那一类（`retryable-error`）；`blocked` 是**确定性**结论，
 *    重试一万次也一样 —— 那是界面该换成"去激活 / 换账号"的地方（Task 4）。
 */
export function retryCommercialRelayBootstrap(): void {
  notifyRelayBootstrapNeeded('manual', '手动重试 relay bootstrap');
}

function notifyRelayBootstrapNeeded(reason: Exclude<RelayBootstrapReason, 'startup'>, label: string): void {
  try {
    void runRelayBootstrap(reason)
      .then((res) => log('commercial.relay.bootstrap', { ...res, trigger: reason }))
      .catch((error: unknown) => {
        // 调度器内部已经不抛（`bootstrapRelayWithRetry` 永不抛），这里只是兜底。
        console.error(`[commercial] ${label} 失败（忽略，界面照常）:`, error);
      });
  } catch (error) {
    console.error(`[commercial] ${label} 失败（忽略，界面照常）:`, error);
  }
}
