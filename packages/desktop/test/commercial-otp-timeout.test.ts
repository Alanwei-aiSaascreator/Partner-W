import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/**
 * 🔴 P0（复核：登录是内测门槛）：`sendLoginOtp` / `verifyLoginOtp` 必须**有 8 秒上限**。
 *
 * ## 为什么
 *
 * 这两个函数原来**直接 await Supabase**，没有任何上限。同文件里的其它探测
 *（`probeAuth` / `readSessionState`）早就有 8 秒口径（`NETWORK_TIMEOUT_MS`），
 * 唯独"用户正盯着按钮转圈"的这两个没有 —— 网络挂住时界面**无限等待**，
 * 用户既不知道在等什么、也没法重试（复核口径：登录请求不能无限转圈）。
 *
 * ## 上限该是多少、超过之后说什么
 *
 * 与同文件其它调用**同一个数**（8 秒，`NETWORK_TIMEOUT_MS`），别再引入第二个口径。
 * 超时后的出口口径：
 *   · 发送 ⇒ `otp_send_unreachable`（界面说「服务暂时无响应，请重新发送」）；
 *   · 校验 ⇒ `otp_verify_timeout`（界面说「验证请求超时，请重试」+ 一次性提醒）
 *     —— ⚠️ **绝不能说"验证码错了"**：OTP 是一次性的，把"我们没问出来"说成
 *     "你码错了"会让用户拿同一个码反复重试（2026-09-17 实机就是这条，
 *     见 `auth-classify.ts` 的说明）。
 *     两档超时是**分开**的错误码：界面的两句话不一样（"没响应，请重新发送" vs
 *     "超时了，请重试"），合成一个码就说不出区别了。
 *
 * ## 桩为什么是"真 supabase-js + 挂住的 fetch"
 *
 * `hidden` 的教训：桩与真身两份时，绿了不代表真身对。这里用**真的** supabase-js 客户端
 * （只是把 fetch 换成一条永不回包的），这样连 supabase-js 自己的重试/退避也一起被测到
 * —— 我们的 8 秒上限必须在它之上仍然成立。
 */

/** 一条**只有被中止才会结束**的 fetch：模拟"网络挂住、没有任何回包"。 */
function hangingFetch(): (input: unknown, init?: RequestInit) => Promise<Response> {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? null;
      // 没有信号 ⇒ 永远挂着。这正是"无限等待"的形态：我们不希望任何一条路走到这里。
      if (!signal) return;
      // ⚠️ 桩必须**忠实**：真实 fetch 拿到**已经中止**的 signal 会立刻 reject。
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
}

const mocks = vi.hoisted(() => ({ client: null as unknown }));

// client.js 会被真的 `createClient` 顶替（见 beforeEach）；这里只提供取值口。
vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => mocks.client,
  resetCommercialClient: vi.fn(),
}));
// auth.ts 静态 import 了 license.js（只为 deviceFingerprint），那条链会拉 electron。
vi.mock('../src/main/commercial/license.js', () => ({ deviceFingerprint: () => 'fp-test' }));
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { sendLoginOtp, verifyLoginOtp } = await import('../src/main/commercial/auth.js');

