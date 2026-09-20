import type { CommercialAccountOverview, CommercialLicenseSummary, IpcResult } from '@clawwork/shared';
import { getCommercialClient, resetCommercialClient } from './client.js';
import { deviceFingerprint } from './license.js';
import {
  classifyAuthFailure,
  classifyOtpVerifyFailure,
  type AuthCheck,
  type OtpVerifyFailure,
} from './auth-classify.js';
import { getDebugLogger } from '../debug/index.js';

export interface CommercialProfile {
  userId: string;
  email: string | null;
  phone: string | null;
  nickname: string | null;
  avatar: string | null;
}

export interface CommercialOrg {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: string;
}

export interface CommercialSessionState {
  signedIn: boolean;
  profile: CommercialProfile | null;
  orgs: CommercialOrg[];
}

function fail<T = unknown>(error: unknown, errorCode: string): IpcResult<T> {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: message, errorCode };
}

/**
 * Turns a Supabase auth error into a code the renderer can localise.
 *
 * The raw messages are English and, for SMS failures, misleading: Supabase's
 * Send SMS Hook collapses every non-2xx from the hook into a generic 500, so
 * an upstream 429 ("you are sending too fast") reaches us as
 * "Service currently unavailable due to hook". Classify by status first, then
 * fall back to matching the text.
 */
function classifyOtpError(error: unknown): string {
  const anyErr = error as { status?: number; code?: string; message?: string } | null;
  const status = typeof anyErr?.status === 'number' ? anyErr.status : undefined;
  const text = `${anyErr?.code ?? ''} ${anyErr?.message ?? ''}`.toLowerCase();

  if (status === 429 || text.includes('rate limit') || text.includes('too many')) {
    return 'otp_rate_limited';
  }
  if (status && status >= 500) {
    // Supabase surfaces hook failures as 5xx; the hook itself reports 429/503
    // for upstream throttling and quota exhaustion, which land here too.
    return text.includes('hook') ? 'otp_hook_failed' : 'otp_send_failed';
  }
  return 'otp_send_failed';
}

type CommercialClient = NonNullable<ReturnType<typeof getCommercialClient>>;

/**
 * Records this device against the org's licence, so the device list reflects
 * reality rather than only the machine that first typed the key.
 *
 * Deliberately fire-and-forget. Access is decided by ownership (`activated`
 * below), never by this call — if it fails, is rate-limited, or the server
 * declines, the user notices nothing. Its only job is to keep the anti-abuse
 * list current, and because activate_license bumps `last_seen_at`, a machine
 * that is actually used does not get evicted by one that is not.
 */
async function registerDevice(supabase: CommercialClient, licenseKey: string): Promise<void> {
  if (!licenseKey) return;
  try {
    await supabase.rpc('activate_license', {
      p_license_key: licenseKey,
      p_device_fingerprint: deviceFingerprint(),
    });
  } catch {
    // Intentionally swallowed — see above.
  }
}

const NETWORK_TIMEOUT_MS = 8000;

/** Accepts PromiseLike so Supabase's thenable query builders can be raced directly. */
function withTimeout<T>(work: PromiseLike<T>, fallback: T, label: string): Promise<T> {
  return Promise.race([
    Promise.resolve(work),
    new Promise<T>((resolve) =>
      setTimeout(() => {
        console.error(`[commercial] ${label} timed out after ${NETWORK_TIMEOUT_MS}ms`);
        resolve(fallback);
      }, NETWORK_TIMEOUT_MS),
    ),
  ]);
}

/**
 * Races a query against the network timeout, resolving to null on timeout.
 *
 * Returning a plain `null` (rather than a fabricated response) forces callers
 * to handle it explicitly — a timeout must never be mistaken for "this org has
 * no license".
 */
