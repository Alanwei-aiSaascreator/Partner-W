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
  const sendOtp = vi.fn(async () => ({ ok: true }));
  const verifyOtp = vi.fn(async () => ({ ok: true }));

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
    expect(container.textContent).toContain('mainArea.compassAssistant');
    expect(container.textContent).toContain('assistantWorkspaces.compass.description');
    expect(container.textContent).not.toContain('assistantDefinitions.main');

    unmount();
  });

  it('shows four concise purpose choices and remembers the selected purpose', () => {
    const { container, unmount } = render(<Login onSignedIn={vi.fn()} />);
    const choices = container.querySelectorAll('[data-login-purpose]');

    expect(choices).toHaveLength(4);
    expect(container.textContent).toContain('login.purposes.content');
    expect(container.textContent).toContain('login.purposes.office');
    expect(container.textContent).toContain('login.purposes.ecommerce');
    expect(container.textContent).toContain('login.purposes.research');

    act(() => (choices[1] as HTMLButtonElement).click());
    expect(choices[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('rongying-login-purpose')).toBe('office');
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
