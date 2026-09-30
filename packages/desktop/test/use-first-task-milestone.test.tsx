// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { useArtifactDeliveryStore } from '../src/renderer/stores/artifactDeliveryStore';
import { useFirstTaskMilestone } from '../src/renderer/hooks/useFirstTaskMilestone';
import type { MilestoneMessage, MilestoneStorage } from '../src/renderer/lib/first-task-milestone';

class MemoryStorage implements MilestoneStorage {
  readonly values = new Map<string, string>();
  writes = 0;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes++;
    this.values.set(key, value);
  }
}

interface HarnessProps {
  storage: MilestoneStorage;
  userId?: string;
  activity?: 'idle' | 'responding';
  messages: MilestoneMessage[];
}

function Harness({ storage, userId = 'user-1', activity = 'idle', messages }: HarnessProps) {
  const milestone = useFirstTaskMilestone({
    userId,
    onboardingCompletedAt: '2026-09-14T10:00:00.000Z',
    taskId: 'task-1',
    messages,
    activity,
    storage,
  });

  return (
    <div>
      <span>{milestone.visible ? 'visible' : 'hidden'}</span>
      <button onClick={milestone.dismiss}>dismiss</button>
    </div>
  );
}

function mount(ui: ReactElement): { container: HTMLDivElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const userMessage: MilestoneMessage = {
  id: 'u1',
  role: 'user',
  content: 'draft a plan',
  timestamp: '2026-09-14T10:01:00.000Z',
};

const assistantMessage: MilestoneMessage = {
  id: 'a1',
  role: 'assistant',
  content: 'Here is the plan',
  timestamp: '2026-09-14T10:02:00.000Z',
};

describe('useFirstTaskMilestone', () => {
  beforeEach(() => useArtifactDeliveryStore.setState({ settled: [] }));
  it('reveals and persists once after a completed idle exchange', () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const storage = new MemoryStorage();
    const view = mount(<Harness storage={storage} messages={[userMessage]} />);
    expect(view.container.textContent).toContain('hidden');

    act(() =>
      view.root.render(<Harness storage={storage} activity="responding" messages={[userMessage, assistantMessage]} />),
    );
    expect(view.container.textContent).toContain('hidden');

    act(() => view.root.render(<Harness storage={storage} messages={[userMessage, assistantMessage]} />));
    expect(view.container.textContent).toContain('hidden');
    expect(storage.writes).toBe(0);
    act(() =>
      useArtifactDeliveryStore
        .getState()
        .record({ taskId: 'task-1', sessionKey: 'session-1', messageId: 'a1', status: 'succeeded' }),
    );
    expect(view.container.textContent).toContain('visible');
    expect(storage.writes).toBe(1);

    act(() => view.container.querySelector('button')!.click());
    expect(view.container.textContent).toContain('hidden');
    expect(storage.writes).toBe(1);
    view.unmount();
  });

  it('does not reveal a milestone already recorded for the account', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'rongying-cube:first-task:v1:user-1',
      JSON.stringify({
        version: 1,
        userId: 'user-1',
        taskId: 'task-1',
        assistantMessageId: 'a1',
        completedAt: '2026-09-14T10:02:00.000Z',
      }),
    );
    const view = mount(<Harness storage={storage} messages={[userMessage, assistantMessage]} />);

    expect(view.container.textContent).toContain('hidden');
    expect(storage.writes).toBe(1);
    view.unmount();
  });

  it.each(['failed', 'needs-review', 'canceled'] as const)('does not celebrate %s delivery', (status) => {
    const storage = new MemoryStorage();
    const view = mount(<Harness storage={storage} messages={[userMessage, assistantMessage]} />);
    act(() =>
      useArtifactDeliveryStore
        .getState()
        .record({ taskId: 'task-1', sessionKey: 'session-1', messageId: 'a1', status }),
    );
    expect(view.container.textContent).toContain('hidden');
    expect(storage.writes).toBe(0);
    view.unmount();
  });
});
