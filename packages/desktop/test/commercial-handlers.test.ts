import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAnalyticsReporter,
  initAnalyticsReporterForTest,
  stopAnalyticsReporter,
  type AnalyticsReporter,
} from '../src/main/analytics/reporter.js';

/**
 * Stage 2C 的**接线**：两个登录入口成功后必须调度一次 relay bootstrap。
 *
 * ## 为什么单独钉这一条
 *
 * 2C 的功能全貌是：
 *
 *   commercial:send-otp → commercial:verify-otp → verifyLoginOtp()
 *   → **notifyCommercialSignedIn()** → bootstrapCommercialRelay() → relay applied
 *
 * 中间那一环只有两行 `if (res.ok) notifyCommercialSignedIn();`，但它**是**
 * 「登录成功后模型才出现」这句承诺的开关。单元测试能低成本钉死它：
 * 成功必须触发、**失败必须不触发**（否则用户打错一次验证码就会白跑一轮 bootstrap）。
 *
 * ⚠️ 这里刻意**不**调 `notifyCommercialSignedIn()` 的真身（那是 `relay-bootstrap.test.ts`
 * 里调度器的活），只钉"handler 有没有叫它"。
 */
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  verifyLoginOtp: vi.fn(),
  signInWithPassword: vi.fn(),
  signOutCommercial: vi.fn(),
  notifyCommercialSignedIn: vi.fn(),
  notifyCommercialActivated: vi.fn(),
  activateLicense: vi.fn(),
  requestCommercialAccessCleanup: vi.fn(),
  drainPendingCommercialAccessCleanup: vi.fn(),
  clearCommercialSession: vi.fn(),
  hasLocalSession: vi.fn(),
  readSessionState: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
  // 有些 handler 会顺带读配置（`readConfig` → `app.getPath('userData')`）。
  // 指到一个**不存在的**目录即可：读不到就是"没配置"，正是我们要的默认态。
  app: { getPath: () => 'C:\\clawwork-test-no-such-dir' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
}));

vi.mock('../src/main/commercial/auth.js', () => ({
  verifyLoginOtp: (...a: unknown[]) => mocks.verifyLoginOtp(...a),
  signInWithPassword: (...a: unknown[]) => mocks.signInWithPassword(...a),
  sendLoginOtp: vi.fn(),
  signOutCommercial: (...a: unknown[]) => mocks.signOutCommercial(...a),
  readSessionState: () => mocks.readSessionState(),
  readAccountOverview: vi.fn(),
}));

vi.mock('../src/main/commercial/client.js', () => ({
  clearCommercialSession: () => mocks.clearCommercialSession(),
  resetCommercialClient: vi.fn(),
  hasLocalSession: () => mocks.hasLocalSession(),
}));

vi.mock('../src/main/commercial/relay-cleanup.js', () => ({
  buildCommercialAccessCleanupDeps: () => ({}),
  requestCommercialAccessCleanup: () => mocks.requestCommercialAccessCleanup(),
  drainPendingCommercialAccessCleanup: () => mocks.drainPendingCommercialAccessCleanup(),
}));

vi.mock('../src/main/commercial/relay-startup.js', () => ({
  notifyCommercialSignedIn: () => mocks.notifyCommercialSignedIn(),
  notifyCommercialActivated: () => mocks.notifyCommercialActivated(),
}));

vi.mock('../src/main/commercial/license.js', () => ({
  activateLicense: (...a: unknown[]) => mocks.activateLicense(...a),
  clearLicense: vi.fn(),
  deviceFingerprint: () => 'fp-test',
  readLicenseStatus: vi.fn(),
}));

const { registerCommercialHandlers } = await import('../src/main/ipc/commercial-handlers.js');

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`没注册 ${channel}；已注册：${[...mocks.handlers.keys()].join(', ')}`);
  return fn;
}

// 埋点走真的 reporter 单例（同 context-handlers.test.ts 的写法）：
// 断言的是「handler 到底记了哪个事件」，mock 掉 trackEvent 就退化成看字符串了。
let analytics: AnalyticsReporter;

beforeEach(() => {
  analytics = createAnalyticsReporter({
    storage: { read: () => null, write: () => {} },
    send: vi.fn(async () => ({ ok: true, inserted: 0 })),
  });
  initAnalyticsReporterForTest(analytics);
});

afterEach(() => {
  stopAnalyticsReporter();
});

