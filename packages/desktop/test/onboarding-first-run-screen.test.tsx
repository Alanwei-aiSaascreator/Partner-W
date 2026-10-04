// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOnboardingWorkMatchInput,
  loadOnboardingProfile,
  saveOnboardingProfile,
  type OnboardingProfile,
  type OnboardingWorkMatchInput,
} from '../src/renderer/lib/user-onboarding';

const translationMode = vi.hoisted(() => ({ real: false }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => (translationMode.real ? actual.useTranslation() : { t: (key: string) => key }),
  };
});

import Onboarding from '../src/renderer/layouts/Onboarding';
import i18n from '../src/renderer/i18n';

function render(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (next: ReactElement) => {
      act(() => root.render(next));
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function click(container: HTMLElement, key: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(key));
  expect(button, `Missing button ${key}`).toBeDefined();
  act(() => button!.click());
}

function industry(container: HTMLElement, code: string) {
  const button = container.querySelector<HTMLButtonElement>(`[data-industry="${code}"]`);
  expect(button).not.toBeNull();
  act(() => button!.click());
}

function fill(container: HTMLElement, selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  expect(input).not.toBeNull();
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function savedAiProfile(usageStatus: 'pending' | 'settled' = 'settled'): OnboardingProfile {
  const profile: OnboardingProfile = {
    version: 3,
    userId: 'user-1',
    nickname: 'Saved nickname',
    introduction: 'Saved introduction',
    role: 'finance',
    customRole: 'Hotel finance',
    useCases: ['office'],
    customGoal: 'Prepare monthly reports',
    selectedAssistantIds: ['family', 'research'],
    responseDetail: 'balanced',
    filePermission: 'ask-every-time',
    completedAt: '2026-10-03T00:00:00.000Z',
    industry: { code: 'H', generalConfirmed: false, source: 'user', catalogVersion: 1 },
    questionnaire: { version: 1, answers: ['yes', 'no', null, 'yes'] },
    persona: { id: 'saved-character', source: 'user', ruleVersion: null },
  };
  return {
    ...profile,
    workMatch: {
      source: 'ai',
      profileVersion: buildOnboardingWorkMatchInput(profile, 'workspace-a').profileVersion,
      requestId: 'saved-request',
      runId: 'saved-run',
      modelId: 'actual-model',
      summary: 'A previously purchased work suggestion',
      starters: ['Review monthly reports'],
      usageStatus,
    },
  };
}

function failNextProfileWrite() {
  const failure = new DOMException('Profile storage unavailable', 'SecurityError');
  const observedErrors: unknown[] = [];
  const onError = (event: ErrorEvent) => {
    if (event.error !== failure) return;
    observedErrors.push(event.error);
    event.preventDefault();
  };
  window.addEventListener('error', onError);
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw failure;
  });
  return {
    observedErrors,
    write,
    restore: () => {
      write.mockRestore();
      window.removeEventListener('error', onError);
    },
  };
}

