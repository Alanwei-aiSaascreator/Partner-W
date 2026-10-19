/**
 * 飞书应用注册（OAuth **设备码流程**）—— 主进程纯逻辑。
 *
 * 为什么要自己走这条流程（2026-10-18 用户要求）：扫二维码必须**在应用里**弹出来，
 * 不能再把用户丢进系统终端。内核插件（`extensions/feishu/dist/app-registration-*.js`）
 * 的 CLI 路径是同一套协议，这里按它的语义逐条对齐（只读参考，不 import 插件）：
 *
 *   POST https://accounts.feishu.cn/oauth/v1/app/registration   (form-urlencoded)
 *   ① `action=init`  → `supported_auth_methods` 必须含 `client_secret`
 *   ② `action=begin`（`archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id`）
 *        → `{ device_code, verification_uri_complete, user_code, interval, expire_in }`
 *        二维码内容 = `verification_uri_complete` + `from=oc_onboard&tp=ob_cli_app`
 *   ③ `action=poll`（`device_code`）
 *        → 成功 `{ client_id, client_secret, user_info:{ open_id, tenant_brand } }`
 *        → 错误 `authorization_pending / slow_down / access_denied / expired_token`
 *
 * ⚠️ 本文件**不 import electron、不碰网络**（`fetch` 与 `sleep` 全部注入）——
 *    这样注册流程可以脱离真实网关/真实飞书做确定性单测。
 */

export type FeishuRegistrationDomain = 'feishu' | 'lark';

const FEISHU_ACCOUNTS_URL = 'https://accounts.feishu.cn';
const LARK_ACCOUNTS_URL = 'https://accounts.larksuite.com';
const REGISTRATION_PATH = '/oauth/v1/app/registration';

/** 与插件同口径的默认值（秒）。 */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRE_SECONDS = 600;
/** `slow_down` 的加长步长（插件是 `currentInterval += 5`，单位秒）。 */
const SLOW_DOWN_STEP_MS = 5_000;

export interface FeishuHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface FeishuFetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export type FeishuFetchImpl = (url: string, init: FeishuFetchInit) => Promise<FeishuHttpResponse>;

export interface FeishuRegistrationBegin {
  deviceCode: string;
  /** 手机飞书扫码打开的就是这个地址（已带 onboard 追踪参数）。 */
  qrUrl: string;
  userCode: string;
  /** 过期时刻（epoch ms），由 `expire_in` 换算。 */
  expireAt: number;
  /** 轮询间隔（ms）。 */
  intervalMs: number;
  domain: FeishuRegistrationDomain;
}

export interface FeishuRegistrationCredentials {
  appId: string;
  appSecret: string;
  domain: FeishuRegistrationDomain;
  /** 应用所有者 open_id；`dmPolicy=allowlist` 的默认允许名单就是它。 */
  openId: string | null;
}

export type FeishuBeginFailure = 'network' | 'unsupported-auth' | 'rejected' | 'malformed';

export type BeginFeishuRegistrationResult =
  | { ok: true; begin: FeishuRegistrationBegin }
  | { ok: false; reason: FeishuBeginFailure; message?: string };

export type FeishuPollOnce =
  | { status: 'success'; credentials: FeishuRegistrationCredentials }
  | { status: 'pending' }
  | { status: 'slow-down' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'domain-switched'; domain: FeishuRegistrationDomain }
  | { status: 'network' }
  | { status: 'error'; message: string };

export type PollFeishuRegistrationResult =
  | { status: 'success'; credentials: FeishuRegistrationCredentials; domain: FeishuRegistrationDomain }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function accountsBaseUrl(domain: FeishuRegistrationDomain): string {
  return domain === 'lark' ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
}

/** `expire_in` / `interval` 的容错换算（非正数/非数字 ⇒ 插件同款默认值）。 */
function secondsOrDefault(value: unknown, fallbackSeconds: number): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallbackSeconds;
}

