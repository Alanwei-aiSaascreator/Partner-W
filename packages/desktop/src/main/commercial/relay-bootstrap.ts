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

import { relayProviderIds, applyRelayConfig, RELAY_PROVIDER_ID } from './relay-config.js';

/**
 * 结果分类。**刻意分得细**：「没登录」「没卡」「网关没连上」「写失败」是四件
 * 不同的事，界面要说的和排查要看的都不一样，混成一个 `false` 就只能靠猜。
 */
export type RelayBootstrapStatus =
  | 'not-configured' // 没配 Supabase —— 产品没接商业层（纯净开发环境）
  | 'unauthenticated' // 配了，但没登录
  | 'unlicensed' // 登录了，但名下没有可用 license
  | 'runtime-not-ready' // 商业侧没问题，是网关还没连上（**可重试**）
  | 'already-applied' // 网关已经有指向中转的 provider —— 幂等命中，什么都没做
  | 'applied' // 这次真的写进去了
  | 'failed'; // 写了但没成功

export interface RelayBootstrapResult {
  status: RelayBootstrapStatus;
  /**
   * 模型是否可用。**只有 applied / already-applied 为 true。**
   *
   * ⚠️ 这正是「runtime ready ≠ commercial ready」那条：网关活着只说明
   * `runtime ready`，模型能不能用要看这个。
   */
  relayReady: boolean;
  /** 给人看的补充（**绝不含任何密钥**）。 */
  detail?: string;
}

export interface RelayGatewayHandle {
  getConfig: () => Promise<unknown>;
  patchConfig: (params: { baseHash: string; raw: string }) => Promise<unknown>;
}

export interface RelayBootstrapDeps {
  /** 商业层配好了没（Supabase url + anon key 都在）。 */
  hasCommercialClient: () => boolean;
  /** 本地会话还有效吗（**会真的问服务端**）。 */
  isSignedIn: () => Promise<boolean>;
  /** 读名下 license（账号绑定口径，不依赖设备激活行）。 */
  readLicenseKey: () => Promise<string | null>;
  /** 取中转 key（幂等：同一设备重复调用返回同一把）。 */
  fetchRelayKey: (licenseKey: string) => Promise<string | null>;
  /** 现在有没有一个**连上的**网关可以写。没有返回 null（⇒ runtime-not-ready）。 */
  getGateway: () => RelayGatewayHandle | null;
  /** 解析一个默认模型 ref；拿不到返回 null（不阻塞）。 */
  resolveDefaultModel?: (relayKey: string) => Promise<string | null>;
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
    return { status: 'not-configured', relayReady: false };
  }

  let signedIn = false;
  try {
    signedIn = await deps.isSignedIn();
  } catch (error) {
    log('relay.bootstrap.session-check-failed', { message: messageOf(error) });
    signedIn = false;
  }
  if (!signedIn) {
    log('relay.bootstrap.unauthenticated');
    return { status: 'unauthenticated', relayReady: false };
  }

  let licenseKey: string | null = null;
  try {
    licenseKey = await deps.readLicenseKey();
  } catch (error) {
    log('relay.bootstrap.license-read-failed', { message: messageOf(error) });
  }
  if (!licenseKey) {
    log('relay.bootstrap.unlicensed');
    return { status: 'unlicensed', relayReady: false };
  }

  const gateway = deps.getGateway();
  if (!gateway) {
    // ⚠️ **可重试**：调用方该等网关连上再来，而不是把它当成"没激活"。
    log('relay.bootstrap.runtime-not-ready');
    return { status: 'runtime-not-ready', relayReady: false };
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
    return { status: 'runtime-not-ready', relayReady: false, detail: messageOf(error) };
  }

  if (relayProviderIds(snapshot).size > 0) {
    log('relay.bootstrap.already-applied', { provider: RELAY_PROVIDER_ID });
    return { status: 'already-applied', relayReady: true };
  }

  let relayKey: string | null = null;
  try {
    relayKey = await deps.fetchRelayKey(licenseKey);
  } catch (error) {
    log('relay.bootstrap.relay-key-failed', { message: messageOf(error) });
  }
  if (!relayKey) {
    // 卡在、账号在，但服务端没给中转凭证（旧卡 / RPC 形状变了）。
    // 不当成「已就绪」—— 没有 key 就是列不出模型。
    log('relay.bootstrap.no-relay-key');
    return { status: 'unlicensed', relayReady: false, detail: 'no relay key issued for this license' };
  }

  const result = await applyRelayConfig(
    {
      getConfig: gateway.getConfig,
      patchConfig: gateway.patchConfig,
      resolveDefaultModel: deps.resolveDefaultModel,
      log: (event, data) => log(event, data),
    },
    { relayKey, deviceFingerprint: deps.deviceFingerprint() },
  );

  if (result.configured) {
    log('relay.bootstrap.applied', { provider: RELAY_PROVIDER_ID });
    return { status: 'applied', relayReady: true };
  }

  log('relay.bootstrap.failed', { errorCode: result.errorCode, error: result.error });
  return {
    status: 'failed',
    relayReady: false,
    detail: `${result.errorCode ?? 'unknown'}: ${result.error ?? ''}`.trim(),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
