/**
 * 「会话还有效吗」的失败分类。
 *
 * ## 为什么需要这个文件（2026-09-13 实测）
 *
 * 原先这条链只有一个布尔：
 *
 * ```
 * auth.getUser() 超时 ─┐
 * DNS / ECONNRESET ────┼─→ 全都塌缩成 { signedIn: false } ─→ relay.bootstrap 判定
 * 401 / 没有用户 ──────┘                                    "unauthenticated"
 * ```
 *
 * 后果：一次 **8 秒的网络抖动**被固化成「用户已退出登录」——而且因为启动只
 * bootstrap 一次、且只对 `runtime-not-ready` 重试，**那一整个会话都不再列商业模型**，
 * 用户必须重启客户端。实测同一个有效会话：一次启动报 `unauthenticated`，
 * 下一次直接 `applied`。
 *
 * ## 判定依据（打真实后端拿到的，不是猜的）
 *
 * `GET {supabase}/auth/v1/user`：
 *
 * | 情形 | HTTP | error_code |
 * |---|---|---|
 * | 不带 Authorization | **401** | `no_authorization` |
 * | token 伪造 / 签名错 | **403** | `bad_jwt` |
 *
 * ⇒ **401 / 403 才算「明确没登录」**；其余一切（超时、status 0、
 * `AuthRetryableFetchError`、5xx、没有 status 的网络异常）都是**暂时问不出来**。
 *
 * ⚠️ 保守方向是刻意的：把「暂时」误判成「没登录」会把用户踢出登录态（本次要修的 bug）；
 * 反过来只是多重试几次、最后报「暂不可用」——**代价小得多**。
 *
 * 本文件**不依赖 electron / supabase**，纯函数，可以直接钉单测。
 */

/** 会话检查的结果。**三态，不是布尔**。 */
export type AuthCheck = 'authenticated' | 'unauthenticated' | 'transient';

/** 验证码校验失败的结果。 */
export type OtpVerifyFailure = 'unreachable' | 'rejected' | 'too-many';

/**
 * 把一次**验证码校验**的失败归类。
 *
 * ⚠️ 与 `classifyAuthFailure` **刻意相反**，别"顺手统一"成一个函数：
 *   · 会话检查里 4xx 说明不了问题 ⇒ 保守归 transient（宁可重试也别把人踢成未登录）；
 *   · 校验验证码时 **auth 服务器已经回话了** ⇒ 那就是"这个码我没接受"，
 *     正是用户需要知道的信息。两边判反了都会出 bug。
 *
 * ⭐ 为什么必须分（2026-09-17 实机）：校验请求**超时**，界面却统一说
 *   「验证码不正确或已过期」⇒ 用户拿同一个码重试 ⇒ OTP 是一次性的、
 *   那次超时的请求其实已把它消费掉 ⇒ 第二次必然失败（"收到验证码登不上"）。
 *
 * `too-many` 单列的理由：429 时服务端在说"你试得太频繁"，
 * 让用户去"检查验证码"是错的引导（而且他正是因为被误导才反复重试）。
 */
export function classifyOtpVerifyFailure(error: unknown): OtpVerifyFailure {
  // 问不出来「为什么」⇒ 更不能替用户断定"你码错了"。
  if (error === null || error === undefined) return 'unreachable';

  const e = error as { status?: unknown; name?: unknown; code?: unknown };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const name = String(e.name ?? '');
  const code = String(e.code ?? '');

  // 请求压根没到 / 没回来
  if (name === 'AuthRetryableFetchError') return 'unreachable';
  if (status === undefined) return 'unreachable';
  if (status === 0) return 'unreachable';
  // 服务端自己的毛病（含短信 hook 塌缩成的 500）—— 不能说人家码错
  if (status >= 500) return 'unreachable';

  if (status === 429) return 'too-many';
  if (code.includes('rate_limit') || code.startsWith('over_')) return 'too-many';

  // 到这一步：auth 服务器明确回复了"不接受这次校验"
  return 'rejected';
}

/**
 * 服务端**明确**说"你没登录"的状态码。
 *
 * 401 = 没带凭证；403 = 凭证无效（`bad_jwt`）。两者都打真后端实测过。
 */
const DEFINITIVE_UNAUTHENTICATED_STATUS = new Set([401, 403]);

/**
 * supabase-js 里**语义上就是"你没登录"**的错误类名。
 *
 * ⚠️ 这份名单是查 `@supabase/auth-js` 的 `lib/errors.js` 得到的，不是猜的。
 * 关键一条：`AuthSessionMissingError` 的 **status 是 400**（不是 401/403）——
 * 只按状态码判会把它当"暂时问不出来"，于是"根本没登录"也会被无谓地重试 4 次。
 *
 *   AuthSessionMissingError      400  根本没登录（本地就没有会话）
 *   AuthInvalidJwtError          400  code=invalid_jwt，JWT 无效
 *   AuthInvalidCredentialsError  400  凭证无效
 *
 * ⚠️ 刻意**不**收 `AuthInvalidTokenResponseError`（它是 500，属服务端异常）
 * 与 `AuthRetryableFetchError`（请求没到）—— 那两个都是 transient。
 */
const DEFINITIVE_UNAUTHENTICATED_NAMES = new Set([
  'AuthSessionMissingError',
  'AuthInvalidJwtError',
  'AuthInvalidCredentialsError',
]);

/**
 * 把一次会话检查的失败归类。
 *
 * 只认**明确**的"没登录"证据，其余一律 `transient`。
 *
 * 保守方向是刻意的：把"暂时"误判成"没登录"会把用户踢出登录态（本次要修的 bug）；
 * 反过来只是多重试几次、最后报"暂不可用"——代价小得多。
 */
export function classifyAuthFailure(error: unknown): AuthCheck {
  // 问不出来「为什么」⇒ 就更不能断言"没登录"。
  if (error === null || error === undefined) return 'transient';

  const e = error as { status?: unknown; name?: unknown };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const name = String(e.name ?? '');

  // 先说"请求压根没到 / 没回来" —— 这是最典型的 transient，优先于一切。
  if (name === 'AuthRetryableFetchError') return 'transient';

  if (status !== undefined && DEFINITIVE_UNAUTHENTICATED_STATUS.has(status)) return 'unauthenticated';
  if (DEFINITIVE_UNAUTHENTICATED_NAMES.has(name)) return 'unauthenticated';

  // status 0 = fetch 层就失败了（DNS / 连接被拒 / 断网）。
  if (status === 0) return 'transient';
  if (status !== undefined && status >= 500) return 'transient';
  // 没有 status ⇒ 网络层异常（ECONNRESET / fetch failed / abort）。
  if (status === undefined) return 'transient';

  // 其余 4xx：服务端拒绝了这次请求，但我们**分不清**是不是"没登录"。
  // 保守归 transient —— 宁可重试几次，也别把用户踢成未登录。
  return 'transient';
}
