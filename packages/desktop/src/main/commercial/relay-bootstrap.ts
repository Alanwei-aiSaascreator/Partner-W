/**
 * 启动时的商业配置落地：把「这台机器已激活」变成「网关真的能列模型」。
 *
 * ## 为什么需要这一层（2026-09-13 实测定位）
 *
 * 原有的链路只有一条，而且只在**激活那一刻**跑：
 *
 * ```
 * activateLicense(key) → RPC activate_license → relayKey
 *                      → configureRelay(relayKey) → applyRelayConfig → 网关 config.patch
 * ```
 *
 * 于是有三个洞：
 *
 * 1. **没有启动时的调用** —— 应用重启（或换一个干净 profile）之后，没有任何代码
 *    再去把中转配置写进网关。网关的配置是新的 ⇒ `models.list` 空 ⇒ 界面只有 Default。
 * 2. **`configureRelay` 要求"此刻有网关连着"** —— 首次启动时网关往往还没连上，
 *    它只记一条 `relay.config-no-gateway` 就返回 false，**而且没有重试**。
 * 3. **中转 key 没有第二个来源** —— 它只在 `activate_license` 的返回里出现，
 *    写完就没了。所以"恢复"必须能**再取一次**。
 *
 * ## 再取一次安全吗（已核实，不是推测）
 *
 * `activate_license` 对**已知设备**是幂等的（迁移 `20260912000011`）：
 * 它先把 `license_activations` 那行 `update ... where device_fingerprint = $1`，
 * 找得到就只刷新 `last_seen_at`，**不插入新行、不占激活名额**；relay key 也是
 * 「没生成过就生成，生成一次后固定不变」⇒ 同一台设备拿到的永远是同一把。
 *
 * ## 分层
 *
 * 本模块**不认识** Supabase、不认识 gateway-client、不认识 electron ——
 * 全部通过依赖注入。这样它可以在没有 electron 的环境里被单测钉死，
 * 也保证「runtime loader」与「commercial activation」继续是两层。
 */

import { relayProviderIds, applyRelayConfig, RELAY_PROVIDER_ID, type RelayMediaCapabilities } from './relay-config.js';
import type { AuthCheck } from './auth-classify.js';
// ⚠️ **type-only**：编译期擦除 ⇒ 运行时**不**加载 license.js，上面那句
//    「本模块不认识 Supabase / 不认识 electron，可以裸跑单测」仍然成立。
//    宁可要这一个类型依赖，也不要在这边再写一遍错误码字面量：闭集少一个成员的
//    后果是「边界层永远产不出那个码」，而 runtime 不报错、lint 也看不见。
import type { ActivationErrorCode } from './license.js';
import type { RelayMediaReadiness } from '@clawwork/shared';

/**
 * 取中转 key 失败原因的**安全错误码**闭集。
 *
 * 服务端给出的确定性拒绝直接复用 `license.ts` 的 `ActivationErrorCode`
 * （唯一那份消息匹配表在那边，本模块**不**复制它的匹配逻辑）；
 * `transport` 是**本地**归类（网络 / 超时 / 边界违约），不是服务端给的码。
 */
export type RelayKeyFetchErrorCode = ActivationErrorCode | 'transport';

/**
 * `fetchRelayKey` 的返回。
 *
 * ⚠️ 刻意**不再是 `string | null`**：那个形状把三件完全不同的事压成同一个
 * `null` —— ① 服务端**确定性**拒绝（卡绑在别的组织 / 卡失效 / 没下发 key）、
 * ② 网络超时、③ RPC 成功却没有 key。上层于是只能报"没卡"（`unlicensed`）：
 * 用户既看不懂、也不会去做对的事，排查的人也拿不到原因。
 */
export type RelayKeyFetchResult =
  | { ok: true; relayKey: string }
  | {
      ok: false;
      errorCode: RelayKeyFetchErrorCode;
      /** 等一等会不会好。**只有** `transport` 为 true。 */
      retryable: boolean;
    };

/**
 * 结果分类。**刻意分得细**：「没登录」「没卡」「网关没连上」「写失败」是四件
 * 不同的事，界面要说的和排查要看的都不一样，混成一个 `false` 就只能靠猜。
 */
