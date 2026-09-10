import type { IpcResult } from '@clawwork/shared';
import { getCommercialClient, resetCommercialClient } from './client.js';

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
    if (error) return fail(error, 'otp_send_failed');
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
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return { ok: true, result: empty };

    const user = data.user;
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