async function postRegistration(
  fetchImpl: FeishuFetchImpl,
  domain: FeishuRegistrationDomain,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${accountsBaseUrl(domain)}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  // OAuth 的错误码在 JSON body 里（HTTP 状态不总是 200），所以**无论 ok 都读 body**。
  try {
    return recordOf(await response.json()) ?? {};
  } catch {
    return {};
  }
}

/** 二维码地址：追加 onboard 追踪参数（与插件逐字一致）。 */
export function withFeishuOnboardParams(uri: string): string {
  try {
    const url = new URL(uri);
    url.searchParams.set('from', 'oc_onboard');
    url.searchParams.set('tp', 'ob_cli_app');
    return url.toString();
  } catch {
    const separator = uri.includes('?') ? '&' : '?';
    return `${uri}${separator}from=oc_onboard&tp=ob_cli_app`;
  }
}

/**
 * 第 1、2 步：校验环境支持 `client_secret` 并拿到设备码与二维码。
 *
 * 失败分类都**具名**（UI 要按类型给不同文案）：
 *   · `network`         —— 还没走到协议层（断网 / DNS / 超时）；
 *   · `unsupported-auth`—— init 明确说环境不支持 `client_secret`；
 *   · `rejected`        —— 服务端回了 `error`（被拒、风控、参数变了）；
 *   · `malformed`       —— 响应缺关键字段（协议变了，不能拿半个 URL 去渲染二维码）。
 */
export async function beginFeishuRegistration(deps: {
  fetchImpl: FeishuFetchImpl;
  now?: () => number;
  domain?: FeishuRegistrationDomain;
}): Promise<BeginFeishuRegistrationResult> {
  const now = deps.now ?? Date.now;
  const domain = deps.domain ?? 'feishu';

  let init: Record<string, unknown>;
  try {
    init = await postRegistration(deps.fetchImpl, domain, { action: 'init' });
  } catch {
    return { ok: false, reason: 'network' };
  }
  const methods = init['supported_auth_methods'];
  if (!Array.isArray(methods) || !methods.includes('client_secret')) {
    const serverError = typeof init['error'] === 'string' ? init['error'] : null;
    return serverError
      ? { ok: false, reason: 'rejected', message: serverError }
      : { ok: false, reason: 'unsupported-auth' };
  }

  let begin: Record<string, unknown>;
  try {
    begin = await postRegistration(deps.fetchImpl, domain, {
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    });
  } catch {
    return { ok: false, reason: 'network' };
  }

  const serverError = typeof begin['error'] === 'string' ? begin['error'] : null;
  if (serverError) {
    const description = typeof begin['error_description'] === 'string' ? begin['error_description'] : '';
    return { ok: false, reason: 'rejected', message: description ? `${serverError}: ${description}` : serverError };
  }

  const deviceCode = typeof begin['device_code'] === 'string' ? begin['device_code'].trim() : '';
  const userCode = typeof begin['user_code'] === 'string' ? begin['user_code'].trim() : '';
  const verificationUri =
    typeof begin['verification_uri_complete'] === 'string' ? begin['verification_uri_complete'].trim() : '';
  if (!deviceCode || !userCode || !verificationUri) return { ok: false, reason: 'malformed' };

  const intervalSeconds = secondsOrDefault(begin['interval'], DEFAULT_POLL_INTERVAL_SECONDS);
  const expireSeconds = secondsOrDefault(begin['expire_in'], DEFAULT_EXPIRE_SECONDS);
  return {
    ok: true,
    begin: {
      deviceCode,
      qrUrl: withFeishuOnboardParams(verificationUri),
      userCode,
      expireAt: now() + expireSeconds * 1000,
      intervalMs: intervalSeconds * 1000,
      domain,
    },
  };
}