export type RelayBootstrapStatus =
  | 'not-configured' // 没配 Supabase —— 产品没接商业层（纯净开发环境）
  | 'unauthenticated' // 配了，**明确**没登录（服务端说 401/403）
  | 'auth-transient' // 会话/后端**暂时问不出来**（超时/网络不通/5xx）—— **可重试**，别当成没登录
  | 'unlicensed' // 登录了，但名下没有可用 license
  | 'entitlement-rejected' // 有卡，但服务端/边界**确定性**拒绝（绑在别的组织 / 卡失效 / 没下发 key）—— 等多久都一样
  | 'runtime-not-ready' // 商业侧没问题，是网关还没连上（**可重试**）
  | 'already-applied' // 网关已经有指向中转的 provider —— 幂等命中，什么都没做
  | 'applied' // 这次真的写进去了
  | 'failed'; // 写了但没成功

/**
 * 会话检查的结果。定义在 `auth-classify.ts`（那里是纯函数、可直接钉单测），
 * 这里 re-export 一份，调用方不用多认一个模块。
 */
export type { AuthCheck } from './auth-classify.js';

/**
 * 「上一个账号的网关配置清理干净了没有」的返回。
 *
 * ⚠️ 刻意**不用布尔值**：调用方要按失败原因决定重不重试，而"网关没连上"（可重试）
 * 与"补丁被网关拒了"（重试一万次也一样）必须分开 —— 混在一起就是 2026-09-17
 * 那次每秒重试、把网关打到限流的现场。
 */
export type GatewayAccessPrep =
  | { ok: true }
  | { ok: false; errorCode?: 'transport' | 'rejected' | 'hash-conflict' | 'verify-failed' };

export interface RelayBootstrapResult {
  status: RelayBootstrapStatus;
  /**
   * 模型是否可用。**只有 applied / already-applied 为 true。**
   *
   * ⚠️ 这正是「runtime ready ≠ commercial ready」那条：网关活着只说明
   * `runtime ready`，模型能不能用要看这个。
   */
  relayReady: boolean;
  media?: RelayMediaReadiness;
  /**
   * 给人看的补充。
   *
   * 🔴 **必须永远无密**：整个结果会被整份摊进调试日志
   * （`relay-startup.ts` 的 `notifyRelayBootstrapNeeded` 与 `main/index.ts` 都是
   * `{...res}`），所以这里只能放安全码与人话，**不许**放 relay key / 卡密 / 原始 message。
   */
  detail?: string;
  /**
   * 取中转 key 那一步的**安全错误码**（见 `RelayKeyFetchErrorCode`）。
   *
   * ⚠️ 它**不是**服务端的原始 message —— 原始 message 可能回显卡密，
   * 一律不进结果、不进日志、不进界面。
   */
  errorCode?: RelayKeyFetchErrorCode;
  /**
   * **再试一次是否有意义**（不是"本轮还会不会再试"）。
   *
   * ⚠️ 两者刻意分开：退避用尽、或下一次退避会越过总 deadline 时，循环会把
   * `auth-transient` **如实返回**（本轮不再重试），但它的 `retryable` 仍然是 `true` ——
   * 因为"这次没成"是**暂时**的，换个时间点（下一次启动、下一次触发）再试就是对的。
   * 别把 `true` 读成"本函数还会再试"。
   *
   * ⚠️ **每个返回点都必须显式设置**（不是可选字段）：只在被分类的那两条分支上设置，
   * 会留下 `auth-transient` 有时带、有时不带，以及 `runtime-not-ready`（循环**真的会
   * 重试**它）根本没有这个字段 —— 调用方拿到 `undefined` 只能靠猜。
   *
   * - `true`：`runtime-not-ready`（网关还没连上）与 `auth-transient`（会话/传输暂时
   *   问不出来）—— 这两类对应重试循环里的两条重试路径；
   * - `false`：其余全部 —— 明确没登录 / 没卡 / **确定性拒绝**（卡绑在别的组织、
   *   卡失效、没下发 key）/ 写失败 / 已经就绪（applied / already-applied）/
   *   本机没接商业层（not-configured）。重试一万次结果一样，**尤其别为了它再发一次
   *   `activate_license`**。
   */
  retryable: boolean;
}

export interface RelayGatewayHandle {
  bundledWebSearchAvailable?: boolean;
  getConfig: () => Promise<unknown>;
  patchConfig: (params: { baseHash: string; raw: string; replacePaths?: string[] }) => Promise<unknown>;
  /** 把 relay 的 get→patch→verify 作为一笔事务排进该网关的配置写队列。 */
  runConfigMutation: <T>(
    work: (tx: {
      getConfig: () => Promise<unknown>;
      patchConfig: (params: { baseHash: string; raw: string; replacePaths?: string[] }) => Promise<unknown>;
    }) => Promise<T>,
  ) => Promise<T>;
}