function withTimeoutOrNull<T>(work: PromiseLike<T>, label: string): Promise<T | null> {
  return Promise.race([
    Promise.resolve(work),
    new Promise<null>((resolve) =>
      setTimeout(() => {
        console.error(`[commercial] ${label} timed out after ${NETWORK_TIMEOUT_MS}ms`);
        resolve(null);
      }, NETWORK_TIMEOUT_MS),
    ),
  ]);
}

/**
 * 超时哨兵：`withTimeout` 的 fallback。
 *
 * ⚠️ 用**哨兵**而不是 `null`/`undefined`：`signInWithOtp` 的返回值是个对象、
 *    失败时也是对象，拿"空值"当超时只能靠猜；哨兵能一字不差地判等，
 *    而且不会跟"服务端真的回了错"混在一起。
 */
const OTP_TIMED_OUT = Symbol('otp-timeout');
type OtpTimeout = typeof OTP_TIMED_OUT;

/**
 * 超时时的**代用错误**：只为了让 `failOtp` 的日志与分类有东西可读。
 * `name=OtpTimeout` ⇒ `classifyOtpVerifyFailure` 判 `unreachable`（status 缺失），
 * 这正是我们要的：**问不出来**就绝不能说"你码错了"。
 */
const OTP_TIMEOUT_ERROR = {
  name: 'OtpTimeout',
  message: `otp request timed out after ${NETWORK_TIMEOUT_MS}ms`,
};

/**
 * 发验证码。
 *
 * ⚠️ **必须有 8 秒上限**（2026-09-20 复核点名）：这是"用户正盯着按钮转圈"的那条路，
 *    而同文件的探测早就走 `NETWORK_TIMEOUT_MS` —— 它原来**直接 await**，
 *    网络挂住时界面无限等待，用户既不知道在等什么、也没法重试。
 *    超时**不取消**底层请求（凭据可能已经发出去了），只是不再等它。
 */
export async function sendLoginOtp(target: string): Promise<IpcResult> {
  const supabase = getCommercialClient();
  if (!supabase) {
    return { ok: false, error: 'Commercial backend is not configured', errorCode: 'not_configured' };
  }
  const isEmail = target.includes('@');
  try {
    const raced = await withTimeout<{ error: unknown } | OtpTimeout>(
      (isEmail
        ? supabase.auth.signInWithOtp({ email: target })
        : supabase.auth.signInWithOtp({ phone: target })
      ).then((r) => ({ error: r.error as unknown })),
      OTP_TIMED_OUT,
      'otp.send',
    );
    if (raced === OTP_TIMED_OUT) {
      return { ok: false, error: OTP_TIMEOUT_ERROR.message, errorCode: 'otp_send_unreachable' };
    }
    if (raced.error) return fail(raced.error, classifyOtpError(raced.error));
    return { ok: true, result: { target, channel: isEmail ? 'email' : 'phone' } };
  } catch (error) {
    return fail(error, 'otp_send_failed');
  }
}

/**
 * 校验失败的出口码。**四档**，界面据此说不同的话（见 `classifyOtpVerifyFailure`）。
 *
 * ⚠️ `timedOut` 单列 `otp_verify_timeout`（而不是并进 `otp_verify_unreachable`）：
 *    复核口径要求"验证超过 8 秒 ⇒ 说『验证请求超时，请重试』"。
 *    **但两档的文案都必须带上"验证码是一次性的、请重新发送"** —— 那次超时的请求
 *    可能已经服务端消费掉了码，只让人"重试"会把他推回 09-17 那个死循环
 *    （拿同一个码反复试、次次报"验证码不正确"）。
 */
function otpVerifyErrorCode(kind: OtpVerifyFailure, timedOut: boolean): string {
  if (timedOut) return 'otp_verify_timeout';
  if (kind === 'unreachable') return 'otp_verify_unreachable';
  if (kind === 'too-many') return 'otp_verify_too_many';
  return 'otp_verify_failed';
}

