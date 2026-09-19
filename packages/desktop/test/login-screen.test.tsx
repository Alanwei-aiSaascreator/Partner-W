// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(':')}` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import Login from '../src/renderer/layouts/Login';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('Login', () => {
  // ⚠️ 返回类型要写全：登录失败会带 errorCode，推断成 { ok: boolean } 会让
  //    mockResolvedValueOnce({ ok: false, errorCode }) 在 typecheck:tests 里报错。
  const sendOtp = vi.fn(async (): Promise<{ ok: boolean; errorCode?: string }> => ({ ok: true }));
  const verifyOtp = vi.fn(async (): Promise<{ ok: boolean; errorCode?: string }> => ({ ok: true }));

  beforeEach(() => {
    window.localStorage.clear();
    sendOtp.mockClear();
    verifyOtp.mockClear();
    Object.assign(window, {
      clawwork: {
        commercialSendOtp: sendOtp,
        commercialVerifyOtp: verifyOtp,
      },
    });
  });

  it('renders separate brand and sign-in regions', () => {
    const { container, unmount } = render(<Login onSignedIn={vi.fn()} />);

    expect(container.querySelector('[data-login-region="brand"]')).not.toBeNull();
    expect(container.querySelector('[data-login-region="form"]')).not.toBeNull();
    expect(container.querySelector('[data-guide-mascot]')).not.toBeNull();
    expect(container.textContent).toContain('mainArea.welcomeTitle');
    expect(container.textContent).toContain('assistantWorkspaces.compass.description');
    expect(container.textContent).not.toContain('assistantDefinitions.main');
    expect(container.textContent).not.toContain('数据不出内网');
    expect(container.querySelectorAll('[data-primary-action]')).toHaveLength(1);

    unmount();
  });

  /**
   * ⭐ 合规最小告知（2026-09-19，明天出 U 盘内测版）。
   *
   * 内测同事用**手机号**注册 —— 手机号是个人信息，PIPL 下"内部员工"**不是豁免**。
   * 完整的同意记录（落库 + 版本门禁）是合规二期，**今晚不做**；
   * 但"**我们拿手机号干什么、留多久**"这一句必须**现在就摆出来**，否则是"采了没说"。
   *
   * ⚠️ 位置是刻意的：摆在**输入手机号那一屏**（`phase === 'phone'`）——
   *    用户正要填手机号的那一刻，才是这句话有用的时刻。
   */
  it('⭐⭐ 输入手机号那一屏必须写明手机号用途与保留期（合规最小告知）', () => {
    const { container, unmount } = render(<Login onSignedIn={vi.fn()} />);

    const notice = container.querySelector<HTMLElement>('[data-testid="beta-phone-notice"]');
    expect(notice, '这一句必须在，且要能定位到').not.toBeNull();
    expect(notice!.hidden, '不许藏起来').toBe(false);
    expect(notice!.textContent).toContain('login.betaPhoneNotice');

    unmount();
  });

  it('keeps purpose selection out of the login screen', () => {
    const { container, unmount } = render(<Login onSignedIn={vi.fn()} />);

    expect(container.querySelectorAll('[data-login-purpose]')).toHaveLength(0);
    expect(container.textContent).not.toContain('login.purposes.content');
    expect(container.textContent).not.toContain('login.purposes.office');
    expect(container.textContent).not.toContain('login.purposes.ecommerce');
    expect(container.textContent).not.toContain('login.purposes.research');
    expect(window.localStorage.getItem('rongying-login-purpose')).toBeNull();
    expect(container.textContent).toContain('fileBrowser.workspaceAccessDescription');
    unmount();
  });

  /**
   * ⭐ 2026-09-17 实机 bug：校验验证码**超时**时，界面统一说
   * 「验证码不正确或已过期」⇒ 用户拿同一个码重试 ⇒ OTP 是一次性的、
   * 那次超时的请求已把它消费掉 ⇒ 第二次必然失败（"收到验证码登不上"）。
   *
   * 修法：主进程把失败分成「没到服务器」和「服务端拒绝了」，界面分开说。
   */
  it('⭐ 校验时连不上服务器 ⇒ 说网络，不说验证码错', async () => {
    verifyOtp.mockResolvedValueOnce({ ok: false, errorCode: 'otp_verify_unreachable' });
    const { container, unmount } = render(<Login onSignedIn={vi.fn()} />);

    const phone = container.querySelector('input[type="tel"]') as HTMLInputElement;
    const agreement = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      setInput(phone, '13800138000');
      agreement.click();
    });
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const code = container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    act(() => setInput(code, '123456'));
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('login.verifyUnreachable');
    expect(container.textContent).not.toContain('login.verifyFailed');
    unmount();
  });

  it('服务端拒绝了验证码 ⇒ 仍然是"验证码不正确或已过期"', async () => {
    verifyOtp.mockResolvedValueOnce({ ok: false, errorCode: 'otp_verify_failed' });
    const { container, unmount } = render(<Login onSignedIn={vi.fn()} />);

    const phone = container.querySelector('input[type="tel"]') as HTMLInputElement;
    const agreement = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      setInput(phone, '13800138000');
      agreement.click();
    });
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const code = container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    act(() => setInput(code, '123456'));
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('login.verifyFailed');
    unmount();
  });

  it('covers its eyes with the same mascot arms while entering the verification code', async () => {
    const { container, unmount } = render(<Login onSignedIn={vi.fn()} />);
    const phone = container.querySelector('input[type="tel"]') as HTMLInputElement;
    const agreement = container.querySelector('input[type="checkbox"]') as HTMLInputElement;

    act(() => {
      setInput(phone, '13800138000');
      agreement.click();
    });
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(sendOtp).toHaveBeenCalledWith('+8613800138000');
    const code = container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    act(() => code.focus());
    expect(container.querySelector('svg[data-pose="covering"]')).not.toBeNull();

    act(() => code.blur());
    expect(container.querySelector('svg[data-pose="idle"]')).not.toBeNull();

    unmount();
  });
});