describe('登录入口 → notifyCommercialSignedIn（Stage 2C 接线）', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.verifyLoginOtp.mockReset();
    mocks.signInWithPassword.mockReset();
    mocks.signOutCommercial.mockReset();
    mocks.notifyCommercialSignedIn.mockReset();
    mocks.notifyCommercialActivated.mockReset();
    mocks.activateLicense.mockReset();
    mocks.requestCommercialAccessCleanup.mockReset();
    mocks.drainPendingCommercialAccessCleanup.mockReset();
    mocks.clearCommercialSession.mockReset();
    mocks.requestCommercialAccessCleanup.mockResolvedValue({ cleaned: true, pending: false });
    mocks.drainPendingCommercialAccessCleanup.mockResolvedValue({ cleaned: false, pending: false });
    mocks.signOutCommercial.mockResolvedValue({ ok: true });
    registerCommercialHandlers();
  });

  it('⭐ verifyOtp 成功 ⇒ 触发一次补跑，并把结果原样回给渲染层', async () => {
    mocks.verifyLoginOtp.mockResolvedValue({ ok: true, result: { userId: 'u-1' } });
    const res = (await handlerFor('commercial:verify-otp')({}, '+8613800000000', '123456')) as {
      ok: boolean;
      result?: { userId: string };
    };

    expect(res.ok).toBe(true);
    expect(res.result?.userId).toBe('u-1');
    expect(mocks.requestCommercialAccessCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.notifyCommercialSignedIn, '登录成功了却没补跑 ⇒ 用户得重启客户端才看得到模型').toHaveBeenCalledTimes(
      1,
    );
  });

  it('⭐ verifyOtp 失败 ⇒ **不**触发（打错一次验证码不该白跑一轮 bootstrap）', async () => {
    mocks.verifyLoginOtp.mockResolvedValue({ ok: false, error: 'bad code', errorCode: 'otp_verify_failed' });
    const res = (await handlerFor('commercial:verify-otp')({}, '+8613800000000', '000000')) as { ok: boolean };

    expect(res.ok).toBe(false);
    expect(mocks.notifyCommercialSignedIn).not.toHaveBeenCalled();
  });

  it('⭐ 密码登录成功 ⇒ 也触发（两条产品入口都覆盖）', async () => {
    mocks.signInWithPassword.mockResolvedValue({ ok: true, result: { userId: 'u-2' } });
    const res = (await handlerFor('commercial:sign-in-password')({}, 'a@b.test', 'pw')) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(mocks.requestCommercialAccessCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.notifyCommercialSignedIn).toHaveBeenCalledTimes(1);
  });

  it('⭐ 密码登录失败 ⇒ 不触发', async () => {
    mocks.signInWithPassword.mockResolvedValue({ ok: false, error: 'bad credentials', errorCode: 'sign_in_failed' });
    const res = (await handlerFor('commercial:sign-in-password')({}, 'a@b.test', 'wrong')) as { ok: boolean };

    expect(res.ok).toBe(false);
    expect(mocks.notifyCommercialSignedIn).not.toHaveBeenCalled();
  });

  it('★ 登录成功记一次 login_success（两个入口都记）；失败一条都不记', async () => {
    mocks.verifyLoginOtp.mockResolvedValue({ ok: true, result: { userId: 'u-1' } });
    await handlerFor('commercial:verify-otp')({}, '+8613800000000', '123456');
    expect(analytics.peek().map((e) => e.event)).toEqual(['login_success']);

    mocks.signInWithPassword.mockResolvedValue({ ok: true, result: { userId: 'u-2' } });
    await handlerFor('commercial:sign-in-password')({}, 'a@b.test', 'pw');
    expect(analytics.peek().map((e) => e.event)).toEqual(['login_success', 'login_success']);

    mocks.verifyLoginOtp.mockResolvedValue({ ok: false, errorCode: 'otp_verify_failed' });
    await handlerFor('commercial:verify-otp')({}, '+8613800000000', '000000');
    expect(analytics.peek().map((e) => e.event)).toEqual(['login_success', 'login_success']);
  });

  it('★ 登录成功但账户清理抛错：事件仍记下（清理失败不该把「登录成功了」吞掉）', async () => {
    mocks.verifyLoginOtp.mockResolvedValue({ ok: true, result: { userId: 'u-1' } });
    mocks.requestCommercialAccessCleanup.mockRejectedValue(new Error('cleanup down'));

    await expect(handlerFor('commercial:verify-otp')({}, '+8613800000000', '123456')).rejects.toThrow('cleanup down');
    expect(analytics.peek().map((e) => e.event)).toEqual(['login_success']);
  });

  it('⭐ `commercial:local-session` 走的是**本地**那条路（B7：它是"不发网络"的保证）', async () => {
    mocks.hasLocalSession.mockReturnValue(true);

    const result = (await handlerFor('commercial:local-session')({})) as { ok: boolean; result: boolean };

    expect(result).toEqual({ ok: true, result: true });
    expect(mocks.hasLocalSession, '必须委托给本地那条路，不许另外发一次网络').toHaveBeenCalledTimes(1);
    // ⚠️ 它**不是**会话结论 —— 读它不该触发任何"登录了"的副作用
    expect(mocks.notifyCommercialSignedIn).not.toHaveBeenCalled();
    expect(mocks.readSessionState).not.toHaveBeenCalled();
  });

  it('⭐ 只有**登录**入口会补跑：发验证码 / 读会话 / 登出都不该触发', async () => {
    await handlerFor('commercial:session')({});
    await handlerFor('commercial:get-config')({});
    expect(mocks.notifyCommercialSignedIn, '读一下会话就重跑 bootstrap 是不可接受的回归').not.toHaveBeenCalled();
  });

  it('⭐ 登出时即使远端失败，也先清除本地许可证和旧 relay', async () => {
    mocks.signOutCommercial.mockResolvedValue({ ok: false, error: 'network down' });

    const result = (await handlerFor('commercial:sign-out')({})) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(mocks.requestCommercialAccessCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.clearCommercialSession).toHaveBeenCalledTimes(1);
  });
});

