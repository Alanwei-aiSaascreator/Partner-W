import { app, ipcMain } from 'electron';
import {
  relayBootstrapPublicStateStore,
  relayLivenessPublicStateStore,
  resetRelayBootstrapPublicState,
  resolveCommercialCredentials,
} from '@clawwork/shared';
import { readConfig, updateConfig } from '../workspace/config.js';
import { clearCommercialSession, hasLocalSession, resetCommercialClient } from '../commercial/client.js';
import {
  readAccountOverview,
  readQuotaSnapshot,
  readSessionState,
  sendLoginOtp,
  signOutCommercial,
  signInWithPassword,
  verifyLoginOtp,
} from '../commercial/auth.js';
import {
  activateLicense,
  clearLicense,
  deviceFingerprint,
  readLicenseStatus,
  recoverLicenseActivation,
} from '../commercial/license.js';
import { trackOnSuccess } from '../analytics/reporter.js';
import {
  notifyCommercialActivated,
  notifyCommercialSignedIn,
  retryCommercialRelayBootstrap,
} from '../commercial/relay-startup.js';
import { probeRelayLivenessNow } from '../commercial/relay-liveness.js';
import { resyncMemoryOnAccountBoundary } from '../memory/account-switch.js';
import { buildCommercialAccessCleanupDeps, requestCommercialAccessCleanup } from '../commercial/relay-cleanup.js';
import { runUsageReport } from '../commercial/usage-reporter.js';
import {
  createCustomRechargeOrder,
  createRechargeOrder,
  readRechargeOrder,
  readRechargeSkus,
} from '../commercial/payment.js';
import { clearProviderBillingCooldowns, resolveCooldownStateDirs } from '../commercial/auth-cooldown.js';

/**
 * 换卡/恢复授权成功后：清掉内核的**计费冷却**（BUG-161，2026-10-18 实机）。
 *
 * 旧卡欠费时网关会给 `clawrouter` 打 10 分钟 `billing` 冷却，且**按 provider 记、
 * 持久化在 agent 库里**（换卡、重启都清不掉）。用户充完钱还得干等 10 分钟，
 * 这是最伤的场景。这里：
 *   ① 清 DB 里 `inline-api-key:clawrouter` 这一条；
 *   ② 只有真的清到了东西才重启本机网关 —— 内核在 worker 里缓存了这份 store，
 *      不重启就不会重新读盘。
 *
 * ⚠️ 全程 fire-and-forget、不抛：激活结果绝不能因为收尾动作失败而变红。
 * ⚠️ 动态 import：`runtime/index` 会拉进 ws 客户端与大量运行时代码，静态引入会破坏
 *    本档测试的模块隔離（见 BUG-127 第三次）。
 */
function clearBillingCooldownAfterLicenseChange(): void {
  void (async () => {
    try {
      const stateDirs = resolveCooldownStateDirs(app.getPath('userData'), process.env.OPENCLAW_STATE_DIR);
      const result = clearProviderBillingCooldowns({ stateDirs });
      if (result.cleared === 0) return;
      const { restartLocalGatewayRuntime } = await import('../runtime/index.js');
      const restarted = await restartLocalGatewayRuntime();
      if (!restarted?.ok) return;
      const { reconnectGateway } = await import('../ws/index.js');
      reconnectGateway('local-runtime');
      // 重启会让 relay 配置重新走一遍写入校验；显式排一次 relay bootstrap，
      // 避免"网关回来了、模型却没配上"的中间态。
      retryCommercialRelayBootstrap();
    } catch {
      // 收尾动作：失败不回传、不打断激活。
    }
  })();
}