/**
 * 验证码校验失败的出口。
 *
 * ⚠️ 必须**留痕**：原先这里只是 `return fail(...)`，实机出现"收到验证码却登不上"时
 *    日志里一个字都没有，只能靠猜。只记错误类名/状态码/错误码 ——
 *    **不记手机号、不记验证码**。
 */
function failOtp(error: unknown, where: string, timedOut = false): IpcResult {
  const kind = classifyOtpVerifyFailure(error);
  const e = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown };
  console.error(
    `[commercial] otp.verify.failed kind=${kind} where=${where} timedOut=${timedOut} ` +
      `name=${String(e?.name ?? '')} status=${String(e?.status ?? '')} code=${String(e?.code ?? '')}`,
  );
  return {
    ok: false,
    error: e?.message ? String(e.message) : kind,
    errorCode: otpVerifyErrorCode(kind, timedOut),
  };
}

/**
 * 校验验证码。
 *
 * ⚠️ 与发送同理，**必须有 8 秒上限**：这里挂住时用户看到的是"输入了吗？是不是我打错了？"
 *    的空白等待。超时走 `otp_verify_timeout` ⇒ 界面说「验证请求超时，请重试」
 *    + 一次性提醒，**绝不说"验证码错误"**。
 */
export async function verifyLoginOtp(target: string, token: string): Promise<IpcResult> {
  const supabase = getCommercialClient();
  if (!supabase) {
    return { ok: false, error: 'Commercial backend is not configured', errorCode: 'not_configured' };
  }
  const isEmail = target.includes('@');
  const where = isEmail ? 'email' : 'sms';
  try {
    const raced = await withTimeout<{ data: { user: { id?: string } | null }; error: unknown } | OtpTimeout>(
      (isEmail
        ? supabase.auth.verifyOtp({ email: target, token, type: 'email' })
        : supabase.auth.verifyOtp({ phone: target, token, type: 'sms' })
      ).then((r) => ({
        data: r.data as { user: { id?: string } | null },
        error: r.error as unknown,
      })),
      OTP_TIMED_OUT,
      'otp.verify',
    );
    if (raced === OTP_TIMED_OUT) return failOtp(OTP_TIMEOUT_ERROR, where, true);
    if (raced.error) return failOtp(raced.error, where);
    return { ok: true, result: { userId: raced.data.user?.id ?? null } };
  } catch (error) {
    return failOtp(error, where);
  }
}

export async function signInWithPassword(email: string, password: string): Promise<IpcResult> {
  const supabase = getCommercialClient();
  if (!supabase) {
    return { ok: false, error: 'Commercial backend is not configured', errorCode: 'not_configured' };
  }
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return fail(error, 'sign_in_failed');
    return { ok: true, result: { userId: data.user?.id ?? null } };
  } catch (error) {
    return fail(error, 'sign_in_failed');
  }
}

export async function signOutCommercial(): Promise<IpcResult> {
  const supabase = getCommercialClient();
  if (!supabase) return { ok: true };
  try {
    await supabase.auth.signOut();
    resetCommercialClient();
    return { ok: true };
  } catch (error) {
    return fail(error, 'sign_out_failed');
  }
}

/**
 * 探测结果的诊断日志。
 *
 * ⚠️ 只记**分类依据**（错误类名 / status / code / 耗时），**不记任何 token**。
 * 没有它就只能看到一句 `auth-transient-failure`，完全不知道是"超时"还是
 * "fetch 直接失败"——2026-09-13 排查时就卡在这一步。
 */
function logProbe(verdict: AuthCheck | 'timeout', elapsedMs: number, error?: unknown): void {
  const e = error as { name?: unknown; status?: unknown; code?: unknown } | undefined;
  getDebugLogger().info({
    domain: 'commercial',
    event: 'commercial.auth.probe',
    data: {
      verdict,
      elapsedMs,
      ...(e ? { errorName: String(e.name ?? ''), errorStatus: e.status ?? null, errorCode: e.code ?? null } : {}),
    },
  });
}