/** 真 supabase-js + 挂住的网络；调用方**必须**自己带上限。 */
function hangingClient(): unknown {
  return createClient('https://hanging.supabase.co', 'anon-key', {
    global: { fetch: hangingFetch() as never },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** 手写假客户端：只用于"明确有回包"的两条路（成功 / 服务端拒绝）。 */
function replyingClient(signInWithOtp: () => Promise<unknown>, verifyOtp: () => Promise<unknown>): unknown {
  return { auth: { signInWithOtp, verifyOtp } };
}

describe('登录验证码两个调用的 8 秒上限', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('⭐ 发送验证码：网络挂住 ⇒ 8 秒内必须有结论，不许一直转圈', async () => {
    mocks.client = hangingClient();

    const pending = sendLoginOtp('+8613800138000');
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(8_000);

    expect(settled, '超过 8 秒还没有结论 ⇒ 界面就一直在转圈（复核点名的那条）').toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'otp_send_unreachable' });
  });

  it('⭐ 校验验证码：网络挂住 ⇒ 8 秒内给出 otp_verify_timeout，**不是**"验证码错了"', async () => {
    mocks.client = hangingClient();

    const pending = verifyLoginOtp('+8613800138000', '123456');
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(8_000);

    expect(settled, '超过 8 秒还没有结论 ⇒ 用户只会一直等').toBe(true);
    const res = await pending;
    expect(res).toMatchObject({ ok: false, errorCode: 'otp_verify_timeout' });
    // 「一次性验证码被判成码错」是 09-17 实机那条：拿同一个码重试必然再次失败。
    expect(res.errorCode).not.toBe('otp_verify_failed');
  });

  it('健康路径零行为改变：两条路正常回包就原样透传（不许被超时路径吃掉）', async () => {
    mocks.client = replyingClient(
      async () => ({ data: {}, error: null }),
      async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    );

    await expect(sendLoginOtp('+8613800138000')).resolves.toMatchObject({ ok: true });
    await expect(verifyLoginOtp('+8613800138000', '123456')).resolves.toMatchObject({
      ok: true,
      result: { userId: 'user-1' },
    });
  });

  /**
   * ⭐⭐ **接线**测试（2026-09-26）：超时之后要继续看着那条请求，并记下它到底回没回。
   *
   * 8 秒超时的**根因至今没坐实**，而每次复发日志里只有"我们不等了"——
   * 没说的是那条请求本身怎么了。"几秒后其实回来了"（后端慢）与"直到被中止都没回来"
   * （卡住/排队）是两种根因、两种修法，只有这条观测能分开。
   *
   * ⚠️ 这一条守的是**接线**：观测模块写好了但没人调用，是这个仓库反复出过的缝
   *    （`request-timeout.ts` 自己的 docblock 就记着"模块写好但忘了接"）。
   *    ⇒ 断言的是"从**公开的** `sendLoginOtp` 走一遍，日志里真的出现了那条观测"。
   */
  it('⭐⭐ 超时之后**继续看着**：9 秒才回来的请求要记成 settled（不是"卡住"）', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      mocks.client = replyingClient(
        // 9 秒才回包：8 秒时我们已经不等它了，但它**确实回了** ⇒ 这就是"后端慢"那一档。
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ data: {}, error: null }), 9_000);
          }),
        async () => ({ data: {}, error: null }),
      );

      const pending = sendLoginOtp('+8613800138000');
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'otp_send_unreachable' });

      // ⚠️ 8 秒这一刻**只有"我们不等了"那句**：请求还没回来，没什么可记的
      //    （观测那条要等它**真的落定**才有内容 —— 这是设计，不是缺口）。
      expect(errors.some((line) => line.includes('otp.send timed out'))).toBe(true);
      expect(errors.some((line) => line.includes('we gave up, then:'))).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      const later = errors.filter((line) => line.includes('we gave up, then:'));
      expect(later, '超时之后必须留下"它后来怎么样了"的证据 —— 根因至今没坐实，全靠这条分辨').toHaveLength(1);
      expect(later[0], '9 秒时它回来了 ⇒ 要记成 settled').toContain('settled');
      expect(later[0], '耗时记的是**从发起到落定**（不是从超时算起）').toContain('at 9000ms');
      expect(later[0]).toContain('otp.send');
    } finally {
      spy.mockRestore();
    }
  });

  it('服务端**明确**回话（限流 / 校验失败）仍走原分类，不被超时兜底吃成"没问出来"', async () => {
    mocks.client = replyingClient(
      async () => ({ data: {}, error: { status: 429, message: 'rate limit' } }),
      async () => ({ data: { user: null }, error: { status: 403, message: 'invalid token' } }),
    );

    await expect(sendLoginOtp('+8613800138000')).resolves.toMatchObject({
      ok: false,
      errorCode: 'otp_rate_limited',
    });
    await expect(verifyLoginOtp('+8613800138000', '000000')).resolves.toMatchObject({
      ok: false,
      errorCode: 'otp_verify_failed',
    });
  });
});
