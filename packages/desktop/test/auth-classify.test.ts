import { describe, expect, it } from 'vitest';
import { classifyAuthFailure, classifyOtpVerifyFailure } from '../src/main/commercial/auth-classify.js';

/**
 * 「会话检查失败」的分类。
 *
 * 这条链原先只有一个布尔：超时、断网、401、没用户**全都塌缩成 `{signedIn:false}`**
 * ⇒ 一次 8 秒网络抖动被固化成「用户已退出登录」，而且整个会话都不再列商业模型
 * （启动只 bootstrap 一次、且只对 `runtime-not-ready` 重试）。
 *
 * ⚠️ 下面 401/403 的断言不是猜的 —— 是打真实后端 `GET /auth/v1/user` 拿到的：
 *   - 不带 Authorization ⇒ 401 `no_authorization`
 *   - token 伪造/签名错  ⇒ 403 `bad_jwt`
 */
describe('classifyAuthFailure —— 只有明确证据才算「没登录」', () => {
  it('⭐ 401（no_authorization：没带凭证）⇒ unauthenticated', () => {
    expect(
      classifyAuthFailure({ status: 401, code: 'no_authorization', message: 'requires a valid Bearer token' }),
    ).toBe('unauthenticated');
  });

  it('⭐ 403（bad_jwt：凭证无效）⇒ unauthenticated', () => {
    expect(classifyAuthFailure({ status: 403, code: 'bad_jwt', message: 'invalid JWT' })).toBe('unauthenticated');
  });

  it('⭐⭐ 超时 ⇒ transient（**这条就是 2B 修的东西**）', () => {
    // 超时在实现里被表示成「没有 error 对象可分类」或一个无 status 的异常；
    // 两种都**绝不能**被当成「用户已退出登录」。
    expect(classifyAuthFailure(undefined)).toBe('transient');
    expect(classifyAuthFailure(null)).toBe('transient');
  });

  it('⭐ 请求压根没到（AuthRetryableFetchError / status 0）⇒ transient', () => {
    expect(classifyAuthFailure({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' })).toBe(
      'transient',
    );
    expect(classifyAuthFailure({ status: 0, message: 'NetworkError' })).toBe('transient');
  });

  it('⭐ 5xx（服务端自己挂了）⇒ transient —— 不是用户的问题', () => {
    expect(classifyAuthFailure({ status: 500, message: 'Internal Server Error' })).toBe('transient');
    expect(classifyAuthFailure({ status: 503, message: 'Service Unavailable' })).toBe('transient');
  });

  it('⭐ 没有 status 的网络异常（ECONNRESET / fetch failed / abort）⇒ transient', () => {
    expect(classifyAuthFailure(new Error('fetch failed'))).toBe('transient');
    expect(classifyAuthFailure(new Error('read ECONNRESET'))).toBe('transient');
    expect(classifyAuthFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('transient');
  });

  it('⭐⭐ 根本没登录（AuthSessionMissingError）⇒ unauthenticated —— **别被它的 400 骗了**', () => {
    // 查 @supabase/auth-js 的 lib/errors.js 得到：这个类的 status 是 **400**（不是 401/403）。
    // 只按状态码判会把它归成 transient ⇒「没登录」被无谓地重试 4 次。
    expect(
      classifyAuthFailure({ name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' }),
    ).toBe('unauthenticated');
  });

  it('⭐ 明确无效的 JWT / 凭证（400 + 专门的错误类）⇒ unauthenticated', () => {
    expect(classifyAuthFailure({ name: 'AuthInvalidJwtError', status: 400, code: 'invalid_jwt' })).toBe(
      'unauthenticated',
    );
    expect(classifyAuthFailure({ name: 'AuthInvalidCredentialsError', status: 400 })).toBe('unauthenticated');
  });

  it('⭐ 服务端响应异常（AuthInvalidTokenResponseError，500）⇒ 仍算 transient', () => {
    // 500 是服务端自己的毛病，不该让用户去重新登录。
    expect(classifyAuthFailure({ name: 'AuthInvalidTokenResponseError', status: 500 })).toBe('transient');
  });

  it('⭐ 其余 4xx 保守归 transient（分不清就别把用户踢成未登录）', () => {
    // 宁可多重试几次、最后报「暂不可用」，也不要把还能用的会话说成已登出。
    expect(classifyAuthFailure({ status: 400, message: 'Bad Request' })).toBe('transient');
    expect(classifyAuthFailure({ status: 429, message: 'Too Many Requests' })).toBe('transient');
  });
});

/**
 * 「验证码校验失败」的分类。
 *
 * ⚠️ **和上面那个函数刻意相反**，别"顺手统一"：
 *   · 会话检查里，4xx 说明不了问题 ⇒ 保守归 transient（宁可重试也别把人踢成未登录）；
 *   · 校验验证码时，**auth 服务器已经回话了** ⇒ 那就是"这个码我没接受"，
 *     正是用户需要知道的（码错/过期）。
 *   两边判反了都会出 bug：并成一个函数必然弄坏一边。
 *
 * ⭐ 为什么要分：实机（2026-09-17）里校验请求**超时**，界面却统一说
 *   「验证码不正确或已过期」⇒ 用户拿同一个码重试 ⇒ 而 OTP 是一次性的、
 *   那次超时的请求其实已经把它消费掉了 ⇒ 第二次必然失败，表现成"收到验证码登不上"。
 */
describe('classifyOtpVerifyFailure —— 没答案 与 码被拒 必须分开', () => {
  it('⭐ 压根没拿到回应（无 status / 超时 / 断网）⇒ unreachable', () => {
    expect(classifyOtpVerifyFailure(undefined)).toBe('unreachable');
    expect(classifyOtpVerifyFailure(null)).toBe('unreachable');
    expect(classifyOtpVerifyFailure(new Error('fetch failed'))).toBe('unreachable');
    expect(classifyOtpVerifyFailure({ name: 'AuthRetryableFetchError' })).toBe('unreachable');
  });

  it('⭐ status 0（请求没出去）⇒ unreachable', () => {
    expect(classifyOtpVerifyFailure({ status: 0 })).toBe('unreachable');
  });

  it('⭐ 服务端 5xx ⇒ unreachable（那是服务端自己的毛病，不能说人家码错）', () => {
    expect(classifyOtpVerifyFailure({ status: 500 })).toBe('unreachable');
    expect(classifyOtpVerifyFailure({ name: 'AuthInvalidTokenResponseError', status: 500 })).toBe('unreachable');
  });

  it('⭐ 4xx ⇒ rejected（auth 服务器明确没接受这个码）', () => {
    expect(classifyOtpVerifyFailure({ status: 400, code: 'otp_expired', message: 'Token has expired' })).toBe(
      'rejected',
    );
    expect(classifyOtpVerifyFailure({ status: 401 })).toBe('rejected');
    expect(classifyOtpVerifyFailure({ status: 403, code: 'otp_disabled' })).toBe('rejected');
  });

  it('⭐ 429 ⇒ too-many（服务端在说"你试得太频繁"，不是"码错"）', () => {
    expect(classifyOtpVerifyFailure({ status: 429, code: 'over_request_rate_limit' })).toBe('too-many');
  });
});
