import { hostname, arch, platform } from 'node:os';
import { createHash } from 'node:crypto';
import type { IpcResult } from '@clawwork/shared';
import { getCommercialClient } from './client.js';
import { ensureDeviceId, readConfig, updateConfig } from '../workspace/config.js';

export interface LicenseStatus {
  configured: boolean;
  licenseKey: string | null;
  sku: string | null;
  status: string | null;
  expiresAt: string | null;
  maxActivations: number;
  tokenQuotaCents: number;
  tokenUsedCents: number;
  activated: boolean;
  deviceFingerprint: string;
}

type CommercialClient = NonNullable<ReturnType<typeof getCommercialClient>>;

function fail<T = unknown>(error: unknown, errorCode: string): IpcResult<T> {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: message, errorCode };
}

export function deviceFingerprint(): string {
  const stableId = ensureDeviceId();
  const material = [stableId, hostname(), platform(), arch()].join('|');
  return createHash('sha256').update(material).digest('hex');
}

function readStoredLicenseKey(): string | null {
  const key = readConfig()?.commercial?.licenseKey ?? '';
  return key || null;
}

// Both sources expose exactly these: the `licenses` table directly, and the
// `org_active_license` view (migration 20260911000008 added max_activations to it).
const LICENSE_FIELDS = 'license_key, sku, status, expires_at, max_activations, token_quota_cents, token_used_cents';

/**
 * The caller's owner org, chosen the same way the server chooses it
 * (`order by joined_at asc, org_id asc`) so both sides agree on which org a
 * user "is" when they happen to own several.
 */
async function firstOwnerOrg(supabase: CommercialClient): Promise<string | null> {
  const { data } = await supabase
    .from('org_members')
    .select('org_id, joined_at')
    .eq('role', 'owner')
    .order('joined_at', { ascending: true })
    .order('org_id', { ascending: true })
    .limit(1);
  return (data?.[0]?.org_id as string) ?? null;
}

export async function readLicenseStatus(): Promise<IpcResult<LicenseStatus>> {
  const fingerprint = deviceFingerprint();
  const storedKey = readStoredLicenseKey();
  const base: LicenseStatus = {
    configured: false,
    licenseKey: storedKey,
    sku: null,
    status: null,
    expiresAt: null,
    maxActivations: 0,
    tokenQuotaCents: 0,
    tokenUsedCents: 0,
    activated: false,
    deviceFingerprint: fingerprint,
  };

  const supabase = getCommercialClient();
  if (!supabase) return { ok: true, result: base };

  try {
    // Look the licence up by this machine's stored key first, then by account.
    //
    // The account lookup is what makes a new machine work. A fresh install has
    // no stored key, but the card belongs to the account — and *that*, not a
    // row in license_activations, is what "I own this" means. Gating on the
    // device row is what used to lock people out after a reinstall while
    // protecting nothing (see migration 20260911000008).
    let license = storedKey
      ? (
          await supabase
            .from('licenses')
            .select(LICENSE_FIELDS)
            .eq('license_key', storedKey)
            .maybeSingle()
        ).data
      : null;

    if (!license) {
      const org = await firstOwnerOrg(supabase);
      if (!org) return { ok: true, result: base };

      license = (
        await supabase
          .from('org_active_license')
          .select(LICENSE_FIELDS)
          .eq('org_id', org)
          .maybeSingle()
      ).data;

      // Remember it locally so the next launch takes the direct path.
      if (license?.license_key) {
        const current = readConfig()?.commercial ?? { supabaseUrl: '', supabaseAnonKey: '' };
        updateConfig({ commercial: { ...current, licenseKey: String(license.license_key) } });
      }
    }

    if (!license) return { ok: true, result: base };

    return {
      ok: true,
      result: {
        configured: true,
        licenseKey: (license.license_key as string) ?? null,
        sku: (license.sku as string) ?? null,
        status: (license.status as string) ?? null,
        expiresAt: (license.expires_at as string) ?? null,
        maxActivations: Number(license.max_activations ?? 0),
        tokenQuotaCents: Number(license.token_quota_cents ?? 0),
        tokenUsedCents: Number(license.token_used_cents ?? 0),
        // Ownership, not device registration. See the comment above.
        activated: true,
        deviceFingerprint: fingerprint,
      },
    };
  } catch (error) {
    return fail(error, 'license_read_failed');
  }
}

/**
 * Translates what activate_license() raised into a code the UI can localise.
 *
 * check_activation_limit() runs as a BEFORE INSERT trigger and raises
 * check_violation, so the activation limit is the one branch carrying a
 * SQLSTATE of its own (23514). Everything else shares P0001, which says nothing
 * about which check failed, so those still have to be told apart by the message
 * text the function emits.
 */
function mapActivationError(error: { code?: string; message?: string }): string {
  const sqlState = typeof error.code === 'string' ? error.code : '';
  const message = String(error.message ?? '');

  // The Chinese wording stays as a fallback: it is the only signal present when
  // an error reaches us without a code.
  if (sqlState === '23514' || message.includes('激活数已达上限')) return 'activation_limit_reached';

  if (sqlState === 'P0002') {
    // P0002 also covers "no organization for user", which is a broken account
    // rather than a bad key — don't tell the user their card number is wrong.
    return message.includes('organization') ? 'activation_failed' : 'license_not_found';
  }

  if (message.includes('not found')) return 'license_not_found';
  if (message.includes('expired')) return 'license_expired';
  if (message.includes('another organization')) return 'license_bound_elsewhere';
  // Suspended / revoked cards come back as "license is <status>".
  if (message.includes('license is ')) return 'license_inactive';
  return 'activation_failed';
}

export async function activateLicense(licenseKey: string): Promise<IpcResult<LicenseStatus>> {
  const supabase = getCommercialClient();
  if (!supabase) {
    return { ok: false, error: 'Commercial backend is not configured', errorCode: 'not_configured' };
  }

  const trimmed = licenseKey.trim();
  if (!trimmed) {
    return { ok: false, error: 'License key is empty', errorCode: 'empty_key' };
  }

  try {
    // Direct table access cannot work here: a freshly minted licence has a null
    // org_id, and the RLS policy is `org_id in (auth_org_ids())` — null matches
    // nothing, so the row is invisible to every user. The definer function does
    // the claim, the limit check and the activation row in one transaction.
    const { error } = await supabase.rpc('activate_license', {
      p_license_key: trimmed,
      p_device_fingerprint: deviceFingerprint(),
    });

    if (error) {
      return { ok: false, error: String(error.message ?? ''), errorCode: mapActivationError(error) };
    }

    updateConfig({ commercial: { ...readConfig()?.commercial, licenseKey: trimmed } as never });
    return readLicenseStatus();
  } catch (error) {
    return fail(error, 'activation_failed');
  }
}

export function clearLicense(): IpcResult {
  const current = readConfig()?.commercial;
  if (current) {
    updateConfig({ commercial: { ...current, licenseKey: undefined } });
  }
  return { ok: true };
}