/**
 * 只回答一个问题：**这个会话现在有没有效**。三态，不是布尔。
 *
 * 为什么不复用 `readSessionState`：那个函数存在的意义是给界面一份**完整快照**
 * （profile + orgs），失败一律塌缩成 `{signedIn:false}`——它区分不了
 * 「401」和「8 秒超时」。而启动路径**必须**分清：前者要把用户当未登录，
 * 后者只是暂时问不出来、应该重试（见 auth-classify.ts 的实测依据）。
 *
 * ⚠️ 超时**不取消**底层请求，只是不再等它 —— 每次探测仍然只发一次 `getUser()`，
 * 重试次数由调用方（bootstrapCommercialRelay）有界控制，不会打爆服务端。
 */
export async function probeAuth(): Promise<AuthCheck> {
  const supabase = getCommercialClient();
  // 没有商业层客户端不在本函数的语义里（调用方先看 hasCommercialClient）。
  // 真走到这儿只能保守当成"没登录"，反正 `relay.bootstrap` 会先短路。
  if (!supabase) return 'unauthenticated';

  const startedAt = Date.now();
  const timedOut = Symbol('auth-probe-timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raced: { user: unknown; error: unknown } | typeof timedOut;
  try {
    raced = await Promise.race([
      supabase.auth
        .getUser()
        .then((r) => ({ user: r.data.user as unknown, error: r.error as unknown }))
        // supabase-js 多数时候把网络失败放进 `error`，但也会直接抛 —— 两条都收。
        .catch((error: unknown) => ({ user: null as unknown, error })),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), NETWORK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const elapsedMs = Date.now() - startedAt;
  if (raced === timedOut) {
    logProbe('timeout', elapsedMs);
    return 'transient';
  }
  if (raced.error) {
    const verdict = classifyAuthFailure(raced.error);
    logProbe(verdict, elapsedMs, raced.error);
    return verdict;
  }
  const verdict: AuthCheck = raced.user ? 'authenticated' : 'unauthenticated';
  logProbe(verdict, elapsedMs);
  return verdict;
}

export async function readSessionState(): Promise<IpcResult<CommercialSessionState>> {
  const empty: CommercialSessionState = { signedIn: false, profile: null, orgs: [] };
  const supabase = getCommercialClient();
  if (!supabase) return { ok: true, result: empty };

  try {
    const authResult = await withTimeout(
      supabase.auth
        .getUser()
        .then((r) => ({ user: r.data.user, error: r.error }))
        .catch(() => null),
      null,
      'auth.getUser',
    );
    if (!authResult || authResult.error || !authResult.user) {
      return { ok: true, result: empty };
    }

    const user = authResult.user;
    // ⚠️ 这条查询**原来没有超时** —— 它一挂住，整个 `readSessionState` 就永不 resolve。
    //    今天这个洞被界面那侧"5 秒改判未登录"盖着；B7 改成"本地有会话就继续等真答案"
    //    之后它就会露出来（界面永远停在加载页）⇒ 必须补上。
    //    超时后仍然报 `signedIn: true`：登录已被 `getUser()` 确认过，只是团队没读出来 ——
    //    说成"未登录"会把已登录的人扔回登录页，那是另一种撒谎。
    const membershipsResult = await withTimeoutOrNull(
      supabase.from('org_members').select('role, organizations(id, name, slug, plan)'),
      'org_members.select',
    );
    const memberships = membershipsResult?.data;

    const orgs: CommercialOrg[] = [];
    for (const row of memberships ?? []) {
      const org = row.organizations as unknown as {
        id: string;
        name: string;
        slug: string;
        plan: string;
      } | null;
      if (!org) continue;
      orgs.push({
        id: org.id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        role: String(row.role ?? 'member'),
      });
    }

    return {
      ok: true,
      result: {
        signedIn: true,
        profile: {
          userId: user.id,
          email: user.email ?? null,
          phone: user.phone ?? null,
          nickname: (user.user_metadata?.nickname as string | undefined) ?? null,
          avatar: (user.user_metadata?.avatar as string | undefined) ?? null,
        },
        orgs,
      },
    };
  } catch (error) {
    return fail(error, 'session_read_failed');
  }
}

/** Shorten a fingerprint for display: first 8 and last 4 hex chars. */
function shortenFingerprint(fingerprint: string): string {
  if (fingerprint.length <= 16) return fingerprint;
  return `${fingerprint.slice(0, 8)}…${fingerprint.slice(-4)}`;
}

/**
 * Reads the Account panel's entire snapshot in one round-trip.
 *
 * License is resolved from the user's active org rather than from the locally
 * stored license key: activation happens on one device, but the plan and quota
 * belong to the org and must show on every device the user signs in on.
 */
export async function readAccountOverview(): Promise<IpcResult<CommercialAccountOverview>> {
  const supabase = getCommercialClient();
  if (!supabase) {
    return { ok: false, error: 'Commercial backend is not configured', errorCode: 'not_configured' };
  }

  const fingerprint = deviceFingerprint();
  const device = { fingerprint, shortFingerprint: shortenFingerprint(fingerprint) };

  try {
    const sessionResult = await readSessionState();
    if (!sessionResult.ok) return fail(sessionResult.error, sessionResult.errorCode ?? 'session_read_failed');

    const session = sessionResult.result;
    if (!session?.signedIn || !session.profile) {
      return { ok: false, error: 'Not signed in', errorCode: 'not_signed_in' };
    }

    const org = session.orgs[0] ?? null;

    let license: CommercialLicenseSummary | null = null;
    if (org) {
      // Reads the org's *active* licence through the view, not the table.
      //
      // Two reasons, both of which used to bite:
      //   1. An org can hold more than one licence (two U-disks bound to the
      //      same account). Selecting from the table by org_id then returned
      //      several rows, and `.maybeSingle()` turned that into PGRST116 —
      //      the whole panel failed to load, and because the quota gate reads
      //      the same snapshot it silently fell back to "unlimited".
      //   2. Which licence to show is not an arbitrary choice: the server
      //      charges the one with the most remaining balance (see
      //      org_active_license). Showing a different card's balance would
      //      mean the number on screen is not the number being spent.
      const licenseResponse = await withTimeoutOrNull(
        supabase
          .from('org_active_license')
          .select('id, license_key, sku, status, expires_at, token_quota_micros, token_used_micros')
          .eq('org_id', org.id)
          .maybeSingle(),
        'licenses.read',
      );

      if (!licenseResponse) {
        return { ok: false, error: 'License lookup timed out', errorCode: 'license_read_timeout' };
      }
      if (licenseResponse.error) return fail(licenseResponse.error, 'license_read_failed');

      const row = licenseResponse.data;
      if (row) {
        license = {
          // The licence is visible through RLS, which means it belongs to one of
          // this user's orgs — that is what ownership means, and it is what the
          // UI should report. Previously this also required a non-revoked device
          // row for *this* machine, which locked people out after a reinstall
          // while gating nothing (see migration 20260911000008).
          activated: true,
          licenseKey: (row.license_key as string) ?? null,
          sku: (row.sku as string) ?? null,
          status: (row.status as string) ?? null,
          expiresAt: (row.expires_at as string) ?? null,
          tokenQuotaMicros: Number(row.token_quota_micros ?? 0),
          tokenUsedMicros: Number(row.token_used_micros ?? 0),
        };

        void registerDevice(supabase, String(row.license_key ?? ''));
      }
    }

    return {
      ok: true,
      result: {
        account: session.profile,
        org,
        license,
        device,
        fetchedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return fail(error, 'account_overview_failed');
  }
}
