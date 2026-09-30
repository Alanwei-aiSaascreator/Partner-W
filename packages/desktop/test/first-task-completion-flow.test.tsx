// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useArtifactDeliveryStore } from '../src/renderer/stores/artifactDeliveryStore';
import type { MilestoneStorage } from '../src/renderer/lib/first-task-milestone';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import FirstTaskCompletionFlow from '../src/renderer/layouts/MainArea/FirstTaskCompletionFlow';

class MemoryStorage implements MilestoneStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
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

describe('FirstTaskCompletionFlow', () => {
  beforeEach(() =>
    useArtifactDeliveryStore.setState({
      settled: [
        { taskId: 'task-1', sessionKey: 'session-1', messageId: 'assistant-message', status: 'succeeded' },
        { taskId: 'task-2', sessionKey: 'session-2', messageId: 'assistant-message', status: 'succeeded' },
      ],
    }),
  );
  it('reveals the first completion actions and consumes the card after an action', () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const storage = new MemoryStorage();
    const onContinue = vi.fn();
    const onNewTask = vi.fn();
    const onViewUsage = vi.fn();
    const onGenerateFile = vi.fn();
    const onViewArtifacts = vi.fn();
    const { container, unmount } = render(
      <FirstTaskCompletionFlow
        userId="user-1"
        onboardingCompletedAt="2026-09-14T08:00:00.000Z"
        taskId="task-1"
        messages={[
          {
            id: 'user-message',
            role: 'user',
            content: '帮我整理一份拍摄清单',
            timestamp: '2026-09-14T08:01:00.000Z',
          },
          {
            id: 'assistant-message',
            role: 'assistant',
            content: '这是整理好的拍摄清单',
            timestamp: '2026-09-14T08:01:10.000Z',
          },
        ]}
        activity="idle"
        storage={storage}
        artifactCount={0}
        onContinue={onContinue}
        onNewTask={onNewTask}
        onViewUsage={onViewUsage}
        onGenerateFile={onGenerateFile}
        onViewArtifacts={onViewArtifacts}
      />,
    );

    expect(container.textContent).toContain('firstTaskCompletion.title');
    const buttons = [...container.querySelectorAll('button')];
    const continueButton = buttons.find((button) => button.textContent === 'firstTaskCompletion.continue');
    act(() => continueButton!.click());

    expect(onContinue).toHaveBeenCalledOnce();
    expect(onNewTask).not.toHaveBeenCalled();
    expect(onViewUsage).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('firstTaskCompletion.title');
    unmount();
  });

  it('passes the real artifact count and artifact action through before dismissing', () => {
    const storage = new MemoryStorage();
    const onViewArtifacts = vi.fn();
    const { container, unmount } = render(
      <FirstTaskCompletionFlow
        userId="user-2"
        onboardingCompletedAt="2026-09-14T08:00:00.000Z"
        taskId="task-2"
        messages={[
          {
            id: 'user-message',
            role: 'user',
            content: '帮我整理一份拍摄清单',
            timestamp: '2026-09-14T08:01:00.000Z',
          },
          {
            id: 'assistant-message',
            role: 'assistant',
            content: '这是整理好的拍摄清单',
            timestamp: '2026-09-14T08:01:10.000Z',
          },
        ]}
        activity="idle"
        storage={storage}
        artifactCount={2}
        onContinue={vi.fn()}
        onNewTask={vi.fn()}
        onViewUsage={vi.fn()}
        onGenerateFile={vi.fn()}
        onViewArtifacts={onViewArtifacts}
      />,
    );

    expect(container.textContent).toContain('taskWorkbench.viewArtifacts');
    expect(container.textContent).not.toContain('taskWorkbench.generateFile');
    const viewArtifacts = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'taskWorkbench.viewArtifacts',
    );
    act(() => viewArtifacts!.click());

    expect(onViewArtifacts).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('firstTaskCompletion.title');
    unmount();
  });
});
