import { ipcMain } from 'electron';
import { readConfig, updateConfig } from '../workspace/config.js';
import { clearCommercialSession, resetCommercialClient } from '../commercial/client.js';
import {
  readAccountOverview,
  readSessionState,
  sendLoginOtp,
  signOutCommercial,
  signInWithPassword,
  verifyLoginOtp,
} from '../commercial/auth.js';
import { activateLicense, clearLicense, deviceFingerprint, readLicenseStatus } from '../commercial/license.js';
import { trackOnSuccess } from '../analytics/reporter.js';
import { notifyCommercialActivated, notifyCommercialSignedIn } from '../commercial/relay-startup.js';
import { buildCommercialAccessCleanupDeps, requestCommercialAccessCleanup } from '../commercial/relay-cleanup.js';
import { runUsageReport } from '../commercial/usage-reporter.js';
import {
  createCustomRechargeOrder,
  createRechargeOrder,
  readRechargeOrder,
  readRechargeSkus,
} from '../commercial/payment.js';

export function registerCommercialHandlers(): void {
  ipcMain.handle('commercial:get-config', () => {
    const config = readConfig()?.commercial;
    return {
      ok: true,
      result: {
        supabaseUrl: config?.supabaseUrl ?? '',
        hasAnonKey: Boolean(config?.supabaseAnonKey),
        licenseKey: config?.licenseKey ?? '',
      },
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
  ipcMain.handle('commercial:verify-otp', async (_event, target: string, token: string) => {
    const res = await verifyLoginOtp(String(target ?? ''), String(token ?? ''));
    // ⭐ 「登录成功」是一次**状态转变**（signed-out → signed-in）。
    //    启动那次 bootstrap 早在"没登录"上收场了，而明确没登录按设计不重试 ——
    //    所以这里必须再调度一次，否则用户不重启客户端就看不到模型（Stage 2C）。
    if (res.ok) {
      // 每次交互式登录都是账户边界：即使没有先点退出，也不能沿用旧账号的 relay。
      await requestCommercialAccessCleanup(buildCommercialAccessCleanupDeps());
      notifyCommercialSignedIn();
    }
    return trackOnSuccess(res, 'login_success');
  });
  ipcMain.handle('commercial:sign-in-password', async (_event, email: string, password: string) => {
    const res = await signInWithPassword(String(email ?? ''), String(password ?? ''));
    if (res.ok) {
      await requestCommercialAccessCleanup(buildCommercialAccessCleanupDeps());
      notifyCommercialSignedIn();
    }
    return trackOnSuccess(res, 'login_success');
  });
  ipcMain.handle('commercial:sign-out', async () => {
    try {
      await requestCommercialAccessCleanup(buildCommercialAccessCleanupDeps());
      return await signOutCommercial();
    } finally {
      clearCommercialSession();
    }
  });
  ipcMain.handle('commercial:session', () => readSessionState());
  ipcMain.handle('commercial:account-overview', () => readAccountOverview());

  ipcMain.handle('commercial:license-status', () => readLicenseStatus());
  ipcMain.handle('commercial:license-activate', async (_event, licenseKey: string) => {
    const res = await activateLicense(String(licenseKey ?? ''));
    // ⭐ 激活和登录一样是一次**状态转变**，而激活那一刻网关常常还没连上：
    //    `activateLicense` 里的 `configureRelay` 遇到没网关只记一条
    //    `relay.config-no-gateway` 就放弃，**没有第二道保险**。
    //    这里补跑一次（调度器会等网关连上，最长 240 秒）。
    // ⚠️ 与登录不同：**不做**账户清理 —— 那会把刚激活的 license 清掉。
    if (res.ok) notifyCommercialActivated();
    return trackOnSuccess(res, 'license_activated');
  });
  ipcMain.handle('commercial:license-clear', () => clearLicense());
  ipcMain.handle('commercial:device-fingerprint', () => deviceFingerprint());

  // 手动触发一次上报，返回本次是否产生了可用结果（0 表示无可报内容/失败）。
  // 定时器那套是兜底，这个入口给「刚花完额度、要立刻刷新顶栏」之类的场景用。
  ipcMain.handle('commercial:usage-report', () => runUsageReport());

  ipcMain.handle('commercial:recharge-skus', () => readRechargeSkus());
  ipcMain.handle('commercial:recharge-create', (_event, sku: string) => createRechargeOrder(String(sku ?? '')));
  // 自定义金额，单位分。范围在 RPC 里还会再校验一次；这里先挡掉非数字，
  // 避免 NaN 一路传到数据库。
  ipcMain.handle('commercial:recharge-create-custom', (_event, amountCents: number) =>
    createCustomRechargeOrder(Number(amountCents)),
  );
  ipcMain.handle('commercial:recharge-order', (_event, orderNo: string) => readRechargeOrder(String(orderNo ?? '')));
}
