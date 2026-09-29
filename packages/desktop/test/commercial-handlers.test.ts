import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAnalyticsReporter,
  initAnalyticsReporterForTest,
  stopAnalyticsReporter,
  type AnalyticsReporter,
} from '../src/main/analytics/reporter.js';
import {
  relayBootstrapPublicStateStore,
  resetRelayBootstrapPublicState,
  type RelayBootstrapPublicState,
} from '@clawwork/shared';

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
  retryCommercialRelayBootstrap: vi.fn(),
  activateLicense: vi.fn(),
  requestCommercialAccessCleanup: vi.fn(),
  drainPendingCommercialAccessCleanup: vi.fn(),
  clearLicense: vi.fn(),
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
  retryCommercialRelayBootstrap: () => mocks.retryCommercialRelayBootstrap(),
}));

vi.mock('../src/main/commercial/license.js', () => ({
  activateLicense: (...a: unknown[]) => mocks.activateLicense(...a),
  clearLicense: () => mocks.clearLicense(),
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
    mocks.clearLicense.mockReset();
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
    expect(mocks.clearLicense).toHaveBeenCalledTimes(1);
    expect(mocks.requestCommercialAccessCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.clearLicense.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requestCommercialAccessCleanup.mock.invocationCallOrder[0]!,
    );
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

/**
 * 中转 bootstrap 的公开状态：**读** / **手动重试** / 两个**账户边界**。
 *
 * ## 为什么"初始读"必须存在（2026-09-21 实机）
 *
 * bootstrap 在 `app.whenReady()` 里就跑了一轮（登录、激活、重试各自还会再跑），
 * 而窗口与渲染层是**之后**才挂上来的 —— 那之前发出的状态事件没人收
 * （`sendToWindow` 在窗口还没建时直接返回 false）。少了这条读，渲染层就会一直
 * 停在"正在准备模型"，而主进程其实早就拿着 `license_bound_elsewhere` 了。
 *
 * ⚠️ 这里读的是**真实的**共享单例（`@clawwork/shared`），不是 relay-startup 的替身：
 *    "handler 有没有把快照读出来"只有拿真 store 才钉得住。
 */
describe('中转 bootstrap 公开状态：初始读 / 手动重试 / 账户边界', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.verifyLoginOtp.mockReset();
    mocks.signInWithPassword.mockReset();
    mocks.signOutCommercial.mockReset();
    mocks.notifyCommercialSignedIn.mockReset();
    mocks.retryCommercialRelayBootstrap.mockReset();
    mocks.requestCommercialAccessCleanup.mockReset();
    mocks.clearCommercialSession.mockReset();
    mocks.requestCommercialAccessCleanup.mockResolvedValue({ cleaned: true, pending: false });
    mocks.signOutCommercial.mockResolvedValue({ ok: true });
    // 公开状态是**进程级单例**：用例之间必须回到起点，否则上一条的 blocked 会漏给下一条。
    resetRelayBootstrapPublicState();
    registerCommercialHandlers();
  });

  it('⭐⭐ 初始读：窗口挂载前就失败的那一次，渲染层问一句就能拿到（不必等下一次事件）', async () => {
    // 模拟"启动那一轮在渲染层挂上之前就结束了"：状态早就写进快照，事件没人收。
    relayBootstrapPublicStateStore.set({ phase: 'blocked', errorCode: 'license_bound_elsewhere' });

    const res = (await handlerFor('commercial:relay-bootstrap-state')({})) as {
      ok: boolean;
      result: RelayBootstrapPublicState;
    };

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({
      phase: 'blocked',
      errorCode: 'license_bound_elsewhere',
      updatedAt: expect.any(Number),
    });
    expect(Object.keys(res.result).sort(), '初始读与事件是同一份载荷 —— 字段同样是闭集').toEqual([
      'errorCode',
      'phase',
      'updatedAt',
    ]);
  });

  it('⭐ 初始读读的是**快照**：连着问两次拿到的是同一条（不是每次现造一个 idle）', async () => {
    relayBootstrapPublicStateStore.set({ phase: 'retryable-error', errorCode: 'runtime_not_ready' });

    const first = await handlerFor('commercial:relay-bootstrap-state')({});
    const second = await handlerFor('commercial:relay-bootstrap-state')({});

    expect(second).toEqual(first);
    expect((second as { result: RelayBootstrapPublicState }).result.phase).toBe('retryable-error');
  });

  it('⭐⭐ 登录成功：补跑之前先把上一个账号的 blocked 清掉（补跑那一刻读到的必须是 idle）', async () => {
    relayBootstrapPublicStateStore.set({ phase: 'blocked', errorCode: 'license_bound_elsewhere' });
    let atNotify: RelayBootstrapPublicState | undefined;
    mocks.notifyCommercialSignedIn.mockImplementation(() => {
      atNotify = relayBootstrapPublicStateStore.get();
    });
    mocks.verifyLoginOtp.mockResolvedValue({ ok: true, result: { userId: 'u-1' } });

    await handlerFor('commercial:verify-otp')({}, '+8613800000000', '123456');

    expect(atNotify, '补跑那一刻陈旧 blocked 还在 ⇒ 界面会拿上一个账号的结论吓刚登录的用户').toMatchObject({
      phase: 'idle',
    });
  });

  it('⭐ 密码登录那条同样清（两条产品入口都覆盖）', async () => {
    relayBootstrapPublicStateStore.set({ phase: 'blocked', errorCode: 'license_bound_elsewhere' });
    let atNotify: RelayBootstrapPublicState | undefined;
    mocks.notifyCommercialSignedIn.mockImplementation(() => {
      atNotify = relayBootstrapPublicStateStore.get();
    });
    mocks.signInWithPassword.mockResolvedValue({ ok: true, result: { userId: 'u-2' } });

    await handlerFor('commercial:sign-in-password')({}, 'a@b.test', 'pw');

    expect(atNotify).toMatchObject({ phase: 'idle' });
  });

  it('⭐⭐ 登录成功但账户清理抛错：陈旧状态也已经清掉了（清理失败不该把这件事一起吞掉）', async () => {
    relayBootstrapPublicStateStore.set({ phase: 'blocked', errorCode: 'license_bound_elsewhere' });
    mocks.verifyLoginOtp.mockResolvedValue({ ok: true, result: { userId: 'u-1' } });
    mocks.requestCommercialAccessCleanup.mockRejectedValue(new Error('cleanup down'));

    await expect(handlerFor('commercial:verify-otp')({}, '+8613800000000', '123456')).rejects.toThrow('cleanup down');

    expect(relayBootstrapPublicStateStore.get()).toMatchObject({ phase: 'idle' });
  });

  it('⭐⭐ 登出：账户清理抛错也照样清（状态属于**当前账号**，登出即作废）', async () => {
    relayBootstrapPublicStateStore.set({ phase: 'blocked', errorCode: 'license_required' });
    mocks.requestCommercialAccessCleanup.mockRejectedValue(new Error('cleanup down'));

    await expect(handlerFor('commercial:sign-out')({})).rejects.toThrow('cleanup down');

    expect(
      relayBootstrapPublicStateStore.get(),
      '旧账号的 blocked 留给下一个人看 = 上一个账号的状态泄漏',
    ).toMatchObject({ phase: 'idle' });
    expect(mocks.clearCommercialSession).toHaveBeenCalledTimes(1);
  });

  it('⭐ 手动重试：**立刻**回 {ok:true}，不等 runner 跑完（进度跟状态事件走）', async () => {
    // 让 runner 一直挂着：handler 若在等它，这条用例就永远不会返回。
    let release!: () => void;
    mocks.retryCommercialRelayBootstrap.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const res = await handlerFor('commercial:relay-bootstrap-retry')({});

    expect(res).toEqual({ ok: true });
    expect(mocks.retryCommercialRelayBootstrap).toHaveBeenCalledTimes(1);
    release();
  });
});
