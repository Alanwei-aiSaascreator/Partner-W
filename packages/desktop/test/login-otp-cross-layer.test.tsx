// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/**
 * ⭐ 真链：**真** `auth.ts` → **真** `Login` 界面。
 *
 * ## 为什么必须有一条这样的用例（2026-09-20 变异验证抓出来的盲区）
 *
 * 这一刀原本有两层用例，各自都对：
 *   · `test/commercial-otp-timeout.test.ts` —— 喂真 supabase-js，钉主进程 8 秒上限
 *     和错误码；
 *   · `test/login-screen.test.tsx` —— 喂**桩 IPC 结果**，钉界面文案与"迟到响应不覆盖"。
 *
 * 但把主进程那条改坏（`otp_verify_timeout` 偷偷并回 `otp_verify_unreachable`）时，
 * **界面那层一条都不会红** —— 因为界面用例吃的根本不是主进程产出的错误码，
 * 是我手写的桩。两边各自绿，中间的**那条缝没人钉**：错误码字符串一旦对不上，
 * 用户看到的就是错的（甚至是最怕的那句"验证码不正确"），而全仓测试全绿。
 *
 * 所以这里让 IPC 桥**直接接真函数**（不是伪造结果）：真超时、真分类、真文案。
 *
 * ⚠️ 只桩三处系统边界：商业客户端（换一条永不回包的 fetch / 明确回话的桩）、
 *    设备指纹（那条链会拉 electron）、调试日志。
 */

/** 只有被中止才会结束的 fetch：模拟"网络挂住"。 */
function hangingFetch(): (input: unknown, init?: RequestInit) => Promise<Response> {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? null;
      if (!signal) return;
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(':')}` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const mocks = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => mocks.client,
  resetCommercialClient: vi.fn(),
}));
vi.mock('../src/main/commercial/license.js', () => ({ deviceFingerprint: () => 'fp-test' }));
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { sendLoginOtp, verifyLoginOtp } = await import('../src/main/commercial/auth.js');
import Login from '../src/renderer/layouts/Login';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 真 supabase-js + 挂住的 fetch ⇒ 只有主进程那 8 秒上限能救场。 */
function hangingVerifyClient(): unknown {
  const real = createClient('https://hanging.supabase.co', 'anon-key', {
    global: { fetch: hangingFetch() as never },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    auth: {
      // 发码这一半要能成，否则界面根本进不到"填验证码"那一屏。
      signInWithOtp: async () => ({ data: {}, error: null }),
      verifyOtp: (params: unknown) => (real.auth.verifyOtp as (p: unknown) => Promise<unknown>)(params),
    },
  };
}

/** 明确回话的桩：用来走"服务端说了什么"的那两条路。 */
function replyingClient(signInWithOtp: () => Promise<unknown>, verifyOtp: () => Promise<unknown>): unknown {
  return { auth: { signInWithOtp, verifyOtp } };
}

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('登录验证码：真主进程 ↔ 真界面', () => {
  let onSignedIn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    onSignedIn = vi.fn();
    Object.assign(window, {
      clawwork: {
        // ⚠️ 桥后面是**真函数**，不是伪造的返回值 —— 这条用例的全部意义就在这里。
        commercialSendOtp: (target: string) => sendLoginOtp(target),
        commercialVerifyOtp: (target: string, token: string) => verifyLoginOtp(target, token),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 走到"填验证码"那一屏（发码本身必须成功）。 */
  async function reachCodePhase(container: HTMLDivElement): Promise<void> {
    const phone = container.querySelector('input[type="tel"]') as HTMLInputElement;
    const agreement = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      setInput(phone, '13800138000');
      agreement.click();
    });
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('input[inputmode="numeric"]'), '前提：已经进到填码那一屏').not.toBeNull();
  }

  it('⭐ 真链：发送验证码超时（主进程 8 秒）⇒ 界面说"服务暂时无响应，请重新发送"', async () => {
    // 发码这一半也挂住：模拟上游 SMS 通道没回话。
    const real = createClient('https://hanging.supabase.co', 'anon-key', {
      global: { fetch: hangingFetch() as never },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    mocks.client = {
      auth: { signInWithOtp: (p: unknown) => (real.auth.signInWithOtp as (x: unknown) => Promise<unknown>)(p) },
    };

    const { container, unmount } = render(<Login onSignedIn={onSignedIn} />);
    const phone = container.querySelector('input[type="tel"]') as HTMLInputElement;
    const agreement = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      setInput(phone, '13800138000');
      agreement.click();
    });

    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      // 主进程那 8 秒上限（真的 `withTimeout`）—— 界面上不该出现"无限转圈"。
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(container.textContent).toContain('login.sendTimeout');
    expect(container.textContent, '对不上码就会掉进这句笼统的话里').not.toContain('login.sendFailed');
    unmount();
  });

  it('⭐ 真链：校验验证码超时（主进程 8 秒）⇒ 界面说"验证请求超时，请重试"，**不是**"验证码不正确"', async () => {
    mocks.client = hangingVerifyClient();

    const { container, unmount } = render(<Login onSignedIn={onSignedIn} />);
    await reachCodePhase(container);

    const code = container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    act(() => setInput(code, '123456'));
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(container.textContent).toContain('login.verifyTimeout');
    expect(container.textContent, '09-17 实机那条：把"我们没问出来"说成"你码错了"').not.toContain('login.verifyFailed');
    unmount();
  });

  it('⭐ 真链：服务端明确说"发太频繁"（429）⇒ 界面说"发送太频繁"（分类没被超时兜底吃掉）', async () => {
    mocks.client = replyingClient(
      async () => ({ data: {}, error: { status: 429, message: 'rate limit' } }),
      async () => ({ data: { user: null }, error: { status: 403, message: 'invalid token' } }),
    );

    const { container, unmount } = render(<Login onSignedIn={onSignedIn} />);
    const phone = container.querySelector('input[type="tel"]') as HTMLInputElement;
    const agreement = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      setInput(phone, '13800138000');
      agreement.click();
    });
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(container.textContent).toContain('login.rateLimited:60');
    unmount();
  });

  it('⭐ 真链：正常成功 ⇒ 校验通过后进入应用（回调真的被调用）', async () => {
    mocks.client = replyingClient(
      async () => ({ data: {}, error: null }),
      async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    );

    const { container, unmount } = render(<Login onSignedIn={onSignedIn} />);
    await reachCodePhase(container);

    const code = container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    act(() => setInput(code, '123456'));
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    // 成功那一刻界面先摆姿势，320ms 后才回调进应用。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('login.verifyFailed');
    unmount();
  });
});