describe('first-run local onboarding', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    translationMode.real = false;
    window.localStorage.clear();
  });

  it('shows seven industry choices and explicit general, without charging on mount', () => {
    const request = vi.fn();
    const view = render(
      <Onboarding userId="user-1" onComplete={vi.fn()} workMatch={{ scopeKey: 'workspace-a', request }} />,
    );
    expect(view.container.querySelectorAll('[data-industry]')).toHaveLength(8);
    expect(view.container.textContent).toContain('onboarding.firstRun.chargeNotice');
    expect(request).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-question="popular"]')).not.toBeNull();
    view.unmount();
  });

  it('preserves answers across previous/skip and requires confirmation for the basic result', () => {
    const onComplete = vi.fn();
    const view = render(<Onboarding userId="user-1" onComplete={onComplete} />);
    industry(view.container, 'H');
    click(view.container, 'onboarding.firstRun.answerYes');
    click(view.container, 'onboarding.firstRun.answerNo');
    click(view.container, 'onboarding.firstRun.questionSkip');
    click(view.container, 'onboarding.firstRun.questionBack');
    expect(view.container.querySelector('[data-question="math"]')).not.toBeNull();
    click(view.container, 'onboarding.firstRun.questionSkip');
    click(view.container, 'onboarding.firstRun.answerYes');
    click(view.container, 'onboarding.firstRun.useBasic');
    expect(onComplete).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('onboarding.firstRun.sourceBasic');
    expect(view.container.textContent).toContain('onboarding.firstRun.personaUnavailable');
    click(view.container, 'onboarding.firstRun.confirm');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 3,
        userId: 'user-1',
        industry: { code: 'H', generalConfirmed: false, source: 'user', catalogVersion: 1 },
        questionnaire: { version: 1, answers: ['yes', 'no', null, 'yes'] },
        persona: { id: null, source: 'default', ruleVersion: null },
        workMatch: expect.objectContaining({ source: 'basic' }),
      }),
    );
    view.unmount();
  });

  it('calls the optional matching adapter only on explicit submit and records validated provenance', async () => {
    const request = vi.fn(async (input: OnboardingWorkMatchInput) => ({
      profileVersion: input.profileVersion,
      requestId: 'request-1',
      runId: 'run-1',
      modelId: 'actual-model',
      summary: 'Organize the work clearly',
      selectedAssistantIds: ['office'],
      starters: ['Organize a report'],
      usageStatus: 'pending',
    }));
    const onComplete = vi.fn();
    const view = render(
      <Onboarding userId="user-1" onComplete={onComplete} workMatch={{ scopeKey: 'workspace-a', request }} />,
    );
    industry(view.container, 'general');
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      click(view.container, 'onboarding.firstRun.generate');
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).not.toHaveProperty('questionnaire');
    expect(view.container.textContent).toContain('onboarding.firstRun.sourceAi');
    click(view.container, 'onboarding.firstRun.confirm');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        workMatch: expect.objectContaining({
          source: 'ai',
          requestId: 'request-1',
          runId: 'run-1',
          modelId: 'actual-model',
          usageStatus: 'pending',
        }),
      }),
    );
    view.unmount();
  });

  it('keeps the basic choice when a pending model result arrives late', async () => {
    let resolveReply: ((value: unknown) => void) | undefined;
    let input: OnboardingWorkMatchInput | undefined;
    const request = vi.fn((value: OnboardingWorkMatchInput) => {
      input = value;
      return new Promise<unknown>((resolve) => {
        resolveReply = resolve;
      });
    });
    const onComplete = vi.fn();
    const view = render(
      <Onboarding userId="user-1" onComplete={onComplete} workMatch={{ scopeKey: 'workspace-a', request }} />,
    );
    industry(view.container, 'C');
    click(view.container, 'onboarding.firstRun.generate');
    click(view.container, 'onboarding.firstRun.useBasic');
    await act(async () => {
      resolveReply!({
        profileVersion: input!.profileVersion,
        requestId: 'r',
        runId: 'u',
        modelId: 'm',
        summary: 'Late suggestion',
        selectedAssistantIds: ['office'],
        starters: ['Task'],
        usageStatus: 'settled',
      });
    });
    expect(view.container.textContent).toContain('onboarding.firstRun.sourceBasic');
    expect(view.container.textContent).not.toContain('Late suggestion');
    click(view.container, 'onboarding.firstRun.confirm');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ workMatch: expect.objectContaining({ source: 'basic' }) }),
    );
    view.unmount();
  });

  it('remounts local state when account changes and never imports the previous account profile', () => {
    const view = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    industry(view.container, 'H');
    click(view.container, 'onboarding.firstRun.answerYes');
    view.rerender(<Onboarding userId="user-2" onComplete={vi.fn()} />);
    expect(view.container.querySelector('[data-industry="H"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(view.container.querySelector('[data-question="popular"]')).not.toBeNull();
    view.unmount();
  });

  it('does not apply a pending reply to a changed workspace scope', async () => {
    let resolveReply: ((value: unknown) => void) | undefined;
    let input: OnboardingWorkMatchInput | undefined;
    let signal: AbortSignal | undefined;
    const request = vi.fn((value: OnboardingWorkMatchInput, abortSignal: AbortSignal) => {
      input = value;
      signal = abortSignal;
      return new Promise<unknown>((resolve) => {
        resolveReply = resolve;
      });
    });
    const onComplete = vi.fn();
    const view = render(
      <Onboarding userId="user-1" onComplete={onComplete} workMatch={{ scopeKey: 'workspace-a', request }} />,
    );
    industry(view.container, 'H');
    click(view.container, 'onboarding.firstRun.generate');
    view.rerender(
      <Onboarding userId="user-1" onComplete={onComplete} workMatch={{ scopeKey: 'workspace-b', request }} />,
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolveReply!({
        profileVersion: input!.profileVersion,
        requestId: 'r',
        runId: 'u',
        modelId: 'm',
        summary: 'Old workspace result',
        selectedAssistantIds: ['office'],
        starters: ['Task'],
        usageStatus: 'settled',
      });
    });
    expect(view.container.textContent).not.toContain('Old workspace result');
    expect(view.container.querySelector('[data-industry="H"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(onComplete).not.toHaveBeenCalled();
    view.unmount();
  });

  it('offers the basic plan after a model reply with an invented assistant', async () => {
    const request = vi.fn(async (input: OnboardingWorkMatchInput) => ({
      profileVersion: input.profileVersion,
      requestId: 'r',
      runId: 'u',
      modelId: 'm',
      summary: 'Untrusted result',
      selectedAssistantIds: ['unknown'],
      starters: ['Task'],
      usageStatus: 'settled',
    }));
    const view = render(
      <Onboarding userId="user-1" onComplete={vi.fn()} workMatch={{ scopeKey: 'workspace-a', request }} />,
    );
    industry(view.container, 'H');
    await act(async () => {
      click(view.container, 'onboarding.firstRun.generate');
    });
    expect(view.container.textContent).toContain('onboarding.firstRun.matchFailed');
    expect(view.container.textContent).not.toContain('Untrusted result');
    click(view.container, 'onboarding.firstRun.useBasic');
    expect(view.container.textContent).toContain('onboarding.firstRun.sourceBasic');
    view.unmount();
  });

  it('allows reselecting an AI-recommended assistant after toggling it off', async () => {
    const request = vi.fn(async (input: OnboardingWorkMatchInput) => ({
      profileVersion: input.profileVersion,
      requestId: 'r',
      runId: 'u',
      modelId: 'm',
      summary: 'Valid result',
      selectedAssistantIds: ['office'],
      starters: ['Task'],
      usageStatus: 'settled',
    }));
    const view = render(
      <Onboarding userId="user-1" onComplete={vi.fn()} workMatch={{ scopeKey: 'workspace-a', request }} />,
    );
    industry(view.container, 'H');
    await act(async () => {
      click(view.container, 'onboarding.firstRun.generate');
    });
    const assistant = () => view.container.querySelector<HTMLButtonElement>('[data-assistant="office"]')!;
    act(() => assistant().click());
    expect(assistant().getAttribute('aria-pressed')).toBe('false');
    act(() => assistant().click());
    expect(assistant().getAttribute('aria-pressed')).toBe('true');
    view.unmount();
  });

  it('preserves the saved character id and provenance when its artwork is unavailable', () => {
    const onComplete = vi.fn();
    const view = render(
      <Onboarding
        userId="user-1"
        mode="edit"
        onComplete={onComplete}
        initialProfile={{
          version: 3,
          userId: 'user-1',
          nickname: '',
          useCases: ['office'],
          customGoal: '',
          completedAt: '',
          industry: { code: 'H', generalConfirmed: false, source: 'user', catalogVersion: 1 },
          questionnaire: { version: 1, answers: [null, null, null, null] },
          persona: { id: 'approved-user-character', source: 'user', ruleVersion: null },
          workMatch: { source: 'basic', profileVersion: 'old' },
        }}
      />,
    );
    click(view.container, 'onboarding.firstRun.useBasic');
    expect(view.container.textContent).toContain('onboarding.firstRun.personaSourceUser');
    expect(view.container.textContent).not.toContain('onboarding.firstRun.personaSourceDefault');
    click(view.container, 'onboarding.firstRun.confirm');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ persona: { id: 'approved-user-character', source: 'user', ruleVersion: null } }),
    );
    view.unmount();
  });

  it.each(['pending', 'settled'] as const)(
    'saves ordinary v3 edits without losing %s AI receipts or manually selected assistants',
    (usageStatus) => {
      const profile = savedAiProfile(usageStatus);
      const request = vi.fn();
      const onComplete = vi.fn((result: OnboardingProfile) => saveOnboardingProfile(result));
      const view = render(
        <Onboarding
          userId="user-1"
          mode="edit"
          initialProfile={profile}
          onComplete={onComplete}
          workMatch={{ scopeKey: 'workspace-a', request }}
        />,
      );
      fill(view.container, '[data-first-run-nickname]', 'Edited nickname');
      fill(view.container, 'input[maxlength="400"]', 'Edited introduction');
      click(view.container, 'onboarding.firstRun.answerNo');
      click(view.container, 'onboarding.save');
      expect(onComplete).toHaveBeenCalledTimes(1);
      const result = loadOnboardingProfile('user-1');
      expect(result).toMatchObject({
        nickname: 'Edited nickname',
        introduction: 'Edited introduction',
        questionnaire: { version: 1, answers: ['no', 'no', null, 'yes'] },
        selectedAssistantIds: ['family', 'research'],
        persona: profile.persona,
        workMatch: profile.workMatch,
      });
      expect(request).not.toHaveBeenCalled();
      expect(profile.nickname).toBe('Saved nickname');
      view.unmount();
    },
  );

  it('keeps the original receipt version after work fields change without purchasing another suggestion', () => {
    const profile = savedAiProfile();
    const request = vi.fn();
    const onComplete = vi.fn();
    const view = render(
      <Onboarding
        userId="user-1"
        mode="edit"
        initialProfile={profile}
        onComplete={onComplete}
        workMatch={{ scopeKey: 'workspace-a', request }}
      />,
    );
    industry(view.container, 'C');
    fill(view.container, '[data-first-run-goal]', 'Prepare manufacturing budgets');
    click(view.container, 'onboarding.save');
    expect(onComplete).toHaveBeenCalledTimes(1);
    const saved = onComplete.mock.calls[0][0] as OnboardingProfile;
    expect(saved.customGoal).toBe('Prepare manufacturing budgets');
    expect(saved.industry?.code).toBe('C');
    expect(saved.workMatch).toEqual(profile.workMatch);
    expect(buildOnboardingWorkMatchInput(saved, 'workspace-a').profileVersion).not.toBe(
      saved.workMatch?.profileVersion,
    );
    expect(saved.selectedAssistantIds).toEqual(['family', 'research']);
    expect(request).not.toHaveBeenCalled();
    view.unmount();
  });

  it('preserves the latest explicit AI result and manual assistant choices through later profile edits', async () => {
    const profile = savedAiProfile();
    const request = vi.fn(async (input: OnboardingWorkMatchInput) => ({
      profileVersion: input.profileVersion,
      requestId: 'new-request',
      runId: 'new-run',
      modelId: 'actual-model',
      summary: 'New suggestion',
      selectedAssistantIds: ['office', 'research'],
      starters: ['Prepare a report'],
      usageStatus: 'settled',
    }));
    const onComplete = vi.fn();
    const view = render(
      <Onboarding
        userId="user-1"
        mode="edit"
        initialProfile={profile}
        onComplete={onComplete}
        workMatch={{ scopeKey: 'workspace-a', request }}
      />,
    );
    await act(async () => {
      click(view.container, 'onboarding.firstRun.generate');
    });
    act(() => view.container.querySelector<HTMLButtonElement>('[data-assistant="office"]')!.click());
    click(view.container, 'onboarding.firstRun.editProfile');
    fill(view.container, '[data-first-run-nickname]', 'Another nickname');
    click(view.container, 'onboarding.save');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: 'Another nickname',
        selectedAssistantIds: ['research'],
        workMatch: expect.objectContaining({ source: 'ai', requestId: 'new-request', runId: 'new-run' }),
      }),
    );
    expect(request).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('preserves a saved basic result and user assistant choices on ordinary save', () => {
    const profile: OnboardingProfile = {
      ...savedAiProfile(),
      workMatch: { source: 'basic', profileVersion: 'saved-basic-version' },
    };
    const onComplete = vi.fn();
    const view = render(<Onboarding userId="user-1" mode="edit" initialProfile={profile} onComplete={onComplete} />);
    fill(view.container, '[data-first-run-nickname]', 'Basic nickname');
    click(view.container, 'onboarding.save');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: 'Basic nickname',
        selectedAssistantIds: ['family', 'research'],
        workMatch: profile.workMatch,
      }),
    );
    view.unmount();
  });

  it('keeps ordinary save disabled when the user deselects the last assistant instead of restoring an old choice', async () => {
    const request = vi.fn(async (input: OnboardingWorkMatchInput) => ({
      profileVersion: input.profileVersion,
      requestId: 'new-request',
      runId: 'new-run',
      modelId: 'actual-model',
      summary: 'New suggestion',
      selectedAssistantIds: ['office'],
      starters: ['Prepare a report'],
      usageStatus: 'settled',
    }));
    const onComplete = vi.fn();
    const view = render(
      <Onboarding
        userId="user-1"
        mode="edit"
        initialProfile={savedAiProfile()}
        onComplete={onComplete}
        workMatch={{ scopeKey: 'workspace-a', request }}
      />,
    );
    await act(async () => {
      click(view.container, 'onboarding.firstRun.generate');
    });
    act(() => view.container.querySelector<HTMLButtonElement>('[data-assistant="office"]')!.click());
    click(view.container, 'onboarding.firstRun.editProfile');
    const save = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'onboarding.save',
    )!;
    expect(save.disabled).toBe(true);
    act(() => {
      save.focus();
      save.click();
    });
    expect(document.activeElement).not.toBe(save);
    expect(onComplete).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('still replaces the saved AI suggestion when the user explicitly chooses the basic plan', () => {
    const profile = savedAiProfile();
    const request = vi.fn();
    const onComplete = vi.fn();
    const view = render(
      <Onboarding
        userId="user-1"
        mode="edit"
        initialProfile={profile}
        onComplete={onComplete}
        workMatch={{ scopeKey: 'workspace-a', request }}
      />,
    );
    click(view.container, 'onboarding.firstRun.useBasic');
    expect(view.container.textContent).toContain('onboarding.firstRun.sourceBasic');
    click(view.container, 'onboarding.firstRun.confirm');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ workMatch: { source: 'basic', profileVersion: profile.workMatch?.profileVersion } }),
    );
    expect(onComplete.mock.calls[0][0].selectedAssistantIds).not.toEqual(profile.selectedAssistantIds);
    expect(request).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each([1, 2] as const)('keeps legacy v%s edits on the existing uncharged save flow', (version) => {
    const profile: OnboardingProfile = {
      version,
      userId: 'user-1',
      nickname: 'Legacy nickname',
      role: 'finance',
      customRole: 'Hotel finance',
      useCases: ['office'],
      customGoal: 'Prepare monthly reports',
      selectedAssistantIds: ['family', 'research'],
      responseDetail: 'balanced',
      filePermission: 'ask-every-time',
      completedAt: '2026-09-30T00:00:00.000Z',
    };
    const request = vi.fn();
    const onComplete = vi.fn();
    const view = render(
      <Onboarding
        userId="user-1"
        mode="edit"
        initialProfile={profile}
        onComplete={onComplete}
        workMatch={{ scopeKey: 'workspace-a', request }}
      />,
    );
    click(view.container, 'onboarding.next');
    click(view.container, 'onboarding.next');
    click(view.container, 'onboarding.next');
    click(view.container, 'onboarding.save');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, selectedAssistantIds: ['family', 'research'] }),
    );
    expect(onComplete.mock.calls[0][0]).not.toHaveProperty('workMatch');
    expect(request).not.toHaveBeenCalled();
    view.unmount();
  });

  it('shows a save error and preserves the first-run basic draft until a user retry succeeds', () => {
    const onComplete = vi.fn((profile: OnboardingProfile) => saveOnboardingProfile(profile));
    const view = render(<Onboarding userId="user-1" onComplete={onComplete} />);
    fill(view.container, '[data-first-run-nickname]', 'First-run nickname');
    fill(view.container, 'input[maxlength="400"]', 'First-run introduction');
    fill(view.container, '[data-first-run-goal]', 'First-run monthly report');
    industry(view.container, 'H');
    click(view.container, 'onboarding.firstRun.answerYes');
    click(view.container, 'onboarding.firstRun.answerNo');
    click(view.container, 'onboarding.firstRun.useBasic');
    const manual = view.container.querySelector<HTMLButtonElement>('[data-assistant]')!;
    act(() => manual.click());
    const selected = [...view.container.querySelectorAll('[data-assistant][aria-pressed="true"]')].map((button) =>
      button.getAttribute('data-assistant'),
    );
    const failure = failNextProfileWrite();
    try {
      click(view.container, 'onboarding.firstRun.confirm');
      expect(failure.write).toHaveBeenCalledTimes(1);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('teams.wizard.saveError');
      expect(failure.observedErrors).toEqual([]);
      expect(loadOnboardingProfile('user-1')).toBeNull();
      expect(onComplete.mock.calls[0][0]).toMatchObject({
        nickname: 'First-run nickname',
        introduction: 'First-run introduction',
        customGoal: 'First-run monthly report',
        questionnaire: { answers: ['yes', 'no', null, null] },
        selectedAssistantIds: selected,
        workMatch: { source: 'basic' },
      });
      expect(view.container.querySelector('[data-match-source="basic"]')).not.toBeNull();
      click(view.container, 'onboarding.firstRun.confirm');
      expect(onComplete).toHaveBeenCalledTimes(2);
      expect(loadOnboardingProfile('user-1')).toMatchObject({
        nickname: 'First-run nickname',
        introduction: 'First-run introduction',
        customGoal: 'First-run monthly report',
        questionnaire: { answers: ['yes', 'no', null, null] },
        selectedAssistantIds: selected,
      });
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      click(view.container, 'onboarding.firstRun.editProfile');
      expect(view.container.querySelector<HTMLInputElement>('[data-first-run-nickname]')!.value).toBe(
        'First-run nickname',
      );
      expect(view.container.querySelector<HTMLInputElement>('input[maxlength="400"]')!.value).toBe(
        'First-run introduction',
      );
      expect(view.container.querySelector<HTMLTextAreaElement>('[data-first-run-goal]')!.value).toBe(
        'First-run monthly report',
      );
    } finally {
      failure.restore();
      view.unmount();
    }
  });

  it('keeps an explicitly purchased first-run AI result and hand selection after storage failure without another request', async () => {
    const request = vi.fn(async (input: OnboardingWorkMatchInput) => ({
      profileVersion: input.profileVersion,
      requestId: 'first-run-request',
      runId: 'first-run-run',
      modelId: 'actual-model',
      summary: 'Keep this purchased suggestion',
      selectedAssistantIds: ['office', 'research'],
      starters: ['Prepare a report'],
      usageStatus: 'pending',
    }));
    const onComplete = vi.fn((profile: OnboardingProfile) => saveOnboardingProfile(profile));
    const view = render(
      <Onboarding userId="user-1" onComplete={onComplete} workMatch={{ scopeKey: 'workspace-a', request }} />,
    );
    fill(view.container, '[data-first-run-nickname]', 'AI draft nickname');
    industry(view.container, 'H');
    await act(async () => click(view.container, 'onboarding.firstRun.generate'));
    act(() => view.container.querySelector<HTMLButtonElement>('[data-assistant="office"]')!.click());
    const failure = failNextProfileWrite();
    try {
      click(view.container, 'onboarding.firstRun.confirm');
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('teams.wizard.saveError');
      expect(view.container.querySelector('[data-match-source="ai"]')).not.toBeNull();
      expect(view.container.textContent).toContain('Keep this purchased suggestion');
      expect(view.container.textContent).toContain('onboarding.firstRun.usagePending');
      expect(view.container.querySelector('[data-assistant="office"]')!.getAttribute('aria-pressed')).toBe('false');
      expect(view.container.querySelector('[data-assistant="research"]')!.getAttribute('aria-pressed')).toBe('true');
      expect(loadOnboardingProfile('user-1')).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
      expect(failure.observedErrors).toEqual([]);
      const first = onComplete.mock.calls[0][0];
      click(view.container, 'onboarding.firstRun.confirm');
      expect(onComplete).toHaveBeenCalledTimes(2);
      expect(loadOnboardingProfile('user-1')).toMatchObject({
        nickname: 'AI draft nickname',
        selectedAssistantIds: ['research'],
        workMatch: first.workMatch,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      failure.restore();
      view.unmount();
    }
  });

  it.each(['pending', 'settled'] as const)(
    'preserves v3 input and the %s AI receipt while a visible save failure is retried',
    (usageStatus) => {
      const original = savedAiProfile(usageStatus);
      saveOnboardingProfile(original);
      const request = vi.fn();
      const onCancel = vi.fn();
      const onComplete = vi.fn((profile: OnboardingProfile) => saveOnboardingProfile(profile));
      const view = render(
        <Onboarding
          userId="user-1"
          mode="edit"
          initialProfile={original}
          onComplete={onComplete}
          onCancel={onCancel}
          workMatch={{ scopeKey: 'workspace-a', request }}
        />,
      );
      fill(view.container, '[data-first-run-nickname]', 'Unsaved edited nickname');
      fill(view.container, 'input[maxlength="400"]', 'Unsaved introduction');
      fill(view.container, '[data-first-run-goal]', 'Unsaved report goal');
      industry(view.container, 'C');
      click(view.container, 'onboarding.firstRun.answerNo');
      const failure = failNextProfileWrite();
      try {
        click(view.container, 'onboarding.save');
        expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('teams.wizard.saveError');
        expect(view.container.querySelector<HTMLInputElement>('[data-first-run-nickname]')!.value).toBe(
          'Unsaved edited nickname',
        );
        expect(view.container.querySelector<HTMLInputElement>('input[maxlength="400"]')!.value).toBe(
          'Unsaved introduction',
        );
        expect(view.container.querySelector<HTMLTextAreaElement>('[data-first-run-goal]')!.value).toBe(
          'Unsaved report goal',
        );
        expect(view.container.querySelector('[data-industry="C"]')!.getAttribute('aria-pressed')).toBe('true');
        expect(loadOnboardingProfile('user-1')).toMatchObject({
          nickname: original.nickname,
          workMatch: original.workMatch,
        });
        expect(onCancel).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        expect(failure.observedErrors).toEqual([]);
        click(view.container, 'onboarding.save');
        expect(onComplete).toHaveBeenCalledTimes(2);
        expect(loadOnboardingProfile('user-1')).toMatchObject({
          nickname: 'Unsaved edited nickname',
          introduction: 'Unsaved introduction',
          customGoal: 'Unsaved report goal',
          industry: { code: 'C' },
          questionnaire: { answers: ['no', 'no', null, 'yes'] },
          selectedAssistantIds: ['family', 'research'],
          persona: original.persona,
          workMatch: original.workMatch,
        });
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
        expect(request).not.toHaveBeenCalled();
      } finally {
        failure.restore();
        view.unmount();
      }
    },
  );

  it.each([1, 2] as const)(
    'keeps legacy v%s edit controls and choices after a save error for a real button retry',
    (version) => {
      const original: OnboardingProfile = { ...savedAiProfile(), version, workMatch: undefined };
      saveOnboardingProfile(original);
      const onComplete = vi.fn((profile: OnboardingProfile) => saveOnboardingProfile(profile));
      const onCancel = vi.fn();
      const request = vi.fn();
      const view = render(
        <Onboarding
          userId="user-1"
          mode="edit"
          initialProfile={original}
          onComplete={onComplete}
          onCancel={onCancel}
          workMatch={{ scopeKey: 'workspace-a', request }}
        />,
      );
      click(view.container, 'onboarding.next');
      fill(view.container, 'textarea', 'Edited legacy goal');
      click(view.container, 'onboarding.next');
      const manual = view.container.querySelector<HTMLButtonElement>('[data-assistant][aria-pressed="false"]')!;
      act(() => manual.click());
      click(view.container, 'onboarding.next');
      fill(view.container, 'input', 'Edited legacy nickname');
      click(view.container, 'onboarding.responseOptions.detailed');
      click(view.container, 'onboarding.fileOptions.task-folder');
      const failure = failNextProfileWrite();
      try {
        click(view.container, 'onboarding.save');
        expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('teams.wizard.saveError');
        expect(view.container.querySelector<HTMLInputElement>('input')!.value).toBe('Edited legacy nickname');
        expect(loadOnboardingProfile('user-1')).toMatchObject({ nickname: original.nickname });
        expect(onCancel).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        expect(failure.observedErrors).toEqual([]);
        const first = onComplete.mock.calls[0][0];
        expect(first.selectedAssistantIds).toContain(manual.dataset.assistant);
        click(view.container, 'onboarding.save');
        expect(onComplete).toHaveBeenCalledTimes(2);
        expect(loadOnboardingProfile('user-1')).toMatchObject({
          version: 2,
          nickname: 'Edited legacy nickname',
          customGoal: 'Edited legacy goal',
          selectedAssistantIds: first.selectedAssistantIds,
          responseDetail: 'detailed',
          filePermission: 'task-folder',
        });
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
        expect(request).not.toHaveBeenCalled();
      } finally {
        failure.restore();
        view.unmount();
      }
    },
  );

  it.each(
    (['en', 'zh'] as const).flatMap((language) =>
      (['first-run', 'v3-edit', 'legacy-edit'] as const).map((surface) => ({ language, surface })),
    ),
  )('renders the real $language save error on $surface and allows an explicit retry', async ({ language, surface }) => {
    await i18n.changeLanguage(language);
    translationMode.real = true;
    const initialProfile = surface === 'v3-edit' ? savedAiProfile() : { ...savedAiProfile(), version: 2 as const };
    const onComplete = vi.fn((profile: OnboardingProfile) => saveOnboardingProfile(profile));
    const request = vi.fn();
    const view = render(
      <Onboarding
        userId="user-1"
        mode={surface === 'first-run' ? 'first-run' : 'edit'}
        initialProfile={surface === 'first-run' ? null : initialProfile}
        onComplete={onComplete}
        workMatch={{ scopeKey: 'workspace-a', request }}
      />,
    );
    if (surface === 'first-run') {
      industry(view.container, 'H');
      click(view.container, i18n.t('onboarding.firstRun.useBasic'));
    } else if (surface === 'legacy-edit') {
      for (let step = 0; step < 3; step++) click(view.container, i18n.t('onboarding.next'));
    }
    const saveLabel = i18n.t(surface === 'first-run' ? 'onboarding.firstRun.confirm' : 'onboarding.save');
    const failure = failNextProfileWrite();
    try {
      expect(i18n.exists('teams.wizard.saveError')).toBe(true);
      expect(i18n.exists('team.wizard.saveError')).toBe(false);
      click(view.container, saveLabel);
      const alert = view.container.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe(i18n.t('teams.wizard.saveError'));
      expect(alert?.textContent).not.toBe('teams.wizard.saveError');
      expect(failure.observedErrors).toEqual([]);
      expect(loadOnboardingProfile('user-1')).toBeNull();
      click(view.container, saveLabel);
      expect(onComplete).toHaveBeenCalledTimes(2);
      expect(loadOnboardingProfile('user-1')).toMatchObject({ userId: 'user-1' });
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      expect(request).not.toHaveBeenCalled();
    } finally {
      failure.restore();
      view.unmount();
      translationMode.real = false;
      await i18n.changeLanguage('en');
    }
  });
});
