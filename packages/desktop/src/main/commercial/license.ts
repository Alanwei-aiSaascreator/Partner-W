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
  if (!supabase || !storedKey) return { ok: true, result: base };

  try {
    const { data: license, error } = await supabase
      .from('licenses')
      .select('id, license_key, sku, status, expires_at, max_activations, token_quota_cents, token_used_cents')
      .eq('license_key', storedKey)
      .maybeSingle();

    if (error) return fail(error, 'license_read_failed');
    if (!license) return { ok: true, result: base };

    const { data: activation } = await supabase
      .from('license_activations')
      .select('id, revoked_at')
      .eq('license_id', license.id)
      .eq('device_fingerprint', fingerprint)
      .maybeSingle();

    return {
      ok: true,
      result: {
        configured: true,
        licenseKey: license.license_key as string,
        sku: (license.sku as string) ?? null,
        status: (license.status as string) ?? null,
        expiresAt: (license.expires_at as string) ?? null,
        maxActivations: Number(license.max_activations ?? 0),
        tokenQuotaCents: Number(license.token_quota_cents ?? 0),
        tokenUsedCents: Number(license.token_used_cents ?? 0),
        activated: Boolean(activation && !activation.revoked_at),
        deviceFingerprint: fingerprint,
      },
    };
  } catch (error) {
    return fail(error, 'license_read_failed');
  }
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

  const fingerprint = deviceFingerprint();

  try {
    const { data: license, error: readError } = await supabase
      .from('licenses')
      .select('id, status, expires_at')
      .eq('license_key', trimmed)
      .maybeSingle();

    if (readError) return fail(readError, 'license_read_failed');
    if (!license) {
      return { ok: false, error: 'License key not found', errorCode: 'license_not_found' };
    }
    if (license.status !== 'active') {
      return { ok: false, error: `License is ${license.status}`, errorCode: 'license_inactive' };
    }
    if (license.expires_at && new Date(license.expires_at as string) < new Date()) {
      return { ok: false, error: 'License expired', errorCode: 'license_expired' };
    }

    const { error: insertError } = await supabase
      .from('license_activations')
      .upsert(
        { license_id: license.id, device_fingerprint: fingerprint, activated_at: new Date().toISOString() },
        { onConflict: 'license_id,device_fingerprint', ignoreDuplicates: true },
      );

    if (insertError) {
      const limitReached = String(insertError.message ?? '').includes('激活数已达上限');
      return {
        ok: false,
        error: insertError.message,
        errorCode: limitReached ? 'activation_limit_reached' : 'activation_failed',
      };
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
