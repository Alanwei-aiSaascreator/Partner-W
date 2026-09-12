import type { CommercialAccountOverview, CommercialLicenseSummary, IpcResult } from '@clawwork/shared';
import { getCommercialClient, resetCommercialClient } from './client.js';
import { deviceFingerprint } from './license.js';

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

export async function sendLoginOtp(target: string): Promise<IpcResult> {
  const supabase = getCommercialClient();
  if (!supabase) {
    return { ok: false, error: 'Commercial backend is not configured', errorCode: 'not_configured' };
  }
  const isEmail = target.includes('@');
  try {
    const { error } = isEmail
      ? await supabase.auth.signInWithOtp({ email: target })
      : await supabase.auth.signInWithOtp({ phone: target });
    if (error) return fail(error, classifyOtpError(error));
    return { ok: true, result: { target, channel: isEmail ? 'email' : 'phone' } };
  } catch (error) {
    return fail(error, 'otp_send_failed');
  }
}

export async function verifyLoginOtp(target: string, token: string): Promise<IpcResult> {
  const supabase = getCommercialClient();
  if (!supabase) {
    return { ok: false, error: 'Commercial backend is not configured', errorCode: 'not_configured' };
  }
  const isEmail = target.includes('@');
  try {
    const { data, error } = isEmail
      ? await supabase.auth.verifyOtp({ email: target, token, type: 'email' })
      : await supabase.auth.verifyOtp({ phone: target, token, type: 'sms' });
    if (error) return fail(error, 'otp_verify_failed');
    return { ok: true, result: { userId: data.user?.id ?? null } };
  } catch (error) {
    return fail(error, 'otp_verify_failed');
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
    const { data: memberships } = await supabase
      .from('org_members')
      .select('role, organizations(id, name, slug, plan)');

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
