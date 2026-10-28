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
import { useUiStore } from '../src/renderer/stores/uiStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactElement): {
  container: HTMLDivElement;
  unmount: () => void;
  rerender: (ui: ReactElement) => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (nextUi) => act(() => root.render(nextUi)),
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
    expect(container.textContent).toContain('mainArea.welcomeTitle');
    expect(container.textContent).toContain('login.brandSubline');
    // 2026-10-09 登录页文案 A：左栏第二行改用登录向独立键；工作台的罗盘描述
    // 不再借到登录页上（它指向"从下面选一个开始"的 starter 卡，本屏不存在）。
    expect(container.textContent).not.toContain('assistantWorkspaces.compass.description');
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

  /**
   * 激活页"同意勾选"（材料批 2026-10-03 对照项）。
   *
   * 现状即所需：勾选框在**合并页**（手机号+验证码+激活码同页）渲染，且
   * **未勾选时两条提交都被挡住** —— 这不是"按钮画灰"那种装饰，挡的是真实
   * 守卫（直接派发 form submit 也进不去），只有勾选状态为真才放行。
   * C 切片的既有契约（认证后激活不再显示勾选、不重复要 OTP）由本文件其余
   * 用例钉住，不在本条内改动。
   */
  it('⭐⭐ 激活页同意勾选：未勾选不许发码（激活码已填也一样），勾选后才放行', async () => {
    const { container, unmount } = render(<Login activationEnabled onSignedIn={vi.fn()} />);
    try {
      const phone = container.querySelector('input[type="tel"]') as HTMLInputElement;
      const card = container.querySelector('input[type="password"]') as HTMLInputElement;
      const agreement = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      const submit = (): void => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      };

      act(() => {
        setInput(phone, '13800138000');
        setInput(card, 'RY-EXACT');
      });
      expect(agreement.checked).toBe(false);

      // 未勾选：手机号合法、卡也填了 —— 仍然不发码（守卫挡的，不是按钮画灰）。
      await act(async () => submit());
      expect(sendOtp).not.toHaveBeenCalled();

      act(() => agreement.click());
      await act(async () => submit());
      expect(sendOtp).toHaveBeenCalledWith('+8613800138000');
    } finally {
      unmount();
    }
  });

  it('⭐⭐ 验证码屏：勾选状态跨 phase 保留；未勾选挡住校验提交，勾选后才校验', async () => {
    const { container, unmount } = render(<Login activationEnabled onSignedIn={vi.fn()} />);
    try {
      const phone = container.querySelector('input[type="tel"]') as HTMLInputElement;
      const agreement = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      act(() => {
        setInput(phone, '13800138000');
        agreement.click();
      });
      await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      // 切到验证码屏：勾选框仍在、且勾选状态保留（Task 13 的两个 phase 口径）。
      const agreementInCode = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(agreementInCode).not.toBeNull();
      expect(agreementInCode.checked).toBe(true);

      act(() => agreementInCode.click()); // 取消勾选
      const code = container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
      act(() => setInput(code, '123456'));
      await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(verifyOtp).not.toHaveBeenCalled();

      act(() => agreementInCode.click()); // 重新勾选
      await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(verifyOtp).toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('keeps purpose selection out of the login screen', () => {
    const { container, unmount } = render(<Login onSignedIn={vi.fn()} />);

    expect(container.querySelectorAll('[data-login-purpose]')).toHaveLength(0);
    expect(container.textContent).not.toContain('login.purposes.content');
    expect(container.textContent).not.toContain('login.purposes.office');
    expect(container.textContent).not.toContain('login.purposes.ecommerce');
    expect(container.textContent).not.toContain('login.purposes.research');
    expect(window.localStorage.getItem('rongying-login-purpose')).toBeNull();
    // 2026-10-09 登录页文案 A：权限机制说明已从登录页移除（FileBrowser 原位置保留）。
    expect(container.textContent).not.toContain('fileBrowser.workspaceAccessDescription');
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

  it('keeps verified authentication recoverable when the account read fails, without consuming OTP again', async () => {
    vi.useFakeTimers();
    const onSignedIn = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('session unavailable'))
      .mockResolvedValueOnce();
    const { container, unmount } = render(<Login onSignedIn={onSignedIn} />);
    act(() => {
      setInput(container.querySelector('input[type="tel"]') as HTMLInputElement, '13800138000');
      (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    });
    await act(async () =>
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    act(() => setInput(container.querySelector('input[inputmode="numeric"]') as HTMLInputElement, '123456'));
    await act(async () =>
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(container.textContent).toContain('login.sessionUnavailable');
    expect(container.querySelector('.animate-spin')).toBeNull();
    await act(async () =>
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(onSignedIn).toHaveBeenCalledTimes(2);
    unmount();
    vi.useRealTimers();
  });

  /**
   * 🔴 2026-09-20 复核拍板（登录是内测门槛）：
   *
   *   · `sendLoginOtp` / `verifyLoginOtp` 在**主进程**里必须有 8 秒上限
   *     （`test/commercial-otp-timeout.test.ts` 直接钉住那两条），界面这两条路
   *     各自要有话说：发送超时说「服务暂时无响应，请重新发送」、
   *     校验超时说「验证请求超时，请重试」，**都不能无限转圈**。
   *   · 校验超时**绝不能**塌成「验证码不正确或已过期」：OTP 是一次性的，
   *     把"我们没问出来"说成"你码错了"会把人推进重试死循环（09-17 实机那条）。
   *   · 迟到的响应**不许**覆盖当前界面状态。
   */
  it('⭐ 发送验证码超时 ⇒ 说"服务暂时无响应，请重新发送"，不是笼统的发送失败', async () => {
    sendOtp.mockResolvedValueOnce({ ok: false, errorCode: 'otp_send_unreachable' });
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

    expect(container.textContent, '超时说"没响应，重新发送"，别混进笼统的发送失败').toContain('login.sendTimeout');
    expect(container.textContent).not.toContain('login.sendFailed');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    // 结论已出 ⇒ 不能停在转圈上：转圈的图标只在这一处，且输入框必须能再输入。
    // （提交按钮此刻是灰的属于正常：已经进到"填验证码"那一屏，而码还是空的。）
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect((container.querySelector('input[inputmode="numeric"]') as HTMLInputElement).disabled).toBe(false);
    unmount();
  });

  it('⭐ 校验验证码超时 ⇒ 说"验证请求超时，请重试"，且**不是**"验证码不正确"', async () => {
    verifyOtp.mockResolvedValueOnce({ ok: false, errorCode: 'otp_verify_timeout' });
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

    expect(container.textContent).toContain('login.verifyTimeout');
    expect(container.textContent, '"问不出来"绝不能说成"你码错了"').not.toContain('login.verifyFailed');
    unmount();
  });

  /**
   * ⭐ 「防止超时后的迟到响应覆盖当前 UI 状态」。
   *
   * 做法：只有**最新一次**尝试才准写界面（每次尝试带一个递增序号，await 回来先对号）。
   *
   * ⚠️ 这条用例先钉住前提：**同一 tick 里的两次提交真的会发两次**——
   *    否则"迟到覆盖"根本无从发生，这条用例也就什么都没证明。
   *    （React 只在事件处理结束时刷新状态，`busy` 是 state 不是同步锁，
   *      所以第二次提交读到的还是旧闭包里的 `busy === false`。）
   */
  it('⭐ 迟到的响应不许覆盖当前界面状态（以最新一次尝试的结论为准）', async () => {
    let resolveLate!: (value: { ok: boolean; errorCode?: string }) => void;
    sendOtp
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: boolean; errorCode?: string }>((resolve) => {
            resolveLate = resolve;
          }),
      )
      .mockImplementationOnce(async () => ({ ok: false, errorCode: 'otp_rate_limited' }));

    const { container, unmount } = render(<Login onSignedIn={vi.fn()} />);
    const phone = container.querySelector('input[type="tel"]') as HTMLInputElement;
    const agreement = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      setInput(phone, '13800138000');
      agreement.click();
    });

    await act(async () => {
      const form = container.querySelector('form') as HTMLFormElement;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(sendOtp, '前提：这次重叠真的发生了，否则本用例证明不了任何事').toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('login.rateLimited:60');

    // 第 1 次（已被第 2 次取代）这时才回来 —— 它说什么都不该改变界面。
    await act(async () => {
      resolveLate({ ok: false, errorCode: 'otp_send_unreachable' });
    });
    expect(container.textContent, '迟到的第 1 次响应把第 2 次的结论覆盖掉了').toContain('login.rateLimited:60');
    expect(container.textContent).not.toContain('login.sendTimeout');
    unmount();
  });

  /** 同一条纪律，校验侧也要有（两条路的序号各自独立，别只钉一半）。 */
  it('⭐ 校验时迟到的响应同样不许覆盖当前结论（不许多出一个"超时"）', async () => {
    let resolveLate!: (value: { ok: boolean; errorCode?: string }) => void;
    verifyOtp
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: boolean; errorCode?: string }>((resolve) => {
            resolveLate = resolve;
          }),
      )
      .mockImplementationOnce(async () => ({ ok: false, errorCode: 'otp_verify_failed' }));

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
      const form = container.querySelector('form') as HTMLFormElement;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(verifyOtp, '前提：这次重叠真的发生了').toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('login.verifyFailed');

    await act(async () => {
      resolveLate({ ok: false, errorCode: 'otp_verify_unreachable' });
    });
    expect(container.textContent, '迟到的第 1 次响应把第 2 次的结论覆盖掉了').toContain('login.verifyFailed');
    expect(container.textContent).not.toContain('login.verifyUnreachable');
    expect(container.textContent).not.toContain('login.verifyTimeout');
    unmount();
  });
  it('keeps a card on the login form and only forwards it after successful OTP', async () => {
    const onSignedIn = vi.fn(),
      { container, unmount } = render(<Login activationEnabled onSignedIn={onSignedIn} />);
    try {
      expect(container.querySelector('input[type="password"]')).not.toBeNull();
      act(() => {
        setInput(container.querySelector('input[type="tel"]') as HTMLInputElement, '13800138000');
        setInput(container.querySelector('input[type="password"]') as HTMLInputElement, 'RY-EXACT');
        (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
      });
      await act(async () =>
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(onSignedIn).not.toHaveBeenCalled();
      act(() => setInput(container.querySelector('input[inputmode="numeric"]') as HTMLInputElement, '123456'));
      verifyOtp.mockResolvedValueOnce({ ok: false, errorCode: 'otp_verify_failed' });
      await act(async () =>
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(onSignedIn).not.toHaveBeenCalled();
      await act(async () =>
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(onSignedIn).toHaveBeenCalledWith('RY-EXACT');
      expect(JSON.stringify(window.localStorage)).not.toContain('RY-EXACT');
    } finally {
      unmount();
    }
  });
  it('keeps an authenticated account at activation without another OTP and maps its error', async () => {
    const onSignedIn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('unknown'), { code: 'activation_outcome_unknown' }))
      .mockResolvedValueOnce(undefined);
    const { container, unmount } = render(
      <Login
        activationEnabled
        authenticatedAccount={{ userId: 'user-A', nickname: 'Alice' }}
        onSignedIn={onSignedIn}
      />,
    );
    try {
      expect(container.querySelector('input[type="tel"]')).toBeNull();
      expect(container.querySelector('input[inputmode="numeric"]')).toBeNull();
      act(() => setInput(container.querySelector('input[type="password"]') as HTMLInputElement, 'RY-EXACT'));
      await act(async () =>
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(container.textContent).toContain('activation.errorOutcomeUnknown');
      expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('RY-EXACT');
      await act(async () =>
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(verifyOtp).not.toHaveBeenCalled();
      expect(onSignedIn).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
    }
  });
  it('locks same-tick activation submissions without invalidating the first attempt', async () => {
    let finish: (() => void) | undefined;
    const onSignedIn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { container, unmount } = render(
      <Login activationEnabled authenticatedAccount={{ userId: 'user-A', nickname: '' }} onSignedIn={onSignedIn} />,
    );
    try {
      await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(onSignedIn).toHaveBeenCalledTimes(1);
      await act(async () => finish?.());
      expect(container.querySelector('.animate-spin')).toBeNull();
    } finally {
      unmount();
    }
  });
  it('clears the card and returns to authentication when the user changes account', async () => {
    const onChangeAccount = vi.fn();
    const { container, unmount } = render(
      <Login
        activationEnabled
        authenticatedAccount={{ userId: 'user-A', nickname: 'Alice' }}
        onSignedIn={vi.fn()}
        onChangeAccount={onChangeAccount}
      />,
    );
    try {
      expect(container.querySelector('input[type="password"]')).not.toBeNull();
      act(() => setInput(container.querySelector('input[type="password"]') as HTMLInputElement, 'PRIVATE-CARD'));
      await act(async () => (container.querySelector('[data-change-account]') as HTMLButtonElement).click());
      expect(onChangeAccount).toHaveBeenCalledTimes(1);
      expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
    } finally {
      unmount();
    }
  });
  it('clears a replaced account card and ignores its late rejection', async () => {
    let rejectOld: ((reason: Error) => void) | undefined;
    const onSignedIn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const { container, unmount, rerender } = render(
      <Login activationEnabled authenticatedAccount={{ userId: 'A', nickname: '' }} onSignedIn={onSignedIn} />,
    );
    try {
      act(() => setInput(container.querySelector('input[type="password"]') as HTMLInputElement, 'A-PRIVATE-CARD'));
      await act(async () =>
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      rerender(
        <Login activationEnabled authenticatedAccount={{ userId: 'B', nickname: '' }} onSignedIn={onSignedIn} />,
      );
      expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
      await act(async () => rejectOld?.(Object.assign(new Error('old'), { code: 'activation_outcome_unknown' })));
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await act(async () =>
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(onSignedIn).toHaveBeenLastCalledWith('');
    } finally {
      unmount();
    }
  });
  it('does not let a replaced account release the current activation lock', async () => {
    let finishOld: (() => void) | undefined, finishNew: (() => void) | undefined;
    const onSignedIn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishNew = resolve;
          }),
      );
    const { container, unmount, rerender } = render(
      <Login activationEnabled authenticatedAccount={{ userId: 'A', nickname: '' }} onSignedIn={onSignedIn} />,
    );
    const submit = () =>
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    try {
      await act(async () => submit());
      rerender(
        <Login activationEnabled authenticatedAccount={{ userId: 'B', nickname: '' }} onSignedIn={onSignedIn} />,
      );
      await act(async () => submit());
      await act(async () => finishOld?.());
      expect(container.querySelector('.animate-spin')).not.toBeNull();
      await act(async () => submit());
      expect(onSignedIn).toHaveBeenCalledTimes(2);
      await act(async () => finishNew?.());
    } finally {
      unmount();
    }
  });
  it('does not trust an external account arriving during an OTP activation attempt', async () => {
    let rejectOld: ((reason: Error) => void) | undefined;
    const onSignedIn = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectOld = reject;
        }),
    );
    const { container, unmount, rerender } = render(<Login activationEnabled onSignedIn={onSignedIn} />);
    try {
      act(() => {
        setInput(container.querySelector('input[type="tel"]') as HTMLInputElement, '13800138000');
        setInput(container.querySelector('input[type="password"]') as HTMLInputElement, 'A-CARD');
        (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
      });
      await act(async () =>
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      act(() => setInput(container.querySelector('input[inputmode="numeric"]') as HTMLInputElement, '123456'));
      await act(async () =>
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      rerender(
        <Login activationEnabled authenticatedAccount={{ userId: 'B', nickname: '' }} onSignedIn={onSignedIn} />,
      );
      expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
      await act(async () => rejectOld?.(Object.assign(new Error('A late'), { code: 'activation_outcome_unknown' })));
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      unmount();
    }
  });
  it('waits for account sign-out before permitting another entry request', async () => {
    let finish: (() => void) | undefined;
    const onSignedIn = vi.fn(),
      onChangeAccount = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    const { container, unmount } = render(
      <Login
        activationEnabled
        authenticatedAccount={{ userId: 'A', nickname: '' }}
        onSignedIn={onSignedIn}
        onChangeAccount={onChangeAccount}
      />,
    );
    try {
      await act(async () => (container.querySelector('[data-change-account]') as HTMLButtonElement).click());
      expect(container.querySelector('.animate-spin')).not.toBeNull();
      await act(async () =>
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(onSignedIn).not.toHaveBeenCalled();
      await act(async () => finish?.());
      expect(container.querySelector('.animate-spin')).toBeNull();
    } finally {
      unmount();
    }
  });

  /**
   * 1.0.11：**登录页也要能检查更新**（用户原话："用户不登陆就可以更新"）。
   *
   * 更新检查与下载走的是主进程 IPC，本身与登录态无关（`registerUpdateHandlers`
   * 在启动阶段就注册，handler 里没有 auth 门控）。缺的只是**入口**：登录页
   * 没挂 `Settings`，所以必须在这里给一个直接打开应用级 `UpdateDialog` 的按钮。
   */
  it('⭐ 登录页有不登录也能打开更新弹窗的入口', () => {
    useUiStore.setState({ updateDialogOpen: false });
    const { container, unmount } = render(<Login onSignedIn={vi.fn()} />);

    const entry = container.querySelector('[data-testid="login-check-updates"]') as HTMLButtonElement | null;
    expect(entry, '登录页必须有「检查更新」入口').not.toBeNull();
    expect(entry?.textContent).toContain('settings.checkForUpdates');

    act(() => entry?.click());
    expect(useUiStore.getState().updateDialogOpen).toBe(true);

    unmount();
  });
});