export interface RelayBootstrapDeps {
  /** 商业层配好了没（Supabase url + anon key 都在）。 */
  hasCommercialClient: () => boolean;
  /**
   * 联网搜索开关（设置里那一行）。
   *
   * ⚠️ 可选，缺省按**开**：这是一个老盘升级上来行为不变的判据，
   *    写成必填会让每个测试夹具都要补一次，而那些夹具**根本不关心**这件事。
   */
  webSearchEnabled?: () => boolean;
  /**
   * 本地会话还有效吗（**会真的问服务端**）。
   *
   * ⚠️ 返回**三态**而不是 boolean —— 「没登录」和「暂时问不出来」必须分开，
   * 否则一次网络超时就会被说成"用户已退出登录"。见 `AuthCheck`。
   */
  checkAuth: () => Promise<AuthCheck>;
  /** Remove any previous account's relay credentials before inspecting readiness. */
  /**
   * 清理上一个账号的中转配置（`drainPendingCommercialAccessCleanup`）。
   *
   * 返回的对象**必须带上失败原因**：`undefined` 的 errorCode 表示"网关还没连上"（可重试），
   * `rejected` / `verify-failed` 表示确定性失败（**不可重试** —— 重试只会打爆网关）。
   */
  prepareGatewayAccess?: () => Promise<GatewayAccessPrep>;
  /** 读名下 license（账号绑定口径，不依赖设备激活行）。 */
  readLicenseKey: () => Promise<string | null>;
  /**
   * 取中转 key（幂等：同一设备重复调用返回同一把）。
   *
   * 返回**结构化结果**，不是 `string | null` —— 见 `RelayKeyFetchResult`。
   * ⚠️ 实现**不该抛**：网络/超时要在这一层收成 `transport`，否则上层只能靠
   * catch 去猜，而"猜"出来的结论无法区分"暂时"和"永久"。
   */
  fetchRelayKey: (licenseKey: string) => Promise<RelayKeyFetchResult>;
  /** 现在有没有一个**连上的**网关可以写。没有返回 null（⇒ runtime-not-ready）。 */
  getGateway: () => RelayGatewayHandle | null;
  /** 解析一个默认模型 ref；拿不到返回 null（不阻塞）。 */
  resolveDefaultModel?: (relayKey: string) => Promise<string | null>;
  /** 逐卡媒体能力；存在时启动必须重新对齐，不能被聊天 provider 的幂等快路跳过。 */
  resolveMediaCapabilities?: (relayKey: string) => Promise<RelayMediaCapabilities>;
  deviceFingerprint: () => string;
  /** 日志。⚠️ **不要传含 relay key 的数据进来**。 */
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * 确保本地网关带着中转配置。
 *
 * ⚠️ **本函数不抛** —— 它跑在启动路径上，抛出去就是白屏。失败一律 resolve 成
 * 带 `status` 的结果；「网关没起来」与「没激活」是两件不同的事，各自有表达。
 */
export async function ensureRelayConfigured(deps: RelayBootstrapDeps): Promise<RelayBootstrapResult> {
  const log = deps.log ?? ((): void => {});

  if (!deps.hasCommercialClient()) {
    // 纯净开发环境：没有 Supabase 配置 ⇒ 这不是错误，是「没接商业层」。
    log('relay.bootstrap.not-configured');
    return { status: 'not-configured', relayReady: false, retryable: false };
  }

  let auth: AuthCheck;
  try {
    auth = await deps.checkAuth();
  } catch (error) {
    // 检查本身抛了 ⇒ **问不出来**，不是"没登录"。归类成暂时失败，交给有界重试。
    log('relay.bootstrap.session-check-failed', { message: messageOf(error) });
    auth = 'transient';
  }
  if (auth === 'transient') {
    // ⚠️ 这一条**不能**说成 unauthenticated：一次 8s 超时不该等价于用户退出登录。
    //    调用方（bootstrapCommercialRelay）会对它做**有界退避重试**。
    log('relay.bootstrap.auth-transient-failure');
    return {
      status: 'auth-transient',
      relayReady: false,
      retryable: true,
      detail: 'auth check could not reach the backend',
    };
  }
  if (auth === 'unauthenticated') {
    log('relay.bootstrap.unauthenticated');
    return { status: 'unauthenticated', relayReady: false, retryable: false };
  }
  log('relay.bootstrap.authenticated');

  if (deps.prepareGatewayAccess) {
    try {
      const prepared = await deps.prepareGatewayAccess();
      if (!prepared.ok) {
        // ⚠️ **确定性失败不能轮询**：清理被网关拒（补丁不合法）或回读校验没过，
        //    配置不改结论就不变 —— 而每次轮询要打两个网关 RPC，4 分钟窗口能把
        //    网关自己打到限流（2026-09-17 实测 `rate limit exceeded for config.patch`）。
        if (prepared.errorCode === 'rejected' || prepared.errorCode === 'verify-failed') {
          log('relay.bootstrap.cleanup-rejected', { errorCode: prepared.errorCode });
          return {
            status: 'failed',
            relayReady: false,
            retryable: false,
            detail: `previous account cleanup was rejected (${prepared.errorCode})`,
          };
        }
        // 网关没连上 / 传输抖动：等一等真的会好，交给调用方轮询。
        log('relay.bootstrap.cleanup-pending', { errorCode: prepared.errorCode ?? 'gateway-offline' });
        return {
          status: 'runtime-not-ready',
          relayReady: false,
          retryable: true,
          detail: 'previous account cleanup pending',
        };
      }
    } catch (error) {
      log('relay.bootstrap.cleanup-failed', { message: messageOf(error) });
      return {
        status: 'runtime-not-ready',
        relayReady: false,
        retryable: true,
        detail: 'previous account cleanup failed',
      };
    }
  }

  let licenseKey: string | null = null;
  try {
    licenseKey = await deps.readLicenseKey();
  } catch (error) {
    log('relay.bootstrap.license-read-failed', { message: messageOf(error) });
  }
  if (!licenseKey) {
    log('relay.bootstrap.unlicensed');
    // 名下确实没有卡 ⇒ 同样不是"等一等会好"（用户得去激活/兑换）。
    return { status: 'unlicensed', relayReady: false, retryable: false };
  }

  const gateway = deps.getGateway();
  if (!gateway) {
    // ⚠️ **可重试**：调用方该等网关连上再来，而不是把它当成"没激活"。
    log('relay.bootstrap.runtime-not-ready');
    return { status: 'runtime-not-ready', relayReady: false, retryable: true };
  }

  // 幂等快路径：网关已经有一个**指向中转**的 provider ⇒ 一个字节都不写，
  // 也**不调服务端**（省掉每次启动一次激活 RPC）。
  //
  // 判据用 baseUrl 而不是 provider 名 —— 名字用户能改（见 relayProviderIds 的注释）。
  let snapshot: unknown;
  try {
    snapshot = await gateway.getConfig();
  } catch (error) {
    log('relay.bootstrap.config-read-failed', { message: messageOf(error) });
    return { status: 'runtime-not-ready', relayReady: false, retryable: true, detail: messageOf(error) };
  }

  if (relayProviderIds(snapshot).size > 0 && !deps.resolveMediaCapabilities) {
    log('relay.bootstrap.already-applied', { provider: RELAY_PROVIDER_ID });
    return {
      status: 'already-applied',
      relayReady: true,
      retryable: false,
      media: { image: 'unknown', video: 'unknown' },
    };
  }

  let keyResult: RelayKeyFetchResult;
  try {
    keyResult = await deps.fetchRelayKey(licenseKey);
  } catch (error) {
    // 边界函数**不该抛**（网络/超时在那边就该收成 transport 结果）。真抛了说明
    // 注入了一个违约实现 ⇒ 按"暂时问不出来"处理：等一等真的可能好，而把一次
    // 异常说成"你没卡"正是本轮要拆掉的塌缩。
    log('relay.bootstrap.relay-key-failed', { errorName: errorNameOf(error), errorCode: 'transport' });
    keyResult = { ok: false, errorCode: 'transport', retryable: true };
  }

  if (!keyResult.ok) {
    if (keyResult.errorCode === 'transport') {
      // 网络 / 超时：**复用既有的 `auth-transient` 有界退避路径**，不新开重试路径。
      // 语义也合：后端**暂时**问不出来（这正是该状态注释里写的"超时/网络不通"）。
      log('relay.bootstrap.relay-key-transport', { errorCode: keyResult.errorCode });
      return {
        status: 'auth-transient',
        relayReady: false,
        errorCode: keyResult.errorCode,
        retryable: true,
        detail: 'relay key could not be fetched (transport)',
      };
    }

    // 服务端**确定性**拒绝：卡绑在别的组织 / 卡失效 / 激活数满 / 没下发 key。
    // ⚠️ 两个"不许"：不许说成 `unlicensed`（用户要做的动作完全不同），也不许
    //    丢进重试窗口（结论不是时间能改的，重试只是再打一次服务端）。
    log('relay.bootstrap.no-relay-key', { errorCode: keyResult.errorCode });
    return {
      status: 'entitlement-rejected',
      relayReady: false,
      errorCode: keyResult.errorCode,
      retryable: false,
      detail: `relay key not issued (${keyResult.errorCode})`,
    };
  }

  const relayKey = keyResult.relayKey;
  if (!relayKey) {
    // 类型上 `ok:true` 必带非空 key；空串只可能来自违约的实现。没有 key 就是
    // 列不出模型 ⇒ 确定性失败，**绝不**报 ready（这正是本任务要钉住的那条）。
    log('relay.bootstrap.no-relay-key', { errorCode: 'activation_failed' });
    return {
      status: 'entitlement-rejected',
      relayReady: false,
      errorCode: 'activation_failed',
      retryable: false,
      detail: 'relay key issued was empty',
    };
  }

  const webSearch = deps.webSearchEnabled?.() ?? true;
  // ⚠️ 2026-10-03（W03 真机定位）：运行时没捆搜索扩展时，这个闸门是 **silent false** ——
  //    搜索补丁永不写入、用户侧"搜索调不动"，而日志里一无所见（排查只能反读产物配置，
  //    本次就是这么查的）。补一条明确事件：只记"不可用且用户没自己关搜索"这半边，
  //    支持侧一眼定位；搜索正常或用户自关时不打（避免噪音）。
  if (gateway.bundledWebSearchAvailable !== true && webSearch) {
    log('relay.bundled-search.unavailable', { detected: false });
  }

  const apply = (tx: Pick<RelayGatewayHandle, 'getConfig' | 'patchConfig'>) =>
    applyRelayConfig(
      {
        getConfig: tx.getConfig,
        patchConfig: tx.patchConfig,
        resolveDefaultModel: deps.resolveDefaultModel,
        resolveMediaCapabilities: deps.resolveMediaCapabilities,
        log: (event, data) => log(event, data),
      },
      {
        relayKey,
        deviceFingerprint: deps.deviceFingerprint(),
        webSearch,
        bundledWebSearchAvailable: gateway.bundledWebSearchAvailable === true,
      },
    );
  const result = await gateway.runConfigMutation(apply);

  if (result.configured) {
    log('relay.bootstrap.applied', { provider: RELAY_PROVIDER_ID });
    return { status: 'applied', relayReady: true, retryable: false, ...(result.media ? { media: result.media } : {}) };
  }

  log('relay.bootstrap.failed', { errorCode: result.errorCode, error: result.error });
  return {
    status: 'failed',
    relayReady: false,
    retryable: false,
    detail: `${result.errorCode ?? 'unknown'}: ${result.error ?? ''}`.trim(),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 只取异常**类型名**（`TypeError` / `AbortError` / …），**绝不**取 message。
 *
 * 用在"说不清是不是敏感"的那几条路径上：异常文案里可能带 URL、`apikey`、卡密，
 * 而类型名足够定位是哪一类失败（例如 `AbortError` = 超时）。
 */
function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * 等网关连上的窗口。
 *
 * ⚠️ 要**同时**容得下 `AUTH_RETRY_BACKOFF_MS` 的全部退避（见下），否则
 * `runtime-not-ready` 的 deadline 会**提前掐掉**退避重试。首次启动要等部署 +
 * spawn + WS 握手，本来就要几十秒，所以这个窗口放宽到 3 分钟。
 * 它**不阻塞启动**（`void bootstrapCommercialRelay()`），只是后台慢慢来。
 */
const DEFAULT_WAIT_MS = 240_000;
const POLL_MS = 1_000;

/**
 * `auth-transient` 的**有界**退避表（用完即止）。合计 172 秒。
 *
 * ⚠️ **必须越过 supabase-js 的刷新失败冷却期**，否则重试全是白试：
 * `@supabase/auth-js` 的 `REFRESH_FAILURE_COOLDOWN_MS = 2 × 30s = **60 秒**`
 * —— 冷却期内同一个 refresh token 的调用会**直接拿到缓存的失败**
 * （实测 0ms 返回 `AuthRetryableFetchError`），根本不会发新请求。
 * 我第一版把退避排在 52 秒内，**整段落在冷却期里**，所以"重试"只是个安慰，
 * 用户照样得重启客户端（是打包态 E2E 把这条逼出来的）。
 *
 * 后两次特意都取 **60 秒**：冷却期一过，第一个探针就应该能真正发出去；
 * 万一那次正好卡在边界上，下一次还有机会。**不靠"恰好掐准"取胜。**
 *
 * 两条仍然满足：**不无限重试**（表用完即止）、**不高频打服务端**（间隔递增，最快也是分钟级）。
 */
const AUTH_RETRY_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 60_000];

/**
 * 调度器只认这几种触发来源，**刻意做成联合类型**：调用点一眼能看出自己属于哪一种，
 * 也不会有人顺手塞进"收到某个 auth 事件"这种会误伤的来源。
 *
 *   - `startup`    —— `app.whenReady()` 里那一次（全仓唯一的启动调用点）
 *   - `signed-in`  —— 用户**刚刚完成一次交互式登录**（OTP / 密码）
 *   - `activated`  —— 用户**刚刚激活了一张卡**（卡密输入成功；激活那刻网关常常还没连上）
 *   - `manual`     —— 用户在界面上**点了重试**（`commercial:relay-bootstrap-retry`）。
 *     与上面三个一样只是**排队**：单飞跑着就记一个补跑，绝不另开一条链。
 */
export type RelayBootstrapReason = 'startup' | 'signed-in' | 'activated' | 'manual';

export interface RelayBootstrapScheduler {
  /**
   * 触发一次 bootstrap。**单飞**：已经有一次在跑就共享它，
   * 并记一个"跑完补一次"（见下），绝不开第二条链。
   */
  trigger: (reason: RelayBootstrapReason) => Promise<RelayBootstrapResult>;
  /** 现在有没有一次 bootstrap 在跑（排障与测试用）。 */
  inFlight: () => boolean;
}

/**
 * 单飞调度器 —— 商业 bootstrap 的**唯一**入口。
 *
 * ## 为什么需要它（2026-09-14，Stage 2C）
 *
 * 启动路径只在 `app.whenReady()` 里 bootstrap **一次**。启动时没登录 ⇒ 结论
 * `unauthenticated` ⇒ 按设计**不重试**（明确没登录，等多久都一样）。
 * 可用户接下来会在登录页完成 OTP —— 那一刻主进程只有 `verifyLoginOtp()` 返回
 * `{ok:true}`，**没有任何东西再去调度一次 bootstrap** ⇒ 模型列表一直空着，
 * 用户必须重启客户端。这是 2C 要补的洞。
 *
 * ## 为什么不能只是"再调一次 `bootstrapRelayWithRetry`"
 *
 * OTP 成功的那一刻，可能**同时**存在另一条在跑的链：2B 的 `auth-transient`
 * 退避重试（最长 172 秒）、`runtime-not-ready` 轮询……两条链并行会各自
 * `applyRelayConfig`，而它带 baseHash 回读校验 —— 会互相打架。
 *
 * ⇒ 单飞。而且要解决一个必须解决的细节：**登录这一下不能被吞掉**。
 * 如果只是"在跑就返回同一个 promise"，那么当那次在跑的链已经过了 `checkAuth`
 * 这一步（结论是 `unauthenticated`）时，登录就丢了，relay 仍然不会落地。
 * 所以跑着的时候再触发会记一个 `rerunRequested`，**跑完补一次**。
 *
 * ⚠️ `rerunRequested` 用**布尔**而不是计数：一串密集触发只值一次补跑，
 * 不会滚成无限循环。（触发来源本来就只有两个，且都不是高频。）
 *
 * ## 与 `TOKEN_REFRESHED` 的关系
 *
 * 本调度器**不认识** auth 事件 —— 触发权在调用方手里，而调用方只挂在
 * "登录成功"这一个**状态转变**上。所以 auto-refresh（每 ~30 秒刷一次 token）
 * 连门都进不来，不存在"刷一次 token 就重写一次网关配置"的回归。
 */
export function createRelayBootstrapScheduler(
  deps: RelayBootstrapDeps,
  opts: RelayBootstrapRunOptions = {},
): RelayBootstrapScheduler {
  let inFlight: Promise<RelayBootstrapResult> | null = null;
  let rerunRequested = false;

  return {
    trigger: (reason) => {
      deps.log?.('relay.bootstrap.trigger', { reason, inFlight: inFlight !== null });

      if (inFlight) {
        // ⚠️ 同步置位（在返回之前）—— 这是"登录不会被吞掉"的关键。
        rerunRequested = true;
        return inFlight;
      }

      const p = (async (): Promise<RelayBootstrapResult> => {
        let result: RelayBootstrapResult;
        for (;;) {
          rerunRequested = false;
          result = await bootstrapRelayWithRetry(deps, opts);
          // ⚠️ 从这一行到 `inFlight = null` 之间**没有 await** ⇒ 相对其它任务
          //    是原子的：要么触发方看见 inFlight 还在（于是置位、被本循环下一轮
          //    接住），要么看见它已经清空（于是自己起一条新链）。不会两头落空。
          if (!rerunRequested) break;
          deps.log?.('relay.bootstrap.rerun', { reason });
        }
        inFlight = null;
        return result;
      })();

      inFlight = p;
      return p;
    },
    inFlight: () => inFlight !== null,
  };
}

export interface RelayBootstrapRunOptions {
  /** 等网关连上的总窗口。 */
  waitForGatewayMs?: number;
  /** 测试注入用：免得真等几十秒。 */
  sleep?: (ms: number) => Promise<void>;
  /** 测试注入用：让 deadline 可控。 */
  now?: () => number;
}

/**
 * 带着**重试策略**跑 `ensureRelayConfigured`。**永不抛**。
 *
 * 两种「等一等就会好」的结论各自处理：
 *   - `runtime-not-ready`：纯本地探测、**不打服务端** ⇒ 1 秒一次轮询到 deadline
 *   - `auth-transient`：会话暂时问不出来 ⇒ **有界退避**（见 `AUTH_RETRY_BACKOFF_MS`）
 *
 * ⚠️ 其余结论（**明确**没登录 / 没卡 / **确定性拒绝** / 写失败）等多久都一样，
 *     **一律不重试**。尤其：
 *       - `auth-transient` **不能**被当成没登录 —— 那正是 2B 修的 bug：
 *         一次 8 秒网络抖动会让用户整个会话都列不出模型，且无法自愈；
 *       - `entitlement-rejected` **不能**被塞进退避表 —— 它是终局结论（卡的归属
 *         不是时间能改的），塞进来只会让 4 分钟窗口里反复重发 `activate_license`。
 *
 * ⚠️ 传输类失败（取 key 超时）走的是**既有**的 `auth-transient` 分支：本函数
 *    刻意**不**新增重试路径 —— 新路径意味着新的等待节奏，而要等多久已经有结论了。
 */
export async function bootstrapRelayWithRetry(
  deps: RelayBootstrapDeps,
  opts: RelayBootstrapRunOptions = {},
): Promise<RelayBootstrapResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => Date.now());
  const waitMs = opts.waitForGatewayMs ?? DEFAULT_WAIT_MS;

  if (!deps.hasCommercialClient()) return { status: 'not-configured', relayReady: false, retryable: false };

  const deadline = now() + waitMs;
  let authRetries = 0;
  for (;;) {
    const res = await ensureRelayConfigured(deps);

    if (res.status === 'runtime-not-ready') {
      if (now() >= deadline) return res;
      await sleep(POLL_MS);
      continue;
    }

    if (res.status === 'auth-transient') {
      const backoff = AUTH_RETRY_BACKOFF_MS[authRetries];
      authRetries += 1;
      // 退避表用完 / 下一次等待会越过总 deadline ⇒ 打住，如实报"暂不可用"。
      if (backoff === undefined || now() + backoff >= deadline) return res;
      deps.log?.('relay.bootstrap.retry', { attempt: authRetries, reason: 'auth-transient', backoffMs: backoff });
      await sleep(backoff);
      continue;
    }

    // ⚠️ 其余结论一律**不重试** —— 尤其 `entitlement-rejected`：卡的归属不是时间
    //    能改的，重试只是再发一次 `activate_license`（窗口里能发几十次）。别把
    //    它加进上面那个 `auth-transient` 条件里。
    return res;
  }
}
