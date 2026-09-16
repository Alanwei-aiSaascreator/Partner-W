// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingProfile } from '../src/renderer/lib/user-onboarding';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import Onboarding from '../src/renderer/layouts/Onboarding';

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

function buttonFor(container: HTMLElement, key: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(key))!;
}

function setInput(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Onboarding', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
  });

  it('uses a four-step role, purpose, assistant, and personalization flow', () => {
    const onComplete = vi.fn();
    const { container, unmount } = render(
      <Onboarding userId="user-1" defaultNickname="小荣" onComplete={onComplete} />,
    );

    expect(container.textContent).toContain('onboarding.steps.role');
    expect(container.textContent).toContain('onboarding.roleTitle');
    act(() => buttonFor(container, 'onboarding.roles.operations.title').click());
    act(() => buttonFor(container, 'onboarding.next').click());

    expect(container.textContent).toContain('onboarding.purposeTitle');
    act(() => {
      buttonFor(container, 'onboarding.useCases.content.title').click();
      buttonFor(container, 'onboarding.useCases.video.title').click();
    });
    act(() => buttonFor(container, 'onboarding.next').click());

    expect(container.textContent).toContain('onboarding.assignmentTitle');
    expect(container.querySelector('[data-assistant="content"]')).not.toBeNull();
    expect(container.querySelector('[data-assistant="photography"]')).not.toBeNull();
    act(() => buttonFor(container, 'onboarding.next').click());

    expect(container.textContent).toContain('onboarding.personalizeTitle');
    act(() => buttonFor(container, 'onboarding.finish').click());

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 2,
        userId: 'user-1',
        nickname: '小荣',
        role: 'operations',
        useCases: ['content', 'video'],
        selectedAssistantIds: expect.arrayContaining(['content', 'photography']),
        responseDetail: 'balanced',
        filePermission: 'ask-every-time',
      }),
    );
    unmount();
  });

  it('prefills the login purpose on step two but still lets the user change it', () => {
    window.localStorage.setItem('rongying-login-purpose', 'office');
    const { container, unmount } = render(<Onboarding userId="user-purpose" onComplete={vi.fn()} />);

    act(() => buttonFor(container, 'onboarding.roles.owner.title').click());
    act(() => buttonFor(container, 'onboarding.next').click());
    const office = buttonFor(container, 'onboarding.useCases.office.title');
    const content = buttonFor(container, 'onboarding.useCases.content.title');
    expect(office.getAttribute('aria-pressed')).toBe('true');
    act(() => {
      office.click();
      content.click();
    });
    expect(office.getAttribute('aria-pressed')).toBe('false');
    expect(content.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('rongying-login-purpose')).toBe('office');
    unmount();
  });

  it('uses free role and goal text in assistant recommendations', () => {
    const onComplete = vi.fn();
    const { container, unmount } = render(<Onboarding userId="user-2" onComplete={onComplete} />);

    act(() => buttonFor(container, 'onboarding.roles.custom.title').click());
    setInput(container.querySelector('[data-custom-role]') as HTMLInputElement, '门店短视频负责人');
    act(() => buttonFor(container, 'onboarding.next').click());
    setInput(
      container.querySelector('[data-onboarding-goal] textarea') as HTMLTextAreaElement,
      '  每周生成三个短视频脚本  ',
    );
    act(() => buttonFor(container, 'onboarding.next').click());
    expect(container.querySelector('[data-assistant="photography"]')).not.toBeNull();
    act(() => buttonFor(container, 'onboarding.next').click());
    act(() => buttonFor(container, 'onboarding.finish').click());

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'custom',
        customRole: '门店短视频负责人',
        customGoal: '每周生成三个短视频脚本',
        selectedAssistantIds: expect.arrayContaining(['photography']),
      }),
    );
    unmount();
  });

  it('preloads edit mode and cancels without saving changes', () => {
    const initialProfile: OnboardingProfile = {
      version: 2,
      userId: 'user-edit',
      nickname: '原昵称',
      role: 'finance',
      customRole: '',
      useCases: ['office'],
      customGoal: '整理月度报表',
      selectedAssistantIds: ['office'],
      responseDetail: 'detailed',
      filePermission: 'task-folder',
      completedAt: '2026-09-16T00:00:00.000Z',
    };
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    const { container, unmount } = render(
      <Onboarding
        userId="user-edit"
        mode="edit"
        initialProfile={initialProfile}
        onComplete={onComplete}
        onCancel={onCancel}
      />,
    );

    expect(buttonFor(container, 'onboarding.roles.finance.title').getAttribute('aria-pressed')).toBe('true');
    act(() => buttonFor(container, 'onboarding.cancel').click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    unmount();
  });
});