/**
 * 激活入口的第二道保险（2026-09-17 实机 `relay.config-no-gateway`）。
 *
 * `activateLicense` 内部会顺手把中转配置写进网关，但**遇到网关没连上就放弃** ——
 * 只记一条 `relay.config-no-gateway` 日志、返回 false，没有任何重试。
 * 而激活那一刻恰恰是网关最可能还没起好的时候（全新环境、刚装完）。
 * 结果：卡激活了、额度到了、模型列表却是空的，用户以为激活失败。
 */
describe('激活入口 → 补跑 relay bootstrap（第二道保险）', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    // ⚠️ 必须**自己**重置：上一个 describe 的用例已经动过这些计数器
    mocks.notifyCommercialActivated.mockReset();
    mocks.activateLicense.mockReset();
    mocks.requestCommercialAccessCleanup.mockReset();
    mocks.notifyCommercialSignedIn.mockReset();
    registerCommercialHandlers();
  });

  it('⭐ 激活成功 ⇒ 补跑一次（否则用户得重启客户端才看得到模型）', async () => {
    mocks.activateLicense.mockResolvedValue({ ok: true, result: { activated: true } });

    const res = (await handlerFor('commercial:license-activate')({}, 'RY-AAAA-BBBB')) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(mocks.notifyCommercialActivated, '激活成功了却没补跑 ⇒ 网关没连上时中转永远落不下去').toHaveBeenCalledTimes(
      1,
    );
    // 激活**不是**账户边界：顺手做账户清理会把刚拿到的 license 清掉
    expect(mocks.requestCommercialAccessCleanup).not.toHaveBeenCalled();
  });

  it('激活失败 ⇒ 不补跑（卡密打错不该白跑一轮 bootstrap）', async () => {
    mocks.activateLicense.mockResolvedValue({ ok: false, error: '卡密无效', errorCode: 'invalid_license' });

    const res = (await handlerFor('commercial:license-activate')({}, 'BAD-KEY')) as { ok: boolean };

    expect(res.ok).toBe(false);
    expect(mocks.notifyCommercialActivated).not.toHaveBeenCalled();
  });

  it('★ 激活成功记一次 license_activated；失败不记', async () => {
    mocks.activateLicense.mockResolvedValue({ ok: true, result: { activated: true } });
    await handlerFor('commercial:license-activate')({}, 'RY-AAAA-BBBB');
    expect(analytics.peek().map((e) => e.event)).toEqual(['license_activated']);

    mocks.activateLicense.mockResolvedValue({ ok: false, errorCode: 'invalid_license' });
    await handlerFor('commercial:license-activate')({}, 'BAD-KEY');
    expect(analytics.peek().map((e) => e.event)).toEqual(['license_activated']);
  });
});
