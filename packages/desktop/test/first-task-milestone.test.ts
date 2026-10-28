import { describe, expect, it } from 'vitest';
import {
  detectFirstTaskCompletion,
  loadFirstTaskMilestone,
  saveFirstTaskMilestone,
  type FirstTaskMilestoneRecord,
  type MilestoneStorage,
} from '../src/renderer/lib/first-task-milestone';

class MemoryStorage implements MilestoneStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const baseInput = {
  userId: 'user-1',
  taskId: 'task-1',
  onboardingCompletedAt: '2026-09-14T10:00:00.000Z',
  activity: 'idle' as const,
  deliveredMessageIds: ['a1'],
  messages: [
    { id: 'u1', role: 'user' as const, content: 'draft a plan', timestamp: '2026-09-14T10:01:00.000Z' },
    {
      id: 'a1',
      role: 'assistant' as const,
      content: 'Here is the plan',
      timestamp: '2026-09-14T10:02:00.000Z',
    },
  ],
};

describe('first task milestone', () => {
  it('recognizes the first completed real exchange after onboarding', () => {
    expect(detectFirstTaskCompletion(baseInput)).toEqual({
      version: 1,
      userId: 'user-1',
      taskId: 'task-1',
      assistantMessageId: 'a1',
      completedAt: '2026-09-14T10:02:00.000Z',
    });
  });

  it('rejects incomplete, empty, out-of-order, and historical exchanges', () => {
    expect(detectFirstTaskCompletion({ ...baseInput, deliveredMessageIds: [] })).toBeNull();
    expect(detectFirstTaskCompletion({ ...baseInput, deliveredMessageIds: ['unrelated-message'] })).toBeNull();
    expect(detectFirstTaskCompletion({ ...baseInput, activity: 'responding' })).toBeNull();
    expect(
      detectFirstTaskCompletion({
        ...baseInput,
        messages: [baseInput.messages[0], { ...baseInput.messages[1], content: '   ' }],
      }),
    ).toBeNull();
    expect(
      detectFirstTaskCompletion({
        ...baseInput,
        messages: [baseInput.messages[1], baseInput.messages[0]],
      }),
    ).toBeNull();
    expect(
      detectFirstTaskCompletion({
        ...baseInput,
        onboardingCompletedAt: '2026-09-14T11:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('stores a validated record per account and ignores malformed data', () => {
    const storage = new MemoryStorage();
    const record: FirstTaskMilestoneRecord = {
      version: 1,
      userId: 'user-1',
      taskId: 'task-1',
      assistantMessageId: 'a1',
      completedAt: '2026-09-14T10:02:00.000Z',
    };

    expect(saveFirstTaskMilestone(record, storage)).toBe(true);
    expect(loadFirstTaskMilestone('user-1', storage)).toEqual(record);
    expect(loadFirstTaskMilestone('user-2', storage)).toBeNull();

    storage.values.set('partner-w:first-task:v1:user-1', '{bad json');
    expect(loadFirstTaskMilestone('user-1', storage)).toBeNull();
  });
});