export function registerCommercialHandlers(): void {
  ipcMain.handle('commercial:get-config', () => {
    const config = readConfig()?.commercial;
    // 读取期兜底：干净机器上 `commercial` 段是空的，这里必须回落到随包下发的
    // 生产默认值 —— 渲染层**只凭这个返回值**决定进不进登录页（App.tsx 里
    // `Boolean(supabaseUrl && hasAnonKey)`），返回空就等于屏幕上没有登录页。
    // 见 `@clawwork/shared` 的 resolveCommercialCredentials / P0 事故记录。
    const { supabaseUrl, supabaseAnonKey } = resolveCommercialCredentials(config);
    return {
      ok: true,
      result: {
        supabaseUrl,
        hasAnonKey: Boolean(supabaseAnonKey),
        licenseKey: config?.licenseKey ?? '',
      },
    };
  });

  ipcMain.handle('commercial:set-config', (_event, payload: { supabaseUrl?: string; supabaseAnonKey?: string }) => {
    const current = readConfig()?.commercial ?? { supabaseUrl: '', supabaseAnonKey: '' };
    updateConfig({
      commercial: {
        ...current,
        // 空串 = **不改动**（两个字段一致）。这里是唯一会写凭据的 IPC：留一个
        // "清得掉 url、清不掉 key"的口子，就会造出"用户 URL + 生产 key"这种
        // 必坏、且报错读不出原因的半配置（与刚修的 P0 同一类症状）。
        supabaseUrl: payload.supabaseUrl?.trim() || current.supabaseUrl,
        supabaseAnonKey: payload.supabaseAnonKey?.trim() || current.supabaseAnonKey,
      },
    });
    resetCommercialClient();
    return { ok: true };
  });

  ipcMain.handle('commercial:send-otp', (_event, target: string) => sendLoginOtp(String(target ?? '')));
  ipcMain.handle('commercial:verify-otp', async (_event, target: string, token: string) => {
    const res = await verifyLoginOtp(String(target ?? ''), String(token ?? ''));
    // ⚠️ 事件要在**清理之前**记：`requestCommercialAccessCleanup` 一旦抛错，
    //    这一句之后的代码全都不执行 —— 服务端登录其实成功了，`login_success` 却是 0。
    const tracked = trackOnSuccess(res, 'login_success');
    // ⭐ 「登录成功」是一次**状态转变**（signed-out → signed-in）。
    //    启动那次 bootstrap 早在"没登录"上收场了，而明确没登录按设计不重试 ——
    //    所以这里必须再调度一次，否则用户不重启客户端就看不到模型（Stage 2C）。
    if (res.ok) {
      // 每次交互式登录都是**账户边界**：上一个账号的公开状态（可能正挂着
      // `license_bound_elsewhere`）对新账号不成立 ⇒ 先清掉。
      // ⚠️ 必须放在清理**之前**：`requestCommercialAccessCleanup` 会抛（它自己去碰网关），
      //    而"换账号了"这件事已经成立 —— 旧账号的结论不该因为清理失败而留在界面上。
      resetRelayBootstrapPublicState();
      clearLicense();
      // ⭐ BUG-133：`clearLicense` 之后归属已变匿名 —— 立刻重投影 `MEMORY.md`，
      //    否则上一个账号的已确认记忆会随共享文件留到下一轮提示词里。
      //    刻意放在清理**之前**：清理一旦抛错（它自己去碰网关），"换账号了"仍成立，
      //    上一账号的记忆不该因为清理失败而继续被读到。
      await resyncMemoryOnAccountBoundary();
      // 即使没有先点退出，也不能沿用旧账号的 relay。
      await requestCommercialAccessCleanup(buildCommercialAccessCleanupDeps());
      notifyCommercialSignedIn();
    }
    return tracked;
  });
  ipcMain.handle('commercial:sign-in-password', async (_event, email: string, password: string) => {
    const res = await signInWithPassword(String(email ?? ''), String(password ?? ''));
    const tracked = trackOnSuccess(res, 'login_success'); // 同上：先记事件，再跑清理
    if (res.ok) {
      resetRelayBootstrapPublicState(); // 同上：账户边界，先作废旧账号的公开状态
      clearLicense();
      // ⭐ BUG-133：同上 —— 归属变匿名后立刻重投影，别把上一账号的记忆留给下一轮。
      await resyncMemoryOnAccountBoundary();
      await requestCommercialAccessCleanup(buildCommercialAccessCleanupDeps());
      notifyCommercialSignedIn();
    }
    return tracked;
  });
  ipcMain.handle('commercial:sign-out', async () => {
    // 同步作废所有在途的 license 读取/激活，再开始可能很慢的网关清理。
    // 否则旧账号的慢读取可能在 cleanup 清空本地绑定后把它重新写回来。
    clearLicense();
    try {
      await requestCommercialAccessCleanup(buildCommercialAccessCleanupDeps());
      return await signOutCommercial();
    } finally {
      clearCommercialSession();
      // 公开状态属于**当前账号**，登出即作废。⚠️ 必须在 `finally` 里：上面那句清理
      // 一旦抛错，写在 try 里的重置就永远不会执行，而用户已经登出了 —— 旧账号的
      // `blocked` 会留给下一个登录的人看。
      resetRelayBootstrapPublicState();
      // ⭐ BUG-133：登出也是账户边界 —— 归属已在开头 `clearLicense` 时变匿名，
      //    这里把 `MEMORY.md` 重投影一次（清空受管区块），否则旧账号的已确认记忆
      //    会随共享文件留到下一个登录的人那一轮提示词里。放 `finally` 保证清理抛错也照做。
      await resyncMemoryOnAccountBoundary();
    }
  });
  ipcMain.handle('commercial:session', () => readSessionState());
  /**
   * **本地快速态**（B7）：本地存着一个会话吗。**不发网络、同步**。
   *
   * 与 `commercial:session` 的分工（别把两者搞混）：
   * - 这个只回答"本地有没有 token" —— 用来决定**网络慢时兜底该怎么判**；
   * - `commercial:session` 才是"到底登没登录"的**唯一**来源，它照旧发网络。
   *
   * ⇒ 渲染层**不得**拿它的 `true` 直接进工作区（那是"本地有 token 即已登录"）。
   */
  ipcMain.handle('commercial:local-session', () => ({ ok: true, result: hasLocalSession() }));
  ipcMain.handle('commercial:account-overview', () => readAccountOverview());
  /**
   * 轻量只读额度通道（BUG-082）：**无写副作用**，供消费中的余额刷新使用。
   * 与 `commercial:account-overview` 同一套 user/org/license 校验，只是不带
   * profile/设备指纹、不登记设备 —— 所以它可以被每几秒调一次。
   */
  ipcMain.handle('commercial:quota-snapshot', () => readQuotaSnapshot());

  ipcMain.handle('commercial:license-status', () => readLicenseStatus());
  ipcMain.handle('commercial:license-activate', async (_event, licenseKey: string) => {
    const res = await activateLicense(String(licenseKey ?? ''));
    // ⭐ 激活和登录一样是一次**状态转变**，而激活那一刻网关常常还没连上：
    //    `activateLicense` 里的 `configureRelay` 遇到没网关只记一条
    //    `relay.config-no-gateway` 就放弃，**没有第二道保险**。
    //    这里补跑一次（调度器会等网关连上，最长 240 秒）。
    // ⚠️ 与登录不同：**不做**账户清理 —— 那会把刚激活的 license 清掉。
    if (res.ok) notifyCommercialActivated();
    // ⭐ BUG-133：激活成功后授权绑定已落盘（`activateLicense` 内部 persist），归属
    //    已是**这张卡的主人** —— 重投影一次，助手才读得到新账号自己的那批记忆。
    if (res.ok) await resyncMemoryOnAccountBoundary();
    // BUG-161：旧卡欠费留下的 10 分钟计费冷却必须随换卡清掉（否则充完钱还要干等）。
    if (res.ok) clearBillingCooldownAfterLicenseChange();
    return trackOnSuccess(res, 'license_activated');
  });
  ipcMain.handle('commercial:license-recover-activation', async (_event, licenseKey: string) => {
    const res = await recoverLicenseActivation(String(licenseKey ?? ''));
    if (res.ok) notifyCommercialActivated();
    if (res.ok) await resyncMemoryOnAccountBoundary(); // BUG-133：同上（恢复授权也是账户边界）
    if (res.ok) clearBillingCooldownAfterLicenseChange(); // BUG-161
    return res;
  });
  ipcMain.handle('commercial:license-clear', async () => {
    const res = clearLicense();
    // ⭐ BUG-133：清卡 = 归属变匿名 —— 同步清掉受管区块，别把这张卡的记忆留给下一张卡。
    await resyncMemoryOnAccountBoundary();
    return res;
  });
  ipcMain.handle('commercial:device-fingerprint', () => deviceFingerprint());

  // 手动触发一次上报，返回本次是否产生了可用结果（0 表示无可报内容/失败）。
  // 定时器那套是兜底，这个入口给「刚花完额度、要立刻刷新顶栏」之类的场景用。
  ipcMain.handle('commercial:usage-report', () => runUsageReport());

  /**
   * 中转 bootstrap 的**公开状态快照**（渲染层挂载时补读一次）。
   *
   * ## 为什么必须有这条读（2026-09-21 实机：第二台机器一直"正在准备模型"）
   *
   * bootstrap 在 `app.whenReady()` 里就跑了一轮，而窗口与渲染层是**之后**才挂上来的
   * —— 那之前发出的状态事件没人收（没有窗口时 `sendToWindow` 直接返回 false）。
   * 少了这条读，渲染层就永远不知道主进程手里其实已经有
   * `license_bound_elsewhere` 了。事件只覆盖"挂上之后"的转变。
   *
   * ⚠️ 返回的就是那份**无密**的公开状态（`@clawwork/shared` 的 DTO）：只有
   *    `phase` / `errorCode` / `updatedAt`，没有 `detail`、没有原始 message、
   *    没有卡密 / relay key / token。
   */
  ipcMain.handle('commercial:relay-bootstrap-state', () => ({
    ok: true,
    result: relayBootstrapPublicStateStore.get(),
  }));

  /**
   * 「手动重试」：**立刻**回一个确认，真正的进度跟公开状态事件走。
   *
   * ⚠️ 绝不要 await 它 —— 一轮最长 240 秒（等网关 + 有界退避 + 取 key），把 IPC
   *    挂住等于把渲染层的按钮按住不放。单飞调度器保证重复点击不会开出第二条链。
   */
  ipcMain.handle('commercial:relay-bootstrap-retry', () => {
    retryCommercialRelayBootstrap();
    return { ok: true };
  });

  /**
   * relay **运行期存活**的快照（初读）与手动探（[立即重试]）。
   * 与 bootstrap 那对的分工相同：事件只覆盖"挂上之后"，初读补"挂上之前"。
   */
  ipcMain.handle('commercial:relay-liveness-state', () => ({
    ok: true,
    result: relayLivenessPublicStateStore.get(),
  }));
  ipcMain.handle('commercial:relay-liveness-probe', () => {
    probeRelayLivenessNow();
    return { ok: true };
  });

  ipcMain.handle('commercial:recharge-skus', () => readRechargeSkus());
  ipcMain.handle('commercial:recharge-create', (_event, sku: string) => createRechargeOrder(String(sku ?? '')));
  // 自定义金额，单位分。范围在 RPC 里还会再校验一次；这里先挡掉非数字，
  // 避免 NaN 一路传到数据库。
  ipcMain.handle('commercial:recharge-create-custom', (_event, amountCents: number) =>
    createCustomRechargeOrder(Number(amountCents)),
  );
  ipcMain.handle('commercial:recharge-order', (_event, orderNo: string) => readRechargeOrder(String(orderNo ?? '')));
}
