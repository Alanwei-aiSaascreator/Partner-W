import { ipcMain } from 'electron';
import { readConfig, updateConfig } from '../workspace/config.js';
import { clearCommercialSession, resetCommercialClient } from '../commercial/client.js';
import {
  readSessionState,
  sendLoginOtp,
  signOutCommercial,
  signInWithPassword,
  verifyLoginOtp,
} from '../commercial/auth.js';
import { activateLicense, clearLicense, deviceFingerprint, readLicenseStatus } from '../commercial/license.js';

export function registerCommercialHandlers(): void {
  ipcMain.handle('commercial:get-config', () => {
    const config = readConfig()?.commercial;
    return {
      supabaseUrl: config?.supabaseUrl ?? '',
      hasAnonKey: Boolean(config?.supabaseAnonKey),
      licenseKey: config?.licenseKey ?? '',
    };
  });

  ipcMain.handle('commercial:set-config', (_event, payload: { supabaseUrl?: string; supabaseAnonKey?: string }) => {
    const current = readConfig()?.commercial ?? { supabaseUrl: '', supabaseAnonKey: '' };
    updateConfig({
      commercial: {
        ...current,
        supabaseUrl: payload.supabaseUrl?.trim() ?? current.supabaseUrl,
        supabaseAnonKey: payload.supabaseAnonKey?.trim() || current.supabaseAnonKey,
      },
    });
    resetCommercialClient();
    return { ok: true };
  });

  ipcMain.handle('commercial:send-otp', (_event, target: string) => sendLoginOtp(String(target ?? '')));
  ipcMain.handle('commercial:verify-otp', (_event, target: string, token: string) =>
    verifyLoginOtp(String(target ?? ''), String(token ?? '')),
  );
  ipcMain.handle('commercial:sign-in-password', (_event, email: string, password: string) =>
    signInWithPassword(String(email ?? ''), String(password ?? '')),
  );
  ipcMain.handle('commercial:sign-out', async () => {
    const result = await signOutCommercial();
    clearCommercialSession();
    return result;
  });
  ipcMain.handle('commercial:session', () => readSessionState());

  ipcMain.handle('commercial:license-status', () => readLicenseStatus());
  ipcMain.handle('commercial:license-activate', (_event, licenseKey: string) =>
    activateLicense(String(licenseKey ?? '')),
  );
  ipcMain.handle('commercial:license-clear', () => clearLicense());
  ipcMain.handle('commercial:device-fingerprint', () => deviceFingerprint());
}