/**
 * 第 3 步的**一次**轮询。把服务端状态翻译成调用方要决策的东西：
 *   · `domain-switched` 由**循环**消费（换 `accounts.larksuite.com` 后立即重试，不等待）；
 *   · `network` 等同于 pending（插件也是"睡一觉再来"）。
 */
export async function pollFeishuRegistrationOnce(input: {
  fetchImpl: FeishuFetchImpl;
  deviceCode: string;
  domain: FeishuRegistrationDomain;
  /** 已经切换过域名 ⇒ 再看到 `tenant_brand=lark` 不再切换（否则会来回跳）。 */
  allowDomainSwitch?: boolean;
}): Promise<FeishuPollOnce> {
  let payload: Record<string, unknown>;
  try {
    payload = await postRegistration(input.fetchImpl, input.domain, {
      action: 'poll',
      device_code: input.deviceCode,
    });
  } catch {
    return { status: 'network' };
  }

  const userInfo = recordOf(payload['user_info']);
  const tenantBrand = userInfo && typeof userInfo['tenant_brand'] === 'string' ? userInfo['tenant_brand'] : null;
  if (tenantBrand === 'lark' && (input.allowDomainSwitch ?? true)) {
    return { status: 'domain-switched', domain: 'lark' };
  }

  const appId = typeof payload['client_id'] === 'string' ? payload['client_id'].trim() : '';
  const appSecret = typeof payload['client_secret'] === 'string' ? payload['client_secret'] : '';
  if (appId && appSecret) {
    const openId = userInfo && typeof userInfo['open_id'] === 'string' ? userInfo['open_id'].trim() : '';
    return {
      status: 'success',
      credentials: {
        appId,
        appSecret,
        domain: input.domain,
        openId: openId || null,
      },
    };
  }

  const error = typeof payload['error'] === 'string' ? payload['error'] : '';
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'slow-down' };
  if (error === 'access_denied') return { status: 'denied' };
  if (error === 'expired_token') return { status: 'expired' };
  if (!error) return { status: 'pending' };
  const description = typeof payload['error_description'] === 'string' ? payload['error_description'] : 'unknown';
  return { status: 'error', message: `${error}: ${description}` };
}

/**
 * 轮询循环：按「过期时刻」收口，处理 `slow_down`（每次 +5s）与 `lark` 域名切换。
 *
 * `sleep` / `now` / `isCancelled` 全部注入 —— 单测不需要真等 5 秒，取消也是纯函数级可控。
 */
export async function pollFeishuRegistration(input: {
  fetchImpl: FeishuFetchImpl;
  deviceCode: string;
  intervalMs: number;
  expireAt: number;
  domain: FeishuRegistrationDomain;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isCancelled?: () => boolean;
}): Promise<PollFeishuRegistrationResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let domain = input.domain;
  let intervalMs = input.intervalMs;
  let domainSwitched = false;

  while (now() < input.expireAt) {
    if (input.isCancelled?.()) return { status: 'cancelled' };

    const outcome = await pollFeishuRegistrationOnce({
      fetchImpl: input.fetchImpl,
      deviceCode: input.deviceCode,
      domain,
      allowDomainSwitch: !domainSwitched,
    });

    if (outcome.status === 'success') {
      return { status: 'success', credentials: outcome.credentials, domain };
    }
    if (outcome.status === 'denied') return { status: 'denied' };
    if (outcome.status === 'expired') return { status: 'expired' };
    if (outcome.status === 'error') return { status: 'error', message: outcome.message };
    if (outcome.status === 'domain-switched') {
      domain = outcome.domain;
      domainSwitched = true;
      // 插件在这里 `continue`（不睡）：域名切换后立刻在新域名上轮询。
      continue;
    }
    if (outcome.status === 'slow-down') intervalMs += SLOW_DOWN_STEP_MS;

    if (input.isCancelled?.()) return { status: 'cancelled' };
    const remaining = input.expireAt - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  return { status: 'expired' };
}
